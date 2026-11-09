import {
  BUILT_IN_SKIP_FIELDS,
  type DocumentTypeConfig,
  type TranslationConfig,
} from '../config'
import {stableHash} from '../hash'
import {
  createSegmentCustomId,
  createTaskId,
  FIELDS_TASK_ID,
  pathToString,
  type PathSegment,
} from '../ids'
import {getIntlItem, isIntlArray} from './intl'
import {arrayItemSegment, isPlainObject, type PlainObject} from './paths'
import {
  blockToSegmentContents,
  isPortableTextArray,
  isPortableTextBlock,
  splitText,
  MAX_SEGMENT_LENGTH,
  type PortableTextBlock,
} from './portableText'

/**
 * One translatable value: a text field or one Portable Text block. It is sent to TextUnited
 * as one or more segments (long values are split into chunks).
 */
export type TranslationUnit = {
  /** Stable id, the path to the value written the Sanity way */
  id: string
  taskId: string
  /**
   * `fieldLevel`: path to the internationalized array. `documentLevel`: path to the text
   * field, or to the Portable Text array for blocks.
   */
  fieldPath: PathSegment[]
  /** Path inside the localized value: empty for text, `[{_key}]` for a block */
  innerPath: PathSegment[]
  kind: 'text' | 'block'
  source: string | PortableTextBlock
  segments: Array<{customId: string; content: string}>
  /** Hash of the source, used to notice later edits of the source text */
  sourceHash: string
}

type WalkContext = {
  model: DocumentTypeConfig['model']
  sourceLanguage: string
  skipFields: ReadonlySet<string>
  skipBlockTypes: ReadonlySet<string>
  units: TranslationUnit[]
}

const NON_TEXT_PATTERNS = [
  /^https?:\/\//i,
  /^mailto:/i,
  /^tel:/i,
  /^#[0-9a-f]{3,8}$/i, // colors
  /^[\d\s.,:%+-]+$/, // numbers, dates, percentages
  /^\d{4}-\d{2}-\d{2}/, // ISO dates
]

function isTranslatableString(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== '' && !NON_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed))
}

function shouldSkipField(name: string, context: WalkContext): boolean {
  return name.startsWith('_') || context.skipFields.has(name)
}

function addTextUnit(
  context: WalkContext,
  taskId: string,
  fieldPath: PathSegment[],
  text: string,
): void {
  const id = pathToString(fieldPath)
  const parts = splitText(text, MAX_SEGMENT_LENGTH)
  context.units.push({
    id,
    taskId,
    fieldPath,
    innerPath: [],
    kind: 'text',
    source: text,
    segments: parts.map((content, chunk) => ({
      customId: createSegmentCustomId(fieldPath, chunk),
      content,
    })),
    sourceHash: stableHash(text),
  })
}

function addBlockUnits(
  context: WalkContext,
  taskId: string,
  fieldPath: PathSegment[],
  blocks: unknown[],
  /** Walks non-block items (images, custom objects) for documentLevel text */
  walkObjects: boolean,
): void {
  blocks.forEach((block, index) => {
    const segment = arrayItemSegment(block, index)
    if (isPortableTextBlock(block)) {
      const contents = blockToSegmentContents(block)
      if (contents.length === 0) return
      const innerPath = [segment]
      const fullPath = [...fieldPath, ...innerPath]
      context.units.push({
        id: pathToString(fullPath),
        taskId,
        fieldPath,
        innerPath,
        kind: 'block',
        source: block,
        segments: contents.map((content, chunk) => ({
          customId: createSegmentCustomId(fullPath, chunk),
          content,
        })),
        sourceHash: stableHash(JSON.stringify(contents)),
      })
      return
    }
    if (!walkObjects || !isPlainObject(block)) return
    if (typeof block._type === 'string' && context.skipBlockTypes.has(block._type)) return
    walk(block, [...fieldPath, segment], taskId, context)
  })
}

function walk(value: unknown, path: PathSegment[], taskId: string, context: WalkContext): void {
  if (context.model === 'fieldLevel' && isIntlArray(value)) {
    const sourceValue = getIntlItem(value, context.sourceLanguage)?.value
    if (typeof sourceValue === 'string') {
      if (sourceValue.trim() !== '') addTextUnit(context, taskId, path, sourceValue)
    } else if (isPortableTextArray(sourceValue)) {
      addBlockUnits(context, taskId, path, sourceValue, false)
    }
    return
  }

  if (typeof value === 'string') {
    if (context.model === 'documentLevel' && isTranslatableString(value)) {
      addTextUnit(context, taskId, path, value)
    }
    return
  }

  if (Array.isArray(value)) {
    if (context.model === 'documentLevel' && isPortableTextArray(value)) {
      addBlockUnits(context, taskId, path, value, true)
      return
    }
    value.forEach((item, index) => {
      if (isPlainObject(item) && typeof item._type === 'string' && context.skipBlockTypes.has(item._type)) {
        return
      }
      walk(item, [...path, arrayItemSegment(item, index)], taskId, context)
    })
    return
  }

  if (isPlainObject(value)) {
    // References point at other documents; their text is translated there.
    if (typeof value._ref === 'string') return
    for (const [name, child] of Object.entries(value)) {
      if (shouldSkipField(name, context)) continue
      walk(child, [...path, name], taskId, context)
    }
  }
}

function isPageBuilderArray(value: unknown, context: WalkContext): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (isPortableTextArray(value)) return false
  if (context.model === 'fieldLevel' && isIntlArray(value)) return false
  return value.every((item) => isPlainObject(item) && typeof item._key === 'string')
}

/**
 * Lists the translatable values of a source document, in document order.
 *
 * Tasks: each item of a page-builder array becomes its own task (`sections.a1`), a rich-text
 * field is one task (`body`), and every other field goes to the shared `fields` task.
 */
export function extractTranslationUnits(
  document: PlainObject,
  typeConfig: DocumentTypeConfig,
  config: TranslationConfig,
): TranslationUnit[] {
  const context: WalkContext = {
    model: typeConfig.model,
    sourceLanguage: config.sourceLanguage.id,
    skipFields: new Set([...BUILT_IN_SKIP_FIELDS, ...(typeConfig.skipFields ?? [])]),
    skipBlockTypes: new Set(config.skipBlockTypes ?? []),
    units: [],
  }
  const allowed = typeConfig.fields ? new Set(typeConfig.fields) : undefined

  for (const [field, value] of Object.entries(document)) {
    if (shouldSkipField(field, context)) continue
    if (allowed && !allowed.has(field)) continue

    if (isPageBuilderArray(value, context)) {
      value.forEach((item, index) => {
        const segment = arrayItemSegment(item, index)
        walk(item, [field, segment], createTaskId(field, segment), context)
      })
      continue
    }

    const isRichText =
      isPortableTextArray(value) ||
      (context.model === 'fieldLevel' &&
        isIntlArray(value) &&
        isPortableTextArray(getIntlItem(value, context.sourceLanguage)?.value))

    walk(value, [field], isRichText ? createTaskId(field) : FIELDS_TASK_ID, context)
  }

  return context.units
}

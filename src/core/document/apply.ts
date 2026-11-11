import type {TranslationState} from '../plan'
import type {TranslationUnit} from './extract'
import {getIntlItem} from './intl'
import {cloneForTranslation, cloneValue, getAtPath, isPlainObject, setAtPath, type PlainObject} from './paths'
import {
  applyBlockTranslation,
  decodeHtmlEntities,
  joinTextChunks,
  type PortableTextBlock,
} from './portableText'
import {isMissingValue, readTargetValue, valueHash, type TranslationTargets} from './target'

/** Translation of one segment in one language, as returned by TextUnited. */
export type SegmentTranslation = {content: string; status?: string}

/** customId → Sanity language id → translation */
export type TranslationsBySegment = Map<string, Map<string, SegmentTranslation>>

export type ApplyOutcome =
  /** Written to the document */
  | 'applied'
  /** The document already holds this text */
  | 'unchanged'
  /** Someone edited the translation in Sanity after the plugin wrote it; left as it is */
  | 'keptManualEdit'
  /** TextUnited has no translation (yet) for every chunk of the value */
  | 'incomplete'

export type ApplyResult = {
  targets: TranslationTargets
  state: TranslationState
  /** Top-level fields changed, per document: `''` for fieldLevel, the language for documentLevel */
  changedFields: Map<string, Set<string>>
  outcomes: Array<{unitId: string; language: string; outcome: ApplyOutcome}>
}

const NOT_TRANSLATED = new Set(['untranslated'])

function translatedValue(
  unit: TranslationUnit,
  language: string,
  translations: TranslationsBySegment,
): {value: string | PortableTextBlock; status?: string} | null {
  const chunks: SegmentTranslation[] = []
  for (const segment of unit.segments) {
    const translation = translations.get(segment.customId)?.get(language)
    if (!translation || !translation.content || NOT_TRANSLATED.has(translation.status ?? '')) {
      return null
    }
    chunks.push(translation)
  }

  // The lowest status of the chunks describes the whole value.
  const status = chunks.map((chunk) => chunk.status).find((s) => s !== 'proofread') ?? chunks[0]?.status
  const contents = chunks.map((chunk) => chunk.content)

  if (unit.kind === 'text') {
    return {value: decodeHtmlEntities(joinTextChunks(contents)), status}
  }
  return {value: applyBlockTranslation(unit.source as PortableTextBlock, contents), status}
}

function writeValue(
  unit: TranslationUnit,
  language: string,
  value: unknown,
  targets: TranslationTargets,
  sourceDocument: PlainObject,
  sourceLanguage: string,
): void {
  if (targets.model === 'documentLevel') {
    const document = targets.documents[language]
    if (!document) throw new Error(`No ${language} document to write the translation to`)
    setAtPath(document, sourceDocument, [...unit.fieldPath, ...unit.innerPath], value)
    return
  }

  const intlArray = getAtPath(targets.document, unit.fieldPath)
  if (!Array.isArray(intlArray)) throw new Error(`No internationalized field at ${unit.id}`)
  const sourceItem = getIntlItem(getAtPath(sourceDocument, unit.fieldPath), sourceLanguage)

  let item = getIntlItem(intlArray, language)
  if (!item) {
    item = {
      _key: language,
      ...(isPlainObject(sourceItem) && typeof sourceItem._type === 'string' ? {_type: sourceItem._type} : {}),
      // Rich text starts as a copy of the source, so images and blocks without text are kept;
      // translated blocks replace their originals.
      value: unit.kind === 'text' ? '' : Array.isArray(sourceItem?.value) ? cloneForTranslation(sourceItem.value) : [],
    }
    intlArray.push(item)
  }

  if (unit.innerPath.length === 0) {
    item.value = value
    return
  }
  if (!Array.isArray(item.value)) item.value = []
  setAtPath(item, {value: sourceItem?.value ?? []}, ['value', ...unit.innerPath], value)
}

/**
 * Writes TextUnited translations into the target documents.
 *
 * A translation replaces the current value only when the value is missing, or when it is still
 * exactly what the plugin wrote last time. A value someone edited in Sanity is kept (outcome
 * `keptManualEdit`) unless the unit id is in `overwrite` (the `all` mode).
 *
 * The inputs are not modified: the result holds updated copies.
 */
export function applyTranslations(args: {
  units: TranslationUnit[]
  languages: string[]
  sourceLanguage: string
  sourceDocument: PlainObject
  targets: TranslationTargets
  translations: TranslationsBySegment
  state: TranslationState
  overwrite?: ReadonlySet<string>
}): ApplyResult {
  const targets = cloneValue(args.targets)
  const state: TranslationState = cloneValue(args.state)
  const changedFields = new Map<string, Set<string>>()
  const outcomes: ApplyResult['outcomes'] = []

  for (const unit of args.units) {
    for (const language of args.languages) {
      const translated = translatedValue(unit, language, args.translations)
      if (!translated) {
        outcomes.push({unitId: unit.id, language, outcome: 'incomplete'})
        continue
      }

      const current = readTargetValue(unit, language, targets)
      const record = state.units[unit.id]
      const appliedHash = record?.languages[language]?.appliedHash
      const editedByHand =
        !isMissingValue(unit, current) && appliedHash !== valueHash(current)

      if (editedByHand && !args.overwrite?.has(unit.id)) {
        outcomes.push({unitId: unit.id, language, outcome: 'keptManualEdit'})
        continue
      }

      const unitState = (state.units[unit.id] ??= {sourceHash: unit.sourceHash, languages: {}})
      unitState.languages[language] = {
        appliedHash: valueHash(translated.value),
        status: translated.status,
      }

      if (valueHash(current) === valueHash(translated.value)) {
        outcomes.push({unitId: unit.id, language, outcome: 'unchanged'})
        continue
      }

      writeValue(unit, language, translated.value, targets, args.sourceDocument, args.sourceLanguage)
      const documentKey = targets.model === 'fieldLevel' ? '' : language
      const fields = changedFields.get(documentKey) ?? new Set<string>()
      fields.add(String(unit.fieldPath[0]))
      changedFields.set(documentKey, fields)
      outcomes.push({unitId: unit.id, language, outcome: 'applied'})
    }
  }

  return {targets, state, changedFields, outcomes}
}

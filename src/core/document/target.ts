import {stableHash} from '../hash'
import type {TranslationUnit} from './extract'
import {getIntlItem} from './intl'
import {getAtPath, type PlainObject} from './paths'
import {blockText} from './portableText'

/**
 * Where the translations of one source document live.
 * - `fieldLevel`: in the source document itself (internationalized arrays).
 * - `documentLevel`: one document per target language; undefined when it does not exist yet.
 */
export type TranslationTargets =
  | {model: 'fieldLevel'; document: PlainObject}
  | {model: 'documentLevel'; documents: Record<string, PlainObject | undefined>}

/** Current translated value of a unit in one language, or undefined. */
export function readTargetValue(
  unit: TranslationUnit,
  language: string,
  targets: TranslationTargets,
): unknown {
  if (targets.model === 'fieldLevel') {
    const item = getIntlItem(getAtPath(targets.document, unit.fieldPath), language)
    return getAtPath(item?.value, unit.innerPath)
  }
  return getAtPath(targets.documents[language], [...unit.fieldPath, ...unit.innerPath])
}

/**
 * True when a unit has no usable translation: absent, empty, or still identical to the source
 * (a copy of the original, e.g. from duplicating the document, is not a translation).
 */
export function isMissingValue(unit: TranslationUnit, value: unknown): boolean {
  if (unit.kind === 'text') {
    return typeof value !== 'string' || value.trim() === '' || value.trim() === String(unit.source).trim()
  }
  return blockText(value).trim() === '' || blockText(value) === blockText(unit.source)
}

/** Hash of a translated value, used to tell whether someone edited it after the plugin wrote it. */
export function valueHash(value: unknown): string {
  return stableHash(JSON.stringify(value ?? null))
}

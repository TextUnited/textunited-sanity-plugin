import {isPlainObject, type PlainObject} from './paths'

/**
 * Helpers for sanity-plugin-internationalized-array fields: an array of
 * `{_key: '<language>', _type: 'internationalizedArray…Value', value}` items.
 */
export type IntlArrayItem = PlainObject & {_key: string; value?: unknown}

export function isIntlArray(value: unknown): value is IntlArrayItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isPlainObject(item) &&
        typeof item._key === 'string' &&
        'value' in item &&
        (typeof item._type !== 'string' || item._type.startsWith('internationalizedArray')),
    )
  )
}

export function getIntlItem(array: unknown, language: string): IntlArrayItem | undefined {
  if (!Array.isArray(array)) return undefined
  return array.find(
    (item): item is IntlArrayItem => isPlainObject(item) && item._key === language,
  )
}

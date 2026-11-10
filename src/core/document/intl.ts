import {isPlainObject, type PlainObject} from './paths'

/**
 * Helpers for sanity-plugin-internationalized-array fields: an array of
 * `{_key: '<language>', _type: 'internationalizedArray…Value', value}` items.
 */
export type IntlArrayItem = PlainObject & {_key: string; value?: unknown}

/**
 * A language added in the Studio and not filled in yet has no `value` at all, only its key and
 * type; it still belongs to the field, so the type is enough to recognise an item.
 */
export function isIntlArray(value: unknown): value is IntlArrayItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isPlainObject(item) &&
        typeof item._key === 'string' &&
        (typeof item._type === 'string' ? item._type.startsWith('internationalizedArray') : 'value' in item),
    )
  )
}

export function getIntlItem(array: unknown, language: string): IntlArrayItem | undefined {
  if (!Array.isArray(array)) return undefined
  return array.find(
    (item): item is IntlArrayItem => isPlainObject(item) && item._key === language,
  )
}

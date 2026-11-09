import type {PathSegment} from '../ids'

export type PlainObject = Record<string, unknown>

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

/** Builds the path step for one array item: its `_key` when present, else its index. */
export function arrayItemSegment(item: unknown, index: number): PathSegment {
  return isPlainObject(item) && typeof item._key === 'string' ? {_key: item._key} : index
}

function findArrayIndex(array: unknown[], segment: PathSegment): number {
  if (typeof segment === 'number') return segment < array.length ? segment : -1
  if (typeof segment === 'object') {
    return array.findIndex((item) => isPlainObject(item) && item._key === segment._key)
  }
  return -1
}

/** Reads the value at a path, or undefined when any step is missing. */
export function getAtPath(root: unknown, path: readonly PathSegment[]): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = findArrayIndex(current, segment)
      if (index === -1) return undefined
      current = current[index]
    } else if (isPlainObject(current) && typeof segment === 'string') {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}

/**
 * Writes a value at a path inside `target`, creating missing parents by copying them from
 * `source` at the same path. Missing array items are inserted at the position they have in
 * `source`, so a translated document keeps the structure of the original.
 */
export function setAtPath(
  target: PlainObject,
  source: unknown,
  path: readonly PathSegment[],
  value: unknown,
): void {
  if (path.length === 0) throw new Error('Cannot set a value at an empty path')

  let current: unknown = target
  let currentSource: unknown = source

  for (let depth = 0; depth < path.length; depth += 1) {
    const segment = path[depth] as PathSegment
    const isLast = depth === path.length - 1
    const nextSource = getAtPath(currentSource, [segment])

    if (Array.isArray(current)) {
      let index = findArrayIndex(current, segment)
      if (index === -1) {
        if (isLast) {
          current.push(value)
          return
        }
        const sourceArray = Array.isArray(currentSource) ? currentSource : []
        const sourceIndex = findArrayIndex(sourceArray, segment)
        const placeholder = cloneValue(nextSource ?? (typeof segment === 'object' ? {_key: segment._key} : {}))
        index = insertionIndex(current, sourceArray, sourceIndex)
        current.splice(index, 0, placeholder)
      }
      if (isLast) {
        current[index] = value
        return
      }
      current = current[index]
    } else if (isPlainObject(current) && typeof segment === 'string') {
      if (isLast) {
        current[segment] = value
        return
      }
      if (current[segment] === undefined || current[segment] === null) {
        // Start missing fields empty: copying them from the source would bring along sibling
        // values in the source language, which would then look like existing translations.
        current[segment] = emptyContainer(nextSource, path[depth + 1])
      }
      current = current[segment]
    } else {
      throw new Error('Path does not match the document structure')
    }
    currentSource = nextSource
  }
}

/** An empty object (keeping only `_type`) or array, shaped like the source at that place. */
function emptyContainer(source: unknown, next: PathSegment | undefined): unknown {
  if (Array.isArray(source) || typeof next !== 'string') return []
  return isPlainObject(source) && typeof source._type === 'string' ? {_type: source._type} : {}
}

/** Index in `target` right after the nearest preceding item that `source` also has. */
function insertionIndex(target: unknown[], source: unknown[], sourceIndex: number): number {
  for (let i = sourceIndex - 1; i >= 0; i -= 1) {
    const previous = source[i]
    if (isPlainObject(previous) && typeof previous._key === 'string') {
      const found = findArrayIndex(target, {_key: previous._key})
      if (found !== -1) return found + 1
    }
  }
  return sourceIndex >= 0 ? 0 : target.length
}

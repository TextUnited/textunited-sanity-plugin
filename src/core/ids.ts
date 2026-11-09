import {stableHash} from './hash'

/**
 * One step in a path to a value inside a Sanity document.
 *
 * Array items are addressed by their `_key`, which Sanity keeps stable when items are moved,
 * inserted or removed. A numeric index is only a fallback for arrays whose items have no
 * `_key` (rare in Sanity content); identifiers derived from an index change when items move.
 */
export type PathSegment = string | number | {_key: string}

/** Serialises a path the way Sanity's GROQ and patch APIs write it, e.g. `sections[_key=="a1"].title`. */
export function pathToString(path: readonly PathSegment[]): string {
  let result = ''
  for (const segment of path) {
    if (typeof segment === 'string') {
      result += result ? `.${segment}` : segment
    } else if (typeof segment === 'number') {
      result += `[${segment}]`
    } else {
      result += `[_key==${JSON.stringify(segment._key)}]`
    }
  }
  return result
}

/** Removes the `drafts.` (or any `versions.<release>.`) prefix from a Sanity document id. */
export function getBaseDocumentId(documentId: string): string {
  if (documentId.startsWith('drafts.')) return documentId.slice('drafts.'.length)
  if (documentId.startsWith('versions.')) {
    const rest = documentId.slice('versions.'.length)
    const dot = rest.indexOf('.')
    return dot === -1 ? rest : rest.slice(dot + 1)
  }
  return documentId
}

/**
 * Custom ID of the TextUnited multilingual project for one Sanity document.
 *
 * It is derived from the document alone, so every translation request for the same document
 * targets the same project instead of creating a new one. The Sanity project and dataset are
 * part of the id because one TextUnited company may connect several Sanity projects.
 */
export function createProjectCustomId(args: {
  sanityProjectId: string
  dataset: string
  documentId: string
}): string {
  return `sanity-${args.sanityProjectId}-${args.dataset}-${getBaseDocumentId(args.documentId)}`
}

/** Task that groups all short top-level fields (title, excerpt, SEO, …) of a document. */
export const FIELDS_TASK_ID = 'fields'

/**
 * Task ID (a virtual file inside the TextUnited project) for one part of a document.
 *
 * While the TextUnited `PUT` endpoint replaces a whole task on every update, splitting a
 * document into parts limits each update to the part that changed: one task per item of a
 * page-builder array (`sections.a1`), one per rich-text field (`body`), and one for all short
 * fields together. The id is readable on purpose: translators see it as a file name.
 */
export function createTaskId(field: string, item?: PathSegment): string {
  if (item === undefined) return field
  if (typeof item === 'object') return `${field}.${item._key}`
  return `${field}.${item}`
}

/**
 * Custom ID of one segment. It depends only on where the text lives in the document, never on
 * the text itself or on the translation request, so an edited text keeps its id and the
 * TextUnited segment can be updated in place once the API supports it.
 */
export function createSegmentCustomId(path: readonly PathSegment[], chunk = 0): string {
  // Chunk 0 has no suffix, so a text that later grows past the length limit keeps the id of
  // its first part.
  const suffix = chunk > 0 ? `#${chunk}` : ''
  return `seg-${stableHash(pathToString(path) + suffix)}`
}

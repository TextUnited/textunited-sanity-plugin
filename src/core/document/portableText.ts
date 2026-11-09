import {cloneValue, isPlainObject, type PlainObject} from './paths'

/**
 * Converts Portable Text blocks to TextUnited segment content and back.
 *
 * - A block with one unformatted span is sent as plain text.
 * - Otherwise every span is wrapped in `<span data-tu-id="KEY">…</span>` so that its marks
 *   (bold, links, …) can be restored on the translated text. TextUnited keeps these tags.
 * - Inline objects are not sent and stay as they are.
 * - Content longer than MAX_SEGMENT_LENGTH is split into several segments (chunks).
 */

export const MAX_SEGMENT_LENGTH = 2000

export type PortableTextBlock = PlainObject & {
  _type: 'block'
  children?: unknown[]
  markDefs?: unknown[]
}

type Span = PlainObject & {_type: 'span'; text: string; marks?: unknown[]; _key?: string}

const ENTITIES: Record<string, string> = {amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'}

export function isPortableTextBlock(value: unknown): value is PortableTextBlock {
  return isPlainObject(value) && value._type === 'block'
}

export function isPortableTextArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.some(isPortableTextBlock)
}

function isSpan(value: unknown): value is Span {
  return isPlainObject(value) && value._type === 'span' && typeof value.text === 'string'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, token: string) => {
    if (token[0] === '#') {
      const codePoint =
        token[1] === 'x' || token[1] === 'X'
          ? Number.parseInt(token.slice(2), 16)
          : Number.parseInt(token.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
    }
    return ENTITIES[token.toLowerCase()] ?? entity
  })
}

function spanId(span: Span, index: number): string {
  return typeof span._key === 'string' ? span._key : `child-${index}`
}

function isPlainBlock(block: PortableTextBlock, spans: Span[]): boolean {
  return (
    spans.length === 1 &&
    (!Array.isArray(block.markDefs) || block.markDefs.length === 0) &&
    (!Array.isArray(spans[0]?.marks) || spans[0].marks.length === 0) &&
    (block.children?.length ?? 0) === 1
  )
}

/** Splits text into parts no longer than maxLength, preferring sentence and word boundaries. */
export function splitText(text: string, maxLength: number): string[] {
  const parts: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength)
    const boundary = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('; '),
      slice.lastIndexOf(', '),
      slice.lastIndexOf(' '),
    )
    const splitAt = boundary > maxLength * 0.5 ? boundary + 1 : maxLength
    parts.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  if (remaining) parts.push(remaining)
  return parts
}

/** Joins translated plain-text chunks, restoring a space TextUnited may have trimmed. */
export function joinTextChunks(chunks: string[]): string {
  return chunks.reduce((joined, chunk) => {
    if (!joined) return chunk
    return /\s$/.test(joined) || /^\s/.test(chunk) ? joined + chunk : `${joined} ${chunk}`
  }, '')
}

/**
 * Returns the segment contents for one block, or an empty array when the block has no text.
 */
export function blockToSegmentContents(block: PortableTextBlock): string[] {
  const spans = (block.children ?? []).filter(isSpan)
  if (!spans.some((span) => span.text.trim() !== '')) return []

  if (isPlainBlock(block, spans)) {
    return splitText((spans[0] as Span).text, MAX_SEGMENT_LENGTH)
  }

  const chunks: string[] = []
  let current = ''
  spans.forEach((span, index) => {
    if (span.text === '') return
    const id = escapeHtml(spanId(span, index))
    const wrapperLength = `<span data-tu-id="${id}"></span>`.length
    for (const part of splitText(span.text, Math.max(100, MAX_SEGMENT_LENGTH - wrapperLength))) {
      const wrapped = `<span data-tu-id="${id}">${escapeHtml(part)}</span>`
      if (current && current.length + wrapped.length > MAX_SEGMENT_LENGTH) {
        chunks.push(current)
        current = ''
      }
      current += wrapped
    }
  })
  if (current) chunks.push(current)
  return chunks
}

/** Plain text of a block, used to tell whether a translated block is empty. */
export function blockText(block: unknown): string {
  if (!isPortableTextBlock(block)) return ''
  return (block.children ?? [])
    .filter(isSpan)
    .map((span) => span.text)
    .join('')
}

/**
 * Builds the translated block from the source block and the translated chunk contents.
 * Keys, styles, marks and inline objects come from the source block. A span missing from the
 * translation keeps its source text, so no content is ever dropped.
 */
export function applyBlockTranslation(
  sourceBlock: PortableTextBlock,
  translatedChunks: string[],
): PortableTextBlock {
  const block = cloneValue(sourceBlock)
  const children = (block.children ?? []) as unknown[]
  const spans = children.filter(isSpan)

  if (isPlainBlock(sourceBlock, (sourceBlock.children ?? []).filter(isSpan))) {
    const span = spans[0] as Span
    span.text = decodeHtmlEntities(joinTextChunks(translatedChunks).replace(/<[^>]*>/g, ''))
    return block
  }

  const translatedById = new Map<string, string>()
  const pattern = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi
  const html = translatedChunks.join('')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    const idMatch = (match[1] ?? '').match(/\bdata-tu-id\s*=\s*["']([^"']+)["']/i)
    if (!idMatch?.[1]) continue
    const id = decodeHtmlEntities(idMatch[1])
    const text = decodeHtmlEntities((match[2] ?? '').replace(/<[^>]*>/g, ''))
    translatedById.set(id, (translatedById.get(id) ?? '') + text)
  }

  spans.forEach((span, index) => {
    const translated = translatedById.get(spanId(span, index))
    if (translated !== undefined) span.text = translated
  })
  return block
}

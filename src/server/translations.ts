import type {TranslationConfig} from '../core/config'
import type {TranslationsBySegment} from '../core/document/apply'
import {canonicalLanguageCode} from '../core/languages'

type Entry = {
  source?: {customId?: string; taskId?: string | null}
  translations?: Array<{languageCode?: string; content?: string; status?: string}>
}

/**
 * Maps TextUnited segments (instant translations or `GET …/segments`) to the shape
 * `applyTranslations` reads, translating TextUnited language codes to Sanity language ids.
 *
 * In append mode the same segment can exist in several tasks (each update adds a task with the
 * changed texts). `taskOf` names, per segment, the task that holds its current source; copies in
 * other tasks are ignored. Without an entry, a later copy wins over an earlier one.
 */
export function toTranslationsBySegment(
  entries: Iterable<Entry>,
  config: TranslationConfig,
  taskOf?: ReadonlyMap<string, string>,
): TranslationsBySegment {
  const languageByCode = new Map(
    config.targetLanguages.map((language) => [canonicalLanguageCode(language.textUnitedCode), language.id]),
  )
  const result: TranslationsBySegment = new Map()
  for (const entry of entries) {
    const customId = entry.source?.customId
    if (!customId) continue
    const wantedTask = taskOf?.get(customId)
    if (wantedTask !== undefined && (entry.source?.taskId ?? '') !== wantedTask) continue
    const perLanguage = result.get(customId) ?? new Map()
    for (const translation of entry.translations ?? []) {
      const language = languageByCode.get(canonicalLanguageCode(translation.languageCode))
      if (!language || typeof translation.content !== 'string') continue
      perLanguage.set(language, {content: translation.content, status: translation.status})
    }
    result.set(customId, perLanguage)
  }
  return result
}

/** Statuses after which TextUnited will not change a translation on its own. */
const FINAL_STATUSES = new Set(['translated', 'proofread'])

export function isFinalStatus(status: string | undefined): boolean {
  return FINAL_STATUSES.has(String(status ?? '').toLowerCase())
}

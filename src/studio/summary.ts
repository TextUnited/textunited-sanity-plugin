import type {TranslationUnit} from '../core/document/extract'
import type {TranslationTargets} from '../core/document/target'
import {planTranslation, type TranslationMode, type TranslationState} from '../core/plan'
import {projectForLanguage, type ProjectRecord} from '../core/projects'

/** What a translation request would send, in words an editor understands. */
export type PendingSummary = {
  /** Texts that would be sent for the chosen languages */
  texts: number
  /** Of these: texts whose source was edited since they were sent */
  changed: number
  /** Of these: texts with no translation yet in at least one chosen language */
  untranslated: number
  /** Approximate number of source words */
  words: number
  /** Per language: texts that would be sent for that language alone */
  byLanguage: Record<string, number>
}

/** Words of a segment, ignoring the span markers of formatted text. */
export function countWords(content: string): number {
  const text = content.replace(/<[^>]+>/g, ' ').trim()
  return text ? text.split(/\s+/).length : 0
}

/**
 * What the request would send for the chosen languages. The default request (`changed`) sends
 * untranslated texts and texts whose source changed since they were sent to the language's
 * project; `all` sends everything.
 */
export function summarizePending(args: {
  units: TranslationUnit[]
  targets: TranslationTargets
  state: TranslationState
  languages: string[]
  projects?: ProjectRecord[]
  mode?: TranslationMode
}): PendingSummary {
  const mode = args.mode ?? 'changed'
  const projects = args.projects ?? []
  const planFor = (languages: string[]) =>
    planTranslation({
      units: args.units,
      targets: args.targets,
      state: args.state,
      languages,
      mode,
      projectCustomId: languages[0] ? projectForLanguage(projects, languages[0])?.customId : undefined,
    })

  // The chosen languages grouped as the server sends them: per project, new languages together.
  const groups = new Map<string, string[]>()
  for (const language of args.languages) {
    const key = projectForLanguage(projects, language)?.customId ?? ''
    groups.set(key, [...(groups.get(key) ?? []), language])
  }
  const selected = new Map<string, {unit: TranslationUnit; reason: string}>()
  for (const languages of groups.values()) {
    for (const entry of planFor(languages).selected) {
      // An edited text counts as changed even when another project only misses it.
      if (!selected.has(entry.unit.id) || entry.reason === 'sourceChanged') selected.set(entry.unit.id, entry)
    }
  }
  const byLanguage: Record<string, number> = {}
  for (const language of args.languages) byLanguage[language] = planFor([language]).selected.length
  const chosen = [...selected.values()]
  return {
    texts: chosen.length,
    changed: chosen.filter(({reason}) => reason === 'sourceChanged').length,
    untranslated: chosen.filter(({reason}) => reason === 'missing').length,
    words: chosen.reduce(
      (sum, {unit}) => sum + unit.segments.reduce((total, segment) => total + countWords(segment.content), 0),
      0,
    ),
    byLanguage,
  }
}

/** One line for the summary card, e.g. "1 changed, 2 untranslated · about 14 words". */
export function describePending(summary: PendingSummary): string {
  const parts: string[] = []
  if (summary.changed > 0) parts.push(`${summary.changed} changed`)
  if (summary.untranslated > 0) parts.push(`${summary.untranslated} not translated yet`)
  const words = summary.words === 1 ? '1 word' : `${summary.words} words`
  return `${parts.join(', ')} · about ${words}`
}

/** Short label of the document badge, e.g. "DE 5/7 · PL 7/7", or null without a project. */
export function badgeLabel(
  progress: Map<string, {reviewed: number; total: number}>,
  projectLanguages: string[] | undefined,
): {label: string; complete: boolean} | null {
  const languages = (projectLanguages ?? []).filter((language) => progress.has(language))
  if (languages.length === 0) return null
  const complete = languages.every((language) => {
    const entry = progress.get(language)!
    return entry.reviewed === entry.total
  })
  if (languages.length > 3) {
    const done = languages.filter((language) => {
      const entry = progress.get(language)!
      return entry.reviewed === entry.total
    }).length
    return {label: `Translated ${done}/${languages.length}`, complete}
  }
  const label = languages
    .map((language) => {
      const entry = progress.get(language)!
      return `${language.toUpperCase()} ${entry.reviewed}/${entry.total}`
    })
    .join(' · ')
  return {label, complete}
}

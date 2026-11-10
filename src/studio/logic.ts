import type {TranslationConfig, TranslationLanguage} from '../core/config'
import type {TranslationMode} from '../core/plan'

/** What the Studio reads to show the translation status of a document. */
export type ProjectType = 'outsourced' | 'inHouse'

export type TranslationStatusData = {
  state: {
    projectCustomId?: string
    projectLanguages?: string[]
    projectType?: ProjectType
    projectId?: number
    stateJson?: string
    pending?: boolean
    updatedAt?: string
  } | null
  lastRequest: {
    _id: string
    _createdAt?: string
    status?: 'queued' | 'running' | 'done' | 'failed'
    error?: string | null
    summaryJson?: string
    languages?: string[]
    mode?: TranslationMode
  } | null
}

export const PROJECT_TYPE_OPTIONS: Array<{value: ProjectType; title: string; description: string}> = [
  {
    value: 'outsourced',
    title: 'TextUnited translators (outsourced)',
    description: 'TextUnited manages the project and assigns its translators.',
  },
  {
    value: 'inHouse',
    title: 'Your own team (in-house)',
    description: 'People from your TextUnited account translate. Pick at least one translator.',
  },
]

export function projectTypeLabel(type: ProjectType | undefined): string {
  return type === 'inHouse' ? 'In-house' : type === 'outsourced' ? 'Outsourced' : 'Unknown type'
}

/** A person offered for an in-house team, with the roles picked in the dialog. */
export type TeamChoice = {
  id: number
  username: string
  name: string
  kind: 'user' | 'collaborator'
  translator: boolean
  proofreader: boolean
  projectManager: boolean
}

/** Why the team cannot be used yet, or null when it is fine. */
export function validateTeam(team: TeamChoice[]): string | null {
  return team.some((member) => member.translator) ? null : 'Pick at least one translator.'
}

/** The team as stored in the request document: only people with a role. */
export function teamForRequest(team: TeamChoice[]) {
  return team
    .filter((member) => member.translator || member.proofreader || member.projectManager)
    .map(({id, username, translator, proofreader, projectManager}) => ({
      _key: String(id),
      id,
      username,
      translator,
      proofreader,
      projectManager,
    }))
}

export type LanguageOption = TranslationLanguage & {
  /** False when the language cannot be requested */
  available: boolean
  /** Why the language is unavailable */
  note?: string
}

/**
 * Which languages an editor can pick. While the TextUnited API cannot add a language to an
 * existing project, only the project's languages are available once a project exists.
 */
export function languageOptions(
  config: TranslationConfig,
  projectLanguages: string[] | undefined,
): LanguageOption[] {
  return config.targetLanguages.map((language) => {
    if (!projectLanguages || projectLanguages.includes(language.id)) return {...language, available: true}
    return {
      ...language,
      available: false,
      note: 'Not in this document’s TextUnited project. Adding a language to an existing project is not supported yet.',
    }
  })
}

export type LanguageProgress = {reviewed: number; total: number}

const REVIEWED_STATUSES = new Set(['translated', 'proofread'])

/**
 * Per language: how many of the texts sent to TextUnited translators have confirmed.
 * Read from the plugin's state document; languages with nothing sent are left out.
 */
export function languageProgress(
  stateJson: string | undefined,
  projectLanguages: string[] = [],
): Map<string, LanguageProgress> {
  const progress = new Map<string, LanguageProgress>()
  let state: {units?: Record<string, {sentAt?: string; languages?: Record<string, {status?: string}>}>} = {}
  try {
    state = JSON.parse(stateJson ?? '{}')
  } catch {
    return progress
  }
  const units = Object.values(state.units ?? {}).filter((unit) => unit.sentAt)
  for (const unit of units) {
    // Every sent text counts for every project language, translated yet or not.
    const languages = new Set([...projectLanguages, ...Object.keys(unit.languages ?? {})])
    for (const language of languages) {
      const entry = progress.get(language) ?? {reviewed: 0, total: 0}
      entry.total += 1
      const status = unit.languages?.[language]?.status
      if (REVIEWED_STATUSES.has(String(status ?? '').toLowerCase())) entry.reviewed += 1
      progress.set(language, entry)
    }
  }
  return progress
}

/** Languages ticked when the dialog opens: the project's languages, or none before a project exists. */
export function defaultLanguages(options: LanguageOption[], projectLanguages: string[] | undefined): string[] {
  if (!projectLanguages) return []
  return options.filter((option) => option.available).map((option) => option.id)
}

/**
 * The action is offered on documents in the source language. For document-level translation,
 * translated copies carry another language and do not get the action.
 */
export function canTranslateDocument(
  config: TranslationConfig,
  documentType: string,
  document: Record<string, unknown> | null | undefined,
): {allowed: boolean; reason?: string} {
  const typeConfig = config.documentTypes.find((entry) => entry.type === documentType)
  if (!typeConfig) return {allowed: false, reason: 'This document type is not set up for translation'}
  if (!document) return {allowed: false, reason: 'Save the document before translating it'}
  if (typeConfig.model === 'documentLevel') {
    const language = document[typeConfig.languageField ?? 'language']
    if (language !== undefined && language !== config.sourceLanguage.id) {
      return {allowed: false, reason: `Translations are requested from the ${config.sourceLanguage.title} version`}
    }
  }
  return {allowed: true}
}

/** One-line description of a finished request, for editors. */
export function describeRequest(request: TranslationStatusData['lastRequest']): string {
  if (!request) return 'Not translated with TextUnited yet.'
  if (request.status === 'queued' || request.status === 'running') return 'Translation request in progress…'
  if (request.status === 'failed') return `The last request failed: ${request.error ?? 'unknown error'}`

  let summary: {
    tasksSent?: string[]
    unitsSelected?: number
    tasksAwaitingTranslation?: string[]
    outcomes?: Record<string, number>
    projectCreated?: boolean
  } = {}
  try {
    summary = JSON.parse(request.summaryJson ?? '{}')
  } catch {
    // keep the empty summary
  }
  if (!summary.tasksSent?.length) return 'Nothing needed translation in the last request.'
  const applied = summary.outcomes?.applied ?? 0
  const kept = summary.outcomes?.keptManualEdit ?? 0
  const sent =
    typeof summary.unitsSelected === 'number'
      ? `${summary.unitsSelected} text(s)`
      : `${summary.tasksSent.length} part(s) of the document`
  const parts = [
    `${summary.projectCreated ? 'Created the TextUnited project and sent' : 'Sent'} ${sent}.`,
    `${applied} machine translation(s) added to the draft.`,
  ]
  if (kept > 0) parts.push(`${kept} translation(s) edited by hand were kept.`)
  const awaiting = summary.tasksAwaitingTranslation?.length ?? 0
  if (awaiting > 0) {
    parts.push(`TextUnited is still preparing ${awaiting} part(s); their translations will be added later.`)
  }
  return parts.join(' ')
}

import {getDocumentTypeConfig, type DocumentTypeConfig, type TranslationConfig} from '../core/config'
import {applyTranslations, type ApplyOutcome, type TranslationsBySegment} from '../core/document/apply'
import {extractTranslationUnits, type TranslationUnit} from '../core/document/extract'
import {getIntlItem} from '../core/document/intl'
import type {PlainObject} from '../core/document/paths'
import {createProjectCustomId, getBaseDocumentId} from '../core/ids'
import {canonicalLanguageCode, findUnknownLanguageCodes, type TextUnitedLanguage} from '../core/languages'
import {
  hasPendingTranslations,
  mergeState,
  planTranslation,
  recordBaseline,
  recordSentUnits,
  type TranslationMode,
  type TranslationPlan,
  type TranslationState,
} from '../core/plan'
import {
  TextUnitedTimeoutError,
  type TextUnitedCapabilities,
  type TextUnitedClient,
} from '../core/textunited/client'
import type {TranslationTargets} from '../core/document/target'
import type {ProjectRecord} from '../core/projects'
import type {
  ProjectResponse,
  ProjectSegment,
  ProjectTargetLanguage,
  ProjectTeamMember,
} from '../core/textunited/types'
import {
  createMissingTranslationDocuments,
  loadState,
  loadTargets,
  saveStateMutation,
  writeTargetsMutations,
  type StoredState,
} from './documents'
import {getPreferredDocument, SanityConflictError, type SanityStore} from './sanityStore'
import {isFinalStatus, toTranslationsBySegment} from './translations'

/** Services ordered for every target language of a new project. */
export type ProjectSettings = Omit<ProjectTargetLanguage, 'targetLanguageCode'>

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  managedProject: true,
  serviceTranslation: true,
  serviceProofreading: false,
  serviceAutomaticTranslation: true,
  serviceAdaptiveTranslation: false,
  serviceScoring: false,
}

/** In-house projects: the company's own team works on them, so TextUnited needs that team. */
export const DEFAULT_IN_HOUSE_SETTINGS: ProjectSettings = {
  managedProject: false,
  serviceTranslation: true,
  serviceProofreading: false,
  serviceAutomaticTranslation: true,
  serviceAdaptiveTranslation: false,
  serviceScoring: false,
}

export type ProjectType = 'outsourced' | 'inHouse'

/** One person of an in-house team, as the Studio sends it in the request document. */
type RequestedTeamMember = {
  id?: number
  username?: string
  translator?: boolean
  proofreader?: boolean
  projectManager?: boolean
}

function teamFromRequest(value: unknown): ProjectTeamMember[] {
  if (!Array.isArray(value)) return []
  return (value as RequestedTeamMember[])
    .filter((member) => typeof member?.username === 'string' && member.username !== '')
    .map((member) => ({
      ...(typeof member.id === 'number' ? {id: member.id} : {}),
      username: member.username as string,
      isTranslator: member.translator === true,
      isProofreader: member.proofreader === true,
      isProjectManager: member.projectManager === true,
      isInCountryReviewer: false,
    }))
    .filter((member) => member.isTranslator || member.isProofreader || member.isProjectManager)
}

/** Settings for the target languages of a new project of the requested type. */
function projectSettingsFor(
  request: PlainObject,
  context: JobContext,
): {projectType: ProjectType; settings: ProjectSettings} {
  if (request.projectType !== 'inHouse') return {projectType: 'outsourced', settings: context.projectSettings}
  const team = teamFromRequest(request.team)
  if (!team.some((member) => member.isTranslator)) {
    throw new Error('An in-house project needs at least one translator in the team.')
  }
  return {
    projectType: 'inHouse',
    settings: {
      ...context.inHouseSettings,
      serviceProofreading: team.some((member) => member.isProofreader),
      team,
    },
  }
}

export type JobContext = {
  config: TranslationConfig
  store: SanityStore
  textUnited: TextUnitedClient
  sanityProjectId: string
  dataset: string
  projectSettings: ProjectSettings
  inHouseSettings: ProjectSettings
  /** Languages TextUnited supports, to check the configured codes; null when unavailable */
  knownLanguages?: () => Promise<TextUnitedLanguage[] | null>
  /** What the TextUnited API supports; see `TextUnitedCapabilities` */
  capabilities?: TextUnitedCapabilities
  /** Builds the notification URL TextUnited calls for one document; none in local development */
  eventUrl: (baseDocumentId: string) => Promise<string | undefined>
  newId?: () => string
  now?: () => Date
}

export type JobSummary = {
  tasksSent: string[]
  /** Sent, but TextUnited did not answer in time; their translations arrive later */
  tasksAwaitingTranslation?: string[]
  unitsSelected: number
  /** Texts sent to TextUnited (all of them for a new project after a reset) */
  textsSent?: number
  outcomes: Partial<Record<ApplyOutcome, number>>
  projectCreated: boolean
}

export type JobResult =
  | {status: 'ignored'; reason: string}
  | {status: 'done'; summary: JobSummary}
  | {status: 'failed'; error: string}

const VALID_MODES: ReadonlySet<string> = new Set(['missing', 'changed', 'all'])

function documentTitle(source: PlainObject, sourceLanguage: string): string {
  const title = source.title
  if (typeof title === 'string') return title
  const localized = getIntlItem(title, sourceLanguage)?.value
  return typeof localized === 'string' ? localized : ''
}

/** Name of a project; projects added later name their languages, e.g. "Pricing – JA, IT (page-1)". */
function projectName(source: PlainObject, baseId: string, sourceLanguage: string, languages?: string[]): string {
  const title = documentTitle(source, sourceLanguage).replace(/\s+/g, ' ').trim()
  const suffix = languages?.length ? ` – ${languages.map((language) => language.toUpperCase()).join(', ')}` : ''
  return title ? `${title.slice(0, 160)}${suffix} (${baseId})` : `${baseId}${suffix}`
}

/** Maps TextUnited instant translations to the shape `applyTranslations` reads. */
function collectInstantTranslations(
  responses: ProjectResponse[],
  config: TranslationConfig,
): TranslationsBySegment {
  return toTranslationsBySegment(
    responses.flatMap((response) => response.instantTranslationSegments ?? []),
    config,
  )
}

export function countOutcomes(outcomes: Array<{outcome: ApplyOutcome}>): JobSummary['outcomes'] {
  const counts: JobSummary['outcomes'] = {}
  for (const {outcome} of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1
  return counts
}

/**
 * Processes one translation request document. Safe to call more than once for the same request:
 * only a `queued` request is processed, and it is claimed with a revision check first.
 */
export async function processTranslationRequest(
  requestId: string,
  context: JobContext,
): Promise<JobResult> {
  const now = context.now ?? (() => new Date())
  const newId = context.newId ?? (() => crypto.randomUUID())
  const request = await context.store.getDocument(requestId)
  if (!request) return {status: 'ignored', reason: 'Request not found'}
  if (request.status !== 'queued') return {status: 'ignored', reason: `Request is ${String(request.status)}`}

  try {
    await context.store.mutate([
      {
        patch: {
          id: requestId,
          ifRevisionID: String(request._rev),
          set: {status: 'running', startedAt: now().toISOString()},
        },
      },
    ])
  } catch (error) {
    if (error instanceof SanityConflictError) return {status: 'ignored', reason: 'Already being processed'}
    throw error
  }

  try {
    const summary = await runRequest(request, context, newId)
    await context.store.mutate([
      {
        patch: {
          id: requestId,
          set: {status: 'done', finishedAt: now().toISOString(), summaryJson: JSON.stringify(summary), error: null},
        },
      },
    ])
    return {status: 'done', summary}
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Translation request failed'
    await context.store.mutate([
      {patch: {id: requestId, set: {status: 'failed', finishedAt: now().toISOString(), error: message}}},
    ])
    return {status: 'failed', error: message}
  }
}

async function runRequest(request: PlainObject, context: JobContext, newId: () => string): Promise<JobSummary> {
  const {config} = context
  const now = context.now ?? (() => new Date())
  const baseId = getBaseDocumentId(String(request.documentId ?? ''))
  const mode = String(request.mode ?? 'missing') as TranslationMode
  const reset = request.reset === true
  if (!baseId) throw new Error('The request has no document id')
  if (!VALID_MODES.has(mode)) throw new Error(`Unknown translation mode: ${mode}`)

  const configured = new Set(config.targetLanguages.map((language) => language.id))
  const languages = (Array.isArray(request.languages) ? request.languages : [])
    .map(String)
    .filter((language) => configured.has(language))
  if (languages.length === 0) throw new Error('No configured target language was requested')

  const source = await getPreferredDocument(context.store, baseId)
  if (!source) throw new Error(`Document ${baseId} not found`)
  const typeConfig = getDocumentTypeConfig(config, String(source._type))
  if (!typeConfig) throw new Error(`Documents of type ${String(source._type)} are not configured for translation`)

  const units = extractTranslationUnits(source, typeConfig, config)
  const loaded = await loadTargets({store: context.store, source, typeConfig, languages})
  const stored = await loadState(context.store, baseId)
  const baseState = recordBaseline(stored.state, units)

  // A reset starts over: the current projects are archived and a new one takes the languages.
  const activeProjects = reset ? [] : stored.projects
  const archived = reset ? [...stored.archived, ...stored.projects] : stored.archived
  const groups = planGroups({
    units,
    languages,
    targets: loaded.targets,
    state: baseState,
    mode,
    reset,
    append: context.capabilities?.appendSegments === true,
    projects: activeProjects,
    newCustomId: () => projectCustomIdFor(context, baseId, activeProjects.length + archived.length),
  })

  const selectedIds = new Set(groups.flatMap((group) => group.apply.selected.map(({unit}) => unit.id)))
  const summary: JobSummary = {
    tasksSent: [],
    unitsSelected: selectedIds.size,
    outcomes: {},
    projectCreated: false,
  }
  summary.textsSent = new Set(groups.flatMap((group) => group.sendUnits.map((unit) => unit.id))).size
  if (groups.every((group) => group.sendUnits.length === 0)) {
    try {
      const pending = hasPendingTranslations(baseState, stored.projects, isFinalStatus)
      await context.store.mutate([saveStateMutation(baseId, {...stored, state: baseState}, pending)])
    } catch (error) {
      // The baseline is only a convenience; a concurrent save already holds a newer state.
      if (!(error instanceof SanityConflictError)) throw error
    }
    return summary
  }

  await assertKnownLanguageCodes(context, languages)
  const eventUrl = await context.eventUrl(baseId)
  const sentAt = now().toISOString()
  const isFirst = activeProjects.length === 0 && archived.length === 0

  // Each project is sent to separately; they do not depend on each other.
  const results = await Promise.all(
    groups
      .filter((group) => group.sendUnits.length > 0)
      .map((group) => sendToProject({context, request, group, source, baseId, eventUrl, newId, now, isFirst})),
  )

  let sentState = baseState
  const projects = [...activeProjects]
  const responses: ProjectResponse[] = []
  for (const result of results) {
    responses.push(...result.responses)
    summary.tasksSent.push(...result.tasksSent)
    if (result.awaiting.length > 0) {
      summary.tasksAwaitingTranslation = [...(summary.tasksAwaitingTranslation ?? []), ...result.awaiting]
    }
    if (result.created) summary.projectCreated = true
    const index = projects.findIndex((project) => project.customId === result.project.customId)
    if (index >= 0) projects[index] = result.project
    else projects.push(result.project)
    for (const sent of result.sent) {
      sentState = recordSentUnits(sentState, sent.units, sentAt, sent.taskId, result.project.customId)
    }
  }

  // Only selected units take the instant (machine) translation; in replace mode other units of
  // the same tasks were resent only because the API replaces whole tasks. A translation of an
  // edited source no longer fits, so it is replaced even if edited by hand; so is every value in
  // `all` mode.
  const selected = new Map<string, TranslationUnit>()
  const overwrite = new Set<string>()
  for (const group of groups) {
    for (const {unit, reason} of group.apply.selected) {
      selected.set(unit.id, unit)
      if (mode === 'all' || reason === 'sourceChanged') overwrite.add(unit.id)
    }
  }

  return finishRequest({
    context,
    source,
    typeConfig,
    loaded,
    languages,
    units,
    stored,
    baseId,
    newId,
    summary,
    selectedUnits: [...selected.values()],
    overwrite,
    responses,
    sentState,
    projects,
    archived,
  })
}

/** One TextUnited project a request sends to, with what it sends and what it applies. */
type SendGroup = {
  project: ProjectRecord
  /** Requested languages that belong to this project */
  languages: string[]
  /** Units whose instant translation is written, and why they were chosen */
  apply: TranslationPlan
  /** What is sent: whole parts in replace mode; every text for a new project after a reset */
  sendPlan: TranslationPlan
  sendUnits: TranslationUnit[]
}

/**
 * Splits a request by project: requested languages of an existing project go to that project;
 * languages in no project go together to one new project.
 */
function planGroups(args: {
  units: TranslationUnit[]
  languages: string[]
  targets: TranslationTargets
  state: TranslationState
  mode: TranslationMode
  reset: boolean
  /** Append mode sends the selected texts; replace mode sends whole parts (tasks) */
  append: boolean
  projects: ProjectRecord[]
  newCustomId: () => string
}): SendGroup[] {
  const groups: SendGroup[] = []
  const plan = (languages: string[], projectCustomId: string | undefined, mode: TranslationMode) =>
    planTranslation({units: args.units, languages, targets: args.targets, state: args.state, mode, projectCustomId})
  const unitsToSend = (sendPlan: TranslationPlan) => {
    if (args.append) return sendPlan.selected.map(({unit}) => unit)
    const taskIds = new Set(sendPlan.tasks.map((task) => task.taskId))
    return args.units.filter((unit) => taskIds.has(unit.taskId))
  }

  for (const project of args.projects) {
    const languages = args.languages.filter((language) => project.languages.includes(language))
    if (languages.length === 0) continue
    const apply = plan(languages, project.customId, args.mode)
    groups.push({project, languages, apply, sendPlan: apply, sendUnits: unitsToSend(apply)})
  }

  const covered = new Set(args.projects.flatMap((project) => project.languages))
  const newLanguages = args.languages.filter((language) => !covered.has(language))
  if (newLanguages.length > 0) {
    const project: ProjectRecord = {customId: args.newCustomId(), languages: newLanguages}
    const apply = plan(newLanguages, undefined, args.mode)
    // After a reset the new project receives every text, so it holds the whole document.
    const sendPlan = args.reset ? plan(newLanguages, undefined, 'all') : apply
    groups.push({project, languages: newLanguages, apply, sendPlan, sendUnits: unitsToSend(sendPlan)})
  }
  return groups
}

/** Custom id of a document's next project: the plain id for the first, then `-2`, `-3`… */
function projectCustomIdFor(context: JobContext, baseId: string, existingCount: number): string {
  const customId = createProjectCustomId({
    sanityProjectId: context.sanityProjectId,
    dataset: context.dataset,
    documentId: baseId,
  })
  return existingCount === 0 ? customId : `${customId}-${existingCount + 1}`
}

type SendResult = {
  project: ProjectRecord
  created: boolean
  responses: ProjectResponse[]
  tasksSent: string[]
  awaiting: string[]
  /** Units sent, with the task holding them (append mode) */
  sent: Array<{units: TranslationUnit[]; taskId?: string}>
}

/** Creates or updates one TextUnited project. */
async function sendToProject(args: {
  context: JobContext
  request: PlainObject
  group: SendGroup
  source: PlainObject
  baseId: string
  eventUrl: string | undefined
  newId: () => string
  now: () => Date
  /** The document's first project ever: its name has no language suffix */
  isFirst: boolean
}): Promise<SendResult> {
  const {context, request, group, source, baseId, eventUrl, newId, now} = args
  const {config} = context
  const codeOf = new Map(config.targetLanguages.map((language) => [language.id, language.textUnitedCode]))
  const customId = group.project.customId
  const result: SendResult = {
    project: {...group.project},
    created: false,
    responses: [],
    tasksSent: [],
    awaiting: [],
    sent: [],
  }

  const existing = await context.textUnited.getProject(customId)
  if (typeof existing?.id === 'number') result.project.projectId = existing.id
  if (existing) assertProjectLanguages(existing, group.languages, codeOf)

  const create = async (taskId: string, segments: ProjectSegment[]) => {
    const chosen = projectSettingsFor(request, context)
    result.project.projectType = chosen.projectType
    result.project.createdAt = now().toISOString()
    const created = await context.textUnited
      .createProject({
        customId,
        taskId,
        name: projectName(source, baseId, config.sourceLanguage.id, args.isFirst ? undefined : group.project.languages),
        sourceLanguageCode: config.sourceLanguage.textUnitedCode,
        targetLanguages: group.project.languages.map((language) => ({
          ...chosen.settings,
          targetLanguageCode: codeOf.get(language) as string,
        })),
        segments,
        instantTranslation: true,
        eventUrl,
        referenceNumber: baseId,
      })
      .catch(async (error: unknown) => {
        // The project may have been created even though the answer never came.
        if (error instanceof TextUnitedTimeoutError && (await context.textUnited.getProject(customId))) {
          result.awaiting.push(taskId)
          return null
        }
        throw error
      })
    if (created) {
      result.responses.push(created)
      if (typeof created.id === 'number') result.project.projectId = created.id
    }
    result.created = true
  }

  if (context.capabilities?.appendSegments) {
    // Append mode: the chosen texts go out as one new task; nothing in the project is replaced.
    const segments = group.sendUnits.flatMap((unit) => unit.segments.map((segment) => ({...segment})))
    let taskId = existing ? appendTaskId(now(), newId) : 'content'
    if (!existing) {
      await create(taskId, segments)
    } else {
      try {
        const response = await context.textUnited.appendTask({customId, taskId, segments, eventUrl})
        if (response.taskId) taskId = response.taskId
        result.responses.push(response)
      } catch (error) {
        // The task may have been added even though the answer never came; if it was, its
        // translations arrive through notifications or the periodic check.
        if (!(error instanceof TextUnitedTimeoutError)) throw error
        result.awaiting.push(taskId)
      }
    }
    result.tasksSent.push(taskId)
    result.sent.push({units: group.sendUnits, taskId})
    return result
  }

  // Replace mode: each changed part of the document is its own task, sent complete.
  let tasks = group.sendPlan.tasks
  if (!existing) {
    // The create call handles formatted (HTML) segments reliably, while an update with instant
    // translation may not answer for them, so a task with formatted text goes first.
    const formatted = tasks.findIndex((task) => task.segments.some((s) => s.content.includes('data-tu-id')))
    if (formatted > 0) tasks = [tasks[formatted]!, ...tasks.filter((_, index) => index !== formatted)]
    const [first, ...rest] = tasks
    if (first) {
      await create(first.taskId, first.segments)
      result.tasksSent.push(first.taskId)
    }
    tasks = rest
  }
  for (const task of tasks) {
    try {
      result.responses.push(
        await context.textUnited.replaceTask({customId, taskId: task.taskId, segments: task.segments, eventUrl}),
      )
    } catch (error) {
      // An update stores the segments before TextUnited prepares the instant translation, so a
      // missing answer still means the task was sent; its translations arrive later.
      if (!(error instanceof TextUnitedTimeoutError)) throw error
      result.awaiting.push(task.taskId)
    }
    result.tasksSent.push(task.taskId)
  }
  result.sent.push({units: group.sendUnits})
  return result
}

function appendTaskId(date: Date, newId: () => string): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const suffix = newId().replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()
  return `update-${stamp}-${suffix}`
}

/**
 * Refuses a request whose configured TextUnited codes TextUnited does not know, before anything
 * is sent. Skipped when the language list cannot be loaded.
 */
async function assertKnownLanguageCodes(context: JobContext, languages: string[]): Promise<void> {
  const known = await context.knownLanguages?.()
  if (!known?.length) return
  const {config} = context
  const codes = [
    {label: config.sourceLanguage.title, code: config.sourceLanguage.textUnitedCode},
    ...config.targetLanguages
      .filter((language) => languages.includes(language.id))
      .map((language) => ({label: language.title, code: language.textUnitedCode})),
  ]
  const unknown = findUnknownLanguageCodes(codes, known)
  if (unknown.length === 0) return
  const details = unknown
    .map(({label, code, suggestions}) =>
      `"${code}" (${label})` + (suggestions.length ? ` – known codes: ${suggestions.join(', ')}` : ''),
    )
    .join('; ')
  throw new Error(
    `TextUnited does not know these language codes: ${details}. ` +
      'Fix textUnitedCode in the translation configuration.',
  )
}

function assertProjectLanguages(
  existing: ProjectResponse,
  languages: string[],
  codeOf: Map<string, string>,
): void {
  const inProject = new Set(
    (existing.targetLanguages ?? []).map((target) => canonicalLanguageCode(target.targetLanguageCode)),
  )
  const missing = languages.filter((language) => !inProject.has(canonicalLanguageCode(codeOf.get(language))))
  if (missing.length > 0) {
    throw new Error(
      `The TextUnited project for this document has no ${missing.join(', ')} translation. ` +
        'Adding a language to an existing project is not supported by the TextUnited API yet.',
    )
  }
}

/** Writes the instant translations to the drafts and saves the plugin's state. */
async function finishRequest(args: {
  context: JobContext
  source: PlainObject
  typeConfig: DocumentTypeConfig
  loaded: Awaited<ReturnType<typeof loadTargets>>
  languages: string[]
  units: TranslationUnit[]
  stored: StoredState
  baseId: string
  newId: () => string
  summary: JobSummary
  selectedUnits: TranslationUnit[]
  overwrite: ReadonlySet<string>
  responses: ProjectResponse[]
  sentState: TranslationState
  projects: ProjectRecord[]
  archived: ProjectRecord[]
}): Promise<JobSummary> {
  const {context, source, typeConfig, loaded, languages, units, stored, baseId, newId, summary} = args
  const {config} = context
  const createdLanguages = createMissingTranslationDocuments({
    targets: loaded.targets,
    source,
    typeConfig,
    languages,
    newId,
  })
  const applied = applyTranslations({
    units: args.selectedUnits,
    languages,
    sourceLanguage: config.sourceLanguage.id,
    sourceDocument: source,
    targets: loaded.targets,
    translations: collectInstantTranslations(args.responses, config),
    state: args.sentState,
    overwrite: args.overwrite,
  })
  summary.outcomes = countOutcomes(applied.outcomes)

  const targetMutations = writeTargetsMutations({
    loaded,
    targets: applied.targets,
    source,
    typeConfig,
    sourceLanguage: config.sourceLanguage.id,
    changedFields: applied.changedFields,
    createdLanguages,
    newId,
  })
  const touchedUnits = units.map((unit) => unit.id)
  let current = stored
  for (let attempt = 1; ; attempt += 1) {
    const state = mergeState(current.state, applied.state, touchedUnits)
    try {
      await context.store.mutate([
        ...targetMutations,
        saveStateMutation(
          baseId,
          {state, projects: args.projects, archived: args.archived, revision: current.revision},
          hasPendingTranslations(state, args.projects, isFinalStatus),
        ),
      ])
      return summary
    } catch (error) {
      // A notification saved the state meanwhile: re-read it and keep this request's units.
      if (!(error instanceof SanityConflictError) || attempt >= 3) throw error
      current = await loadState(context.store, baseId)
    }
  }
}

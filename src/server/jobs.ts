import {getDocumentTypeConfig, type DocumentTypeConfig, type TranslationConfig} from '../core/config'
import {applyTranslations, type ApplyOutcome, type TranslationsBySegment} from '../core/document/apply'
import {extractTranslationUnits, type TranslationUnit} from '../core/document/extract'
import {getIntlItem} from '../core/document/intl'
import type {PlainObject} from '../core/document/paths'
import {createProjectCustomId, getBaseDocumentId} from '../core/ids'
import {
  hasPendingTranslations,
  mergeState,
  planTranslation,
  recordBaseline,
  recordSentUnits,
  selectedSegments,
  type TranslationMode,
  type TranslationPlan,
  type TranslationState,
} from '../core/plan'
import {
  TextUnitedTimeoutError,
  type TextUnitedCapabilities,
  type TextUnitedClient,
} from '../core/textunited/client'
import type {ProjectResponse, ProjectTargetLanguage, ProjectTeamMember} from '../core/textunited/types'
import {
  createMissingTranslationDocuments,
  loadState,
  loadTargets,
  saveStateMutation,
  writeTargetsMutations,
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

function projectName(source: PlainObject, baseId: string, sourceLanguage: string): string {
  const title = documentTitle(source, sourceLanguage).replace(/\s+/g, ' ').trim()
  return title ? `${title.slice(0, 180)} (${baseId})` : baseId
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
  const plan = planTranslation({units, languages, targets: loaded.targets, state: stored.state, mode})
  const baseState = recordBaseline(stored.state, units)

  const summary: JobSummary = {
    tasksSent: plan.tasks.map((task) => task.taskId),
    unitsSelected: plan.selected.length,
    outcomes: {},
    projectCreated: false,
  }
  if (plan.tasks.length === 0) {
    try {
      const pending = hasPendingTranslations(baseState, stored.projectLanguages ?? [], isFinalStatus)
      await context.store.mutate([saveStateMutation(baseId, {...stored, state: baseState}, pending)])
    } catch (error) {
      // The baseline is only a convenience; a concurrent save already holds a newer state.
      if (!(error instanceof SanityConflictError)) throw error
    }
    return summary
  }

  const customId = createProjectCustomId({
    sanityProjectId: context.sanityProjectId,
    dataset: context.dataset,
    documentId: baseId,
  })
  const eventUrl = await context.eventUrl(baseId)
  const codeOf = new Map(config.targetLanguages.map((language) => [language.id, language.textUnitedCode]))
  const responses: ProjectResponse[] = []
  let tasks = plan.tasks
  let projectLanguages = stored.projectLanguages
  let projectType = stored.projectType
  let projectId = stored.projectId

  const awaiting: string[] = []
  const existing = await context.textUnited.getProject(customId)
  if (typeof existing?.id === 'number') projectId = existing.id
  if (context.capabilities?.appendSegments) {
    // Append mode: only the selected texts go out, as one new task, and nothing already in the
    // project is replaced. The task id is new on every request, as the API requires.
    let taskId = existing ? appendTaskId(now(), newId) : 'content'
    const segments = selectedSegments(plan)
    if (!existing) {
      const chosen = projectSettingsFor(request, context)
      projectType = chosen.projectType
      const created = await context.textUnited
        .createProject({
          customId,
          taskId,
          name: projectName(source, baseId, config.sourceLanguage.id),
          sourceLanguageCode: config.sourceLanguage.textUnitedCode,
          targetLanguages: languages.map((language) => ({
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
            awaiting.push(taskId)
            return null
          }
          throw error
        })
      if (created) {
        responses.push(created)
        if (typeof created.id === 'number') projectId = created.id
      }
      summary.projectCreated = true
      projectLanguages = languages
    } else {
      assertProjectLanguages(existing, languages, codeOf)
      projectLanguages ??= languages
      try {
        const response = await context.textUnited.appendTask({customId, taskId, segments, eventUrl})
        if (response.taskId) taskId = response.taskId
        responses.push(response)
      } catch (error) {
        // The task may have been added even though the answer never came; if it was, its
        // translations arrive through notifications or the periodic check.
        if (!(error instanceof TextUnitedTimeoutError)) throw error
        awaiting.push(taskId)
      }
    }
    summary.tasksSent = [taskId]
    if (awaiting.length > 0) summary.tasksAwaitingTranslation = awaiting
    const sentUnits = plan.selected.map(({unit}) => unit)
    return finishRequest({
      context, request, mode, plan, source, typeConfig, loaded, languages, units, stored, baseState,
      baseId, customId, projectLanguages, projectType, projectId, responses, summary, newId,
      sentState: recordSentUnits(baseState, sentUnits, now().toISOString(), taskId),
    })
  }
  if (!existing) {
    const chosen = projectSettingsFor(request, context)
    projectType = chosen.projectType
    // The create call handles formatted (HTML) segments reliably, while an update with instant
    // translation may not answer for them, so a task with formatted text goes first.
    const formatted = tasks.findIndex((task) => task.segments.some((s) => s.content.includes('data-tu-id')))
    if (formatted > 0) tasks = [tasks[formatted]!, ...tasks.filter((_, index) => index !== formatted)]
    const [first, ...rest] = tasks
    if (!first) return summary
    const created = await context.textUnited
      .createProject({
        customId,
        taskId: first.taskId,
        name: projectName(source, baseId, config.sourceLanguage.id),
        sourceLanguageCode: config.sourceLanguage.textUnitedCode,
        targetLanguages: languages.map((language) => ({
          ...chosen.settings,
          targetLanguageCode: codeOf.get(language) as string,
        })),
        segments: first.segments,
        instantTranslation: true,
        eventUrl,
        referenceNumber: baseId,
      })
      .catch(async (error: unknown) => {
        // The project may have been created even though the answer never came.
        if (error instanceof TextUnitedTimeoutError && (await context.textUnited.getProject(customId))) {
          awaiting.push(first.taskId)
          return null
        }
        throw error
      })
    if (created) {
        responses.push(created)
        if (typeof created.id === 'number') projectId = created.id
      }
    summary.projectCreated = true
    projectLanguages = languages
    tasks = rest
  } else {
    assertProjectLanguages(existing, languages, codeOf)
    projectLanguages ??= languages
  }

  for (const task of tasks) {
    try {
      responses.push(
        await context.textUnited.replaceTask({customId, taskId: task.taskId, segments: task.segments, eventUrl}),
      )
    } catch (error) {
      // An update stores the segments before TextUnited prepares the instant translation, so a
      // missing answer still means the task was sent; its translations arrive later.
      if (!(error instanceof TextUnitedTimeoutError)) throw error
      awaiting.push(task.taskId)
    }
  }
  if (awaiting.length > 0) summary.tasksAwaitingTranslation = awaiting

  return finishRequest({
    context, request, mode, plan, source, typeConfig, loaded, languages, units, stored, baseState,
    baseId, customId, projectLanguages, projectType, projectId, responses, summary, newId,
    // Every unit of a sent task was sent, since the API replaces whole tasks.
    sentState: recordSentUnits(baseState, units.filter((unit) => summary.tasksSent.includes(unit.taskId))),
  })
}

function appendTaskId(date: Date, newId: () => string): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const suffix = newId().replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()
  return `update-${stamp}-${suffix}`
}

function assertProjectLanguages(
  existing: ProjectResponse,
  languages: string[],
  codeOf: Map<string, string>,
): void {
  const inProject = new Set(
    (existing.targetLanguages ?? []).map((target) => String(target.targetLanguageCode ?? '').toLowerCase()),
  )
  const missing = languages.filter((language) => !inProject.has(String(codeOf.get(language)).toLowerCase()))
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
  request: PlainObject
  mode: TranslationMode
  plan: TranslationPlan
  source: PlainObject
  typeConfig: DocumentTypeConfig
  loaded: Awaited<ReturnType<typeof loadTargets>>
  languages: string[]
  units: TranslationUnit[]
  stored: Awaited<ReturnType<typeof loadState>>
  baseState: TranslationState
  baseId: string
  customId: string
  projectLanguages: string[] | undefined
  projectType: ProjectType | undefined
  projectId: number | undefined
  responses: ProjectResponse[]
  summary: JobSummary
  newId: () => string
  sentState: TranslationState
}): Promise<JobSummary> {
  const {context, mode, plan, source, typeConfig, loaded, languages, units, stored, baseId, customId} = args
  const {projectLanguages, projectType, projectId, responses, summary, newId} = args
  const {config} = context
  // Only the selected units take the instant (machine) translation. Other units in the same tasks
  // were resent only because the API replaces whole tasks; their translations stay as they are.
  const selectedUnits = plan.selected.map(({unit}) => unit)
  // A translation of an edited source no longer matches it, so it is replaced even if it was
  // edited by hand. In `all` mode every selected value is replaced.
  const overwrite = new Set(
    plan.selected
      .filter(({reason}) => mode === 'all' || reason === 'sourceChanged')
      .map(({unit}) => unit.id),
  )
  const createdLanguages = createMissingTranslationDocuments({
    targets: loaded.targets,
    source,
    typeConfig,
    languages,
    newId,
  })
  const applied = applyTranslations({
    units: selectedUnits,
    languages,
    sourceLanguage: config.sourceLanguage.id,
    sourceDocument: source,
    targets: loaded.targets,
    translations: collectInstantTranslations(responses, config),
    state: args.sentState,
    overwrite,
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
    const languagesNow = projectLanguages ?? []
    try {
      await context.store.mutate([
        ...targetMutations,
        saveStateMutation(
          baseId,
          {state, projectCustomId: customId, projectLanguages, projectType, projectId, revision: current.revision},
          hasPendingTranslations(state, languagesNow, isFinalStatus),
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

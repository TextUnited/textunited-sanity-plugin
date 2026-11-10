import type {TranslationUnit} from './document/extract'
import {isMissingValue, readTargetValue, type TranslationTargets} from './document/target'
import type {ProjectSegment} from './textunited/types'

/**
 * What a translation request covers. Replaces the old, misleading modes:
 * - `missing`: values with no translation in at least one selected language (absent or empty).
 * - `changed`: `missing` plus values whose source text changed since it was last sent.
 * - `all`: every value, and existing translations may be replaced.
 */
export type TranslationMode = 'missing' | 'changed' | 'all'

/** What the plugin remembers per document, between requests and notifications. */
export type TranslationState = {
  units: Record<string, UnitState>
}

export type UnitState = {
  /** Source hash at the time the unit was last sent to TextUnited */
  sourceHash: string
  /** When the unit was last sent; absent for a baseline of a value never sent */
  sentAt?: string
  /**
   * Legacy (single project): TextUnited task the unit was last sent in. Moved into `projects` by
   * `migrateLegacyState`.
   */
  taskId?: string
  /**
   * Per TextUnited project (custom id): what was last sent there. A document can have several
   * projects (languages added later get their own), and each holds its own version of the text.
   * `taskId` is the task holding the current copy, when updates add new tasks (append mode).
   */
  projects?: Record<string, SentRecord>
  /** Per Sanity language id: hash of the value the plugin last wrote, and its TextUnited status */
  languages: Record<string, {appliedHash: string; status?: string}>
}

export type SentRecord = {sourceHash: string; sentAt: string; taskId?: string}

/** What was last sent of a unit to one TextUnited project, if anything. */
export function sentRecord(record: UnitState | undefined, projectCustomId: string): SentRecord | undefined {
  return record?.projects?.[projectCustomId]
}

/**
 * States written before documents could have several projects keep the sent source and task on
 * the unit itself. They belong to the document's first project; move them there.
 */
export function migrateLegacyState(state: TranslationState, legacyProjectCustomId: string | undefined): TranslationState {
  if (!legacyProjectCustomId) return state
  let changed = false
  const units: Record<string, UnitState> = {}
  for (const [id, record] of Object.entries(state.units)) {
    if (record.sentAt && !record.projects) {
      const {taskId, ...rest} = record
      units[id] = {
        ...rest,
        projects: {
          [legacyProjectCustomId]: {sourceHash: record.sourceHash, sentAt: record.sentAt, ...(taskId ? {taskId} : {})},
        },
      }
      changed = true
    } else {
      units[id] = record
    }
  }
  return changed ? {units} : state
}

export function emptyState(): TranslationState {
  return {units: {}}
}

export type UnitSelectionReason = 'missing' | 'sourceChanged' | 'all'

export type TranslationPlan = {
  /** Units that need translation, with the reason */
  selected: Array<{unit: TranslationUnit; reason: UnitSelectionReason}>
  /**
   * Tasks to send when the API replaces whole tasks: each part of the document with a selected
   * unit goes out complete. In append mode only `selectedSegments` is sent.
   */
  tasks: Array<{taskId: string; segments: ProjectSegment[]}>
}

/** Segments of the selected units only, for an update that adds them as a new task. */
export function selectedSegments(plan: TranslationPlan): ProjectSegment[] {
  return plan.selected.flatMap(({unit}) => unit.segments.map((segment) => ({...segment})))
}

function selectionReason(
  unit: TranslationUnit,
  languages: string[],
  targets: TranslationTargets,
  state: TranslationState,
  mode: TranslationMode,
  projectCustomId?: string,
): UnitSelectionReason | null {
  if (mode === 'all') return 'all'
  if (languages.some((language) => isMissingValue(unit, readTargetValue(unit, language, targets)))) {
    return 'missing'
  }
  // Without a record the unit was never sent by this plugin (e.g. translated by hand or by an
  // older mechanism), so there is nothing to compare: it is not treated as changed.
  // With a project, the text sent to that project counts; otherwise the last one sent anywhere.
  const record = state.units[unit.id]
  const sentHash = (projectCustomId ? sentRecord(record, projectCustomId)?.sourceHash : undefined) ?? record?.sourceHash
  if (mode === 'changed' && sentHash !== undefined && sentHash !== unit.sourceHash) return 'sourceChanged'
  return null
}

/**
 * Decides what to send to TextUnited. Returns no tasks when nothing needs translation, in which
 * case no project is created or updated.
 */
export function planTranslation(args: {
  units: TranslationUnit[]
  languages: string[]
  targets: TranslationTargets
  state: TranslationState
  mode: TranslationMode
  /** The TextUnited project the languages belong to; "changed" compares with what it was sent */
  projectCustomId?: string
}): TranslationPlan {
  const selected: TranslationPlan['selected'] = []
  for (const unit of args.units) {
    const reason = selectionReason(unit, args.languages, args.targets, args.state, args.mode, args.projectCustomId)
    if (reason) selected.push({unit, reason})
  }

  const taskIds = new Set(selected.map(({unit}) => unit.taskId))
  const tasks = [...taskIds].map((taskId) => ({
    taskId,
    segments: args.units
      .filter((unit) => unit.taskId === taskId)
      .flatMap((unit) => unit.segments.map((segment) => ({...segment, taskId}))),
  }))

  return {selected, tasks}
}

/**
 * Remembers the current source of units the plugin has no record of yet (for example values
 * translated by hand before the plugin was installed). Without this baseline a later edit of
 * their source could not be noticed by the `changed` mode.
 */
export function recordBaseline(state: TranslationState, units: TranslationUnit[]): TranslationState {
  const next: TranslationState = {units: {...state.units}}
  for (const unit of units) {
    next.units[unit.id] ??= {sourceHash: unit.sourceHash, languages: {}}
  }
  return next
}

/**
 * Records the source of the units that were just sent. With a project, the record is kept per
 * project (with the task holding the copy, in append mode); the unit-level hash is the latest sent.
 */
export function recordSentUnits(
  state: TranslationState,
  units: TranslationUnit[],
  sentAt = new Date().toISOString(),
  taskId?: string,
  projectCustomId?: string,
): TranslationState {
  const next: TranslationState = {units: {...state.units}}
  for (const unit of units) {
    const previous = next.units[unit.id]
    if (projectCustomId) {
      next.units[unit.id] = {
        sourceHash: unit.sourceHash,
        sentAt,
        projects: {
          ...previous?.projects,
          [projectCustomId]: {sourceHash: unit.sourceHash, sentAt, ...(taskId ? {taskId} : {})},
        },
        languages: previous?.languages ?? {},
      }
    } else {
      next.units[unit.id] = {
        sourceHash: unit.sourceHash,
        sentAt,
        ...(taskId ? {taskId} : {}),
        languages: previous?.languages ?? {},
      }
    }
  }
  return next
}

/** Copies the records of the given units from `changes` over `base`. */
export function mergeState(
  base: TranslationState,
  changes: TranslationState,
  unitIds: Iterable<string>,
): TranslationState {
  const next: TranslationState = {units: {...base.units}}
  for (const id of unitIds) {
    const record = changes.units[id]
    if (record) next.units[id] = record
  }
  return next
}

/**
 * True while TextUnited may still change a sent translation: some unit sent to a project has, in
 * one of that project's languages, no translation yet or one that is not final.
 */
export function hasPendingTranslations(
  state: TranslationState,
  projects: Array<{customId: string; languages: string[]}>,
  isFinal: (status: string | undefined) => boolean,
): boolean {
  return Object.values(state.units).some((record) =>
    projects.some(
      (project) =>
        sentRecord(record, project.customId) !== undefined &&
        project.languages.some((language) => !isFinal(record.languages[language]?.status)),
    ),
  )
}

import {getDocumentTypeConfig} from '../core/config'
import {applyTranslations} from '../core/document/apply'
import {extractTranslationUnits} from '../core/document/extract'
import {hasPendingTranslations} from '../core/plan'
import {
  createMissingTranslationDocuments,
  loadState,
  loadTargets,
  saveStateMutation,
  writeTargetsMutations,
} from './documents'
import {countOutcomes, type JobContext, type JobSummary} from './jobs'
import {getPreferredDocument, SanityConflictError} from './sanityStore'
import {isFinalStatus, toTranslationsBySegment} from './translations'

export type SyncResult =
  | {status: 'ignored'; reason: string}
  | {
      status: 'synced'
      outcomes: JobSummary['outcomes']
      /** Units whose source was edited after it was sent; they wait for a new request */
      sourceChanged: number
      pending: boolean
    }

const MAX_ATTEMPTS = 3

/**
 * Fetches the current translations of one document from TextUnited and writes them to Sanity.
 * Called for every TextUnited notification and by the periodic check, so it must be idempotent:
 * it always starts from what TextUnited and Sanity hold now.
 */
export async function syncDocument(baseId: string, context: JobContext): Promise<SyncResult> {
  const newId = context.newId ?? (() => crypto.randomUUID())

  for (let attempt = 1; ; attempt += 1) {
    const stored = await loadState(context.store, baseId)
    if (!stored.projectCustomId) return {status: 'ignored', reason: 'No TextUnited project for this document'}
    const languages = stored.projectLanguages ?? []

    const source = await getPreferredDocument(context.store, baseId)
    if (!source) return {status: 'ignored', reason: 'Document not found'}
    const typeConfig = getDocumentTypeConfig(context.config, String(source._type))
    if (!typeConfig) return {status: 'ignored', reason: 'Document type is not configured'}

    const units = extractTranslationUnits(source, typeConfig, context.config)
    // In append mode a segment may be in several tasks; read it from the task it was last sent in.
    const taskOf = new Map<string, string>()
    for (const unit of units) {
      const taskId = stored.state.units[unit.id]?.taskId
      if (taskId) for (const segment of unit.segments) taskOf.set(segment.customId, taskId)
    }
    const translations = toTranslationsBySegment(
      await context.textUnited.getSegments(stored.projectCustomId),
      context.config,
      taskOf,
    )

    // A translation in TextUnited belongs to the source that was sent. If the source was edited
    // since, the translation no longer fits; it waits for the next translation request.
    let sourceChanged = 0
    const eligible = units.filter((unit) => {
      const record = stored.state.units[unit.id]
      if (!record?.sentAt) return false
      if (record.sourceHash !== unit.sourceHash) {
        sourceChanged += 1
        return false
      }
      return unit.segments.every((segment) => translations.has(segment.customId))
    })

    const loaded = await loadTargets({store: context.store, source, typeConfig, languages})
    const createdLanguages = createMissingTranslationDocuments({
      targets: loaded.targets,
      source,
      typeConfig,
      languages,
      newId,
    })
    const applied = applyTranslations({
      units: eligible,
      languages,
      sourceLanguage: context.config.sourceLanguage.id,
      sourceDocument: source,
      targets: loaded.targets,
      translations,
      state: stored.state,
    })
    const pending = hasPendingTranslations(applied.state, languages, isFinalStatus)

    try {
      await context.store.mutate([
        ...writeTargetsMutations({
          loaded,
          targets: applied.targets,
          source,
          typeConfig,
          sourceLanguage: context.config.sourceLanguage.id,
          changedFields: applied.changedFields,
          createdLanguages,
          newId,
        }),
        saveStateMutation(baseId, {...stored, state: applied.state}, pending),
      ])
      return {status: 'synced', outcomes: countOutcomes(applied.outcomes), sourceChanged, pending}
    } catch (error) {
      // Another notification for the same document was saved first: start again from it.
      if (!(error instanceof SanityConflictError) || attempt >= MAX_ATTEMPTS) throw error
    }
  }
}

/** Periodic check: syncs documents that may still receive translations, oldest first. */
export async function syncPendingDocuments(
  context: JobContext,
  limit = 20,
): Promise<Array<{documentId: string; result: SyncResult | {status: 'failed'; error: string}}>> {
  const results = []
  for (const documentId of await context.store.listPendingDocuments(limit)) {
    try {
      results.push({documentId, result: await syncDocument(documentId, context)})
    } catch (error) {
      results.push({
        documentId,
        result: {status: 'failed' as const, error: error instanceof Error ? error.message : 'Sync failed'},
      })
    }
  }
  return results
}

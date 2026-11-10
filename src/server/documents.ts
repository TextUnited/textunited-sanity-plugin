import type {DocumentTypeConfig} from '../core/config'
import {cloneValue, isPlainObject, type PlainObject} from '../core/document/paths'
import {slugify} from '../core/document/slug'
import type {TranslationTargets} from '../core/document/target'
import {getBaseDocumentId} from '../core/ids'
import {emptyState, migrateLegacyState, type TranslationState} from '../core/plan'
import {activeProjects, projectLanguages, readProjects, type ProjectRecord} from '../core/projects'
import {getPreferredDocument, type Mutation, type SanityStore} from './sanityStore'

/** Types of the documents this package keeps in Sanity. Their ids contain a dot, so they are private. */
export const REQUEST_TYPE = 'textunited.translationRequest'
export const STATE_TYPE = 'textunited.translationState'

export function stateDocumentId(baseDocumentId: string): string {
  return `textunited.state.${baseDocumentId}`
}

const SYSTEM_FIELDS = ['_id', '_rev', '_createdAt', '_updatedAt']

function withoutSystemFields(document: PlainObject): PlainObject {
  const copy = cloneValue(document)
  for (const field of SYSTEM_FIELDS) delete copy[field]
  return copy
}

export type StoredState = {
  state: TranslationState
  /** The document's TextUnited projects; each language belongs to one of them */
  projects: ProjectRecord[]
  /** Projects replaced by a reset; kept for reference */
  archived: ProjectRecord[]
  /** Languages stopped by an editor for this document */
  stopped: string[]
  /** Revision of the state document when it was read; absent when it does not exist yet */
  revision?: string
}

export async function loadState(store: SanityStore, baseDocumentId: string): Promise<StoredState> {
  const document = await store.getDocument(stateDocumentId(baseDocumentId))
  if (!document) return {state: emptyState(), projects: [], archived: [], stopped: []}
  const revision = typeof document._rev === 'string' ? document._rev : undefined
  let state = emptyState()
  try {
    if (typeof document.stateJson === 'string') state = JSON.parse(document.stateJson) as TranslationState
  } catch {
    // A damaged state only means translations are treated as not written by the plugin.
  }
  const {projects, archived, stopped} = readProjects(document)
  // States from before several projects keep what was sent on the unit: it belongs to the first.
  if (typeof document.projectsJson !== 'string') state = migrateLegacyState(state, projects[0]?.customId)
  return {state, revision, projects, archived, stopped}
}

/**
 * Saves the state, but only if nobody saved it since it was read (TextUnited may send several
 * notifications at once). A conflict surfaces as SanityConflictError; the caller re-reads and
 * retries. The single-project fields are kept too, for readers of the older format.
 */
export function saveStateMutation(
  baseDocumentId: string,
  stored: StoredState,
  pending: boolean,
): Mutation {
  const first = stored.projects[0]
  const fields = {
    documentId: baseDocumentId,
    projectsJson: JSON.stringify({projects: stored.projects, archived: stored.archived, stopped: stored.stopped}),
    projectCustomId: first?.customId,
    projectLanguages: projectLanguages(activeProjects(stored.projects, stored.stopped)),
    projectType: first?.projectType,
    projectId: first?.projectId,
    stateJson: JSON.stringify(stored.state),
    pending,
    updatedAt: new Date().toISOString(),
  }
  const id = stateDocumentId(baseDocumentId)
  if (stored.revision) return {patch: {id, ifRevisionID: stored.revision, set: fields}}
  return {create: {_id: id, _type: STATE_TYPE, ...fields}}
}

/** Ids of the existing translations of a documentLevel document, per language. */
async function translationDocumentIds(
  store: SanityStore,
  baseDocumentId: string,
): Promise<{metadata: PlainObject | null; ids: Record<string, string>}> {
  const metadata = await store.findTranslationMetadata(baseDocumentId)
  const ids: Record<string, string> = {}
  const translations = Array.isArray(metadata?.translations) ? metadata.translations : []
  for (const entry of translations) {
    if (!isPlainObject(entry) || typeof entry._key !== 'string') continue
    const value = entry.value
    if (isPlainObject(value) && typeof value._ref === 'string') ids[entry._key] = value._ref
  }
  return {metadata, ids}
}

export type LoadedTargets = {
  targets: TranslationTargets
  /** documentLevel: translation metadata, to be updated when new documents are created */
  metadata: PlainObject | null
}

export async function loadTargets(args: {
  store: SanityStore
  source: PlainObject
  typeConfig: DocumentTypeConfig
  languages: string[]
}): Promise<LoadedTargets> {
  if (args.typeConfig.model === 'fieldLevel') {
    return {targets: {model: 'fieldLevel', document: cloneValue(args.source)}, metadata: null}
  }
  const baseId = getBaseDocumentId(String(args.source._id))
  const {metadata, ids} = await translationDocumentIds(args.store, baseId)
  const documents: Record<string, PlainObject | undefined> = {}
  for (const language of args.languages) {
    const id = ids[language]
    documents[language] = id ? ((await getPreferredDocument(args.store, id)) ?? undefined) : undefined
  }
  return {targets: {model: 'documentLevel', documents}, metadata}
}

/**
 * Creates in-memory documentLevel translations for languages that have none yet: a copy of the
 * source without the translated fields, with a new id and the target language. Returns the
 * languages that got a new document.
 */
export function createMissingTranslationDocuments(args: {
  targets: TranslationTargets
  source: PlainObject
  typeConfig: DocumentTypeConfig
  languages: string[]
  newId: () => string
}): string[] {
  if (args.targets.model !== 'documentLevel') return []
  const created: string[] = []
  const languageField = args.typeConfig.languageField ?? 'language'
  for (const language of args.languages) {
    if (args.targets.documents[language]) continue
    const copy = withoutSystemFields(args.source)
    for (const field of args.typeConfig.fields ?? []) delete copy[field]
    delete copy.slug
    copy._id = `drafts.${args.newId()}`
    copy[languageField] = language
    args.targets.documents[language] = copy
    created.push(language)
  }
  return created
}

function translationReference(language: string, documentId: string, type: string): PlainObject {
  return {
    _key: language,
    _type: 'internationalizedArrayReferenceValue',
    value: {
      _type: 'reference',
      _ref: getBaseDocumentId(documentId),
      _weak: true,
      _strengthenOnPublish: {type},
    },
  }
}

/** Mutations that save the changed translations as drafts. */
export function writeTargetsMutations(args: {
  loaded: LoadedTargets
  targets: TranslationTargets
  source: PlainObject
  typeConfig: DocumentTypeConfig
  sourceLanguage: string
  changedFields: Map<string, Set<string>>
  createdLanguages: string[]
  newId: () => string
}): Mutation[] {
  const mutations: Mutation[] = []

  const saveDraft = (document: PlainObject, fields: Set<string>, isNew: boolean) => {
    const id = String(document._id)
    const draftId = id.startsWith('drafts.') ? id : `drafts.${id}`
    if (isNew || !id.startsWith('drafts.')) {
      // No draft yet: the draft starts as the full current document.
      mutations.push({createOrReplace: {...withoutSystemFields(document), _id: draftId}})
      return
    }
    const set: PlainObject = {}
    for (const field of fields) set[field] = document[field]
    mutations.push({patch: {id: draftId, set}})
  }

  if (args.targets.model === 'fieldLevel') {
    const fields = args.changedFields.get('')
    if (fields?.size) saveDraft(args.targets.document, fields, false)
    return mutations
  }

  for (const [language, changed] of args.changedFields) {
    let fields = changed
    const document = args.targets.documents[language]
    if (!document) continue
    const isNew = args.createdLanguages.includes(language)
    // A new translation, or one created empty in the Studio (e.g. from the Translations menu),
    // gets a slug from its translated title.
    const slug = document.slug as {current?: unknown} | null | undefined
    if (isNew || !slug || typeof slug.current !== 'string' || slug.current === '') {
      const titleField = (args.typeConfig.fields ?? ['title']).find((field) => typeof document[field] === 'string')
      const title = titleField ? String(document[titleField]) : ''
      if (title) {
        document.slug = {_type: 'slug', current: slugify(title)}
        fields = new Set([...fields, 'slug'])
      }
    }
    saveDraft(document, fields, isNew)
  }

  const createdIds = args.createdLanguages
    .filter((language) => args.changedFields.has(language))
    .map((language) => [language, String(args.targets.model === 'documentLevel' ? args.targets.documents[language]?._id : '')] as const)
  if (createdIds.length === 0) return mutations

  const type = String(args.source._type)
  const sourceRef = translationReference(args.sourceLanguage, String(args.source._id), type)
  const newRefs = createdIds.map(([language, id]) => translationReference(language, id, type))
  const existing = args.loaded.metadata
  if (!existing) {
    mutations.push({
      create: {
        _id: `translation.metadata.${args.newId()}`,
        _type: 'translation.metadata',
        schemaTypes: [type],
        translations: [sourceRef, ...newRefs],
      },
    })
  } else {
    // A language whose translation was deleted still has its entry, pointing to the deleted
    // document; the new document takes its place.
    const replaced = new Set(newRefs.map((ref) => ref._key))
    const kept = (Array.isArray(existing.translations) ? existing.translations : []).filter(
      (entry) => !(isPlainObject(entry) && replaced.has(String(entry._key))),
    )
    const keys = new Set(kept.map((entry) => (isPlainObject(entry) ? entry._key : undefined)))
    const additions = [sourceRef, ...newRefs].filter((ref) => !keys.has(ref._key))
    mutations.push({patch: {id: String(existing._id), set: {translations: [...kept, ...additions]}}})
  }
  return mutations
}

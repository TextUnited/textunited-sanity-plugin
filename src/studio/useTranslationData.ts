import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useClient, useEditState} from 'sanity'

import {getDocumentTypeConfig} from '../core/config'
import {extractTranslationUnits, type TranslationUnit} from '../core/document/extract'
import type {PlainObject} from '../core/document/paths'
import type {TranslationTargets} from '../core/document/target'
import {getBaseDocumentId} from '../core/ids'
import type {TranslationState} from '../core/plan'
import type {ProjectRecord} from '../core/projects'
import {loadTargets} from '../server/documents'
import type {SanityStore} from '../server/sanityStore'
import {readTranslationState, type TranslationStatusData} from './logic'
import type {TextUnitedStudioOptions} from './options'

const API_VERSION = '2025-02-19'

export type RequestRecord = NonNullable<TranslationStatusData['lastRequest']>

export type TranslationData = {
  loading: boolean
  error: string | null
  state: TranslationStatusData['state']
  translationState: TranslationState
  /** The document's TextUnited projects, and the ones a reset replaced */
  projects: ProjectRecord[]
  archived: ProjectRecord[]
  requests: RequestRecord[]
  source: PlainObject | null
  units: TranslationUnit[]
  targets: TranslationTargets | null
  refresh: () => void
}

const STATUS_QUERY = `{
  "state": *[_id == $stateId][0]{projectCustomId, projectLanguages, projectType, projectId, projectsJson, stateJson, pending, updatedAt},
  "requests": *[_type == "textunited.translationRequest" && documentId == $documentId]
    | order(_createdAt desc)[0...5]{_id, _createdAt, status, error, summaryJson, languages, mode}
}`


/**
 * Everything the translation panel shows for one document, kept up to date: the plugin's state
 * and recent requests (refetched when they change) and the document itself (live from the form).
 */
export function useTranslationData(
  documentId: string,
  documentType: string,
  options: TextUnitedStudioOptions,
): TranslationData {
  const baseId = getBaseDocumentId(documentId)
  const client = useClient({apiVersion: API_VERSION})
  const editState = useEditState(baseId, documentType)
  const source = (editState.draft ?? editState.published ?? null) as PlainObject | null
  const typeConfig = getDocumentTypeConfig(options.translation, documentType)

  const [status, setStatus] = useState<{state: TranslationStatusData['state']; requests: RequestRecord[]} | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [documentLevelTargets, setDocumentLevelTargets] = useState<TranslationTargets | null>(null)
  const mounted = useRef(true)

  const loadStatus = useCallback(async () => {
    try {
      const data = await client.fetch<{state: TranslationStatusData['state']; requests: RequestRecord[]}>(
        STATUS_QUERY,
        {documentId: baseId, stateId: `textunited.state.${baseId}`},
        {perspective: 'raw'},
      )
      if (mounted.current) {
        setStatus(data)
        setError(null)
      }
    } catch (loadError) {
      if (mounted.current) setError(loadError instanceof Error ? loadError.message : 'Could not load the status')
    }
  }, [client, baseId])

  const languages = useMemo(
    () => options.translation.targetLanguages.map((language) => language.id),
    [options.translation],
  )

  // documentLevel translations live in other documents; fieldLevel ones are in the source.
  const loadDocumentLevelTargets = useCallback(async () => {
    if (!source || typeConfig?.model !== 'documentLevel') return
    const store: SanityStore = {
      getDocument: (id) => client.fetch('*[_id == $id][0]', {id}, {perspective: 'raw'}),
      findTranslationMetadata: (id) =>
        client.fetch('*[_type == "translation.metadata" && $id in translations[].value._ref][0]', {id}, {
          perspective: 'raw',
        }),
      mutate: () => Promise.reject(new Error('read only')),
      listPendingDocuments: () => Promise.resolve([]),
    }
    try {
      const loaded = await loadTargets({store, source, typeConfig, languages})
      if (mounted.current) setDocumentLevelTargets(loaded.targets)
    } catch (loadError) {
      if (mounted.current) setError(loadError instanceof Error ? loadError.message : 'Could not load translations')
    }
    // The translations change through requests and notifications, which refresh() follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, typeConfig, languages, source?._id])

  const refresh = useCallback(() => {
    void loadStatus()
    void loadDocumentLevelTargets()
  }, [loadStatus, loadDocumentLevelTargets])

  useEffect(() => {
    mounted.current = true
    refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  // Follow the state document and the document's requests while the panel is open.
  useEffect(() => {
    const subscription = client
      .listen(
        '*[(_id == $stateId) || (_type == "textunited.translationRequest" && documentId == $documentId)]',
        {documentId: baseId, stateId: `textunited.state.${baseId}`},
        {visibility: 'query', includeResult: false},
      )
      .subscribe({next: () => refresh(), error: () => undefined})
    return () => subscription.unsubscribe()
  }, [client, baseId, refresh])

  const units = useMemo(
    () => (source && typeConfig ? extractTranslationUnits(source, typeConfig, options.translation) : []),
    [source, typeConfig, options.translation],
  )
  const targets: TranslationTargets | null =
    typeConfig?.model === 'fieldLevel' && source
      ? {model: 'fieldLevel', document: source}
      : documentLevelTargets

  const read = useMemo(() => readTranslationState(status?.state ?? null), [status?.state])
  return {
    loading: !status && !error,
    error,
    state: status?.state ?? null,
    translationState: read.state,
    projects: read.projects,
    archived: read.archived,
    requests: status?.requests ?? [],
    source,
    units,
    targets,
    refresh,
  }
}

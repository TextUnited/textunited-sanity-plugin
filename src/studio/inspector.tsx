import {useEffect, useMemo, useState} from 'react'
import {
  defineDocumentInspector,
  useClient,
  type DocumentBadgeComponent,
  type DocumentInspector,
} from 'sanity'

import {getBaseDocumentId} from '../core/ids'
import {languageProgress} from './logic'
import type {TextUnitedStudioOptions} from './options'
import {badgeLabel} from './summary'
import {TextUnitedIcon} from './TextUnitedIcon'
import {TranslationPanel} from './TranslationPanel'

export const INSPECTOR_NAME = 'textunited-translation'
const API_VERSION = '2025-02-19'

type StateSummary = {projectLanguages?: string[]; stateJson?: string} | null

/** The plugin's state of one document, followed live. */
function useStateSummary(documentId: string): StateSummary {
  const client = useClient({apiVersion: API_VERSION})
  const stateId = `textunited.state.${getBaseDocumentId(documentId)}`
  const [state, setState] = useState<StateSummary>(null)
  useEffect(() => {
    let active = true
    const load = () =>
      client
        .fetch<StateSummary>('*[_id == $id][0]{projectLanguages, stateJson}', {id: stateId}, {perspective: 'raw'})
        .then((value) => active && setState(value))
        .catch(() => undefined)
    void load()
    const subscription = client
      .listen('*[_id == $id]', {id: stateId}, {visibility: 'query', includeResult: false})
      .subscribe({next: () => void load(), error: () => undefined})
    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [client, stateId])
  return state
}

/** The TextUnited panel next to the document, opened from the pane header or the action. */
export function createTranslationInspector(options: TextUnitedStudioOptions): DocumentInspector {
  return defineDocumentInspector({
    name: INSPECTOR_NAME,
    useMenuItem: () => ({
      icon: TextUnitedIcon,
      title: 'TextUnited',
      showAsAction: true,
    }),
    component: (props) => (
      <TranslationPanel
        documentId={props.documentId}
        documentType={props.documentType}
        options={options}
        onClose={props.onClose}
      />
    ),
  })
}

/** Badge in the document header with the review progress per language, e.g. "DE 5/7 · PL 7/7". */
export function createTranslationBadge(): DocumentBadgeComponent {
  const TranslationBadge: DocumentBadgeComponent = (props) => {
    const state = useStateSummary(props.id)
    const badge = useMemo(() => {
      if (!state?.projectLanguages?.length) return null
      return badgeLabel(languageProgress(state.stateJson, state.projectLanguages), state.projectLanguages)
    }, [state])
    if (!badge) return null
    return {
      label: badge.label,
      title: 'Texts reviewed by translators in TextUnited, per language',
      color: badge.complete ? 'success' : 'warning',
    }
  }
  return TranslationBadge
}

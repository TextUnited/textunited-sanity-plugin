import {TranslateIcon} from '@sanity/icons'
import {useState} from 'react'
import type {DocumentActionComponent} from 'sanity'
import {useDocumentPane} from 'sanity/structure'

import {INSPECTOR_NAME} from './inspector'
import {canTranslateDocument} from './logic'
import type {TextUnitedStudioOptions} from './options'
import {TranslationPanel} from './TranslationPanel'

/** The document pane, or null where actions render outside one (e.g. in other tools). */
function useOptionalDocumentPane(): ReturnType<typeof useDocumentPane> | null {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDocumentPane()
  } catch {
    return null
  }
}

/**
 * "Translate" in the document actions menu. Opens the Translation panel next to the document,
 * or the same panel in a dialog where there is no document pane.
 */
export function createTranslateAction(options: TextUnitedStudioOptions): DocumentActionComponent {
  const TranslateAction: DocumentActionComponent = (props) => {
    const [open, setOpen] = useState(false)
    const pane = useOptionalDocumentPane()
    const document = (props.draft ?? props.published) as Record<string, unknown> | null
    const check = canTranslateDocument(options.translation, props.type, document)

    return {
      label: 'Translate',
      icon: TranslateIcon,
      disabled: !check.allowed,
      title: check.reason,
      onHandle: () => {
        if (pane) pane.openInspector(INSPECTOR_NAME)
        else setOpen(true)
        props.onComplete()
      },
      dialog:
        open && !pane
          ? {
              type: 'dialog',
              header: 'Translate with TextUnited',
              width: 'small',
              onClose: () => setOpen(false),
              content: <TranslationPanel documentId={props.id} documentType={props.type} options={options} />,
            }
          : null,
    }
  }
  TranslateAction.displayName = 'TextUnitedTranslateAction'
  return TranslateAction
}

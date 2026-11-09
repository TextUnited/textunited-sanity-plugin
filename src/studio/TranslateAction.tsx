import {TranslateIcon} from '@sanity/icons'
import {useState} from 'react'
import type {DocumentActionComponent} from 'sanity'

import {canTranslateDocument} from './logic'
import type {TextUnitedStudioOptions} from './options'
import {TranslateDialog} from './TranslateDialog'

export function createTranslateAction(options: TextUnitedStudioOptions): DocumentActionComponent {
  const TranslateAction: DocumentActionComponent = (props) => {
    const [open, setOpen] = useState(false)
    const document = (props.draft ?? props.published) as Record<string, unknown> | null
    const check = canTranslateDocument(options.translation, props.type, document)

    return {
      label: 'Translate',
      icon: TranslateIcon,
      disabled: !check.allowed,
      title: check.reason,
      onHandle: () => setOpen(true),
      dialog: open
        ? {
            type: 'dialog',
            header: 'Translate with TextUnited',
            width: 'medium',
            onClose: () => setOpen(false),
            content: <TranslateDialog documentId={props.id} options={options} />,
          }
        : null,
    }
  }
  TranslateAction.displayName = 'TextUnitedTranslateAction'
  return TranslateAction
}

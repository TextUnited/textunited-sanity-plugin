import {definePlugin} from 'sanity'

import type {TextUnitedStudioOptions} from './options'
import {createTranslationBadge, createTranslationInspector} from './inspector'
import {createTranslateAction} from './TranslateAction'

export type {TranslationConfig, DocumentTypeConfig, TranslationLanguage} from '../core/config'
export type {TextUnitedStudioOptions} from './options'

/**
 * Sanity Studio plugin: adds a "Translate" action to the configured document types. The action
 * shows the TextUnited status of the document and sends translation requests to the server
 * handler (`@textunited/sanity-plugin/server` or `/next`).
 */
export const textUnitedTranslations = definePlugin<TextUnitedStudioOptions>((options) => {
  if (!options?.handlerUrl) {
    throw new Error('textUnitedTranslations: the handlerUrl option is required')
  }
  if (!options.translation?.targetLanguages?.length) {
    throw new Error('textUnitedTranslations: configure at least one target language')
  }

  const types = new Set(options.translation.documentTypes.map((entry) => entry.type))
  const TranslateAction = createTranslateAction(options)
  const TranslationBadge = createTranslationBadge()
  const translationInspector = createTranslationInspector(options)

  return {
    name: '@textunited/sanity-plugin',
    document: {
      actions: (previous, context) =>
        types.has(context.schemaType) ? [...previous, TranslateAction] : previous,
      badges: (previous, context) =>
        types.has(context.schemaType) ? [...previous, TranslationBadge] : previous,
      inspectors: (previous, context) =>
        types.has(context.documentType) ? [...previous, translationInspector] : previous,
    },
  }
})

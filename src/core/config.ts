/**
 * Settings shared by the Studio plugin and the server handler. Both sides must agree on these,
 * so the recommended setup keeps them in one module that the Studio config and the server
 * route both import.
 */
export type TranslationLanguage = {
  /** Language id used in Sanity, e.g. `de` */
  id: string
  /** Label shown to editors, e.g. `German` */
  title: string
  /** TextUnited language code, e.g. `de-de` */
  textUnitedCode: string
}

/**
 * How a document type stores its translations in Sanity.
 * - `fieldLevel`: one document; each translatable field is an internationalized array
 *   (sanity-plugin-internationalized-array) holding one value per language.
 * - `documentLevel`: one document per language, linked by translation metadata
 *   (@sanity/document-internationalization).
 */
export type LocalizationModel = 'fieldLevel' | 'documentLevel'

export type DocumentTypeConfig = {
  type: string
  model: LocalizationModel
  /**
   * Top-level fields to translate. Recommended for `documentLevel`, where every string is
   * otherwise a candidate. When omitted, all fields are scanned.
   */
  fields?: string[]
  /** Field names never translated, at any depth, in addition to the built-in list */
  skipFields?: string[]
  /** `documentLevel` only: field holding the document's language. Defaults to `language`. */
  languageField?: string
}

export type TranslationConfig = {
  sourceLanguage: TranslationLanguage
  targetLanguages: TranslationLanguage[]
  documentTypes: DocumentTypeConfig[]
  /** Portable Text block types copied as they are, never translated (e.g. code, tables) */
  skipBlockTypes?: string[]
}

/** Field names that never hold translatable text. */
export const BUILT_IN_SKIP_FIELDS: ReadonlySet<string> = new Set([
  'language',
  'slug',
  'current',
  'href',
  'url',
  'link',
  'asset',
  'crop',
  'hotspot',
  'markDefs',
  'style',
  'listItem',
  'level',
])

export function getDocumentTypeConfig(
  config: TranslationConfig,
  documentType: string,
): DocumentTypeConfig | undefined {
  return config.documentTypes.find((entry) => entry.type === documentType)
}

import type {PlainObject} from '../core/document/paths'

export type Mutation =
  | {create: PlainObject}
  | {createOrReplace: PlainObject}
  | {createIfNotExists: PlainObject}
  | {delete: {id: string}}
  | {
      patch: {
        id: string
        set?: PlainObject
        setIfMissing?: PlainObject
        ifRevisionID?: string
      }
    }

/**
 * The few Sanity operations the server needs. The HTTP implementation below talks to the Sanity
 * API directly; tests use an in-memory implementation.
 */
export interface SanityStore {
  /** Exact document by id (`drafts.` ids included), or null */
  getDocument(id: string): Promise<PlainObject | null>
  /** Translation metadata (@sanity/document-internationalization) that references the document */
  findTranslationMetadata(baseDocumentId: string): Promise<PlainObject | null>
  /** Applies mutations in one transaction */
  mutate(mutations: Mutation[]): Promise<void>
  /** Ids of source documents whose translations TextUnited may still change, oldest check first */
  listPendingDocuments(limit: number): Promise<string[]>
}

export class SanityConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SanityConflictError'
  }
}

export type HttpSanityStoreOptions = {
  projectId: string
  dataset: string
  token: string
  apiVersion?: string
  fetch?: typeof fetch
}

export class HttpSanityStore implements SanityStore {
  private readonly base: string
  private readonly dataset: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: HttpSanityStoreOptions) {
    const apiVersion = options.apiVersion ?? '2025-02-19'
    this.base = `https://${options.projectId}.api.sanity.io/v${apiVersion}/data`
    this.dataset = options.dataset
    this.token = options.token
    this.fetchImpl = options.fetch ?? fetch
  }

  private async query<T>(query: string, params: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.base}/query/${this.dataset}?perspective=raw`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({query, params}),
    })
    if (!response.ok) {
      throw new Error(`Sanity query failed with status ${response.status}: ${await response.text()}`)
    }
    return ((await response.json()) as {result: T}).result
  }

  getDocument(id: string): Promise<PlainObject | null> {
    return this.query<PlainObject | null>('*[_id == $id][0]', {id})
  }

  findTranslationMetadata(baseDocumentId: string): Promise<PlainObject | null> {
    return this.query<PlainObject | null>(
      '*[_type == "translation.metadata" && $id in translations[].value._ref][0]',
      {id: baseDocumentId},
    )
  }

  listPendingDocuments(limit: number): Promise<string[]> {
    return this.query<string[]>(
      '*[_type == "textunited.translationState" && pending == true] | order(updatedAt asc) [0...$limit].documentId',
      {limit},
    )
  }

  async mutate(mutations: Mutation[]): Promise<void> {
    if (mutations.length === 0) return
    const response = await this.fetchImpl(
      `${this.base}/mutate/${this.dataset}?visibility=sync`,
      {
        method: 'POST',
        headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({mutations}),
      },
    )
    if (response.status === 409) {
      throw new SanityConflictError(await response.text())
    }
    if (!response.ok) {
      throw new Error(`Sanity mutation failed with status ${response.status}: ${await response.text()}`)
    }
  }
}

/** Draft if it exists, otherwise the published document. */
export async function getPreferredDocument(
  store: SanityStore,
  baseDocumentId: string,
): Promise<PlainObject | null> {
  const draft = await store.getDocument(`drafts.${baseDocumentId}`)
  return draft ?? store.getDocument(baseDocumentId)
}

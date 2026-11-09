import type {TranslationConfig} from '../core/config'
import {
  DEFAULT_CAPABILITIES,
  TextUnitedClient,
  type TextUnitedAuth,
  type TextUnitedCapabilities,
} from '../core/textunited/client'
import {
  DEFAULT_IN_HOUSE_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  processTranslationRequest,
  type ProjectSettings,
} from './jobs'
import {HttpSanityStore, type SanityStore} from './sanityStore'
import {signDocumentId, verifyDocumentSignature, verifySanityWebhookSignature} from './signing'
import {syncDocument, syncPendingDocuments} from './sync'

export type {TranslationConfig, DocumentTypeConfig, TranslationLanguage} from '../core/config'
export type {TextUnitedAuth, TextUnitedCapabilities} from '../core/textunited/client'
export {TextUnitedClient, TextUnitedApiError, TextUnitedTimeoutError} from '../core/textunited/client'
export type {JobResult, JobSummary, ProjectSettings} from './jobs'
export type {SyncResult} from './sync'
export type {SanityStore, Mutation} from './sanityStore'

export const REQUEST_ID_PREFIX = 'textunited.request.'
export const TEAM_QUERY_ID_PREFIX = 'textunited.teamQuery.'
const TEAM_QUERY_MAX_AGE_MS = 10 * 60 * 1000

export type TextUnitedHandlerOptions = {
  translation: TranslationConfig
  textUnited: {
    auth: TextUnitedAuth
    baseUrl?: string
    capabilities?: TextUnitedCapabilities
    /** Services ordered for each language of a new outsourced project */
    project?: Partial<ProjectSettings>
    /** Services of a new in-house project; the team comes from the Studio request */
    inHouse?: Partial<ProjectSettings>
    /** Longest wait for one TextUnited response; defaults to 90 seconds */
    timeoutMs?: number
  }
  sanity: {
    projectId: string
    dataset: string
    /** Token with write access, used to save translations. Server side only. */
    token: string
    apiVersion?: string
  }
  /**
   * Public HTTPS origin of the site that hosts this handler, e.g. https://www.example.com.
   * TextUnited sends its notifications here, so it must be reachable from the internet and
   * should not change: TextUnited caches the address for up to 24 hours.
   */
  publicBaseUrl: string
  /** Path the handler is mounted at, e.g. /api/textunited */
  basePath: string
  /** Random secret used to sign notification URLs */
  secret: string
  /**
   * Origins of the Studios allowed to trigger requests directly, e.g.
   * ['https://example.sanity.studio', 'http://localhost:3333']
   */
  studioOrigins?: string[]
  /** Secret of an optional Sanity GROQ webhook on `textunited.translationRequest` documents */
  webhookSecret?: string
  /**
   * Bearer token for the periodic check (`{basePath}/sync`), e.g. Vercel's CRON_SECRET.
   * Defaults to `secret`.
   */
  cronSecret?: string
  /** Replaces the Sanity HTTP client, e.g. in tests */
  store?: SanityStore
  /** Replaces fetch for TextUnited calls, e.g. in tests */
  fetch?: typeof fetch
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', ...headers},
  })
}

/**
 * Framework-independent request handler built on the web-standard Request and Response, so it
 * runs in Next.js route handlers, Remix, Hono, Bun, Deno and Node 20+.
 *
 * Routes, relative to `basePath`:
 * - `POST /jobs`  process a translation request: `{requestId}` from the Studio, or the body of a
 *   signed Sanity webhook
 * - `GET|POST /events`  a notification from TextUnited
 * - `GET|POST /sync`  periodic check of documents still being translated (Bearer token)
 */
export function createTextUnitedRequestHandler(options: TextUnitedHandlerOptions) {
  const basePath = options.basePath.replace(/\/+$/, '')
  const publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '')
  // Local development may use http://localhost: translation requests work, but TextUnited
  // cannot reach the notification URL, so translations arrive only through `/sync`.
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicBaseUrl)
  if (!publicBaseUrl.startsWith('https://') && !isLocal) {
    throw new Error('publicBaseUrl must start with https:// (TextUnited only calls HTTPS addresses)')
  }

  const textUnited = new TextUnitedClient({
    auth: options.textUnited.auth,
    baseUrl: options.textUnited.baseUrl,
    fetch: options.fetch,
    timeoutMs: options.textUnited.timeoutMs,
  })
  const capabilities = options.textUnited.capabilities ?? DEFAULT_CAPABILITIES
  const store =
    options.store ??
    new HttpSanityStore({
      projectId: options.sanity.projectId,
      dataset: options.sanity.dataset,
      token: options.sanity.token,
      apiVersion: options.sanity.apiVersion,
    })
  const studioOrigins = new Set(options.studioOrigins ?? [])

  const jobContext = {
    config: options.translation,
    store,
    textUnited,
    sanityProjectId: options.sanity.projectId,
    dataset: options.sanity.dataset,
    projectSettings: {...DEFAULT_PROJECT_SETTINGS, ...options.textUnited.project},
    inHouseSettings: {
      ...DEFAULT_IN_HOUSE_SETTINGS,
      // The style guide is a property of the content, whoever translates it.
      ...(options.textUnited.project?.styleGuideId ? {styleGuideId: options.textUnited.project.styleGuideId} : {}),
      ...options.textUnited.inHouse,
    },
    capabilities,
    eventUrl: async (baseDocumentId: string): Promise<string | undefined> => {
      // TextUnited rejects a non-HTTPS event URL, so none is sent in local development.
      if (isLocal) return undefined
      const url = new URL(`${publicBaseUrl}${basePath}/events`)
      url.searchParams.set('doc', baseDocumentId)
      url.searchParams.set('sig', await signDocumentId(options.secret, baseDocumentId))
      return url.toString()
    },
  }

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get('origin')
    if (!origin || !studioOrigins.has(origin)) return {}
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    }
  }

  async function handleJobs(request: Request): Promise<Response> {
    const cors = corsHeaders(request)
    const body = await request.text()
    const signature = request.headers.get('sanity-webhook-signature')

    let requestId: unknown
    if (signature) {
      if (!options.webhookSecret || !(await verifySanityWebhookSignature(options.webhookSecret, signature, body))) {
        return json({message: 'Invalid webhook signature'}, 401)
      }
      requestId = safeParse(body)?._id
    } else {
      if (request.headers.get('origin') && Object.keys(cors).length === 0) {
        return json({message: 'Origin not allowed'}, 403)
      }
      requestId = safeParse(body)?.requestId
    }

    // Only request documents created in Sanity are processed: creating one needs write access
    // to the dataset, which is what makes this route safe to call without a secret.
    if (typeof requestId !== 'string' || !requestId.startsWith(REQUEST_ID_PREFIX)) {
      return json({message: 'Missing or invalid requestId'}, 400, cors)
    }
    const result = await processTranslationRequest(requestId, jobContext)
    return json(result, result.status === 'failed' ? 500 : 200, cors)
  }

  return async function handle(request: Request): Promise<Response> {
    const {pathname} = new URL(request.url)
    const route = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname

    if (route === '/jobs') {
      if (request.method === 'OPTIONS') {
        const cors = corsHeaders(request)
        return new Response(null, {status: Object.keys(cors).length ? 204 : 403, headers: cors})
      }
      if (request.method === 'POST') return handleJobs(request)
    }
    if (route === '/team') {
      if (request.method === 'OPTIONS') {
        const cors = corsHeaders(request)
        return new Response(null, {status: Object.keys(cors).length ? 204 : 403, headers: cors})
      }
      if (request.method === 'POST') return handleTeam(request)
    }
    if (route === '/events' && (request.method === 'GET' || request.method === 'POST')) {
      return handleEvent(request)
    }
    if (route === '/sync' && (request.method === 'GET' || request.method === 'POST')) {
      return handleSync(request)
    }
    return json({message: 'Not found'}, 404)
  }

  /**
   * A TextUnited notification. TextUnited calls the URL given at project creation, adding
   * `event`, `segment` and `project`; `doc` and `sig` identify and authenticate the document.
   */
  async function handleEvent(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams
    const documentId = params.get('doc')
    const signature = params.get('sig')
    if (!documentId || !signature) return json({message: 'Missing doc or sig'}, 400)
    if (!(await verifyDocumentSignature(options.secret, documentId, signature))) {
      return json({message: 'Invalid signature'}, 401)
    }
    try {
      return json(await syncDocument(documentId, jobContext))
    } catch (error) {
      return json({message: error instanceof Error ? error.message : 'Sync failed'}, 500)
    }
  }

  /**
   * People who can form an in-house team. The list holds names and e-mail addresses, so it is
   * returned only for a fresh `textunited.teamQuery.*` document the Studio created: creating it
   * needs write access to the dataset. The query document is deleted right away.
   */
  async function handleTeam(request: Request): Promise<Response> {
    const cors = corsHeaders(request)
    if (request.headers.get('origin') && Object.keys(cors).length === 0) {
      return json({message: 'Origin not allowed'}, 403)
    }
    const queryId = safeParse(await request.text())?.queryId
    if (typeof queryId !== 'string' || !queryId.startsWith(TEAM_QUERY_ID_PREFIX)) {
      return json({message: 'Missing or invalid queryId'}, 400, cors)
    }
    const query = await store.getDocument(queryId)
    const createdAt = Date.parse(String(query?._createdAt ?? query?.requestedAt ?? ''))
    if (!query || !Number.isFinite(createdAt) || Date.now() - createdAt > TEAM_QUERY_MAX_AGE_MS) {
      return json({message: 'Unknown or expired team query'}, 403, cors)
    }
    await store.mutate([{delete: {id: queryId}}])
    try {
      return json({members: await textUnited.listTeamCandidates()}, 200, cors)
    } catch (error) {
      return json({message: error instanceof Error ? error.message : 'Could not load the team'}, 502, cors)
    }
  }

  /** Periodic check for notifications TextUnited did not send (e.g. after "approve all"). */
  async function handleSync(request: Request): Promise<Response> {
    const expected = `Bearer ${options.cronSecret ?? options.secret}`
    if (request.headers.get('authorization') !== expected) return json({message: 'Unauthorized'}, 401)
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 20)
    const results = await syncPendingDocuments(jobContext, Number.isFinite(limit) ? Math.min(limit, 100) : 20)
    return json({checked: results.length, results})
  }
}

function safeParse(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body) as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

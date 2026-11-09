import type {
  CreateProjectRequest,
  ProjectResponse,
  ProjectSegment,
  SegmentWithTranslations,
  TeamCandidate,
} from './types'

/**
 * How the server authenticates with TextUnited. A personal access token (`tu_pat_...`, scopes
 * `projects:read` and `projects:write`) is the recommended option; company id plus API key is
 * kept for accounts that still use it.
 */
export type TextUnitedAuth =
  | {type: 'pat'; token: string}
  | {type: 'apiKey'; companyId: string; apiKey: string}

export type TextUnitedClientOptions = {
  auth: TextUnitedAuth
  /** Defaults to https://api.textunited.com */
  baseUrl?: string
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch
  /**
   * Longest wait for one TextUnited response. Instant machine translation can be slow, and an
   * update may not answer at all; the content is stored by then, so callers treat a timeout as
   * "sent, translations follow later". Defaults to 90 seconds.
   */
  timeoutMs?: number
}

export class TextUnitedTimeoutError extends Error {
  constructor(method: string, path: string, timeoutMs: number) {
    super(`TextUnited did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)} seconds`)
    this.name = 'TextUnitedTimeoutError'
  }
}

/**
 * What the connected TextUnited API can do.
 *
 * `appendSegments`: `PUT /segments/projects` accepts `appendContent: true`, which adds the sent
 * segments as a new task and leaves the existing tasks (and their work) untouched. With it, an
 * update sends only new and changed texts, as one new task per request. Without it, an update
 * replaces whole tasks, so each changed part of the document is sent as its own task.
 */
export type TextUnitedCapabilities = {
  appendSegments: boolean
}

export const DEFAULT_CAPABILITIES: TextUnitedCapabilities = {appendSegments: false}

export class TextUnitedApiError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(describeStatus(status, body))
    this.name = 'TextUnitedApiError'
    this.status = status
    this.body = body
  }
}

function describeStatus(status: number, body: string): string {
  if (status === 401) {
    return 'TextUnited rejected the access token. It may have expired or been revoked: create a new one in the TextUnited portal and update the server configuration.'
  }
  if (status === 403) {
    return 'The TextUnited access token lacks the required scopes. It needs projects:read and projects:write.'
  }
  const detail = body.trim().slice(0, 500)
  return `TextUnited request failed with status ${status}${detail ? `: ${detail}` : ''}`
}

function encodeBasic(value: string): string {
  if (typeof btoa === 'function') return btoa(value)
  return Buffer.from(value).toString('base64')
}

export class TextUnitedClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: TextUnitedClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.textunited.com').replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 90_000
    this.authHeader =
      options.auth.type === 'pat'
        ? `Bearer ${options.auth.token}`
        : `Basic ${encodeBasic(`${options.auth.companyId}:${options.auth.apiKey}`)}`
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    let text: string
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      text = await response.text()
    } catch (error) {
      if (controller.signal.aborted) throw new TextUnitedTimeoutError(method, path, this.timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 404 && method === 'GET') return null
    if (!response.ok) throw new TextUnitedApiError(response.status, text)
    return text.trim() ? (JSON.parse(text) as T) : null
  }

  /** Returns the multilingual project with this custom id, or null when it does not exist. */
  getProject(customId: string): Promise<ProjectResponse | null> {
    return this.request<ProjectResponse>(
      'GET',
      `/segments/projects/custom/${encodeURIComponent(customId)}`,
    )
  }

  async createProject(request: CreateProjectRequest): Promise<ProjectResponse> {
    const result = await this.request<ProjectResponse>('POST', '/segments/projects', request)
    return result ?? {customId: request.customId}
  }

  /**
   * Replaces the content of one task (virtual file) in every language project of the
   * multilingual project. With `instantTranslation`, unchanged segments get their text back
   * from TextUnited's translation memory, but with the status `automatic`.
   */
  async replaceTask(args: {
    customId: string
    taskId: string
    segments: ProjectSegment[]
    eventUrl?: string
  }): Promise<ProjectResponse> {
    const result = await this.request<ProjectResponse>('PUT', '/segments/projects', {
      customId: args.customId,
      taskId: args.taskId,
      segments: args.segments,
      appendContent: false,
      instantTranslation: true,
      eventUrl: args.eventUrl,
    })
    return result ?? {customId: args.customId}
  }

  /**
   * People who can join an in-house team: active company users and confirmed collaborators.
   * Needs the same token scopes as projects (projects:read).
   */
  async listTeamCandidates(): Promise<TeamCandidate[]> {
    type User = {id?: number; login?: string; email?: string; firstName?: string; lastName?: string; stateName?: string}
    type Collaborator = {userId?: number; id?: number; email?: string; firstName?: string; lastName?: string; confirmed?: boolean}
    const [users, collaborators] = await Promise.all([
      this.request<User[]>('GET', '/accounts/Users'),
      this.request<Collaborator[]>('GET', '/accounts/Collaborators'),
    ])
    const name = (first?: string, last?: string, fallback = '') =>
      [first, last].filter(Boolean).join(' ').trim() || fallback
    const candidates: TeamCandidate[] = []
    for (const user of users ?? []) {
      const username = user.login || user.email
      if (!user.id || !username || (user.stateName && user.stateName !== 'Normal')) continue
      candidates.push({id: user.id, username, name: name(user.firstName, user.lastName, username), kind: 'user'})
    }
    for (const collaborator of collaborators ?? []) {
      const id = collaborator.userId || collaborator.id
      if (!id || !collaborator.email || collaborator.confirmed === false) continue
      candidates.push({
        id,
        username: collaborator.email,
        name: name(collaborator.firstName, collaborator.lastName, collaborator.email),
        kind: 'collaborator',
      })
    }
    return candidates.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Adds the segments as a new task in every language project of the multilingual project;
   * existing tasks stay as they are. The task id must not exist in the project yet (HTTP 400).
   */
  async appendTask(args: {
    customId: string
    taskId: string
    segments: ProjectSegment[]
    eventUrl?: string
  }): Promise<ProjectResponse> {
    const result = await this.request<ProjectResponse>('PUT', '/segments/projects', {
      customId: args.customId,
      taskId: args.taskId,
      segments: args.segments,
      appendContent: true,
      instantTranslation: true,
      eventUrl: args.eventUrl,
    })
    return result ?? {customId: args.customId, taskId: args.taskId}
  }

  /** Source segments with their translations in every target language. */
  async getSegments(customId: string, taskId?: string): Promise<SegmentWithTranslations[]> {
    const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
    const result = await this.request<SegmentWithTranslations[]>(
      'GET',
      `/segments/projects/custom/${encodeURIComponent(customId)}/segments${query}`,
    )
    return result ?? []
  }
}

import type {PlainObject} from '../src/core/document/paths'
import {SanityConflictError, type Mutation, type SanityStore} from '../src/server/sanityStore'

/** In-memory Sanity dataset with the operations the server uses. */
export class MemoryStore implements SanityStore {
  readonly documents = new Map<string, PlainObject>()
  readonly log: Mutation[] = []
  private revision = 0

  constructor(documents: PlainObject[] = []) {
    for (const document of documents) this.put(document)
  }

  private put(document: PlainObject) {
    this.revision += 1
    this.documents.set(String(document._id), structuredClone({...document, _rev: `rev${this.revision}`}))
  }

  async getDocument(id: string) {
    const document = this.documents.get(id)
    return document ? structuredClone(document) : null
  }

  async findTranslationMetadata(baseDocumentId: string) {
    for (const document of this.documents.values()) {
      if (document._type !== 'translation.metadata') continue
      const refs = (document.translations as Array<{value?: {_ref?: string}}> | undefined) ?? []
      if (refs.some((entry) => entry.value?._ref === baseDocumentId)) return structuredClone(document)
    }
    return null
  }

  async listPendingDocuments(limit: number) {
    return [...this.documents.values()]
      .filter((doc) => doc._type === 'textunited.translationState' && doc.pending === true)
      .slice(0, limit)
      .map((doc) => String(doc.documentId))
  }

  async mutate(mutations: Mutation[]) {
    this.log.push(...mutations)
    for (const mutation of mutations) {
      if ('create' in mutation) {
        if (this.documents.has(String(mutation.create._id))) throw new SanityConflictError('exists')
        this.put(mutation.create)
      } else if ('createOrReplace' in mutation) {
        this.put(mutation.createOrReplace)
      } else if ('delete' in mutation) {
        this.documents.delete(mutation.delete.id)
      } else if ('createIfNotExists' in mutation) {
        if (!this.documents.has(String(mutation.createIfNotExists._id))) this.put(mutation.createIfNotExists)
      } else {
        const {id, set, setIfMissing, ifRevisionID} = mutation.patch
        const current = this.documents.get(id)
        if (!current) throw new Error(`No document ${id}`)
        if (ifRevisionID && current._rev !== ifRevisionID) throw new SanityConflictError('revision')
        const next = {...current}
        for (const [key, value] of Object.entries(setIfMissing ?? {})) next[key] ??= value
        Object.assign(next, set)
        this.put(next)
      }
    }
  }
}

type FakeTranslation = {languageCode: string; content: string; status: string}
type FakeProject = {
  id: number
  customId: string
  languages: string[]
  /** Keyed by segment custom id; an appended copy in another task is keyed `id@task` */
  segments: Map<string, {customId?: string; content: string; taskId: string; translations: FakeTranslation[]}>
}

/**
 * Fake TextUnited Segments API. Instant translations prefix every text with the language code,
 * keeping span markers, so tests can see what was translated. `review` plays a translator.
 */
export function createFakeTextUnited(options: {hangOnPutTask?: string} = {}) {
  const projects = new Map<string, FakeProject>()
  const calls: Array<{method: string; path: string; body?: Record<string, unknown>}> = []

  const machine = (code: string, content: string): FakeTranslation => {
    const language = code.slice(0, 2)
    const translated = content.includes('data-tu-id')
      ? content.replace(/(<span[^>]*>)/g, `$1${language}:`)
      : `${language}:${content}`
    return {languageCode: code.toUpperCase(), content: translated, status: 'automatic'}
  }

  /** Replaces a task's segments, like the real PUT, and returns the instant translations. */
  const replaceTask = (
    project: FakeProject,
    taskId: string,
    segments: Array<{customId: string; content: string}>,
  ) => {
    for (const [id, segment] of project.segments) if (segment.taskId === taskId) project.segments.delete(id)
    return segments.map((segment) => {
      const translations = project.languages.map((code) => machine(code, segment.content))
      project.segments.set(segment.customId, {content: segment.content, taskId, translations})
      return {source: {customId: segment.customId, content: segment.content}, translations}
    })
  }

  /** Adds the segments as a new task, like PUT with appendContent; existing tasks stay. */
  const appendTask = (
    project: FakeProject,
    taskId: string,
    segments: Array<{customId: string; content: string}>,
  ) => {
    return segments.map((segment) => {
      const translations = project.languages.map((code) => machine(code, segment.content))
      const key = project.segments.has(segment.customId) ? `${segment.customId}@${taskId}` : segment.customId
      project.segments.set(key, {customId: segment.customId, content: segment.content, taskId, translations})
      return {source: {customId: segment.customId, content: segment.content}, translations}
    })
  }

  /** Plays a translator on a segment: its copy in `taskId`, or its latest copy. */
  const review = (
    projectId: string,
    segmentId: string,
    languageCode: string,
    content: string,
    status = 'proofread',
    taskId?: string,
  ) => {
    const copies = [...(projects.get(projectId)?.segments ?? [])]
      .filter(([key, entry]) => (entry.customId ?? key) === segmentId && (!taskId || entry.taskId === taskId))
      .map(([, entry]) => entry)
    const segment = copies.at(-1)
    const translation = segment?.translations.find((t) => t.languageCode.toLowerCase() === languageCode.toLowerCase())
    if (!translation) throw new Error(`No ${languageCode} translation of ${segmentId}`)
    translation.content = content
    translation.status = status
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({method, path: url.pathname, body})

    if (method === 'GET' && url.pathname === '/accounts/Users') {
      return Response.json([
        {id: 7, login: 'anna@example.com', email: 'anna@example.com', firstName: 'Anna', lastName: 'Nowak', stateName: 'Normal'},
        {id: 8, login: 'old@example.com', firstName: 'Old', lastName: 'Account', stateName: 'Blocked'},
      ])
    }
    if (method === 'GET' && url.pathname === '/accounts/Collaborators') {
      return Response.json([{id: 1, userId: 9, email: 'jan@freelance.test', firstName: 'Jan', lastName: 'Kowalski', confirmed: true}])
    }

    const segmentsMatch = url.pathname.match(/^\/segments\/projects\/custom\/([^/]+)\/segments$/)
    if (method === 'GET' && segmentsMatch) {
      const project = projects.get(decodeURIComponent(segmentsMatch[1]!))
      if (!project) return new Response('', {status: 404})
      return Response.json(
        [...project.segments].map(([key, segment]) => ({
          source: {customId: segment.customId ?? key, content: segment.content, taskId: segment.taskId},
          translations: structuredClone(segment.translations),
        })),
      )
    }

    const projectMatch = url.pathname.match(/^\/segments\/projects\/custom\/([^/]+)$/)
    if (method === 'GET' && projectMatch) {
      const project = projects.get(decodeURIComponent(projectMatch[1]!))
      if (!project) return new Response('', {status: 404})
      return Response.json({
        id: project.id,
        customId: project.customId,
        targetLanguages: project.languages.map((code) => ({targetLanguageCode: code})),
      })
    }

    const segments = (body?.segments ?? []) as Array<{customId: string; content: string}>
    if (method === 'POST' && url.pathname === '/segments/projects') {
      const languages = (body!.targetLanguages as Array<{targetLanguageCode: string}>).map(
        (target) => target.targetLanguageCode,
      )
      const project: FakeProject = {id: 400000 + projects.size + 1, customId: String(body!.customId), languages, segments: new Map()}
      projects.set(project.customId, project)
      return Response.json({
        id: project.id,
        customId: project.customId,
        instantTranslationSegments: replaceTask(project, String(body!.taskId), segments),
      })
    }
    if (method === 'PUT' && url.pathname === '/segments/projects') {
      const project = projects.get(String(body!.customId))
      if (!project) return new Response('no project', {status: 400})
      if (body!.appendContent === true) {
        const taskId = String(body!.taskId)
        if ([...project.segments.values()].some((segment) => segment.taskId === taskId)) {
          return new Response(`TaskId '${taskId}' already exists.`, {status: 400})
        }
        if (options.hangOnPutTask === 'append') {
          appendTask(project, taskId, segments)
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          })
        }
        return Response.json({
          customId: project.customId,
          taskId,
          instantTranslationSegments: appendTask(project, taskId, segments),
        })
      }
      if (options.hangOnPutTask === body!.taskId) {
        // Like the real API: the segments are stored, then the answer never comes.
        for (const segment of segments) {
          project.segments.set(segment.customId, {content: segment.content, taskId: String(body!.taskId), translations: []})
        }
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      return Response.json({
        customId: project.customId,
        instantTranslationSegments: replaceTask(project, String(body!.taskId), segments),
      })
    }
    return new Response('unexpected', {status: 500})
  }) as typeof globalThis.fetch

  return {fetch, calls, projects, review}
}

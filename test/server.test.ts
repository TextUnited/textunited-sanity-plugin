import {describe, expect, it} from 'vitest'

import type {PlainObject} from '../src/core/document/paths'
import {getAtPath} from '../src/core/document/paths'
import {createTextUnitedRequestHandler, type TextUnitedHandlerOptions} from '../src/server/index'
import {createSanityWebhookSignature} from '../src/server/signing'
import {createFakeTextUnited, MemoryStore} from './fakes'
import {config, makePage, makePost} from './fixtures'

const STUDIO = 'https://example.sanity.studio'

function setup(documents: PlainObject[]) {
  const store = new MemoryStore(documents)
  const textUnited = createFakeTextUnited()
  const options: TextUnitedHandlerOptions = {
    translation: config,
    textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}},
    sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
    publicBaseUrl: 'https://www.example.com',
    basePath: '/api/textunited',
    secret: 'test-secret',
    studioOrigins: [STUDIO],
    webhookSecret: 'webhook-secret',
    store,
    fetch: textUnited.fetch,
  }
  const handle = createTextUnitedRequestHandler(options)
  let counter = 0
  const request = async (documentId: string, languages: string[], mode = 'missing') => {
    counter += 1
    const id = `textunited.request.r${counter}`
    await store.mutate([
      {create: {_id: id, _type: 'textunited.translationRequest', documentId, languages, mode, status: 'queued'}},
    ])
    const response = await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: STUDIO, 'content-type': 'application/json'},
        body: JSON.stringify({requestId: id}),
      }),
    )
    return {id, response, body: (await response.json()) as Record<string, any>}
  }
  return {store, textUnited, handle, request}
}

describe('translation request: fieldLevel page', () => {
  it('creates one project, sends the missing parts and writes machine translations to the draft', async () => {
    const page = {...makePage(), _id: 'page1'}
    const {store, textUnited, request} = setup([page])

    const {id, body} = await request('page1', ['de'])
    expect(body.status).toBe('done')
    expect(body.summary.projectCreated).toBe(true)
    expect(body.summary.tasksSent).toEqual(['sections.s1'])
    // the task with formatted text is the one sent with the create call
    expect(textUnited.calls.find((call) => call.method === 'POST')?.body?.taskId).toBe('sections.s1')

    const post = textUnited.calls.find((call) => call.method === 'POST')!
    expect(post.body).toMatchObject({
      customId: 'sanity-proj-production-page1',
      taskId: 'sections.s1',
      sourceLanguageCode: 'en-us',
      referenceNumber: 'page1',
      targetLanguages: [expect.objectContaining({targetLanguageCode: 'de-de', serviceTranslation: true})],
    })
    expect(String(post.body!.eventUrl)).toMatch(
      /^https:\/\/www\.example\.com\/api\/textunited\/events\?doc=page1&sig=[0-9a-f]{64}$/,
    )

    const draft = store.documents.get('drafts.page1')!
    expect(getAtPath(draft, ['sections', {_key: 's1'}, 'heading', {_key: 'de'}, 'value'])).toBe(
      'de:Translate with control',
    )
    // German written by hand stays
    expect(getAtPath(draft, ['title', {_key: 'de'}, 'value'])).toBe('Sprachschicht')
    expect(store.documents.get(id)?.status).toBe('done')
    expect(store.documents.get('textunited.state.page1')?.projectCustomId).toBe('sanity-proj-production-page1')
  })

  it('sends nothing the second time, and only the edited section after a source change', async () => {
    const page = {...makePage(), _id: 'page1'}
    const {store, textUnited, request} = setup([page])
    await request('page1', ['de'])

    const again = await request('page1', ['de'])
    expect(again.body.summary.tasksSent).toEqual([])

    const draft = store.documents.get('drafts.page1') as any
    draft.sections[1].heading[0].value = 'Book a call'
    await store.mutate([{createOrReplace: draft}])
    const changed = await request('page1', ['de'], 'changed')

    expect(changed.body.summary.tasksSent).toEqual(['sections.s2'])
    expect(changed.body.summary.projectCreated).toBe(false)
    expect(textUnited.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    const put = textUnited.calls.filter((call) => call.method === 'PUT').at(-1)!
    expect(put.body).toMatchObject({taskId: 'sections.s2', appendContent: false, instantTranslation: true})
    // "Demo buchen" was written by hand, but its source changed, so it is replaced
    expect(changed.body.summary.outcomes).toEqual({applied: 1})
    expect(
      getAtPath(store.documents.get('drafts.page1'), ['sections', {_key: 's2'}, 'heading', {_key: 'de'}, 'value']),
    ).toBe('de:Book a call')
  })

  it('orders a language added later as a second project, leaving the first one as it is', async () => {
    const page = {...makePage(), _id: 'page1'}
    const {store, textUnited, request} = setup([page])
    await request('page1', ['de'])
    const before = textUnited.calls.length
    const result = await request('page1', ['fr'])
    expect(result.body.status).toBe('done')
    expect(result.body.summary.projectCreated).toBe(true)
    const second = textUnited.calls.slice(before)

    const posts = textUnited.calls.filter((call) => call.method === 'POST')
    expect(posts.map((call) => call.body!.customId)).toEqual([
      'sanity-proj-production-page1',
      'sanity-proj-production-page1-2',
    ])
    // the second project holds French only and names it
    expect(posts[1]!.body!.targetLanguages).toEqual([expect.objectContaining({targetLanguageCode: 'fr-fr'})])
    expect(String(posts[1]!.body!.name)).toMatch(/ – FR \(page1\)$/)
    // nothing was sent to the German project again
    expect(second.filter((call) => call.body?.customId === 'sanity-proj-production-page1')).toHaveLength(0)

    const state = store.documents.get('textunited.state.page1')!
    expect(JSON.parse(String(state.projectsJson)).projects.map((p: any) => [p.customId, p.languages])).toEqual([
      ['sanity-proj-production-page1', ['de']],
      ['sanity-proj-production-page1-2', ['fr']],
    ])
    expect(state.projectLanguages).toEqual(['de', 'fr'])
  })
})

describe('translation request: documentLevel post', () => {
  it('creates the translated draft, its slug and the translation metadata', async () => {
    const {store, request} = setup([makePost()])
    const {body} = await request('post1', ['de'])
    expect(body.status).toBe('done')

    const german = [...store.documents.values()].find((doc) => doc._type === 'post' && doc.language === 'de')!
    expect(String(german._id)).toMatch(/^drafts\./)
    expect(german.title).toBe('de:One concept, many words')
    expect(german.slug).toEqual({_type: 'slug', current: 'de-one-concept-many-words'})
    expect(german.author).toEqual({_type: 'reference', _ref: 'author1'})

    const metadata = [...store.documents.values()].find((doc) => doc._type === 'translation.metadata')!
    expect((metadata.translations as Array<{_key: string}>).map((entry) => entry._key)).toEqual(['en', 'de'])
  })
})

describe('slow TextUnited answers', () => {
  it('treats a task whose update never answers as sent, and finishes the request', async () => {
    const page = {...makePage(), _id: 'page1'}
    // Remove the German title so the first request sends two tasks: fields (POST) and s1 (PUT)
    page.title = page.title.filter((item) => item._key === 'en')
    const store = new MemoryStore([page])
    const textUnited = createFakeTextUnited({hangOnPutTask: 'fields'})
    const handle = createTextUnitedRequestHandler({
      translation: config,
      textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}, timeoutMs: 50},
      sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
      publicBaseUrl: 'https://www.example.com',
      basePath: '/api/textunited',
      secret: 'test-secret',
      studioOrigins: [STUDIO],
      store,
      fetch: textUnited.fetch,
    })
    await store.mutate([
      {create: {_id: 'textunited.request.t1', _type: 'textunited.translationRequest', documentId: 'page1', languages: ['de'], mode: 'missing', status: 'queued'}},
    ])
    const response = await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: STUDIO},
        body: JSON.stringify({requestId: 'textunited.request.t1'}),
      }),
    )
    const body = (await response.json()) as {status: string; summary: Record<string, unknown>}
    expect(body.status).toBe('done')
    expect([...(body.summary.tasksSent as string[])].sort()).toEqual(['fields', 'sections.s1'])
    expect(body.summary.tasksAwaitingTranslation).toEqual(['fields'])
    // the section (sent with the create call) is translated; the title waits for TextUnited
    expect(
      getAtPath(store.documents.get('drafts.page1'), ['sections', {_key: 's1'}, 'heading', {_key: 'de'}, 'value']),
    ).toBe('de:Translate with control')
    expect(getAtPath(store.documents.get('drafts.page1'), ['title', {_key: 'de'}])).toBeUndefined()
    expect(store.documents.get('textunited.state.page1')?.pending).toBe(true)
  })
})

describe('local development', () => {
  it('accepts http://localhost and sends no notification URL to TextUnited', async () => {
    const store = new MemoryStore([{...makePage(), _id: 'page1'}])
    const textUnited = createFakeTextUnited()
    const handle = createTextUnitedRequestHandler({
      translation: config,
      textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}},
      sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
      publicBaseUrl: 'http://localhost:3000',
      basePath: '/api/textunited',
      secret: 'test-secret',
      studioOrigins: ['http://localhost:3333'],
      store,
      fetch: textUnited.fetch,
    })
    await store.mutate([
      {create: {_id: 'textunited.request.l1', _type: 'textunited.translationRequest', documentId: 'page1', languages: ['de'], mode: 'missing', status: 'queued'}},
    ])
    const response = await handle(
      new Request('http://localhost:3000/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: 'http://localhost:3333'},
        body: JSON.stringify({requestId: 'textunited.request.l1'}),
      }),
    )
    expect(response.status).toBe(200)
    const post = textUnited.calls.find((call) => call.method === 'POST')!
    expect(post.body!.eventUrl).toBeUndefined()
  })

  it('still refuses plain http for other hosts', () => {
    expect(() =>
      createTextUnitedRequestHandler({
        translation: config,
        textUnited: {auth: {type: 'pat', token: 'x'}},
        sanity: {projectId: 'p', dataset: 'd', token: 't'},
        publicBaseUrl: 'http://www.example.com',
        basePath: '/api/textunited',
        secret: 's',
      }),
    ).toThrow(/https/)
  })
})

describe('handler security', () => {
  it('rejects requests from other origins and ids that are not request documents', async () => {
    const {handle} = setup([])
    const foreign = await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: 'https://evil.example'},
        body: JSON.stringify({requestId: 'textunited.request.x'}),
      }),
    )
    expect(foreign.status).toBe(403)

    const wrongId = await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: STUDIO},
        body: JSON.stringify({requestId: 'page1'}),
      }),
    )
    expect(wrongId.status).toBe(400)
  })

  it('accepts a correctly signed Sanity webhook and rejects a forged one', async () => {
    const {handle, store} = setup([{...makePage(), _id: 'page1'}])
    await store.mutate([
      {create: {_id: 'textunited.request.w1', _type: 'textunited.translationRequest', documentId: 'page1', languages: ['de'], mode: 'missing', status: 'queued'}},
    ])
    const body = JSON.stringify({_id: 'textunited.request.w1'})
    const send = (signature: string) =>
      handle(
        new Request('https://www.example.com/api/textunited/jobs', {
          method: 'POST',
          headers: {'sanity-webhook-signature': signature},
          body,
        }),
      )

    expect((await send('t=1,v1=forged')).status).toBe(401)
    const ok = await send(await createSanityWebhookSignature('webhook-secret', body))
    expect(ok.status).toBe(200)
    expect(store.documents.get('textunited.request.w1')?.status).toBe('done')
  })

  it('processes a request only once', async () => {
    const {request, store, handle} = setup([{...makePage(), _id: 'page1'}])
    const {id} = await request('page1', ['de'])
    const replay = await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: STUDIO},
        body: JSON.stringify({requestId: id}),
      }),
    )
    expect(((await replay.json()) as {status: string}).status).toBe('ignored')
    expect(store.documents.get(id)?.status).toBe('done')
  })
})

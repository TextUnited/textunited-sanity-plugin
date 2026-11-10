import {describe, expect, it} from 'vitest'

import type {PlainObject} from '../src/core/document/paths'
import {createTextUnitedRequestHandler} from '../src/server/index'
import {teamForRequest, validateTeam, type TeamChoice} from '../src/studio/logic'
import {createFakeTextUnited, MemoryStore} from './fakes'
import {config, makePage} from './fixtures'

const STUDIO = 'https://example.sanity.studio'

function setup(documents: PlainObject[]) {
  const store = new MemoryStore(documents)
  const textUnited = createFakeTextUnited()
  const handle = createTextUnitedRequestHandler({
    translation: config,
    textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}, capabilities: {appendSegments: false}, project: {styleGuideId: 861}},
    sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
    publicBaseUrl: 'https://www.example.com',
    basePath: '/api/textunited',
    secret: 'test-secret',
    studioOrigins: [STUDIO],
    store,
    fetch: textUnited.fetch,
  })
  const post = (route: string, body: unknown, origin = STUDIO) =>
    handle(
      new Request(`https://www.example.com/api/textunited${route}`, {
        method: 'POST',
        headers: {origin},
        body: JSON.stringify(body),
      }),
    )
  return {store, textUnited, post}
}

async function request(t: ReturnType<typeof setup>, extra: PlainObject) {
  await t.store.mutate([
    {
      create: {
        _id: 'textunited.request.i1',
        _type: 'textunited.translationRequest',
        documentId: 'page1',
        languages: ['de'],
        mode: 'missing',
        status: 'queued',
        ...extra,
      },
    },
  ])
  const response = await t.post('/jobs', {requestId: 'textunited.request.i1'})
  return (await response.json()) as {status: string; error?: string}
}

describe('in-house projects', () => {
  it('creates a non-managed project with the chosen team and roles', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    const result = await request(t, {
      projectType: 'inHouse',
      team: [
        {_key: '7', id: 7, username: 'anna@example.com', translator: true, proofreader: false, projectManager: true},
        {_key: '9', id: 9, username: 'jan@freelance.test', translator: false, proofreader: true, projectManager: false},
      ],
    })
    expect(result.status).toBe('done')

    const created = t.textUnited.calls.find((call) => call.method === 'POST')!
    const target = (created.body!.targetLanguages as Array<Record<string, unknown>>)[0]!
    expect(target).toMatchObject({
      targetLanguageCode: 'de-de',
      managedProject: false,
      serviceTranslation: true,
      serviceProofreading: true,
      styleGuideId: 861,
      team: [
        {id: 7, username: 'anna@example.com', isTranslator: true, isProofreader: false, isProjectManager: true, isInCountryReviewer: false},
        {id: 9, username: 'jan@freelance.test', isTranslator: false, isProofreader: true, isProjectManager: false, isInCountryReviewer: false},
      ],
    })
    expect(t.store.documents.get('textunited.state.page1')?.projectType).toBe('inHouse')
  })

  it('refuses an in-house project without a translator', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    const result = await request(t, {
      projectType: 'inHouse',
      team: [{_key: '9', id: 9, username: 'jan@freelance.test', proofreader: true}],
    })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/at least one translator/)
    expect(t.textUnited.calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('keeps outsourced as the default', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await request(t, {})
    const target = (t.textUnited.calls.find((call) => call.method === 'POST')!.body!.targetLanguages as Array<
      Record<string, unknown>
    >)[0]!
    expect(target.managedProject).toBe(true)
    expect(target.team).toBeUndefined()
    expect(t.store.documents.get('textunited.state.page1')?.projectType).toBe('outsourced')
    // the numeric TextUnited project id is kept for links to the portal
    expect(t.store.documents.get('textunited.state.page1')?.projectId).toBe(400001)
  })
})

describe('team list', () => {
  it('returns active users and collaborators for a fresh query document, once', async () => {
    const t = setup([])
    await t.store.mutate([
      {create: {_id: 'textunited.teamQuery.q1', _type: 'textunited.teamQuery', requestedAt: new Date().toISOString()}},
    ])
    const response = await t.post('/team', {queryId: 'textunited.teamQuery.q1'})
    expect(response.status).toBe(200)
    const body = (await response.json()) as {members: Array<{id: number; name: string; kind: string}>}
    expect(body.members).toEqual([
      {id: 7, username: 'anna@example.com', name: 'Anna Nowak', kind: 'user'},
      {id: 9, username: 'jan@freelance.test', name: 'Jan Kowalski', kind: 'collaborator'},
    ])
    // the query document is used up
    expect(t.store.documents.has('textunited.teamQuery.q1')).toBe(false)
    expect((await t.post('/team', {queryId: 'textunited.teamQuery.q1'})).status).toBe(403)
  })

  it('refuses expired queries, unknown ids and other origins', async () => {
    const t = setup([])
    await t.store.mutate([
      {create: {_id: 'textunited.teamQuery.old', _type: 'textunited.teamQuery', requestedAt: '2020-01-01T00:00:00Z'}},
    ])
    expect((await t.post('/team', {queryId: 'textunited.teamQuery.old'})).status).toBe(403)
    expect((await t.post('/team', {queryId: 'page1'})).status).toBe(400)
    expect((await t.post('/team', {queryId: 'textunited.teamQuery.x'}, 'https://evil.example')).status).toBe(403)
  })
})

describe('team choices in the Studio', () => {
  const person = (id: number, roles: Partial<TeamChoice> = {}): TeamChoice => ({
    id,
    username: `p${id}@example.com`,
    name: `Person ${id}`,
    kind: 'user',
    translator: false,
    proofreader: false,
    projectManager: false,
    ...roles,
  })

  it('needs a translator and sends only people with a role', () => {
    expect(validateTeam([person(1), person(2, {proofreader: true})])).toMatch(/translator/)
    expect(validateTeam([person(1, {translator: true})])).toBeNull()
    expect(teamForRequest([person(1, {translator: true}), person(2)])).toEqual([
      {_key: '1', id: 1, username: 'p1@example.com', translator: true, proofreader: false, projectManager: false},
    ])
  })
})

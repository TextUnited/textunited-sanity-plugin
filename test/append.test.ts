import {describe, expect, it} from 'vitest'

import {getDocumentTypeConfig} from '../src/core/config'
import {extractTranslationUnits} from '../src/core/document/extract'
import {getAtPath, type PlainObject} from '../src/core/document/paths'
import {createTextUnitedRequestHandler} from '../src/server/index'
import {signDocumentId} from '../src/server/signing'
import {createFakeTextUnited, MemoryStore} from './fakes'
import {config, makePage} from './fixtures'

const STUDIO = 'https://example.sanity.studio'
const PROJECT = 'sanity-proj-production-page1'
const HEADING = 'sections[_key=="s1"].heading'
const HEADING_DE = ['sections', {_key: 's1'}, 'heading', {_key: 'de'}, 'value'] as const

/** A handler for an API that supports `appendContent: true`. */
function setup(documents: PlainObject[], fakeOptions: {hangOnPutTask?: string} = {}) {
  const store = new MemoryStore(documents)
  const textUnited = createFakeTextUnited(fakeOptions)
  const handle = createTextUnitedRequestHandler({
    translation: config,
    textUnited: {
      auth: {type: 'pat', token: 'tu_pat_test'},
      capabilities: {appendSegments: true},
      timeoutMs: 50,
    },
    sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
    publicBaseUrl: 'https://www.example.com',
    basePath: '/api/textunited',
    secret: 'test-secret',
    studioOrigins: [STUDIO],
    store,
    fetch: textUnited.fetch,
  })
  let counter = 0
  const requestTranslation = async (languages: string[], mode = 'missing') => {
    counter += 1
    const id = `textunited.request.r${counter}`
    await store.mutate([
      {create: {_id: id, _type: 'textunited.translationRequest', documentId: 'page1', languages, mode, status: 'queued'}},
    ])
    const response = await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: STUDIO},
        body: JSON.stringify({requestId: id}),
      }),
    )
    return (await response.json()) as Record<string, any>
  }
  const notify = async () => {
    const sig = await signDocumentId('test-secret', 'page1')
    const response = await handle(new Request(`https://www.example.com/api/textunited/events?doc=page1&sig=${sig}`))
    return (await response.json()) as Record<string, any>
  }
  const segmentId = (unitId: string) => {
    const page = store.documents.get('drafts.page1') ?? store.documents.get('page1')!
    const units = extractTranslationUnits(page, getDocumentTypeConfig(config, 'page')!, config)
    return units.find((unit) => unit.id === unitId)!.segments[0]!.customId
  }
  const editHeading = async (text: string) => {
    const draft = structuredClone(store.documents.get('drafts.page1')) as any
    draft.sections[0].heading.find((item: any) => item._key === 'en').value = text
    await store.mutate([{createOrReplace: draft}])
  }
  const draftValue = (path: Parameters<typeof getAtPath>[1]) => getAtPath(store.documents.get('drafts.page1'), path)
  const unitState = (unitId: string) =>
    JSON.parse(String(store.documents.get('textunited.state.page1')?.stateJson)).units[unitId]
  const puts = () => textUnited.calls.filter((call) => call.method === 'PUT')
  return {store, textUnited, requestTranslation, notify, segmentId, editHeading, draftValue, unitState, puts}
}

describe('append mode (PUT with appendContent)', () => {
  it('creates the project with only the texts that need translation, in one task', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    const body = await t.requestTranslation(['de'])

    expect(body.status).toBe('done')
    expect(body.summary.tasksSent).toEqual(['content'])
    const post = t.textUnited.calls.find((call) => call.method === 'POST')!
    expect(post.body!.taskId).toBe('content')
    // the heading of s2 and the title already have a German translation
    expect((post.body!.segments as unknown[]).length).toBe(body.summary.unitsSelected)
    expect(t.puts()).toHaveLength(0)
    expect(t.draftValue([...HEADING_DE])).toBe('de:Translate with control')
    expect(t.unitState(HEADING).taskId).toBe('content')
  })

  it('sends a changed text alone as a new task and keeps the existing tasks', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])
    await t.editHeading('Translate with full control')

    const body = await t.requestTranslation(['de'], 'changed')
    expect(body.status).toBe('done')
    const [put] = t.puts()
    expect(t.puts()).toHaveLength(1)
    expect(put!.body).toMatchObject({customId: PROJECT, appendContent: true, instantTranslation: true})
    const taskId = String(put!.body!.taskId)
    expect(taskId).toMatch(/^update-\d{8}-\d{6}-[a-z0-9]{1,6}$/)
    expect(put!.body!.segments).toEqual([{customId: t.segmentId(HEADING), content: 'Translate with full control'}])
    expect(body.summary.tasksSent).toEqual([taskId])

    // the old copy of the segment is still in the project, in the first task
    const copies = [...t.textUnited.projects.get(PROJECT)!.segments.values()].filter(
      (segment) => segment.taskId === 'content' || segment.taskId === taskId,
    )
    expect(copies.some((segment) => segment.content === 'Translate with control')).toBe(true)
    expect(t.draftValue([...HEADING_DE])).toBe('de:Translate with full control')
    expect(t.unitState(HEADING).taskId).toBe(taskId)
  })

  it('reads translations from the task a text was last sent in', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])
    await t.editHeading('Translate with full control')
    await t.requestTranslation(['de'], 'changed')
    const taskId = t.unitState(HEADING).taskId as string
    const segment = t.segmentId(HEADING)

    // a translator works on the outdated copy: it must not reach Sanity
    t.textUnited.review(PROJECT, segment, 'de-de', 'Übersetzen mit Kontrolle', 'proofread', 'content')
    await t.notify()
    expect(t.draftValue([...HEADING_DE])).toBe('de:Translate with full control')

    t.textUnited.review(PROJECT, segment, 'de-de', 'Übersetzen mit voller Kontrolle', 'proofread', taskId)
    const body = await t.notify()
    expect(body.outcomes.applied).toBe(1)
    expect(t.draftValue([...HEADING_DE])).toBe('Übersetzen mit voller Kontrolle')
  })

  it('sends nothing when nothing changed', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])
    const body = await t.requestTranslation(['de'], 'changed')
    expect(body.summary.tasksSent).toEqual([])
    expect(t.puts()).toHaveLength(0)
  })

  it('counts an unanswered append as sent; its translations arrive through notifications', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], {hangOnPutTask: 'append'})
    await t.requestTranslation(['de'])
    await t.editHeading('Translate with full control')

    const body = await t.requestTranslation(['de'], 'changed')
    expect(body.status).toBe('done')
    const taskId = String(t.puts()[0]!.body!.taskId)
    expect(body.summary.tasksAwaitingTranslation).toEqual([taskId])
    expect(t.unitState(HEADING).taskId).toBe(taskId)

    t.textUnited.review(PROJECT, t.segmentId(HEADING), 'de-de', 'Übersetzen mit voller Kontrolle', 'proofread', taskId)
    await t.notify()
    expect(t.draftValue([...HEADING_DE])).toBe('Übersetzen mit voller Kontrolle')
  })
})

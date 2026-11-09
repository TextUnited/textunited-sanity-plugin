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

function setup(documents: PlainObject[]) {
  const store = new MemoryStore(documents)
  const textUnited = createFakeTextUnited()
  const handle = createTextUnitedRequestHandler({
    translation: config,
    textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}},
    sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
    publicBaseUrl: 'https://www.example.com',
    basePath: '/api/textunited',
    secret: 'test-secret',
    cronSecret: 'cron-secret',
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
    await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: STUDIO},
        body: JSON.stringify({requestId: id}),
      }),
    )
  }
  const notify = async (signature?: string) => {
    const sig = signature ?? (await signDocumentId('test-secret', 'page1'))
    const response = await handle(
      new Request(
        `https://www.example.com/api/textunited/events?doc=page1&sig=${sig}&event=new-translation&segment=1&project=2`,
      ),
    )
    return {status: response.status, body: (await response.json()) as Record<string, any>}
  }
  const segmentId = (unitId: string) => {
    const page = store.documents.get('drafts.page1') ?? store.documents.get('page1')!
    const units = extractTranslationUnits(page, getDocumentTypeConfig(config, 'page')!, config)
    return units.find((unit) => unit.id === unitId)!.segments[0]!.customId
  }
  const draftValue = (path: Parameters<typeof getAtPath>[1]) => getAtPath(store.documents.get('drafts.page1'), path)
  return {store, textUnited, handle, requestTranslation, notify, segmentId, draftValue}
}

const HEADING_DE = ['sections', {_key: 's1'}, 'heading', {_key: 'de'}, 'value'] as const

describe('TextUnited notifications', () => {
  it('writes a reviewed translation to the draft', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])
    expect(t.draftValue([...HEADING_DE])).toBe('de:Translate with control')

    t.textUnited.review(PROJECT, t.segmentId('sections[_key=="s1"].heading'), 'de-de', 'Übersetzen mit Kontrolle')
    const {status, body} = await t.notify()

    expect(status).toBe(200)
    expect(body.status).toBe('synced')
    expect(body.outcomes.applied).toBe(1)
    expect(t.draftValue([...HEADING_DE])).toBe('Übersetzen mit Kontrolle')
  })

  it('rejects a notification with a wrong signature', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])
    const {status} = await t.notify('0'.repeat(64))
    expect(status).toBe(401)
  })

  it('does not overwrite a translation an editor changed in Sanity', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])

    const draft = t.store.documents.get('drafts.page1') as any
    draft.sections[0].heading.find((item: any) => item._key === 'de').value = 'Von Hand verbessert'
    await t.store.mutate([{createOrReplace: draft}])

    t.textUnited.review(PROJECT, t.segmentId('sections[_key=="s1"].heading'), 'de-de', 'Übersetzen mit Kontrolle')
    const {body} = await t.notify()
    expect(body.outcomes.keptManualEdit).toBe(1)
    expect(t.draftValue([...HEADING_DE])).toBe('Von Hand verbessert')
  })

  it('does not apply an old translation to a source edited after sending', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])
    const oldSegment = t.segmentId('sections[_key=="s1"].heading')

    const draft = t.store.documents.get('drafts.page1') as any
    draft.sections[0].heading.find((item: any) => item._key === 'en').value = 'Translate with full control'
    await t.store.mutate([{createOrReplace: draft}])

    t.textUnited.review(PROJECT, oldSegment, 'de-de', 'Übersetzen mit Kontrolle')
    const {body} = await t.notify()
    expect(body.sourceChanged).toBe(1)
    expect(t.draftValue([...HEADING_DE])).toBe('de:Translate with control')
  })
})

describe('periodic check', () => {
  it('needs the cron token, then syncs documents that are still being translated', async () => {
    const t = setup([{...makePage(), _id: 'page1'}])
    await t.requestTranslation(['de'])
    expect(t.store.documents.get('textunited.state.page1')?.pending).toBe(true)

    // "approve all" in TextUnited sends no notification; the periodic check catches it
    for (const unitId of [
      'sections[_key=="s1"].heading',
      'sections[_key=="s1"].body[_key=="b1"]',
      'sections[_key=="s1"].body[_key=="b2"]',
    ]) {
      const customId = t.segmentId(unitId)
      const current = t.textUnited.projects.get(PROJECT)!.segments.get(customId)!.translations[0]!
      t.textUnited.review(PROJECT, customId, 'de-de', current.content, 'proofread')
    }

    const denied = await t.handle(new Request('https://www.example.com/api/textunited/sync'))
    expect(denied.status).toBe(401)

    const response = await t.handle(
      new Request('https://www.example.com/api/textunited/sync', {headers: {authorization: 'Bearer cron-secret'}}),
    )
    const body = (await response.json()) as {checked: number; results: Array<{result: {status: string; pending: boolean}}>}
    expect(body.checked).toBe(1)
    expect(body.results[0]?.result).toMatchObject({status: 'synced', pending: false})
    expect(t.store.documents.get('textunited.state.page1')?.pending).toBe(false)
  })
})

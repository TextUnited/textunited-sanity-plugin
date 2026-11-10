import {describe, expect, it} from 'vitest'

import {getAtPath, type PlainObject} from '../src/core/document/paths'
import {createTextUnitedRequestHandler} from '../src/server/index'
import {signDocumentId} from '../src/server/signing'
import {createFakeTextUnited, MemoryStore} from './fakes'
import {config, makePage, makePost} from './fixtures'

// What editors do with the buttons of Sanity's localization plugins, and how the plugin copes.

const STUDIO = 'https://example.sanity.studio'

function setup(documents: PlainObject[], documentId: string) {
  const store = new MemoryStore(documents)
  const textUnited = createFakeTextUnited()
  let counter = 0
  const handle = createTextUnitedRequestHandler({
    translation: config,
    textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}, capabilities: {appendSegments: true}},
    sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
    publicBaseUrl: 'https://www.example.com',
    basePath: '/api/textunited',
    secret: 'test-secret',
    studioOrigins: [STUDIO],
    store,
    fetch: textUnited.fetch,
    // fixed ids, so recreated documents are recognisable
  })
  const request = async (languages: string[], mode = 'changed') => {
    counter += 1
    const id = `textunited.request.r${counter}`
    await store.mutate([
      {create: {_id: id, _type: 'textunited.translationRequest', documentId, languages, mode, status: 'queued'}},
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
  const sync = async () => {
    const sig = await signDocumentId('test-secret', documentId)
    const response = await handle(new Request(`https://www.example.com/api/textunited/events?doc=${documentId}&sig=${sig}`))
    return (await response.json()) as Record<string, any>
  }
  /** Changes the draft the way the Studio form would. */
  const editDraft = async (change: (draft: any) => void) => {
    const draft = structuredClone(store.documents.get(`drafts.${documentId}`) ?? store.documents.get(documentId)) as any
    draft._id = `drafts.${documentId}`
    change(draft)
    await store.mutate([{createOrReplace: draft}])
  }
  const draft = () => store.documents.get(`drafts.${documentId}`) as any
  return {store, textUnited, request, sync, editDraft, draft}
}

const titleIn = (document: any, language: string) =>
  (document.title as Array<{_key: string; value?: string}>).find((item) => item._key === language)

describe('editor actions on translated fields (Internationalized Array)', () => {
  it('a language removed with the minus button is sent again, and only that text', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    await t.request(['de', 'fr'])
    await t.editDraft((draft) => {
      draft.title = draft.title.filter((item: any) => item._key !== 'fr')
    })
    const before = t.textUnited.calls.length
    const body = await t.request(['de', 'fr'])
    expect(body.summary.textsSent).toBe(1)
    const sent = t.textUnited.calls.slice(before).filter((call) => call.method === 'PUT')
    expect(sent.flatMap((call) => call.body!.segments as Array<{content: string}>).map((s) => s.content)).toEqual([
      'Enterprise language layer',
    ])
    expect(titleIn(t.draft(), 'fr')?.value).toBe('fr:Enterprise language layer')
  })

  it('a removed language comes back with the next sync when TextUnited has it', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    await t.request(['fr'])
    await t.editDraft((draft) => {
      draft.title = draft.title.filter((item: any) => item._key !== 'fr')
    })
    const body = await t.sync()
    expect(body.outcomes.applied).toBe(1)
    expect(titleIn(t.draft(), 'fr')?.value).toBe('fr:Enterprise language layer')
  })

  it('a language added from the field menu and left empty is filled, without a second item', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    await t.editDraft((draft) => {
      draft.title.push({_key: 'fr', _type: 'internationalizedArrayStringValue'})
    })
    await t.request(['fr'])
    const french = (t.draft().title as Array<{_key: string}>).filter((item) => item._key === 'fr')
    expect(french).toEqual([{_key: 'fr', _type: 'internationalizedArrayStringValue', value: 'fr:Enterprise language layer'}])
  })

  it('a cleared text is sent again; a text edited by hand is kept on send and sync', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    await t.request(['fr'])
    await t.editDraft((draft) => {
      titleIn(draft, 'fr')!.value = ''
      const heading = draft.sections[0].heading.find((item: any) => item._key === 'fr')
      heading.value = 'Traduire, corrigé à la main'
    })
    const body = await t.request(['fr'])
    expect(body.summary.textsSent).toBe(1)
    expect(titleIn(t.draft(), 'fr')?.value).toBe('fr:Enterprise language layer')
    const heading = ['sections', {_key: 's1'}, 'heading', {_key: 'fr'}, 'value'] as const
    expect(getAtPath(t.draft(), [...heading])).toBe('Traduire, corrigé à la main')
    const synced = await t.sync()
    expect(synced.outcomes.keptManualEdit).toBeGreaterThanOrEqual(1)
    expect(getAtPath(t.draft(), [...heading])).toBe('Traduire, corrigé à la main')
  })

  it('a new page-builder section sends only its texts; reordering sends nothing', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    await t.request(['fr'])
    await t.editDraft((draft) => {
      draft.sections.reverse()
      draft.sections.push({
        _key: 's3',
        _type: 'sectionCta',
        heading: [{_key: 'en', _type: 'internationalizedArrayStringValue', value: 'Talk to us'}],
      })
    })
    const body = await t.request(['fr'])
    expect(body.summary.textsSent).toBe(1)
    expect(getAtPath(t.draft(), ['sections', {_key: 's3'}, 'heading', {_key: 'fr'}, 'value'])).toBe('fr:Talk to us')
    expect((await t.request(['fr'])).summary.textsSent).toBe(0)
  })

  it('a removed section and an emptied source text break nothing', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    await t.request(['fr'])
    await t.editDraft((draft) => {
      draft.sections = draft.sections.filter((section: any) => section._key !== 's2')
      titleIn(draft, 'en')!.value = ''
    })
    expect((await t.sync()).status).toBe('synced')
    const body = await t.request(['fr'])
    expect(body.status).toBe('done')
    expect(body.summary.textsSent).toBe(0)
  })
})

describe('editor actions on translated documents (Document Internationalization)', () => {
  it('fills a language version created from the Translations menu, and gives it a slug', async () => {
    // The Translations menu creates a copy of the English post, linked in the metadata, no slug.
    const copy = {...makePost(), _id: 'drafts.post1-fr', language: 'fr', slug: null}
    const metadata = {
      _id: 'translation.metadata.m1',
      _type: 'translation.metadata',
      translations: [
        {_key: 'en', value: {_type: 'reference', _ref: 'post1'}},
        {_key: 'fr', value: {_type: 'reference', _ref: 'post1-fr'}},
      ],
    }
    const t = setup([makePost(), copy, metadata], 'post1')
    const body = await t.request(['fr'])
    expect(body.status).toBe('done')
    const french = t.store.documents.get('drafts.post1-fr')!
    expect(french.title).toBe('fr:One concept, many words')
    expect(french.slug).toEqual({_type: 'slug', current: 'fr-one-concept-many-words'})
    expect([...t.store.documents.values()].filter((doc) => doc._type === 'post' && doc.language === 'fr')).toHaveLength(1)
  })

  it('recreates a deleted language version and links it in place of the deleted one', async () => {
    const t = setup([makePost()], 'post1')
    await t.request(['de'])
    const german = [...t.store.documents.values()].find((doc) => doc._type === 'post' && doc.language === 'de')!
    // the editor deletes the German post; the metadata still points to it
    await t.store.mutate([{delete: {id: String(german._id)}}])

    const body = await t.request(['de'])
    expect(body.status).toBe('done')
    const recreated = [...t.store.documents.values()].find((doc) => doc._type === 'post' && doc.language === 'de')!
    expect(recreated._id).not.toBe(german._id)
    const metadata = [...t.store.documents.values()].find((doc) => doc._type === 'translation.metadata')!
    const entries = (metadata.translations as Array<{_key: string; value: {_ref: string}}>).filter((e) => e._key === 'de')
    expect(entries.map((entry) => entry.value._ref)).toEqual([String(recreated._id).replace(/^drafts\./, '')])
  })
})

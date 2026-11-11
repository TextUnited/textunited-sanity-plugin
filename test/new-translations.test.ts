import {describe, expect, it} from 'vitest'

import type {TranslationConfig} from '../src/core/config'
import type {PlainObject} from '../src/core/document/paths'
import {createTextUnitedRequestHandler} from '../src/server/index'
import {createFakeTextUnited, MemoryStore} from './fakes'
import {config, makePage, makePost} from './fixtures'

// A new translation must keep everything that is not text: a blog post's main image lost its
// file once, which broke the translated page.

const STUDIO = 'https://example.sanity.studio'

const withImage: TranslationConfig = {
  ...config,
  documentTypes: config.documentTypes.map((entry) =>
    entry.type === 'post' ? {...entry, fields: [...(entry.fields ?? []), 'mainImage']} : entry,
  ),
}

function setup(documents: PlainObject[], documentId: string) {
  const store = new MemoryStore(documents)
  const textUnited = createFakeTextUnited()
  const handle = createTextUnitedRequestHandler({
    translation: withImage,
    textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}},
    sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
    publicBaseUrl: 'https://www.example.com',
    basePath: '/api/textunited',
    secret: 'test-secret',
    studioOrigins: [STUDIO],
    store,
    fetch: textUnited.fetch,
  })
  const request = async (languages: string[]) => {
    await store.mutate([
      {
        create: {
          _id: 'textunited.request.r1',
          _type: 'textunited.translationRequest',
          documentId,
          languages,
          mode: 'changed',
          status: 'queued',
        },
      },
    ])
    const response = await handle(
      new Request('https://www.example.com/api/textunited/jobs', {
        method: 'POST',
        headers: {origin: STUDIO},
        body: JSON.stringify({requestId: 'textunited.request.r1'}),
      }),
    )
    return (await response.json()) as Record<string, any>
  }
  return {store, request}
}

describe('a new translation keeps what is not text', () => {
  it('blog post: the main image keeps its file, body images stay, the canonical URL is not copied', async () => {
    const post = {
      ...makePost(),
      mainImage: {_type: 'image', alt: 'Editor overview', asset: {_type: 'reference', _ref: 'image-main'}},
    }
    const t = setup([post], 'post1')
    expect((await t.request(['de'])).status).toBe('done')

    const german = [...t.store.documents.values()].find((doc) => doc._type === 'post' && doc.language === 'de') as any
    expect(german.mainImage).toEqual({
      _type: 'image',
      alt: 'de:Editor overview',
      asset: {_type: 'reference', _ref: 'image-main'},
    })
    expect(german.body.find((block: any) => block._key === 'img1')?.asset).toEqual({_ref: 'image-1'})
    expect(german.seo.title).toBe('de:Concepts editor')
    // the English page's canonical URL would mark the German page as a duplicate
    expect(german.seo.canonicalUrl).toBeUndefined()
    expect(german.author).toEqual({_type: 'reference', _ref: 'author1'})
  })

  it('page: rich text in a new language keeps its blocks without text', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    expect((await t.request(['fr'])).status).toBe('done')

    const page = (t.store.documents.get('drafts.page1') ?? t.store.documents.get('page1')) as any
    const french = page.sections[0].body.find((item: any) => item._key === 'fr')
    expect(french.value.map((block: any) => block._key)).toEqual(['b1', 'b2', 'code1'])
    expect(french.value[2]).toEqual({_key: 'code1', _type: 'customCode', code: 'npm install'})
    expect(french.value[0].children[0].text).toBe('fr:Plain paragraph.')
  })
})

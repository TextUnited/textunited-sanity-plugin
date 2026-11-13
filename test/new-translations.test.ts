import {describe, expect, it} from 'vitest'

import type {TranslationConfig} from '../src/core/config'
import type {PlainObject} from '../src/core/document/paths'
import {addMissingLocalizedSlugs} from '../src/server/documents'
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

describe('a translated page gets a slug in its language', () => {
  it('adds the slug from the translated title when the page is translated', async () => {
    const t = setup([{...makePage(), _id: 'page1'}], 'page1')
    expect((await t.request(['fr'])).status).toBe('done')

    const page = (t.store.documents.get('drafts.page1') ?? t.store.documents.get('page1')) as any
    expect(page.slug).toEqual([
      {_key: 'en', value: {current: 'enterprise'}},
      {_key: 'de', value: {_type: 'slug', current: 'sprachschicht'}},
      {_key: 'fr', value: {_type: 'slug', current: 'fr-enterprise-language-layer'}},
    ])
  })

  it('keeps the shape of the slug list, leaves existing slugs and drops the " | Brand" part', () => {
    const page: Record<string, any> = {
      title: [
        {_key: 'en', value: 'Enterprise language layer | TextUnited'},
        {_key: 'pl', value: 'Warstwa językowa przedsiębiorstwa | TextUnited'},
        {_key: 'de', value: 'Sprachschicht | TextUnited'},
        {_key: 'zh', value: '企业语言层 | TextUnited'},
        {_key: 'fr', value: ''},
      ],
      slug: [
        {_key: 'k1', _type: 'object', language: 'en', value: {_type: 'slug', current: 'enterprise-language-layer'}},
        {_key: 'k2', _type: 'object', language: 'de', value: {_type: 'slug', current: 'sprachschicht-alt'}},
      ],
    }
    let id = 0
    expect(addMissingLocalizedSlugs(page, 'en', () => `new${++id}`)).toBe(true)
    expect(page.slug).toEqual([
      {_key: 'k1', _type: 'object', language: 'en', value: {_type: 'slug', current: 'enterprise-language-layer'}},
      {_key: 'k2', _type: 'object', language: 'de', value: {_type: 'slug', current: 'sprachschicht-alt'}},
      {_key: 'new1', _type: 'object', language: 'pl', value: {_type: 'slug', current: 'warstwa-jezykowa-przedsiebiorstwa'}},
      {_key: 'new2', _type: 'object', language: 'zh', value: {_type: 'slug', current: 'enterprise-language-layer-zh'}},
    ])
    // nothing more to add
    expect(addMissingLocalizedSlugs(page, 'en', () => 'x')).toBe(false)
  })

  it('leaves the homepage without slugs: it lives at the language root', () => {
    const home: Record<string, any> = {
      isHomepage: true,
      title: [{_key: 'en', value: 'Home'}, {_key: 'pl', value: 'Strona główna'}],
      slug: [{_key: 'en', language: 'en', value: {_type: 'slug', current: 'home'}}],
    }
    expect(addMissingLocalizedSlugs(home, 'en', () => 'x')).toBe(false)
    expect(home.slug).toHaveLength(1)
  })

  it('leaves documents without a per-language slug list alone', () => {
    const single: Record<string, any> = {title: [{_key: 'en', value: 'A'}, {_key: 'pl', value: 'B'}], slug: {_type: 'slug', current: 'a'}}
    expect(addMissingLocalizedSlugs(single, 'en', () => 'x')).toBe(false)
    const none: Record<string, any> = {title: [{_key: 'en', value: 'A'}, {_key: 'pl', value: 'B'}]}
    expect(addMissingLocalizedSlugs(none, 'en', () => 'x')).toBe(false)
  })
})

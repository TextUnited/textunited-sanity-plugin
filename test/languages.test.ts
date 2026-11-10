import {describe, expect, it} from 'vitest'

import type {TranslationConfig} from '../src/core/config'
import {canonicalLanguageCode, findUnknownLanguageCodes, sameLanguageCode} from '../src/core/languages'
import type {PlainObject} from '../src/core/document/paths'
import {createTextUnitedRequestHandler} from '../src/server/index'
import {createFakeTextUnited, MemoryStore} from './fakes'
import {config, makePage} from './fixtures'

const STUDIO = 'https://example.sanity.studio'

describe('language codes', () => {
  it('compares codes the way TextUnited stores them', () => {
    expect(canonicalLanguageCode('zh-CN')).toBe('cn-cn')
    expect(canonicalLanguageCode('en-gb')).toBe('en-en')
    expect(canonicalLanguageCode('DE-DE')).toBe('de-de')
    expect(sameLanguageCode('zh-cn', 'CN-CN')).toBe(true)
    expect(sameLanguageCode('de-de', 'de-at')).toBe(false)
  })

  it('finds unknown codes and suggests known ones for the same language', () => {
    const known = [
      {id: 1, langCode: 'DE-DE', systemName: 'German (Germany)'},
      {id: 2, langCode: 'DE-AT', systemName: 'German (Austria)'},
      {id: 3, langCode: 'CN-CN', systemName: 'Chinese (Simplified)'},
    ]
    expect(
      findUnknownLanguageCodes(
        [
          {label: 'German', code: 'de-xx'},
          {label: 'Chinese', code: 'zh-cn'},
          {label: 'Klingon', code: 'tlh-tlh'},
        ],
        known,
      ),
    ).toEqual([
      {label: 'German', code: 'de-xx', suggestions: ['de-de (German (Germany))', 'de-at (German (Austria))']},
      {label: 'Klingon', code: 'tlh-tlh', suggestions: []},
    ])
  })
})

function setup(translation: TranslationConfig, documents: PlainObject[]) {
  const store = new MemoryStore(documents)
  const textUnited = createFakeTextUnited()
  const handle = createTextUnitedRequestHandler({
    translation,
    textUnited: {auth: {type: 'pat', token: 'tu_pat_test'}, capabilities: {appendSegments: false}},
    sanity: {projectId: 'proj', dataset: 'production', token: 'sk-test'},
    publicBaseUrl: 'https://www.example.com',
    basePath: '/api/textunited',
    secret: 'test-secret',
    studioOrigins: [STUDIO],
    store,
    fetch: textUnited.fetch,
  })
  let counter = 0
  const request = async (languages: string[], mode = 'missing') => {
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
    return (await response.json()) as {status: string; error?: string}
  }
  return {store, textUnited, request}
}

describe('language codes in requests', () => {
  it('refuses an unknown TextUnited code before sending anything', async () => {
    const broken: TranslationConfig = {
      ...config,
      targetLanguages: [{id: 'de', title: 'German', textUnitedCode: 'de-xx'}],
    }
    const t = setup(broken, [{...makePage(), _id: 'page1'}])
    const result = await t.request(['de'])
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/"de-xx" \(German\) – known codes: de-de \(German \(Germany\)\), de-at/)
    expect(t.textUnited.calls.some((call) => call.path === '/segments/projects')).toBe(false)
  })

  it('handles zh-cn, which TextUnited stores as CN-CN', async () => {
    const chinese: TranslationConfig = {
      ...config,
      targetLanguages: [{id: 'zh', title: 'Chinese', textUnitedCode: 'zh-cn'}],
    }
    const t = setup(chinese, [{...makePage(), _id: 'page1'}])
    expect((await t.request(['zh'])).status).toBe('done')
    const draft = t.store.documents.get('drafts.page1') as any
    const heading = draft.sections[0].heading.find((item: any) => item._key === 'zh')
    // the instant translation comes back as CN-CN and still reaches the zh value
    expect(heading?.value).toBe('CN:Translate with control')
    // a second request finds Chinese in the existing project
    expect((await t.request(['zh'], 'all')).status).toBe('done')
  })
})

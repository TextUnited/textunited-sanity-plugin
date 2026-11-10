import {describe, expect, it} from 'vitest'

import {getDocumentTypeConfig} from '../src/core/config'
import {applyTranslations, type TranslationsBySegment} from '../src/core/document/apply'
import {extractTranslationUnits, type TranslationUnit} from '../src/core/document/extract'
import {getAtPath} from '../src/core/document/paths'
import {emptyState, migrateLegacyState, planTranslation, recordSentUnits} from '../src/core/plan'
import {config, makePage, makePost} from './fixtures'

const pageConfig = getDocumentTypeConfig(config, 'page')!
const postConfig = getDocumentTypeConfig(config, 'post')!

/** Fake TextUnited answer: "<lang>:" before every text, keeping span markers. */
function fakeTranslations(units: TranslationUnit[], languages: string[], status = 'translated') {
  const result: TranslationsBySegment = new Map()
  for (const unit of units) {
    for (const segment of unit.segments) {
      const perLanguage = new Map()
      for (const language of languages) {
        const content = segment.content.includes('data-tu-id')
          ? segment.content.replace(/(<span[^>]*>)/g, `$1${language}:`)
          : `${language}:${segment.content}`
        perLanguage.set(language, {content, status})
      }
      result.set(segment.customId, perLanguage)
    }
  }
  return result
}

describe('planTranslation', () => {
  it('selects only values missing in the requested languages, and sends whole tasks', () => {
    const page = makePage()
    const units = extractTranslationUnits(page, pageConfig, config)
    const plan = planTranslation({
      units,
      languages: ['de'],
      targets: {model: 'fieldLevel', document: page},
      state: emptyState(),
      mode: 'missing',
    })

    // title and section s2 already have German; section s1 has none
    expect(plan.selected.map((s) => s.unit.id)).toEqual([
      'sections[_key=="s1"].heading',
      'sections[_key=="s1"].body[_key=="b1"]',
      'sections[_key=="s1"].body[_key=="b2"]',
    ])
    expect(plan.tasks.map((t) => t.taskId)).toEqual(['sections.s1'])
    expect(plan.tasks[0]?.segments).toHaveLength(3)
  })

  it('creates nothing when every value is already translated (no needless project)', () => {
    const post = makePost()
    const units = extractTranslationUnits(post, postConfig, config)
    const translated = applyTranslations({
      units,
      languages: ['de'],
      sourceLanguage: 'en',
      sourceDocument: post,
      targets: {model: 'documentLevel', documents: {de: {_id: 'drafts.post1-de', _type: 'post', language: 'de'}}},
      translations: fakeTranslations(units, ['de']),
      state: emptyState(),
    })
    const plan = planTranslation({
      units,
      languages: ['de'],
      targets: translated.targets,
      state: translated.state,
      mode: 'missing',
    })
    expect(plan.tasks).toEqual([])
  })

  it('in "changed" mode picks up edited source text, but only for units it sent before', () => {
    const page = makePage()
    const units = extractTranslationUnits(page, pageConfig, config)
    const state = recordSentUnits(emptyState(), units)

    page.sections[1]!.heading[0]!.value = 'Book a call'
    const edited = extractTranslationUnits(page, pageConfig, config)
    const plan = planTranslation({
      units: edited,
      languages: ['de'],
      targets: {model: 'fieldLevel', document: page},
      state,
      mode: 'changed',
    })
    expect(plan.selected).toContainEqual(
      expect.objectContaining({reason: 'sourceChanged', unit: expect.objectContaining({id: 'sections[_key=="s2"].heading'})}),
    )
  })
})

describe('applyTranslations', () => {
  it('fills missing values in a fieldLevel page and restores formatting', () => {
    const page = makePage()
    const units = extractTranslationUnits(page, pageConfig, config)
    const result = applyTranslations({
      units,
      languages: ['fr'],
      sourceLanguage: 'en',
      sourceDocument: page,
      targets: {model: 'fieldLevel', document: page},
      translations: fakeTranslations(units, ['fr']),
      state: emptyState(),
    })

    const doc = (result.targets as {document: Record<string, unknown>}).document
    expect(getAtPath(doc, ['title', {_key: 'fr'}, 'value'])).toBe('fr:Enterprise language layer')
    const frBody = getAtPath(doc, ['sections', {_key: 's1'}, 'body', {_key: 'fr'}, 'value']) as Array<{
      _key: string
      children?: Array<{text: string; marks: string[]}>
    }>
    const b2 = frBody.find((b) => b._key === 'b2')!
    expect(b2.children?.map((c) => c.text)).toEqual(['fr:Keep ', 'fr:terms', 'fr: consistent.'])
    expect(b2.children?.[1]?.marks).toEqual(['strong'])
    expect(result.changedFields.get('')).toEqual(new Set(['title', 'sections']))
    // the source document is not modified
    expect(getAtPath(page, ['title', {_key: 'fr'}])).toBeUndefined()
  })

  it('keeps a translation edited by hand, and replaces it only when asked', () => {
    const page = makePage()
    const units = extractTranslationUnits(page, pageConfig, config).filter((u) => u.id === 'title')
    const base = {
      units,
      languages: ['de'],
      sourceLanguage: 'en',
      sourceDocument: page,
      targets: {model: 'fieldLevel' as const, document: page},
      translations: fakeTranslations(units, ['de']),
      state: emptyState(),
    }

    // German title "Sprachschicht" was not written by the plugin
    expect(applyTranslations(base).outcomes[0]?.outcome).toBe('keptManualEdit')
    expect(applyTranslations({...base, overwrite: new Set(['title'])}).outcomes[0]?.outcome).toBe(
      'applied',
    )
  })

  it('updates its own earlier translation when TextUnited sends a reviewed version', () => {
    const page = makePage()
    const units = extractTranslationUnits(page, pageConfig, config).filter((u) => u.id === 'title')
    const first = applyTranslations({
      units,
      languages: ['fr'],
      sourceLanguage: 'en',
      sourceDocument: page,
      targets: {model: 'fieldLevel', document: page},
      translations: fakeTranslations(units, ['fr'], 'automatic'),
      state: emptyState(),
    })
    const reviewed: TranslationsBySegment = new Map([
      [units[0]!.segments[0]!.customId, new Map([['fr', {content: 'Couche linguistique', status: 'proofread'}]])],
    ])
    const second = applyTranslations({
      units,
      languages: ['fr'],
      sourceLanguage: 'en',
      sourceDocument: page,
      targets: first.targets,
      translations: reviewed,
      state: first.state,
    })
    expect(second.outcomes[0]?.outcome).toBe('applied')
    expect(second.state.units.title?.languages.fr?.status).toBe('proofread')
  })

  it('writes into a documentLevel translation and keeps links on translated spans', () => {
    const post = makePost()
    const units = extractTranslationUnits(post, postConfig, config)
    const german = {...structuredClone(post), _id: 'post1-de', language: 'de', body: []}
    const result = applyTranslations({
      units,
      languages: ['de'],
      sourceLanguage: 'en',
      sourceDocument: post,
      targets: {model: 'documentLevel', documents: {de: german}},
      translations: fakeTranslations(units, ['de']),
      state: emptyState(),
    })
    const doc = (result.targets as {documents: Record<string, Record<string, unknown>>}).documents.de!
    const body = doc.body as Array<{_key: string; alt?: string; markDefs?: unknown[]}>
    expect(body.map((b) => b._key)).toEqual(['p1', 'img1', 'p2'])
    expect(body[1]?.alt).toBe('de:Editor screenshot')
    expect(body[2]?.markDefs).toEqual([{_key: 'l1', _type: 'link', href: 'https://docs.textunited.com'}])
    expect(doc.slug).toEqual({current: 'one-concept'})
  })

  it('translates every block of a new documentLevel translation that has no body yet', () => {
    const post = makePost()
    const units = extractTranslationUnits(post, postConfig, config)
    const german: Record<string, unknown> = {_id: 'drafts.post1-de', _type: 'post', language: 'de'}
    const result = applyTranslations({
      units,
      languages: ['de'],
      sourceLanguage: 'en',
      sourceDocument: post,
      targets: {model: 'documentLevel', documents: {de: german}},
      translations: fakeTranslations(units, ['de']),
      state: emptyState(),
    })
    expect(result.outcomes.every((o) => o.outcome === 'applied')).toBe(true)
    const doc = (result.targets as {documents: Record<string, Record<string, unknown>>}).documents.de!
    const body = doc.body as Array<{_key: string; children?: Array<{text: string}>; asset?: unknown}>
    expect(body.map((b) => b._key)).toEqual(['p1', 'img1', 'p2'])
    expect(body[2]?.children?.map((c) => c.text)).toEqual(['de:See ', 'de:the docs'])
    // the image keeps its file reference
    expect(body[1]?.asset).toEqual({_ref: 'image-1'})
    expect((doc.seo as Record<string, unknown>).title).toBe('de:Concepts editor')
    expect((doc.seo as Record<string, unknown>).canonicalUrl).toBeUndefined()
  })

  it('treats a value still identical to the source as untranslated, not as a manual edit', () => {
    const post = makePost()
    const units = extractTranslationUnits(post, postConfig, config)
    const copy = {...structuredClone(post), _id: 'drafts.post1-de', language: 'de'}
    const result = applyTranslations({
      units,
      languages: ['de'],
      sourceLanguage: 'en',
      sourceDocument: post,
      targets: {model: 'documentLevel', documents: {de: copy}},
      translations: fakeTranslations(units, ['de']),
      state: emptyState(),
    })
    expect(result.outcomes.filter((o) => o.outcome === 'keptManualEdit')).toEqual([])
  })

  it('waits until every chunk of a long value is translated', () => {
    const page = makePage()
    page.title[0]!.value = 'Lorem ipsum dolor sit amet. '.repeat(120)
    const units = extractTranslationUnits(page, pageConfig, config).filter((u) => u.id === 'title')
    const translations = fakeTranslations(units, ['fr'])
    translations.delete(units[0]!.segments[1]!.customId)
    const result = applyTranslations({
      units,
      languages: ['fr'],
      sourceLanguage: 'en',
      sourceDocument: page,
      targets: {model: 'fieldLevel', document: page},
      translations,
      state: emptyState(),
    })
    expect(result.outcomes[0]?.outcome).toBe('incomplete')
  })
})

describe('migrateLegacyState', () => {
  it('moves what was sent before several projects existed to the first project', () => {
    const legacy = {
      units: {
        a: {sourceHash: 'h1', sentAt: 't1', taskId: 'update-1', languages: {de: {appliedHash: 'x', status: 'translated'}}},
        b: {sourceHash: 'h2', languages: {}},
      },
    }
    const migrated = migrateLegacyState(legacy, 'proj-1')
    expect(migrated.units.a).toEqual({
      sourceHash: 'h1',
      sentAt: 't1',
      projects: {'proj-1': {sourceHash: 'h1', sentAt: 't1', taskId: 'update-1'}},
      languages: {de: {appliedHash: 'x', status: 'translated'}},
    })
    // a baseline of a value never sent stays as it is
    expect(migrated.units.b).toEqual({sourceHash: 'h2', languages: {}})
    expect(migrateLegacyState(legacy, undefined)).toBe(legacy)
  })
})

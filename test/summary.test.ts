import {describe, expect, it} from 'vitest'

import {getDocumentTypeConfig} from '../src/core/config'
import {extractTranslationUnits} from '../src/core/document/extract'
import {emptyState, recordSentUnits} from '../src/core/plan'
import {badgeLabel, countWords, describePending, summarizePending} from '../src/studio/summary'
import {config, makePage} from './fixtures'

const pageConfig = getDocumentTypeConfig(config, 'page')!

describe('summarizePending', () => {
  it('counts the texts, words and languages a request would send', () => {
    const page = makePage()
    const units = extractTranslationUnits(page, pageConfig, config)
    const summary = summarizePending({
      units,
      targets: {model: 'fieldLevel', document: page},
      state: emptyState(),
      languages: ['de', 'fr'],
    })
    // German has the title and the second heading; French only the second heading
    expect(summary.byLanguage).toEqual({de: 3, fr: 4})
    expect(summary).toMatchObject({texts: 4, untranslated: 4, changed: 0})
    // "Enterprise language layer", "Translate with control", "Plain paragraph.", "Keep terms consistent."
    expect(summary.words).toBe(11)
    expect(describePending(summary)).toBe('4 not translated yet · about 11 words')
  })

  it('reports a source edited after it was sent as changed', () => {
    const page = makePage() as any
    const sent = recordSentUnits(emptyState(), extractTranslationUnits(page, pageConfig, config))
    page.sections[1].heading[0].value = 'Book a free demo'
    const units = extractTranslationUnits(page, pageConfig, config)
    const summary = summarizePending({
      units,
      targets: {model: 'fieldLevel', document: page},
      state: sent,
      languages: ['de'],
    })
    expect(summary).toMatchObject({texts: 4, changed: 1, untranslated: 3})
    expect(describePending(summary)).toBe('1 changed, 3 not translated yet · about 12 words')
  })

  it('counts words of formatted text without its markers', () => {
    expect(countWords('<span data-tu-id="s1">Keep </span><span data-tu-id="s2">terms</span>')).toBe(2)
    expect(countWords('   ')).toBe(0)
  })
})

describe('summarizePending with several projects', () => {
  it('compares an edited text with what each language project was sent', () => {
    const page = makePage() as any
    const units = extractTranslationUnits(page, pageConfig, config)
    // German got everything; French was added later and got nothing yet
    const state = recordSentUnits(emptyState(), units, 't', undefined, 'p-de')
    page.sections[1].heading[0].value = 'Book a free demo'
    const edited = extractTranslationUnits(page, pageConfig, config)
    const summary = summarizePending({
      units: edited,
      targets: {model: 'fieldLevel', document: page},
      state,
      languages: ['de', 'fr'],
      projects: [{customId: 'p-de', languages: ['de']}],
    })
    // German: 3 untranslated + the edited heading. French: 4 untranslated + the edited heading,
    // whose French text was made for the old English wording.
    expect(summary.byLanguage).toEqual({de: 4, fr: 5})
    expect(summary).toMatchObject({texts: 5, changed: 1})
  })
})

describe('badgeLabel', () => {
  const progress = new Map([
    ['de', {reviewed: 5, total: 7}],
    ['pl', {reviewed: 7, total: 7}],
  ])

  it('shows the review progress per language', () => {
    expect(badgeLabel(progress, ['de', 'pl'])).toEqual({label: 'DE 5/7 · PL 7/7', complete: false})
    expect(badgeLabel(new Map([['pl', {reviewed: 7, total: 7}]]), ['pl'])).toEqual({
      label: 'PL 7/7',
      complete: true,
    })
  })

  it('summarises many languages, and shows nothing without a project', () => {
    const many = new Map(['de', 'pl', 'fr', 'it'].map((id) => [id, {reviewed: id === 'de' ? 1 : 3, total: 3}]))
    expect(badgeLabel(many, ['de', 'pl', 'fr', 'it'])).toEqual({label: 'Translated 3/4', complete: false})
    expect(badgeLabel(progress, undefined)).toBeNull()
  })
})

import {describe, expect, it} from 'vitest'

import {getDocumentTypeConfig} from '../src/core/config'
import {extractTranslationUnits} from '../src/core/document/extract'
import {config, makePage, makePost} from './fixtures'

const pageConfig = getDocumentTypeConfig(config, 'page')!
const postConfig = getDocumentTypeConfig(config, 'post')!

describe('extractTranslationUnits: fieldLevel page', () => {
  const units = extractTranslationUnits(makePage(), pageConfig, config)
  const byId = new Map(units.map((unit) => [unit.id, unit]))

  it('finds localized strings and rich-text blocks, and nothing else', () => {
    expect([...byId.keys()]).toEqual([
      'title',
      'sections[_key=="s1"].heading',
      'sections[_key=="s1"].body[_key=="b1"]',
      'sections[_key=="s1"].body[_key=="b2"]',
      'sections[_key=="s2"].heading',
    ])
  })

  it('groups short fields, and gives each page-builder section its own task', () => {
    expect(byId.get('title')?.taskId).toBe('fields')
    expect(byId.get('sections[_key=="s1"].heading')?.taskId).toBe('sections.s1')
    expect(byId.get('sections[_key=="s2"].heading')?.taskId).toBe('sections.s2')
  })

  it('sends a plain paragraph as text and a formatted one with span markers', () => {
    expect(byId.get('sections[_key=="s1"].body[_key=="b1"]')?.segments[0]?.content).toBe(
      'Plain paragraph.',
    )
    expect(byId.get('sections[_key=="s1"].body[_key=="b2"]')?.segments[0]?.content).toBe(
      '<span data-tu-id="c1">Keep </span><span data-tu-id="c2">terms</span><span data-tu-id="c3"> consistent.</span>',
    )
  })

  it('keeps segment ids when sections are reordered', () => {
    const page = makePage()
    page.sections.reverse()
    const reordered = extractTranslationUnits(page, pageConfig, config)
    const ids = (list: typeof units) => new Set(list.flatMap((u) => u.segments.map((s) => s.customId)))
    expect(ids(reordered)).toEqual(ids(units))
  })
})

describe('extractTranslationUnits: documentLevel post', () => {
  const units = extractTranslationUnits(makePost(), postConfig, config)

  it('translates only the configured fields and skips links, slugs and references', () => {
    // document order: seo comes before body in the fixture
    expect(units.map((unit) => unit.id)).toEqual([
      'title',
      'excerpt',
      'seo.title',
      'body[_key=="p1"]',
      'body[_key=="img1"].alt',
      'body[_key=="p2"]',
    ])
  })

  it('keeps the rich text in one task', () => {
    expect(new Set(units.filter((u) => u.id.startsWith('body')).map((u) => u.taskId))).toEqual(
      new Set(['body']),
    )
  })
})

describe('long text', () => {
  it('is split into several segments with distinct ids', () => {
    const page = makePage()
    page.title[0]!.value = 'Lorem ipsum dolor sit amet. '.repeat(120)
    const unit = extractTranslationUnits(page, pageConfig, config).find((u) => u.id === 'title')!
    expect(unit.segments.length).toBeGreaterThan(1)
    expect(new Set(unit.segments.map((s) => s.customId)).size).toBe(unit.segments.length)
    expect(unit.segments.every((s) => s.content.length <= 2000)).toBe(true)
  })
})

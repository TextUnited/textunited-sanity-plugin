import {describe, expect, it} from 'vitest'

import {
  canTranslateDocument,
  checkLocalizationSetup,
  defaultLanguages,
  describeRequest,
  languageOptions,
  languageProgress,
} from '../src/studio/logic'
import {config} from './fixtures'

describe('languageOptions', () => {
  it('offers every language before a project exists, and preselects none', () => {
    const options = languageOptions(config, undefined)
    expect(options.every((option) => option.available)).toBe(true)
    expect(defaultLanguages(options, undefined)).toEqual([])
  })

  it('offers only the project languages once a project exists, and explains why', () => {
    const options = languageOptions(config, ['de'])
    expect(options.find((o) => o.id === 'de')?.available).toBe(true)
    const french = options.find((o) => o.id === 'fr')!
    expect(french.available).toBe(false)
    expect(french.note).toMatch(/not supported yet/)
    expect(defaultLanguages(options, ['de'])).toEqual(['de'])
  })
})

describe('canTranslateDocument', () => {
  it('allows configured types in the source language only', () => {
    expect(canTranslateDocument(config, 'page', {_id: 'p'}).allowed).toBe(true)
    expect(canTranslateDocument(config, 'post', {_id: 'p', language: 'en'}).allowed).toBe(true)
    expect(canTranslateDocument(config, 'post', {_id: 'p', language: 'de'})).toEqual({
      allowed: false,
      reason: 'Translations are requested from the English version',
    })
    expect(canTranslateDocument(config, 'author', {_id: 'a'}).allowed).toBe(false)
    expect(canTranslateDocument(config, 'page', null).reason).toMatch(/Save the document/)
  })
})

describe('describeRequest', () => {
  it('summarises a finished request in plain words', () => {
    expect(describeRequest(null)).toBe('Not translated with TextUnited yet.')
    expect(describeRequest({_id: 'r', status: 'running'})).toMatch(/in progress/)
    expect(describeRequest({_id: 'r', status: 'failed', error: 'Token expired'})).toBe(
      'The last request failed: Token expired',
    )
    expect(
      describeRequest({
        _id: 'r',
        status: 'done',
        summaryJson: JSON.stringify({tasksSent: ['fields', 'body'], projectCreated: true, outcomes: {applied: 4, keptManualEdit: 1}}),
      }),
    ).toBe(
      'Created the TextUnited project and sent 2 part(s) of the document. 4 machine translation(s) added to the draft. 1 translation(s) edited by hand were kept.',
    )
    expect(describeRequest({_id: 'r', status: 'done', summaryJson: '{"tasksSent":[]}'})).toBe(
      'Nothing needed translation in the last request.',
    )
  })
})

describe('languageProgress', () => {
  it('counts texts confirmed by translators per language, among the texts sent', () => {
    const stateJson = JSON.stringify({
      units: {
        title: {sentAt: 'x', languages: {pl: {status: 'proofread'}, de: {status: 'automatic'}}},
        body: {sentAt: 'x', languages: {pl: {status: 'translated'}, de: {status: 'translated'}}},
        never: {languages: {pl: {status: 'automatic'}}},
      },
    })
    const progress = languageProgress(stateJson)
    expect(progress.get('pl')).toEqual({reviewed: 2, total: 2})
    expect(progress.get('de')).toEqual({reviewed: 1, total: 2})
    expect(languageProgress('not json').size).toBe(0)
  })

  it('counts a sent text still waiting for TextUnited in every project language', () => {
    const stateJson = JSON.stringify({
      units: {title: {sentAt: 'x', languages: {pl: {status: 'proofread'}}}, body: {sentAt: 'x', languages: {}}},
    })
    const progress = languageProgress(stateJson, ['pl', 'de'])
    expect(progress.get('pl')).toEqual({reviewed: 1, total: 2})
    expect(progress.get('de')).toEqual({reviewed: 0, total: 2})
  })
})


describe('checkLocalizationSetup', () => {
  const withBoth = ['page', 'post', 'internationalizedArrayString', 'translation.metadata']

  it('accepts a Studio with the localization plugins the configured types need', () => {
    expect(checkLocalizationSetup(config, 'page', withBoth)).toBeNull()
    expect(checkLocalizationSetup(config, 'post', withBoth)).toBeNull()
    expect(checkLocalizationSetup(config, 'author', [])).toBeNull()
  })

  it('names the missing plugin', () => {
    expect(checkLocalizationSetup(config, 'page', ['page', 'translation.metadata'])).toMatch(
      /Internationalized Array plugin/,
    )
    expect(checkLocalizationSetup(config, 'post', ['post', 'internationalizedArrayString'])).toMatch(
      /Document Internationalization plugin/,
    )
  })
})

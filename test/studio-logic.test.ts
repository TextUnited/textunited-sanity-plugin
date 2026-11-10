import {describe, expect, it} from 'vitest'

import {
  canTranslateDocument,
  checkLanguageIds,
  checkLocalizationSetup,
  describeRequest,
  languageProgress,
  readTranslationState,
} from '../src/studio/logic'
import {config} from './fixtures'

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
  const projects = [
    {customId: 'p1', languages: ['pl', 'de']},
    {customId: 'p2', languages: ['fr']},
  ]
  const sent = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, {sourceHash: 'h', sentAt: 'x'}]))

  it('counts, per language, the texts sent to its project and the ones translators confirmed', () => {
    const progress = languageProgress(
      {
        units: {
          title: {sourceHash: 'h', projects: sent('p1', 'p2'), languages: {pl: {appliedHash: 'a', status: 'proofread'}, fr: {appliedHash: 'a', status: 'translated'}}},
          body: {sourceHash: 'h', projects: sent('p1'), languages: {pl: {appliedHash: 'a', status: 'translated'}, de: {appliedHash: 'a', status: 'automatic'}}},
          never: {sourceHash: 'h', languages: {pl: {appliedHash: 'a', status: 'automatic'}}},
        },
      },
      projects,
    )
    expect(progress.get('pl')).toEqual({reviewed: 2, total: 2})
    expect(progress.get('de')).toEqual({reviewed: 0, total: 2})
    // French was ordered later, for the title only
    expect(progress.get('fr')).toEqual({reviewed: 1, total: 1})
  })
})

describe('readTranslationState', () => {
  it('reads states written before documents could have several projects', () => {
    const read = readTranslationState({
      projectCustomId: 'p1',
      projectLanguages: ['de'],
      projectType: 'inHouse',
      stateJson: JSON.stringify({units: {title: {sourceHash: 'h', sentAt: 'x', taskId: 't1', languages: {}}}}),
    })
    expect(read.projects).toEqual([{customId: 'p1', languages: ['de'], projectType: 'inHouse'}])
    expect(read.state.units.title?.projects).toEqual({p1: {sourceHash: 'h', sentAt: 'x', taskId: 't1'}})
    expect(readTranslationState(null).projects).toEqual([])
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

describe('checkLanguageIds', () => {
  const field = (key: string, value: string) => ({_key: key, _type: 'internationalizedArrayStringValue', value})

  it('accepts documents that use the configured ids', () => {
    expect(checkLanguageIds(config, 'page', {_id: 'p', title: [field('en', 'Hi'), field('de', 'Hallo')]})).toBeNull()
    expect(checkLanguageIds(config, 'page', {_id: 'p'})).toBeNull()
    expect(checkLanguageIds(config, 'post', {_id: 'p', language: 'de'})).toBeNull()
  })

  it('explains ids that do not match the localization plugin', () => {
    expect(checkLanguageIds(config, 'page', {_id: 'p', title: [field('en-US', 'Hi')]})).toMatch(
      /use the language ids “en-US”, but the translation configuration expects “en”/,
    )
    expect(checkLanguageIds(config, 'post', {_id: 'p', language: 'en-US'})).toMatch(
      /language is “en-US”, which is not in the translation configuration/,
    )
  })
})

describe('describeRequest for stop and resume', () => {
  it('names the language', () => {
    expect(describeRequest({_id: 'r', status: 'done', summaryJson: JSON.stringify({action: 'stop', languages: ['fr'], tasksSent: []})})).toBe(
      'Stopped translating FR.',
    )
    expect(describeRequest({_id: 'r', status: 'done', summaryJson: JSON.stringify({action: 'resume', languages: ['fr'], tasksSent: []})})).toBe(
      'Resumed translating FR.',
    )
  })
})

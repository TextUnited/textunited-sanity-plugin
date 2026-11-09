import {describe, expect, it} from 'vitest'

import {stableHash} from '../src/core/hash'
import {
  createProjectCustomId,
  createSegmentCustomId,
  createTaskId,
  getBaseDocumentId,
  pathToString,
} from '../src/core/ids'

describe('stableHash', () => {
  it('is deterministic and 32 hex characters long', () => {
    expect(stableHash('body[_key=="a1"]')).toBe(stableHash('body[_key=="a1"]'))
    expect(stableHash('x')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('differs for different input, including non-ASCII text', () => {
    expect(stableHash('zażółć')).not.toBe(stableHash('zazolc'))
    expect(stableHash('a')).not.toBe(stableHash('b'))
  })
})

describe('pathToString', () => {
  it('writes keys, indexes and nested fields like Sanity', () => {
    expect(pathToString(['sections', {_key: 'a1'}, 'heading'])).toBe('sections[_key=="a1"].heading')
    expect(pathToString(['tags', 2])).toBe('tags[2]')
    expect(pathToString(['seo', 'title'])).toBe('seo.title')
  })
})

describe('getBaseDocumentId', () => {
  it('strips draft and release prefixes', () => {
    expect(getBaseDocumentId('drafts.abc')).toBe('abc')
    expect(getBaseDocumentId('versions.rel1.abc')).toBe('abc')
    expect(getBaseDocumentId('abc')).toBe('abc')
  })
})

describe('createProjectCustomId', () => {
  it('is the same for the draft and the published document', () => {
    const base = {sanityProjectId: 'vboowpxm', dataset: 'production'}
    expect(createProjectCustomId({...base, documentId: 'drafts.70ac2ee4'})).toBe(
      createProjectCustomId({...base, documentId: '70ac2ee4'}),
    )
    expect(createProjectCustomId({...base, documentId: '70ac2ee4'})).toBe(
      'sanity-vboowpxm-production-70ac2ee4',
    )
  })
})

describe('createTaskId', () => {
  it('uses the top-level field and the array item key', () => {
    expect(createTaskId('body')).toBe('body')
    expect(createTaskId('sections', {_key: 'a1'})).toBe('sections.a1')
    expect(createTaskId('items', 3)).toBe('items.3')
  })
})

describe('createSegmentCustomId', () => {
  it('depends only on the path, so moving other items does not change it', () => {
    const id = createSegmentCustomId(['sections', {_key: 'a1'}, 'heading'])
    expect(createSegmentCustomId(['sections', {_key: 'a1'}, 'heading'])).toBe(id)
    expect(createSegmentCustomId(['sections', {_key: 'b2'}, 'heading'])).not.toBe(id)
    expect(id).toMatch(/^seg-[0-9a-f]{32}$/)
  })
})

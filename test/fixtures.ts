import type {TranslationConfig} from '../src/core/config'

export const config: TranslationConfig = {
  sourceLanguage: {id: 'en', title: 'English', textUnitedCode: 'en-us'},
  targetLanguages: [
    {id: 'de', title: 'German', textUnitedCode: 'de-de'},
    {id: 'fr', title: 'French', textUnitedCode: 'fr-fr'},
  ],
  documentTypes: [
    {type: 'page', model: 'fieldLevel'},
    {type: 'post', model: 'documentLevel', fields: ['title', 'excerpt', 'body', 'seo']},
  ],
  skipBlockTypes: ['customCode'],
}

const str = (key: string, value: string) => ({
  _key: key,
  _type: 'internationalizedArrayStringValue',
  value,
})

const block = (key: string, children: unknown[], markDefs: unknown[] = []) => ({
  _key: key,
  _type: 'block',
  style: 'normal',
  markDefs,
  children,
})

const span = (key: string, text: string, marks: string[] = []) => ({
  _key: key,
  _type: 'span',
  text,
  marks,
})

/** A page that keeps all languages in internationalized arrays (fieldLevel). */
export function makePage() {
  return {
    _id: 'drafts.page1',
    _type: 'page',
    slug: [{_key: 'en', value: {current: 'enterprise'}}],
    title: [str('en', 'Enterprise language layer'), str('de', 'Sprachschicht')],
    internalNote: 'not localized, never sent',
    sections: [
      {
        _key: 's1',
        _type: 'sectionHero',
        heading: [str('en', 'Translate with control')],
        ctaUrl: 'https://www.textunited.com/demo',
        body: [
          {
            _key: 'en',
            _type: 'internationalizedArrayBlockContentValue',
            value: [
              block('b1', [span('c1', 'Plain paragraph.')]),
              block('b2', [span('c1', 'Keep '), span('c2', 'terms', ['strong']), span('c3', ' consistent.')]),
              {_key: 'code1', _type: 'customCode', code: 'npm install'},
            ],
          },
        ],
      },
      {
        _key: 's2',
        _type: 'sectionCta',
        heading: [str('en', 'Book a demo'), str('de', 'Demo buchen'), str('fr', 'Réserver')],
      },
    ],
  }
}

/** An English blog post; translations are separate documents (documentLevel). */
export function makePost() {
  return {
    _id: 'post1',
    _type: 'post',
    language: 'en',
    title: 'One concept, many words',
    excerpt: 'How the Concepts editor works.',
    slug: {current: 'one-concept'},
    author: {_type: 'reference', _ref: 'author1'},
    publishedAt: '2026-08-11T04:22:58Z',
    seo: {title: 'Concepts editor', canonicalUrl: 'https://www.textunited.com/blog/one-concept'},
    body: [
      block('p1', [span('c1', 'First paragraph.')]),
      {_key: 'img1', _type: 'image', alt: 'Editor screenshot', asset: {_ref: 'image-1'}},
      block('p2', [span('c1', 'See '), span('c2', 'the docs', ['l1'])], [
        {_key: 'l1', _type: 'link', href: 'https://docs.textunited.com'},
      ]),
    ],
  }
}

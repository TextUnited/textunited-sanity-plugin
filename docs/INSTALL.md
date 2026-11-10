# Installing the TextUnited plugin for Sanity

This guide sets up TextUnited translations for a Sanity project. When it is done, editors get a
**Translation** panel in Sanity Studio. It sends the texts of a document to TextUnited, adds a
machine translation to the draft right away, and replaces it with the reviewed translation as
translators confirm it in TextUnited.

Setting it up takes about 30 minutes, and you need someone who can change the code and the
hosting settings of the website.

## How it works

The plugin has two parts:

- **Studio part**: the Translation panel and the progress badge in Sanity Studio. It holds no
  secrets.
- **Server part**: a small API route on your website. It holds the TextUnited and Sanity tokens,
  talks to TextUnited, receives TextUnited's notifications and writes translations to Sanity.

```
Sanity Studio ──"translate this document"──▶ your website /api/textunited ──▶ TextUnited
                                                   ▲                              │
                                                   └──── "a translation changed" ─┘
                                             writes translations to Sanity drafts
```

Each Sanity document gets **one TextUnited project**, kept for its whole life. The first request
creates the project. Every later request adds only the new and changed texts to it.

## What you need

| | |
|---|---|
| Sanity Studio | v3.40 or later, v4 or v5 |
| Localization in Sanity | one of Sanity's two localization plugins, see the next section |
| A website or server for the server part | Next.js (App Router) is supported directly. Any runtime with web `Request`/`Response` works too (Node 20+, Bun, Deno, Remix, Hono). |
| A public HTTPS address of that website | TextUnited sends its notifications there, e.g. `https://www.example.com` |
| A TextUnited account | with the target languages you want to order |

## Before you start: how does your Studio store translations?

Sanity Studio has no translations of its own. A Studio stores them in one of two ways, each
provided by a plugin from the Sanity team. The TextUnited plugin writes translations in the
same format, so the Studio needs **at least one of them**:

| Model in the TextUnited configuration | Sanity plugin it needs | How translations are stored |
|---|---|---|
| `fieldLevel` | [sanity-plugin-internationalized-array](https://github.com/sanity-io/sanity-plugin-internationalized-array) | One document. Each translatable field holds a value per language (a title in English, German, Polish…). Common for pages. |
| `documentLevel` | [@sanity/document-internationalization](https://github.com/sanity-io/document-internationalization) | One document per language, linked together. Common for blog posts. |

How to check which one you have: open `sanity.config.ts` and look for `internationalizedArray(`
or `documentInternationalization(` in the `plugins` list. Many Studios use both, each for
different document types; then set the model per document type in step 3.

**Neither is installed?** Then the Studio and the website show content in one language only.
Add one of the two plugins first, following its own guide, and update the website so that it
shows the translated content. Choose `fieldLevel` when the pages share their structure across
languages, and `documentLevel` when each language needs its own document (for example its own
slug or a different set of blog posts).

The TextUnited plugin does not replace these plugins: they give editors the form fields for each
language, and they keep your content in a standard format, so the website and other tools can
read it without the TextUnited plugin.

If a document type is set up with a model whose plugin is missing, the Translation panel says so
instead of offering to send texts.

## Step 1. Create the tokens

### TextUnited personal access token

1. Sign in to the TextUnited portal and open the personal access tokens of your account.
2. Create a token with the scopes **`projects:read`** and **`projects:write`**.
3. Choose its validity (at most 365 days) and copy the token, which starts with `tu_pat_`. It is
   shown only once.

Projects are created in the account the token belongs to. Keep using tokens of the same
TextUnited account. A token of another account cannot see the existing projects, and the plugin
would start new ones.

TextUnited warns before the token expires. Create a new token and replace the old one in the
website's environment variables (step 5). Nothing else changes.

### Sanity token

In [sanity.io/manage](https://www.sanity.io/manage), open the project, go to **API → Tokens**,
and add a token with the **Editor** permission. The plugin uses it to write translations to
drafts and to keep its own records.

### A random secret

The plugin signs the notification addresses it gives TextUnited. Generate a long random value,
for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 2. Install the package

The package is published on npm as
[`@textunited/sanity-plugin`](https://www.npmjs.com/package/@textunited/sanity-plugin). Install
it in the folder of the Studio and in the folder of the website (often the same repository):

```bash
npm install @textunited/sanity-plugin
```

(`pnpm add`, `yarn add` and `bun add` work the same way.)

## Step 3. Describe your content

Create one configuration file that both the Studio and the website import, for example
`translation.config.ts`:

```ts
import type {TranslationConfig} from '@textunited/sanity-plugin/server'

export const translationConfig: TranslationConfig = {
  // The language editors write in. Translations are always made from it.
  sourceLanguage: {id: 'en', title: 'English', textUnitedCode: 'en-us'},

  // Languages editors can order. `id` is the language id used in Sanity,
  // `textUnitedCode` the TextUnited language code.
  targetLanguages: [
    {id: 'de', title: 'German', textUnitedCode: 'de-de'},
    {id: 'fr', title: 'French', textUnitedCode: 'fr-fr'},
    {id: 'pl', title: 'Polish', textUnitedCode: 'pl-pl'},
  ],

  documentTypes: [
    // One document with translated fields (internationalized arrays)
    {type: 'page', model: 'fieldLevel'},

    // One document per language (document internationalization).
    // List the fields to translate; everything else is copied from the source.
    {type: 'post', model: 'documentLevel', fields: ['title', 'excerpt', 'body', 'seo']},
  ],

  // Optional: rich-text blocks copied as they are, never translated
  skipBlockTypes: ['code', 'table'],
}
```

Notes:

- Only the document types listed here get the Translate button.
- `fieldLevel` translates every internationalized field of the document, at any depth (page
  builder sections included). Plain `string` fields are not touched.
- `documentLevel` creates the translated documents as drafts when they do not exist yet, with a
  slug made from the translated title, and links them in the translation metadata.
- Technical fields (slugs, URLs, links, images and similar) are never sent. Add more with
  `skipFields: ['fieldName']` on a document type.

## Step 4. Add the plugin to the Studio

In `sanity.config.ts`:

```ts
import {defineConfig} from 'sanity'
import {textUnitedTranslations} from '@textunited/sanity-plugin/studio'

import {translationConfig} from './translation.config'

export default defineConfig({
  // ...your existing settings
  plugins: [
    // ...your existing plugins
    textUnitedTranslations({
      translation: translationConfig,
      // The server route from step 5
      handlerUrl: 'https://www.example.com/api/textunited',
      // Optional: which project types editors may choose (default: both)
      // projectTypes: ['outsourced', 'inHouse'],
      // defaultProjectType: 'outsourced',
      // Optional: "Open in TextUnited" link in the Translation panel
      // projectUrl: (id) => `<TextUnited portal address>/project-packages?projectId=${id}`,
    }),
  ],
})
```

Deploy (or restart) the Studio afterwards. Editors who will translate need permission to create
documents in the dataset, which the standard Editor and Administrator roles have.

## Step 5. Add the server route

### Next.js (App Router)

Create `app/api/textunited/[...route]/route.ts`:

```ts
import {createTextUnitedRouteHandlers} from '@textunited/sanity-plugin/next'

import {translationConfig} from '@/translation.config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// TextUnited may take a while to prepare the machine translation of a long document
export const maxDuration = 300

export const {GET, POST, OPTIONS} = createTextUnitedRouteHandlers({
  translation: translationConfig,
  textUnited: {
    auth: {type: 'pat', token: process.env.TEXTUNITED_TOKEN!},
    // Optional: services of new outsourced projects
    // project: {serviceProofreading: true, styleGuideId: 123},
  },
  sanity: {
    projectId: process.env.SANITY_PROJECT_ID!,
    dataset: process.env.SANITY_DATASET!,
    token: process.env.SANITY_WRITE_TOKEN!,
  },
  // Public HTTPS address of this website, and where the route is mounted
  publicBaseUrl: 'https://www.example.com',
  basePath: '/api/textunited',
  secret: process.env.TEXTUNITED_PLUGIN_SECRET!,
  cronSecret: process.env.CRON_SECRET,
  // Studios allowed to send translation requests
  studioOrigins: ['https://your-project.sanity.studio', 'http://localhost:3333'],
})
```

### Other frameworks

`@textunited/sanity-plugin/server` exports `createTextUnitedRequestHandler(options)` with the same
options. It returns a function that takes a web `Request` and returns a `Response`. Send every
request under `basePath` to it.

### Environment variables

Add these to the website's hosting (for example Vercel → Project → Settings → Environment
Variables) and redeploy:

| Variable | Value |
|---|---|
| `TEXTUNITED_TOKEN` | TextUnited personal access token (step 1) |
| `SANITY_PROJECT_ID` | Sanity project id |
| `SANITY_DATASET` | Sanity dataset, e.g. `production` |
| `SANITY_WRITE_TOKEN` | Sanity token with Editor permission (step 1) |
| `TEXTUNITED_PLUGIN_SECRET` | the random secret (step 1) |
| `CRON_SECRET` | optional; a second random value for the periodic check (step 6) |

Keep the tokens on the server only. Never put them in the Studio configuration or in variables
that reach the browser (for example `NEXT_PUBLIC_…` or `SANITY_STUDIO_…`).

## Step 6. Schedule the periodic check

TextUnited sends a notification when a translator changes a translation, but not when a project
manager approves all segments at once. A periodic check covers that case. Call
`GET https://www.example.com/api/textunited/sync` with the header
`Authorization: Bearer <CRON_SECRET>` (or `<TEXTUNITED_PLUGIN_SECRET>` when no `CRON_SECRET` is
set), for example every 15 minutes.

On Vercel, add to `vercel.json` (Vercel sends `CRON_SECRET` automatically):

```json
{"crons": [{"path": "/api/textunited/sync", "schedule": "*/15 * * * *"}]}
```

Elsewhere, use any scheduler (GitHub Actions, a cron job, an uptime monitor that can send a
header).

## Step 7. Check that it works

1. In the Studio, open a document of a configured type in the source language and click the
   **Translation** icon in the document's header (or choose **Translate** in the `⋯` menu next
   to Publish). The Translation panel opens next to the document.
2. Tick one target language and click **Send N texts to TextUnited**.
3. After a few seconds the panel's history shows *Created the TextUnited project and sent N
   text(s)*, and the draft contains machine translations.
4. In the TextUnited portal, the project is named after the document's title.
5. Confirm a segment in TextUnited. Within a minute (or at the next periodic check) the reviewed
   text replaces the machine translation in the draft.
6. Publish the document to show the translations on the website.

## Using it

**The Translation panel** opens from the icon in the document's header. It shows:

- how many texts need translation (changed since they were sent, or not translated yet) and
  about how many words, with one button to send them
- each language with its review progress in TextUnited
- *Open in TextUnited*, a link to the project (when the `projectUrl` option is set)
- the last requests

The document's footer shows a badge with the review progress, e.g. *DE 5/7 · PL 7/7*, and the
Studio shows a short message when reviewed translations arrive while the panel is open.

**Target languages.** The first request decides the languages of the document's TextUnited
project. Languages that are not in the project are listed under *Not in this project*; adding a
language to an existing project is not supported by TextUnited yet.

**Who translates** (first request of a document only):

- *TextUnited translators (outsourced)*: TextUnited manages the project and assigns translators.
- *Your own team (in-house)*: pick people of your TextUnited account and their roles. At least
  one translator is needed. The Studio remembers the roles for the next document.

**What is sent.** *Send N texts* sends the texts that have no translation yet in a chosen
language and the texts whose source was edited since they were sent; translations of edited
texts are replaced. Other translations stay as they are. Under **More options**,
*Retranslate everything* sends all texts again and replaces every translation, including ones
edited by hand in Sanity.

Translations edited by hand in Sanity are kept when TextUnited sends an update, unless the
source text was edited or *Retranslate everything* was used.

## Troubleshooting

| Message or symptom | Cause and fix |
|---|---|
| *The translation server could not be reached* | `handlerUrl` in the Studio is wrong, the website is not deployed, or the Studio's address is missing from `studioOrigins`. |
| *TextUnited request failed with status 401* | The TextUnited token expired, was revoked or lacks the `projects:read` / `projects:write` scopes. Create a new one and update `TEXTUNITED_TOKEN`. |
| *TextUnited request failed with status 500* | An error on the TextUnited side. Check the project settings (for example a `styleGuideId` that does not exist in the account) and contact TextUnited support with the error signature from the message. |
| *An in-house project needs at least one translator* | Tick **Translator** for at least one person. |
| *The TextUnited project for this document has no de translation* | The language is not in the document's TextUnited project (see *Target languages*). |
| Machine translations appear, reviewed ones never do | The website cannot be reached by TextUnited over HTTPS, or the periodic check is not scheduled (step 6). |
| *Translations are requested from the English version* | For one-document-per-language types, open the source-language document. |

## What the plugin stores in Sanity

Besides the translations themselves, the plugin keeps small private documents (their ids contain
a dot, so they are never public and do not appear in the Studio's lists):

- `textunited.request.*`: one per click on Translate, with its result
- `textunited.state.<document id>`: what was sent to TextUnited and when, per document
- `textunited.teamQuery.*`: short-lived, used to list people for in-house projects

Do not delete the `textunited.state.*` documents: they link each document to its TextUnited
project.

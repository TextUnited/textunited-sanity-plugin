# @textunited/sanity-plugin

Translate Sanity content with TextUnited. One package with three entry points:

| Import | Runs in | Purpose |
|---|---|---|
| `@textunited/sanity-plugin/studio` | Sanity Studio (browser) | Translate action and translation status in the Studio |
| `@textunited/sanity-plugin/server` | the customer's server | Framework-independent handler (web `Request`/`Response`) that talks to TextUnited and writes translations to Sanity |
| `@textunited/sanity-plugin/next` | Next.js App Router | Thin adapter around the server handler |

The TextUnited access token and the Sanity write token are used only on the server. The Studio
entry never contains server code.

## Status

Work in progress, not published. Internal TextUnited package (`UNLICENSED`, `private`); it will be
published to the TextUnited registry (`https://npm.textunited.com/`), not to the public npm.

Done:
- package layout, build (ESM + CJS + types), tests
- TextUnited Segments API client (personal access token or company id + API key)
- stable identifiers: one TextUnited project per Sanity document, one task per part of the
  document (each page-builder section, each rich-text field, all short fields together),
  segment ids derived from the path to the text
- extracting translatable values for field-level (internationalized arrays) and
  document-level localization, including Portable Text with marks and long-text chunks
- modes `missing`, `changed` and `all`, deciding which tasks to send
- writing translations back: missing values are filled, the plugin's own earlier translations
  are updated, values edited by hand in Sanity are kept unless `all` is requested

- translation requests on the server (`POST {basePath}/jobs`): the Studio creates a
  `textunited.translationRequest` document and sends its id (allowed Studio origins only), or a
  signed Sanity webhook does; the server creates the TextUnited project once, then replaces only
  the changed tasks, writes the instant machine translation to drafts, and keeps the state in a
  private `textunited.state.<document id>` document
- documentLevel: new translations are created as drafts with a slug from the translated title
  and linked in the translation metadata
- a translation whose source changed is replaced; one edited by hand is kept otherwise

- TextUnited notifications (`{basePath}/events?doc=…&sig=…`): the URL is stable per document
  and signed; each notification fetches the document's segments from TextUnited and writes
  reviewed translations to the drafts. Translations of a source edited after sending are not
  applied. Concurrent notifications are safe (revision check on the state, with retries).
- periodic check (`{basePath}/sync`, `Authorization: Bearer <cronSecret>`): syncs documents
  that may still receive translations, which also covers TextUnited's "approve all", which sends
  no notification. Run it from a cron job, e.g. every 15 minutes.

- Studio: a "Translate" document action on the configured types (source-language documents
  only). Its dialog shows the TextUnited status of the document, lets editors pick languages
  (only the project's languages once a project exists) and one of three clearly described
  modes, creates the request document and follows it until the server has finished.

- outsourced or in-house projects: for a new project the editor picks who translates. In-house
  lists the people of the TextUnited account (`GET /accounts/Users` and `/accounts/Collaborators`,
  same token scopes) and sends the chosen team with roles. The list is returned only for a fresh
  `textunited.teamQuery.*` document, so it is not public.
- TextUnited calls time out after 90 s; a task that did not answer counts as sent and its
  translations arrive through notifications or the periodic check.

Tried on the TextUnited website (local Studio + Next.js, test documents): pages, a blog post,
outsourced and in-house projects.

- append mode (`textUnited.capabilities.appendSegments: true`) for APIs where
  `PUT /segments/projects` supports `appendContent: true` (today: the TextUnited dev API,
  `https://devapinew.textunited.com`): the project is created with the texts that need
  translation as task `content`; each later request sends only its new and changed texts as one
  new task `update-<UTC date>-<time>-<random>`, and nothing in the project is replaced. The state
  remembers the task each text was last sent in, and translations are read only from that task.

Next:
1. make append mode the default once the production API supports it
2. confirm how customers get access to the TextUnited registry (docs/INSTALL.md, step 2)

## Installation

Step-by-step guide for customers: [docs/INSTALL.md](docs/INSTALL.md).

## Usage

Shared configuration, imported by both the Studio and the site:

```ts
// translation.config.ts
import type {TranslationConfig} from '@textunited/sanity-plugin/server'

export const translationConfig: TranslationConfig = {
  sourceLanguage: {id: 'en', title: 'English', textUnitedCode: 'en-us'},
  targetLanguages: [
    {id: 'de', title: 'German', textUnitedCode: 'de-de'},
    {id: 'pl', title: 'Polish', textUnitedCode: 'pl-pl'},
  ],
  documentTypes: [
    {type: 'page', model: 'fieldLevel'},
    {type: 'post', model: 'documentLevel', fields: ['title', 'excerpt', 'body', 'seo']},
  ],
}
```

Studio:

```ts
import {textUnitedTranslations} from '@textunited/sanity-plugin/studio'

plugins: [
  textUnitedTranslations({
    translation: translationConfig,
    handlerUrl: 'https://www.example.com/api/textunited',
  }),
]
```

Next.js, `app/api/textunited/[...route]/route.ts`:

```ts
import {createTextUnitedRouteHandlers} from '@textunited/sanity-plugin/next'

export const runtime = 'nodejs'
export const maxDuration = 300

export const {GET, POST, OPTIONS} = createTextUnitedRouteHandlers({
  translation: translationConfig,
  textUnited: {auth: {type: 'pat', token: process.env.TEXTUNITED_TOKEN!}},
  sanity: {projectId: 'abc123', dataset: 'production', token: process.env.SANITY_WRITE_TOKEN!},
  publicBaseUrl: 'https://www.example.com',
  basePath: '/api/textunited',
  secret: process.env.TEXTUNITED_PLUGIN_SECRET!,
  cronSecret: process.env.CRON_SECRET,
  studioOrigins: ['https://example.sanity.studio', 'http://localhost:3333'],
})
```

Periodic check, e.g. `vercel.json`: `{"crons": [{"path": "/api/textunited/sync", "schedule": "*/15 * * * *"}]}`.

Known limits:
- In field-level documents, text inside custom objects embedded in a localized rich-text field
  is copied, not translated.
- Blocks removed from the source stay in existing translations until the next full update.
- A language cannot be added to an existing TextUnited project yet (API limitation); the request
  fails with an explanation.
- documentLevel: references in a new translation (author, categories) still point to the
  source-language documents.

## TextUnited API today

Production: `PUT /segments/projects` replaces a whole task (virtual file) on every update, and
TextUnited then repackages the whole project. The package therefore sends each changed part of a
document as its own task, so an update touches only that part (default,
`appendSegments: false`).

Dev API (`https://devapinew.textunited.com`): `appendContent: true` adds the segments as a new
task and leaves existing tasks and their work untouched; the task id must be new (HTTP 400
otherwise). Enable it with `textUnited: {baseUrl: 'https://devapinew.textunited.com',
capabilities: {appendSegments: true}}`. Outdated copies of edited texts stay in the earlier tasks
in TextUnited; translators may still see them, the package ignores them.

## Setup on the customer's side (planned)

- TextUnited personal access token with the scopes `projects:read` and `projects:write`
- Sanity token with write access
- public HTTPS address of the site that hosts the server handler
- a random secret for signing notification URLs

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

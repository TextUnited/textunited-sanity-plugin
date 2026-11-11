# Changelog

## 0.1.2 – 2026-11-11

- Fix: the link between a document and its translations (`translation.metadata`, documentLevel)
  was created with a dotted id, which Sanity treats as private. A website reading without a
  token could not see it, so its language switcher sent visitors to a page that does not exist.
  New links get a plain id, as the Studio creates them. Links made by 0.1.0 and 0.1.1 can be
  recreated under a plain id (same content) and the dotted ones deleted.

## 0.1.1 – 2026-11-11

- Fix: a new translation lost what is not text. A blog post translated into a new language
  kept only the alt text of its main image (no file), which broke the translated page; rich
  text in a new language lost its blocks without text (images, code, tables). New
  translations now start as a copy of the source, with the texts replaced by their
  translations; canonical URLs are not copied, so the translation does not point search
  engines to the source page.

## 0.1.0 – 2026-11-10

First release.

- Translate Sanity documents with TextUnited from a panel in the Studio: what needs translation
  with a word count, one button to send, review progress per language, a badge in the document
  footer, links to the TextUnited projects, history.
- One permanent TextUnited project per document; later changes are added as new tasks
  (`appendContent`), only the new and changed texts.
- Field-level (Internationalized Array) and document-level (Document Internationalization)
  localization, Portable Text with marks.
- Outsourced and in-house projects, with the team picked from the TextUnited account.
- Languages added later are ordered as a separate project; reset to a new project; stop and
  resume a language per document.
- Notifications from TextUnited and a periodic check write reviewed translations to drafts;
  translations edited by hand in Sanity are kept.
- Checks of the setup (localization plugins, language ids, TextUnited language codes).

/**
 * TextUnited language codes.
 *
 * TextUnited accepts a few common codes that are not in its language list and stores them as its
 * own code (TextUnited `Languages.GetLanguageByCode`): a project ordered for `zh-cn` comes back as
 * `CN-CN`. Codes are therefore compared in this canonical form, never as written.
 */
const ALIASES: Record<string, string> = {
  'en-gb': 'en-en',
  'en-uk': 'en-en',
  'zh-cn': 'cn-cn',
  'zh-tw': 'ct-ct',
}

/** The code as TextUnited stores it, lower case, e.g. `zh-CN` → `cn-cn`. */
export function canonicalLanguageCode(code: string | null | undefined): string {
  const lower = String(code ?? '').trim().toLowerCase()
  return ALIASES[lower] ?? lower
}

/** True when both codes mean the same TextUnited language. */
export function sameLanguageCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalLanguageCode(a) === canonicalLanguageCode(b)
}

/** One language of `GET /integrations/languages`. */
export type TextUnitedLanguage = {
  id: number
  systemName: string
  langCode: string
  generalLangCode?: string
}

/**
 * Codes of a configuration that TextUnited does not know, with suggestions of known codes for the
 * same language (same first part, e.g. `de-de`, `de-at` for `de-xx`).
 */
export function findUnknownLanguageCodes(
  codes: Array<{label: string; code: string}>,
  known: TextUnitedLanguage[],
): Array<{label: string; code: string; suggestions: string[]}> {
  const knownCodes = new Set(known.map((language) => language.langCode.toLowerCase()))
  const unknown: Array<{label: string; code: string; suggestions: string[]}> = []
  for (const {label, code} of codes) {
    if (knownCodes.has(canonicalLanguageCode(code))) continue
    const general = canonicalLanguageCode(code).split('-')[0]
    const suggestions = known
      .filter((language) => language.langCode.toLowerCase().split('-')[0] === general)
      .slice(0, 5)
      .map((language) => `${language.langCode.toLowerCase()} (${language.systemName})`)
    unknown.push({label, code, suggestions})
  }
  return unknown
}

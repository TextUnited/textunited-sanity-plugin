// Request and response shapes of the TextUnited Segments API (`/segments/projects`).
// Field names follow the API's JSON (camelCase). Only the fields this package uses are typed.

export type SegmentStatus =
  | 'untranslated'
  | 'draft'
  | 'automatic'
  | 'pretranslated'
  | 'translated'
  | 'proofread'

export type ProjectSegment = {
  customId: string
  content: string
  notes?: string
  taskId?: string
}

/** A person in an in-house project team (TextUnited `ProjectTeamMember`). */
export type ProjectTeamMember = {
  id?: number
  username: string
  isProjectManager: boolean
  isTranslator: boolean
  isProofreader: boolean
  isInCountryReviewer: boolean
}

/** A user or collaborator of the TextUnited company who can join an in-house team. */
export type TeamCandidate = {
  id: number
  username: string
  name: string
  kind: 'user' | 'collaborator'
}

export type ProjectTargetLanguage = {
  targetLanguageCode: string
  /** In-house projects: the people who work on this language */
  team?: ProjectTeamMember[]
  managedProject: boolean
  serviceTranslation: boolean
  serviceProofreading: boolean
  serviceAutomaticTranslation: boolean
  serviceAdaptiveTranslation?: boolean
  serviceScoring: boolean
  styleGuideId?: number
}

export type CreateProjectRequest = {
  customId: string
  taskId: string
  name: string
  sourceLanguageCode: string
  targetLanguages: ProjectTargetLanguage[]
  segments: ProjectSegment[]
  instantTranslation?: boolean
  eventUrl?: string
  referenceNumber?: string
  customField1?: string
  customField2?: string
}

export type UpdateProjectRequest = {
  customId: string
  taskId: string
  segments: ProjectSegment[] | null
  instantTranslation?: boolean
  appendContent: boolean
  eventUrl?: string
  name?: string
}

export type InstantTranslation = {
  source?: {customId?: string; content?: string}
  translations?: Array<{
    languageCode?: string
    content?: string
    status?: SegmentStatus | string
  }>
}

export type ProjectResponse = {
  id?: number
  customId?: string
  name?: string
  sourceLanguageCode?: string
  targetLanguages?: Array<
    ProjectTargetLanguage & {
      id?: number
      progress?: number | null
      state?: string | null
    }
  >
  eventUrl?: string
  /** The task an append update added (also when the server generated its id) */
  taskId?: string | null
  instantTranslationSegments?: InstantTranslation[]
}

export type SegmentWithTranslations = {
  source?: {
    customId?: string
    content?: string
    taskId?: string | null
  }
  translations?: Array<{
    languageCode?: string
    content?: string
    status?: SegmentStatus | string
  }>
}

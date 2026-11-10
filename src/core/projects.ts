/**
 * The TextUnited projects of one Sanity document.
 *
 * A document starts with one project. TextUnited cannot add a language to an existing project, so
 * languages added later get a project of their own; each language belongs to exactly one project.
 * A reset moves the current projects to `archived` and starts again with a new one.
 */
export type ProjectType = 'outsourced' | 'inHouse'

export type ProjectRecord = {
  /** Custom id of the TextUnited multilingual project */
  customId: string
  /** Sanity language ids of the project */
  languages: string[]
  projectType?: ProjectType
  /** Numeric id of the TextUnited project, for links to the portal */
  projectId?: number
  createdAt?: string
}

export type DocumentProjects = {
  projects: ProjectRecord[]
  archived: ProjectRecord[]
  /**
   * Languages an editor stopped for this document: nothing is sent, written or restored for them
   * any more. They stay in their TextUnited project.
   */
  stopped: string[]
}

function isProjectType(value: unknown): value is ProjectType {
  return value === 'outsourced' || value === 'inHouse'
}

function toRecord(value: unknown): ProjectRecord | null {
  const record = value as Record<string, unknown> | null
  if (!record || typeof record.customId !== 'string') return null
  return {
    customId: record.customId,
    languages: Array.isArray(record.languages) ? record.languages.map(String) : [],
    ...(isProjectType(record.projectType) ? {projectType: record.projectType} : {}),
    ...(typeof record.projectId === 'number' ? {projectId: record.projectId} : {}),
    ...(typeof record.createdAt === 'string' ? {createdAt: record.createdAt} : {}),
  }
}

/**
 * Projects stored in the plugin's state document: `projectsJson`, or the single-project fields of
 * states written before documents could have several projects.
 */
export function readProjects(document: Record<string, unknown> | null | undefined): DocumentProjects {
  if (!document) return {projects: [], archived: [], stopped: []}
  if (typeof document.projectsJson === 'string') {
    try {
      const parsed = JSON.parse(document.projectsJson) as {projects?: unknown[]; archived?: unknown[]; stopped?: unknown[]}
      return {
        projects: (parsed.projects ?? []).map(toRecord).filter((p): p is ProjectRecord => p !== null),
        archived: (parsed.archived ?? []).map(toRecord).filter((p): p is ProjectRecord => p !== null),
        stopped: Array.isArray(parsed.stopped) ? parsed.stopped.map(String) : [],
      }
    } catch {
      // fall back to the single-project fields
    }
  }
  if (typeof document.projectCustomId !== 'string') return {projects: [], archived: [], stopped: []}
  const legacy = toRecord({
    customId: document.projectCustomId,
    languages: document.projectLanguages,
    projectType: document.projectType,
    projectId: document.projectId,
  })
  return {projects: legacy ? [legacy] : [], archived: [], stopped: []}
}

/** The projects with only the languages that are not stopped; projects left with none are dropped. */
export function activeProjects(projects: ProjectRecord[], stopped: string[]): ProjectRecord[] {
  if (stopped.length === 0) return projects
  return projects
    .map((project) => ({...project, languages: project.languages.filter((language) => !stopped.includes(language))}))
    .filter((project) => project.languages.length > 0)
}

/** The project a language belongs to, if any. */
export function projectForLanguage(projects: ProjectRecord[], language: string): ProjectRecord | undefined {
  return projects.find((project) => project.languages.includes(language))
}

/** All languages of the document's projects. */
export function projectLanguages(projects: ProjectRecord[]): string[] {
  return [...new Set(projects.flatMap((project) => project.languages))]
}

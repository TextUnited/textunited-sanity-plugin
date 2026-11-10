import type {TranslationConfig} from '../core/config'
import type {ProjectType} from './logic'

export type TextUnitedStudioOptions = {
  translation: TranslationConfig
  /**
   * Full URL of the server handler's base path, e.g. https://www.example.com/api/textunited.
   * The Studio sends translation requests there; it never talks to TextUnited directly and
   * never holds the TextUnited token. The Studio's origin must be in the server's
   * `studioOrigins`.
   */
  handlerUrl: string
  /** Project types editors may choose for a new project. Defaults to both. */
  projectTypes?: ProjectType[]
  /** Preselected type for a new project. Defaults to `outsourced`. */
  defaultProjectType?: ProjectType
  /**
   * Address of a project in the TextUnited portal, for the "Open in TextUnited" link, e.g.
   * `(id) => 'https://portal.example/project-packages?projectId=' + id`. No link without it.
   */
  projectUrl?: (projectId: number) => string
}

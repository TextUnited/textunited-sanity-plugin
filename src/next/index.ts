import {createTextUnitedRequestHandler, type TextUnitedHandlerOptions} from '../server/index'

export type {TextUnitedHandlerOptions} from '../server/index'

/**
 * Next.js App Router adapter. Use it in a catch-all route, for example
 * `app/api/textunited/[...route]/route.ts`:
 *
 * ```ts
 * import {createTextUnitedRouteHandlers} from '@textunited/sanity-plugin/next'
 *
 * export const {GET, POST} = createTextUnitedRouteHandlers({basePath: '/api/textunited', ...})
 * export const runtime = 'nodejs'
 * ```
 */
export function createTextUnitedRouteHandlers(options: TextUnitedHandlerOptions) {
  const handle = createTextUnitedRequestHandler(options)
  return {
    GET: (request: Request) => handle(request),
    POST: (request: Request) => handle(request),
    OPTIONS: (request: Request) => handle(request),
  }
}

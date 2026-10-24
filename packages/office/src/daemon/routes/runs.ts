/** The run routes, a stub: each answers 501 not_implemented until the run views land. */
import { HttpError, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

const PATHS = [
  "/runs",
  "/runs/:id",
  "/runs/:id/nodes",
  "/runs/:id/events",
  "/runs/:id/events/:seq",
  "/runs/:id/log",
] as const

/** The run routes. The message names the route pattern because a handler can't see its request path. */
export const ROUTES: readonly Route<RequestContext>[] = PATHS.map((path) => ({
  method: "GET",
  path,
  handler: () => {
    throw new HttpError(501, "not_implemented", `GET ${path} is not implemented yet`)
  },
}))

/** Identity routes: the office's liveness probe and process info, who a request acts as, logging in, and humans'
 *  devices and passwords. */
import { actingPerson } from "../auth.ts"
import type { Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

/** `{person: handle, device: name | null}`: who this request acts as, and from which device. */
export function whoami(ctx: RequestContext): { person: string; device: string | null } {
  return { person: actingPerson(ctx), device: ctx.device }
}

/** The identity routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  // `{"ok": true}`, exactly: the office is answering. Served without a token.
  { method: "GET", path: "/health", handler: () => ({ ok: true }) },
  { method: "GET", path: "/whoami", handler: whoami },
]

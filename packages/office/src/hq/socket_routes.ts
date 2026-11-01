/** HQ's routes on the office socket, which HQ's listeners never serve: status, one-time links, browser sessions. */
import { Ack, BrowserSession, type CompanyView, HqStatus, PairCode, PairCodeRequest } from "@opencorp/protocol"
import { z } from "zod"
import { actingPerson } from "../daemon/auth.ts"
import { HttpError, type Route } from "../daemon/http.ts"
import type { RequestContext } from "../daemon/office.ts"
import type { Hq } from "./core.ts"

/** The office's HQ, or a 501 naming `what` (the route's method and pattern). */
function hqOf(ctx: RequestContext, what: string): Hq {
  const hq = ctx.office.hq
  if (hq === undefined) throw new HttpError(501, "not_implemented", `${what} is not implemented yet`)
  return hq
}

/** Refuses unless `handle` is a human at HEAD and `actor` is them or the CEO (the rule for devices). */
function checkFor(view: CompanyView | null, handle: string, actor: string): void {
  const person = view?.people.find((p) => p.handle === handle)
  if (person === undefined) throw new HttpError(404, "not_found", `no person @${handle}`)
  // A 422 names the field, not its value.
  if (person.kind !== "human")
    throw new HttpError(422, "not_a_human", "the person is an agent; agents don't sign in to HQ")
  if (actor !== handle && actor !== view?.company?.ceo)
    throw new HttpError(403, "forbidden", `only @${handle} or the CEO can do this for @${handle}`)
}

/** HQ's socket routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  // Where HQ listens, and its health.
  {
    method: "GET",
    path: "/hq",
    reply: HqStatus,
    handler: (ctx) => hqOf(ctx, "GET /hq").status(),
  },
  // A one-time link that signs a browser in as `handle` (the asking person by default). In no-device mode the
  // asking person is the CEO; pairing writes no person.yaml, so enforcement doesn't change.
  {
    method: "POST",
    path: "/hq/pair",
    body: PairCodeRequest,
    reply: PairCode,
    // Without HQ the 501 comes before the body is read.
    guard: (ctx) => void hqOf(ctx, "POST /hq/pair"),
    handler: async (ctx, _params, body) => {
      const hq = hqOf(ctx, "POST /hq/pair")
      const { handle, open_file } = body as z.output<typeof PairCodeRequest>
      const actor = actingPerson(ctx)
      const who = handle ?? actor
      checkFor(await hq.snapshots.head(), who, actor)
      return hq.mint(who, { issuer: actor, openFile: open_file })
    },
  },
  // A person's browser sessions on this office, newest first. A person who left the company can't be listed (404):
  // their sessions fail the check and are deleted on first use. Sessions a password change ended are deleted here
  // rather than listed, and expired ones are left out (and pruned at office start and on each new session).
  {
    method: "GET",
    path: "/hq/browsers",
    reply: z.array(BrowserSession),
    handler: async (ctx) => {
      const hq = hqOf(ctx, "GET /hq/browsers")
      const actor = actingPerson(ctx)
      const handle = ctx.query.getAll("person").at(-1) || actor
      // The person and their sessions are checked at one commit.
      const view = await hq.snapshots.head()
      checkFor(view, handle, actor)
      return (await hq.sessions.listLive(handle, view!.sha)).map((r) => r.public())
    },
  },
  // Ends one browser session, its open streams included.
  {
    method: "DELETE",
    path: "/hq/browsers/:id",
    reply: Ack,
    handler: async (ctx, params) => {
      const hq = hqOf(ctx, "DELETE /hq/browsers/:id")
      const record = ctx.office.store.getHqSession(params.id!)
      if (record === undefined) throw new HttpError(404, "not_found", `no browser session ${params.id}`)
      checkFor(await hq.snapshots.head(), record.person, actingPerson(ctx))
      await hq.sessions.revoke(record.id)
      return { ok: true }
    },
  },
]

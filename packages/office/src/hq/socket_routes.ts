/** HQ's routes on the office socket, which HQ's listeners never serve: status, one-time links, browser sessions. */
import { Ack, BrowserSession, type CompanyView, HqStatus, PairCode, PairCodeRequest } from "@opencorp/protocol"
import { z } from "zod"
import { doesntLoad, personFileBroken } from "../company/loader.ts"
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

/** Refuses unless `handle` is a human at HEAD and `actor` is them or the CEO (the rule for devices); the company it
 *  checked. */
function checkFor(view: CompanyView | null, handle: string, actor: string): CompanyView {
  const person = view?.people.find((p) => p.handle === handle)
  if (view === null || person === undefined) {
    const message = personFileBroken(view?.issues ?? [], handle) ? doesntLoad(handle) : `no person @${handle}`
    throw new HttpError(404, "not_found", message)
  }
  // A 422 names the field, not its value.
  if (person.kind !== "human")
    throw new HttpError(422, "not_a_human", "the person is an agent; agents don't sign in to HQ")
  if (actor !== handle && actor !== view.company?.ceo)
    throw new HttpError(403, "forbidden", `only @${handle} or the CEO can do this for @${handle}`)
  return view
}

/** `checkFor` for a person's stored browser sessions: the CEO may also list and end those of a handle that isn't a
 *  human at HEAD (anymore) but has `stored` sessions, which nothing else could reach. */
function checkBrowsersFor(view: CompanyView | null, handle: string, actor: string, stored: boolean): void {
  const person = view?.people.find((p) => p.handle === handle)
  if (stored && view !== null && person?.kind !== "human" && actor === view.company?.ceo) return
  checkFor(view, handle, actor)
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
      const view = checkFor(await hq.snapshots.head(), who, actor)
      // The commit the person was checked at, so a code for someone removed before it's used signs nobody in.
      return hq.mint(who, { issuer: actor, openFile: open_file, sha: view.sha })
    },
  },
  // A person's browser sessions on this office, newest first. Only the CEO may list a person who isn't a human at HEAD
  // (anymore) and still has stored sessions; everyone else, and any other handle, gets 404 or 422 as for devices. Sessions a password change or a removal of their person
  // since they were issued ended are deleted here rather than listed; expired ones are pruned at office start and on
  // each new session.
  {
    method: "GET",
    path: "/hq/browsers",
    reply: z.array(BrowserSession),
    handler: async (ctx) => {
      const hq = hqOf(ctx, "GET /hq/browsers")
      const actor = actingPerson(ctx)
      const handle = ctx.query.getAll("person").at(-1) || actor
      const stored = ctx.office.store.listHqSessions(handle).length > 0
      checkBrowsersFor(await hq.snapshots.head(), handle, actor, stored)
      return (await hq.sessions.listLive(handle)).map((r) => r.public())
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
      checkBrowsersFor(await hq.snapshots.head(), record.person, actingPerson(ctx), true)
      await hq.sessions.revoke(record.id)
      return { ok: true }
    },
  },
]

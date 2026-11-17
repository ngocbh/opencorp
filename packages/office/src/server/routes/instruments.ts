/** Instrument routes: a session's live instruments, an instrument's screen for a client joining late, and the
 *  approver's keys and size for a shell. Anyone who may read the session may watch them; only its approver may type
 *  or resize, so other people's clients never fight over a shell's size.
 *
 *  The keys' body is never logged, recorded or kept: it goes straight to the instrument, and the pipeline logs no
 *  request body. A refused request is refused in the guard, before a byte of it is read. */
import {
  Ack,
  Instrument,
  InstrumentKeysRequest,
  InstrumentScreen,
  InstrumentSizeRequest,
} from "@opencorp/protocol"
import { z } from "zod"
import { loadRepo } from "../../company/loader.ts"
import { approverOf } from "../../runtime/sessions/harness.ts"
import type { LiveInstrument } from "../../runtime/sessions/instruments.ts"
import type { SessionRecord } from "../../runtime/store/store.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

/** The owner's Ctrl-C, all a pipes shell takes. */
const CTRL_C = "\x03"

/** The stored session `id`, or 404. */
function stored(ctx: RequestContext, id: string): SessionRecord {
  const found = ctx.office.store.getSession(id)
  if (found === undefined) throw new HttpError(404, "not_found", `no session ${id}`)
  return found
}

/** Session `:id`'s instrument `:iid`, or 404. */
function live(ctx: RequestContext, params: Params): LiveInstrument {
  const session = stored(ctx, params.id!)
  const found = ctx.office.instruments.get(session.id, params.iid!)
  if (found === undefined) throw new HttpError(404, "not_found", `no instrument ${params.iid} in session ${session.id}`)
  return found
}

/** Refuses 403 `forbidden` unless the request's person is the session's approver (its opener, else the CEO at its
 *  pinned commit); then 404 unless the session lists the instrument. */
async function onlyApprover(ctx: RequestContext, params: Params): Promise<void> {
  const session = stored(ctx, params.id!)
  // The pinned company is read only when it names the approver: for a session nobody opened.
  const pinned = session.opened_by === null ? loadRepo(await ctx.office.git.pin(session.repo_commit)) : undefined
  const approver = approverOf(session, pinned?.company?.ceo ?? null)
  if (approver === null) throw new HttpError(403, "forbidden", "nobody may type into this session's shells")
  if (actingPerson(ctx) !== approver) {
    throw new HttpError(403, "forbidden", `only @${approver} may type into or resize this session's shells`)
  }
  live(ctx, params)
}

/** 409 `not_live` once the instrument has ended or failed: it stays listed, with its scrollback, for its host to
 *  remove. */
function running(instrument: LiveInstrument): void {
  const { status } = instrument.info()
  if (status === "ended" || status === "failed") throw new HttpError(409, "not_live", `this shell has ${status}`)
}

/** The session's instruments, oldest first; their output comes as `instrument.output` events. */
export function listInstruments(ctx: RequestContext, params: Params) {
  return ctx.office.instruments.list(stored(ctx, params.id!).id)
}

/** What the office still holds of the instrument's output, starting at a line; the client applies `instrument.output`
 *  past its `end`. */
export function screen(ctx: RequestContext, params: Params) {
  live(ctx, params)
  const { offset, end, data } = ctx.office.instruments.screen(params.id!, params.iid!)!
  return { offset, end, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64") }
}

/** The approver's keys, straight to the shell's running program. A pipes shell takes only Ctrl-C, which interrupts
 *  its command (409 `not_interactive` for other keys); a shell that ended takes none (409 `not_live`). */
export function keys(ctx: RequestContext, params: Params, body: unknown) {
  const { data } = body as z.output<typeof InstrumentKeysRequest>
  const instrument = live(ctx, params)
  running(instrument)
  if (instrument.interactive) instrument.keys(data)
  else if (data === CTRL_C) instrument.interrupt()
  else throw new HttpError(409, "not_interactive", "this shell takes no keys but Ctrl-C, which interrupts its command")
  return { ok: true }
}

/** The approver's view's size, which the shell's PTY takes and every other viewer draws at. */
export function resize(ctx: RequestContext, params: Params, body: unknown) {
  const { cols, rows } = body as z.output<typeof InstrumentSizeRequest>
  const instrument = live(ctx, params)
  running(instrument)
  if (!instrument.interactive) throw new HttpError(409, "not_interactive", "this shell has no terminal to resize")
  instrument.resize(cols, rows)
  ctx.office.instruments.updated(params.id!, params.iid!)
  return { ok: true }
}

/** The instrument routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  { method: "GET", path: "/sessions/:id/instruments", reply: z.array(Instrument), handler: listInstruments },
  { method: "GET", path: "/sessions/:id/instruments/:iid/screen", reply: InstrumentScreen, handler: screen },
  {
    method: "POST",
    path: "/sessions/:id/instruments/:iid/keys",
    guard: onlyApprover,
    body: InstrumentKeysRequest,
    reply: Ack,
    handler: keys,
  },
  {
    method: "POST",
    path: "/sessions/:id/instruments/:iid/size",
    guard: onlyApprover,
    body: InstrumentSizeRequest,
    reply: Ack,
    handler: resize,
  },
]

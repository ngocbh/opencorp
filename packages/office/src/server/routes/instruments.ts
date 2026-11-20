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
import type { Instruments, LiveInstrument } from "../../runtime/sessions/instruments.ts"
import type { SessionRecord } from "../../runtime/store/store.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

/** What the instrument routes need of their host: a session by its id, who answers for it, and the live instruments.
 *  `Office` fits; so does the no-office host. */
export interface InstrumentsHost {
  /** Session `id`, or undefined when there is none. */
  session(id: string): SessionRecord | undefined
  /** Who may type into and resize `session`'s shells: its approver, or null for nobody. */
  approver(session: SessionRecord): string | null | Promise<string | null>
  readonly instruments: Pick<Instruments, "list" | "get" | "screen" | "updated">
}

/** What the routes read of a request: who it acts as. */
export interface InstrumentsRequest {
  readonly person: string | null
}

/** The owner's Ctrl-C, all a pipes shell takes. */
const CTRL_C = "\x03"

/** The instrument routes for requests `C` of the host `of` gives. */
export function instrumentRoutes<C extends InstrumentsRequest>(of: (ctx: C) => InstrumentsHost): Route<C>[] {
  /** The session `id`, or 404. */
  const stored = (host: InstrumentsHost, id: string): SessionRecord => {
    const found = host.session(id)
    if (found === undefined) throw new HttpError(404, "not_found", `no session ${id}`)
    return found
  }

  /** Session `:id`'s instrument `:iid`, or 404. */
  const live = (host: InstrumentsHost, params: Params): LiveInstrument => {
    const session = stored(host, params.id!)
    const found = host.instruments.get(session.id, params.iid!)
    if (found === undefined) {
      throw new HttpError(404, "not_found", `no instrument ${params.iid} in session ${session.id}`)
    }
    return found
  }

  /** Refuses 403 `forbidden` unless the request's person is the session's approver (on the office, its opener, else
   *  the CEO at its pinned commit); then 404 unless the session lists the instrument. */
  const onlyApprover = async (ctx: C, params: Params): Promise<void> => {
    const host = of(ctx)
    const approver = await host.approver(stored(host, params.id!))
    if (approver === null) throw new HttpError(403, "forbidden", "nobody may type into this session's shells")
    if (actingPerson(ctx) !== approver) {
      throw new HttpError(403, "forbidden", `only @${approver} may type into or resize this session's shells`)
    }
    live(host, params)
  }

  /** The session's instruments, oldest first; their output comes as `instrument.output` events. */
  const listInstruments = (ctx: C, params: Params) => {
    const host = of(ctx)
    return host.instruments.list(stored(host, params.id!).id)
  }

  /** What the host still holds of the instrument's output, starting at a line; the client applies
   *  `instrument.output` past its `end`. */
  const screen = (ctx: C, params: Params) => {
    const host = of(ctx)
    live(host, params)
    const { offset, end, data } = host.instruments.screen(params.id!, params.iid!)!
    return { offset, end, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64") }
  }

  /** The approver's keys, straight to the shell's running program. A pipes shell takes only Ctrl-C, which interrupts
   *  its command (409 `not_interactive` for other keys); a shell still starting, or one that ended, takes none (409
   *  `not_live`). */
  const keys = (ctx: C, params: Params, body: unknown) => {
    const { data } = body as z.output<typeof InstrumentKeysRequest>
    const instrument = live(of(ctx), params)
    running(instrument)
    if (instrument.interactive) instrument.keys(data)
    else if (data === CTRL_C) instrument.interrupt()
    else throw new HttpError(409, "not_interactive", "this shell takes no keys but Ctrl-C, which interrupts its command")
    return { ok: true }
  }

  /** The approver's view's size, which the shell's PTY takes and every other viewer draws at. */
  const resize = (ctx: C, params: Params, body: unknown) => {
    const { cols, rows } = body as z.output<typeof InstrumentSizeRequest>
    const host = of(ctx)
    const instrument = live(host, params)
    running(instrument)
    if (!instrument.interactive) throw new HttpError(409, "not_interactive", "this shell has no terminal to resize")
    instrument.resize(cols, rows)
    host.instruments.updated(params.id!, params.iid!)
    return { ok: true }
  }

  return [
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
}

/** 409 `not_live` while the instrument is still starting, and once it has ended or failed (it stays listed, with its
 *  scrollback, for its host to remove): it would drop the keys. */
function running(instrument: LiveInstrument): void {
  const { status } = instrument.info()
  if (status === "starting") throw new HttpError(409, "not_live", "this shell is still starting; try once it is ready")
  if (status === "ended" || status === "failed") throw new HttpError(409, "not_live", `this shell has ${status}`)
}

/** The office's instrument routes. */
export const ROUTES: readonly Route<RequestContext>[] = instrumentRoutes<RequestContext>((ctx) => ctx.office)

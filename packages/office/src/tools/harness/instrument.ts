/** A harness instrument: one chat's sessions of one harness (Codex, Claude Code), by name, as its host binds them. The
 *  agent starts a session, sends it messages, interrupts and stops it, and reads its record; it sets none of its
 *  trust. Each harness names itself (`Harness`); the rest is the same for every one.
 *
 *  **The host binds the trust**: each session is its own harness session, opened under the employee's permission (the
 *  host's `open`), on the harness's own login, asking nothing. The model names only the message.
 *
 *  **Two speakers.** The owner can open a session and write to the harness too. Every message carries its author,
 *  which the host labels for the harness and the record alike (`label`), and the owner's word wins: the driver can't
 *  interrupt or stop a turn the owner started, and every reply carries what the owner said since the driver last read.
 *
 *  **Replies.** A reply is the conversation from where the driver last read: each message once its turn has ended, as
 *  `{author, text}`, its author the one the office knows (the driver, the owner by the approver's identity, or the
 *  harness by its kind), never one read from a text, so neither the harness nor a file it reads can pose as the owner.
 *  It comes when the turn that took the driver's message ends, when the harness waits for the owner, or after the
 *  call's wait (at most two minutes), with the harness still working; `history` then follows it. A long one comes in
 *  pages.
 *
 *  **Esc and cut-off calls.** A call's `interrupted` signal (the owner's Esc in the chat) interrupts the turn the call
 *  waits on, and the call replies once that turn has stopped, with what the harness did so far. `cutCalls` (the chat's
 *  run stopped: its worker died, or the cost cap stopped it) ends every wait at once, and interrupts each turn a
 *  `start` or `send` waited on that the driver started, as Esc does; a turn the owner started, and one a reply already
 *  said is running, go on. `close` ends every wait and stops every session.
 *
 *  **Records.** Each session's record (`HarnessRecord`) is in the host's folder for it: the conversation, the whole
 *  trace, and its state, with the harness's own id for the session, the turn under way and where the driver last read.
 *  Calls on one session queue; calls on different sessions run together.
 *
 *  **An office restart.** The office's stop leaves each live session's record waiting to be continued (`suspend`); a
 *  crash leaves it as it was. The next office's instrument of the chat takes the records as it is made: each
 *  session by its name, which no new session takes again, its history read from its record, a turn the restart cut
 *  off marked so in it, naming who started it; each is listed as its record left it. A session that was live continues
 *  on the driver's next `send`, or on the owner's next message to it, which the host opens through the harness's own
 *  resume; until then it is listed idle, and doesn't count among the live ones. A record that doesn't load, or isn't
 *  this chat's, is refused and logged. A chat that ends ends them all. */
import path from "node:path"
import { type Instrument, type Message, now } from "@opencorp/protocol"
import { strerror } from "../../util/errors.ts"
import { newId } from "../../util/ids.ts"
import type { HarnessEvent } from "./adapter.ts"
import { HarnessRecord, type Said, loadRecords, saveNextName } from "./record.ts"
import { type Entry as Shown, type Harness, type Parsed, parseArgs, refusalText, type Reply, type ReplyStatus,
  replyText, type ToolName, TOOLS, toolSpecs } from "./tools.ts"

/** What `HarnessHost.open` rejects with when the office is stopping: a session it was to continue waits, as the stop
 *  leaves it, for the office's next start. */
export class HarnessStopping extends Error {
  override name = "HarnessStopping"
}

/** A harness session's state, as its host reports it: starting until it first loads; idle, busy or waiting while
 *  live; ended or failed once it finished. */
export type ThreadState = "starting" | "idle" | "busy" | "waiting" | "ended" | "failed"

/** What a harness session tells its instrument, in order. Neither throws. */
export interface ThreadEvents {
  /** Each message, part and delta the session's translator writes. */
  event(e: HarnessEvent): void
  /** The session's state now. */
  state(state: ThreadState): void
}

/** One harness session as its host opened it. */
export interface HarnessThread {
  /** Sends `text` as the driver's: a new turn, a steer of the running one, or queued until the session loads. Its
   *  user message is written (`ThreadEvents.event`) before this returns; rejects, with words the agent can act on,
   *  when the session takes no message. */
  send(text: string): Promise<unknown>
  /** Interrupts the running turn. */
  interrupt(): Promise<void>
  /** Ends the session: a running turn is interrupted and the harness closes. */
  stop(): Promise<void>
  /** The harness's own id for the session once it has one (the Codex thread's, the Claude Code session's), which a
   *  later office resumes it by. */
  harnessSessionId(): string | null
}

/** A harness session as the chat's live instrument: the registry's `LiveInstrument`, by its shape. */
export interface HarnessListing {
  readonly id: string
  readonly interactive: false
  info(): Instrument
  keys(data: string): void
  interrupt(): void
  resize(cols: number, rows: number): void
}

/** What a chat's harness instrument is bound to; the model sets none of it. */
export interface HarnessHost {
  /** The chat whose instrument it is. */
  readonly sessionId: string
  /** Who drives it: the employee's handle. */
  readonly driver: string
  /** The owner, whose turns the driver may not interrupt or stop. */
  readonly owner: string | null
  /** A message's author as the record and the harness name them, such as `@minh` or `Ngoc (owner)`. */
  label(author: string | null): string
  /** Opens harness session `id` (named `name`) under the employee's permission; its events and states go to
   *  `events`. With `resume`, the harness's own id for a session an earlier office left, it continues that session
   *  through the harness's own resume, by the same start path. Rejects, with words the agent can act on, when it can't
   *  start. */
  open(id: string, name: string, events: ThreadEvents, options?: { resume?: string }): Promise<HarnessThread>
  /** The folder of this harness's records, one folder per session by its id; made private if missing. */
  recordsDir(): string
  /** Where a warning goes: a record refused. */
  log(line: string): void
  /** Lets a message `by` someone to session `id`, one an earlier office left, continue it through `resume` first, as
   *  the driver's `send` would, when `by` is the owner; null takes that away. `resume` rejects, saying why, when it
   *  doesn't continue it. */
  resumable(id: string, resume: ((by: string | null) => Promise<void>) | null): void
  /** Lists `instrument` as the chat's; publishes a change of `id`; takes `id` out of the list. */
  list(instrument: HarnessListing): void
  changed(id: string): void
  remove(id: string): void
}

/** A tool as the model calls it: an `OfficeTool`, by its shape. `interrupted` is the owner's Esc in the chat. */
export interface HarnessTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(args: Record<string, unknown>, options?: { readonly interrupted?: AbortSignal }): Promise<unknown>
}

/** The most of a record one reply carries, in UTF-16 code units. */
export const PAGE_CHARS = 20_000
/** The most sessions of one harness one chat has live at once: each runs its own process. */
export const MAX_LIVE = 4
/** How long an interrupt or a stop waits for the harness's turn to end before it replies anyway. */
const STOP_WAIT_MS = 15_000
/** What replies say, in `h`'s words. */
function notes(h: Harness) {
  const t = h.title
  return {
    closed: `this chat's ${t} instrument has closed`,
    running: `${t} is still working: follow its reply with history, with a long wait; do other work meanwhile.`,
    waiting: `${t} asked the owner a question and waits for their answer: follow it with history, with a long wait.`,
    interrupted: `The owner interrupted you (Esc), so ${t}'s turn stopped: what ${t} did so far is above.`,
    runStopped: `This chat's run stopped, so the ${t} turn you started was interrupted; history reads what it did.`,
    ownersGoesOn: "This chat's run stopped; the owner's turn goes on, and history reads its reply.",
    readGoesOn: `This chat's run stopped; a turn ${t} runs goes on, and history reads its reply.`,
    ended: `This chat ended, so its ${t} sessions stop; history can't read them any more.`,
    stopping: `The office is stopping, so this ${t} session stops; once it starts again, send continues it.`,
    sessionEnded: `This ${t} session has ended; history still reads its record, and start begins a new one.`,
    restored: `The office restarted since ${t} last worked in this session: send continues it where it was.`,
    neverStarted: `The office restarted before ${t} started this session, so it can't be continued; start begins a new one.`,
    cutOff: (who: string) =>
      `[interrupted] The office restarted while ${t} worked on a turn ${who} started, so that turn stopped. The next ` +
      "message continues this session.",
  }
}
const OWNERS_TURN = "the owner started this turn, and the owner's word wins: only they can interrupt or stop it"
const NOT_SENT = "not sent: the owner interrupted you (Esc)"
const NOT_SENT_CUT = "not sent: this chat's run stopped"

/** Why a call's wait was cut: the chat's run stopped (`cutCalls`), the instrument closed (`close`), or the office
 *  stopped (`suspend`). */
type CutWhy = "run" | "close" | "stop"

/** One of the chat's sessions. */
interface Entry {
  readonly id: string
  readonly name: string
  readonly record: HarnessRecord
  readonly created: string
  thread: HarnessThread | null
  state: ThreadState
  error: string | null
  /** The messages of the turn under way, which settle into the record when it ends, in the order they came. */
  open: Message[]
  /** The ids of the messages settled into the record, and of the driver's messages, in the order they came. */
  readonly settled: Set<string>
  readonly sent: string[]
  /** Who started the running turn, and the driver's message it works on (null when the owner started it). */
  turnBy: string | null
  command: string | null
  /** Where the driver last read the conversation. */
  read: number
  /** Woken on every change. */
  readonly waiters: Set<() => void>
  /** The calls on this session, one after another. */
  calls: Promise<unknown>
  /** An earlier office's live session, not continued yet: no thread, not listed, and not among the live ones. */
  restored: boolean
}

/** How a wait ended. */
type Ended = "done" | "timeout" | "interrupted" | "cut"

/** One chat's sessions of one harness, as its host binds them, and the tools the agent works them with. */
export class HarnessInstrument {
  private readonly entries: Entry[] = []
  private readonly notes: ReturnType<typeof notes>
  /** The waits of the calls running now: `cutCalls` and `close` end them, saying why as the abort's reason. */
  private readonly cuts = new Set<AbortController>()
  private made = 0
  private closed = false
  /** Whether the chat's records have been taken (`load`). */
  private loaded = false
  /** The office stopped: what the sessions tell after changes nothing. */
  private suspended = false

  constructor(
    private readonly harness: Harness,
    private readonly host: HarnessHost,
  ) {
    this.notes = notes(harness)
    this.load()
  }

  /** The model-facing tools: description, parameters, `call(args, { interrupted })`. */
  tools(): Record<ToolName, HarnessTool> {
    const specs = toolSpecs(this.harness)
    const tool = (name: ToolName): HarnessTool => ({
      ...specs[name],
      call: (args, options = {}) => this.call(name, args, options),
    })
    return Object.fromEntries(TOOLS.map((name) => [name, tool(name)])) as Record<ToolName, HarnessTool>
  }

  /** The chat's run stopped, so nobody reads these calls' replies: ends every wait now, and interrupts each turn a
   *  `start` or `send` waited on that the driver started. A `start` still opening its session stops it. */
  cutCalls(): void {
    this.cut("run")
  }

  private cut(why: CutWhy): void {
    for (const cut of [...this.cuts]) cut.abort(why)
  }

  /** The chat ended: ends every wait, asks every live session to stop, ends each an earlier office left, and takes
   *  each listing out; later calls are refused, and a session still opening stops once it opens. Never waits on the
   *  harness, which closes after: the chat's end must not wait on a harness that hangs. */
  async close(): Promise<void> {
    this.closed = true
    this.cut("close")
    this.load()
    for (const entry of this.entries) {
      if (entry.restored) {
        this.unrestore(entry)
        this.state(entry, "ended")
      } else if (entry.thread !== null && !finished(entry)) {
        // Already ending, or gone: nothing is left to stop.
        void entry.thread.stop().catch(() => {})
      }
      this.host.remove(entry.id)
    }
  }

  /** The office stops, and has stopped the harness sessions already: ends every wait, and each live session's record
   *  waits, interrupted, for the office's next start to continue it, with what its turn under way said so far and
   *  who started that turn. Later calls are refused, nothing the sessions tell after changes their records, and the
   *  listings go. */
  async suspend(): Promise<void> {
    this.closed = true
    this.suspended = true
    this.cut("stop")
    for (const entry of this.entries) {
      this.host.resumable(entry.id, null)
      if (!finished(entry)) {
        const open = entry.open
        entry.open = []
        for (const m of open) entry.settled.add(m.id)
        entry.record.add(open, (author) => this.host.label(author))
        entry.record.suspend()
      }
      this.host.remove(entry.id)
    }
  }

  /** Takes the sessions an earlier office left in the chat's records, once, and lists each: by its name, an ended or
   *  failed one as it finished, and a live one as that office's stop or crash left it, to continue on the driver's
   *  next `send` or the owner's next message, with a turn the restart cut off marked so first. One the harness never
   *  named can't be continued, and fails. */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const { harness, host } = this
    let found: ReturnType<typeof loadRecords>
    try {
      found = loadRecords(harness, host.recordsDir(), { chat: host.sessionId, driver: host.driver, log: (l) => host.log(l) })
    } catch (error) {
      const why = strerror(error) ?? (error as Error).name
      host.log(`${harness.kind} sessions of chat ${host.sessionId}: their records can't be read (${why})`)
      return
    }
    this.made = Math.max(this.made, found.next - 1)
    for (const record of found.records) {
      const entry = this.restore(record)
      this.entries.push(entry)
      try {
        host.list(this.listing(entry))
      } catch (error) {
        host.log(`${harness.kind} session ${entry.id} of chat ${host.sessionId} isn't listed (${(error as Error).name})`)
      }
      if (entry.restored) host.resumable(entry.id, (by) => this.ownerWrites(entry, by))
    }
  }

  /** `by` wrote to `entry`'s session, one an earlier office left: when `by` is the owner it continues first, as the
   *  driver's `send` would, the owner's word never held back by the live sessions' cap. Rejects, saying why, for
   *  anyone else, and when it can't. */
  private ownerWrites(entry: Entry, by: string | null): Promise<void> {
    const { owner } = this.host
    if (owner === null || by !== owner) {
      return Promise.reject(new Error(`only ${this.host.label(owner)} may write in this ${this.harness.title} session`))
    }
    return this.queue(entry, async () => {
      if (!entry.restored) return
      if (this.closed) throw new Error(this.notes.closed)
      const not = await this.continue(entry, { cut: new AbortController().signal }, { owner: true })
      if (not !== null) throw new Error(not.refused ?? entry.error ?? `this ${this.harness.title} session couldn't continue`)
    })
  }

  /** `entry` is no longer one an earlier office left waiting to continue. */
  private unrestore(entry: Entry): void {
    entry.restored = false
    this.host.resumable(entry.id, null)
  }

  /** The entry of `record`, an earlier office's session. */
  private restore(record: HarnessRecord): Entry {
    const meta = record.meta
    const entry: Entry = {
      id: meta.id, name: meta.name, record, created: meta.started, thread: null, state: "idle", error: null, open: [],
      settled: new Set(), sent: [], turnBy: null, command: null, read: 0, waiters: new Set(),
      calls: Promise.resolve(), restored: false,
    }
    // A position past the log's end, kept before a write of it failed, would hide what comes next.
    if (meta.read !== undefined) entry.read = Math.min(meta.read, record.conversation.end)
    if (meta.state === "ended" || meta.state === "failed") {
      entry.state = meta.state
      entry.error = meta.error ?? null
      return entry
    }
    if (meta.harnessSessionId === undefined) {
      entry.state = "failed"
      entry.error = this.notes.neverStarted
      record.end("failed", entry.error)
      return entry
    }
    if (meta.turn !== undefined) {
      record.note(this.notes.cutOff(this.host.label(meta.turn.by)))
      record.setTurn(null)
    }
    // A crash left it running: from here it is as an office stop leaves it.
    record.suspend()
    entry.restored = true
    return entry
  }

  private async call(
    tool: ToolName,
    args: Record<string, unknown>,
    options: { readonly interrupted?: AbortSignal },
  ): Promise<string> {
    if (this.closed) return refusalText(this.notes.closed)
    const parsed = parseArgs(this.harness, tool, args)
    if (typeof parsed === "string") return refusalText(parsed)
    this.load()
    const cut = new AbortController()
    this.cuts.add(cut)
    const signals = { interrupted: options.interrupted, cut: cut.signal }
    try {
      if (parsed.tool === "start") return await this.start(parsed, signals)
      const entry = this.entries.find((e) => e.name === parsed.session)
      if (entry === undefined) return refusalText(this.unknown(parsed.session))
      return await this.queue(entry, () => {
        switch (parsed.tool) {
          case "send":
            return this.send(entry, parsed.message, parsed.waitMs, signals)
          case "interrupt":
            return this.interrupt(entry)
          case "stop":
            return this.stop(entry)
          case "history":
            return this.history(entry, parsed, signals)
        }
      })
    } finally {
      this.cuts.delete(cut)
    }
  }

  /** Opens the next session, lists it, and sends it the first message; refused past `MAX_LIVE` live sessions. Its
   *  name's number is kept before its record is made, so no later session takes it, even after a restart. */
  private async start(parsed: Parsed & { tool: "start" }, signals: Signals): Promise<string> {
    const full = this.full("starting another")
    if (full !== null) return refusalText(full)
    const id = newId()
    const { kind, title } = this.harness
    const name = `${kind} ${++this.made}`
    let record: HarnessRecord
    try {
      const dir = this.host.recordsDir()
      saveNextName(dir, kind, this.host.sessionId, this.made + 1)
      record = new HarnessRecord(this.harness, path.join(dir, id), {
        id, name, driver: this.host.driver, chat: this.host.sessionId, started: now(),
      })
    } catch (error) {
      return refusalText(`a ${title} session's record couldn't be made: ${(error as Error).message}`)
    }
    const entry: Entry = {
      id, name, record, created: now(), thread: null, state: "starting", error: null, open: [], settled: new Set(),
      sent: [], turnBy: null, command: null, read: 0, waiters: new Set(), calls: Promise.resolve(), restored: false,
    }
    this.entries.push(entry)
    this.host.list(this.listing(entry))
    return await this.queue(entry, async () => {
      try {
        entry.thread = await this.host.open(id, name, this.events(entry))
      } catch (error) {
        entry.error = (error as Error).message
        this.state(entry, "failed")
        return this.reply(entry)
      }
      this.learn(entry)
      // Closed or cut off while it opened: nobody would read it, so it stops before any message.
      if (this.closed || signals.cut.aborted) {
        void entry.thread.stop().catch(() => {})
        return this.reply(entry, { refused: this.closed ? this.notes.closed : NOT_SENT_CUT })
      }
      return await this.send(entry, parsed.message, parsed.waitMs, signals)
    })
  }

  /** Why no more sessions may be live, before `what`: `MAX_LIVE` are, not counting those an earlier office left that
   *  haven't continued; null when one more may. */
  private full(what: string): string | null {
    const live = this.entries.filter((e) => !finished(e) && !e.restored)
    if (live.length < MAX_LIVE) return null
    const names = live.map((e) => e.name).join(", ")
    return (
      `this chat has ${MAX_LIVE} live ${this.harness.title} sessions (${names}), the most it may: send one of them the ` +
      `work, or stop one, before ${what}`
    )
  }

  /** What `entry`'s session tells it, which an observer's failure never reaches. */
  private events(entry: Entry): ThreadEvents {
    return {
      event: (e) => this.guard(entry, () => this.event(entry, e)),
      state: (state) => this.guard(entry, () => this.state(entry, state)),
    }
  }

  /** Keeps the harness's own id for `entry`'s session in its record once the session has one. */
  private learn(entry: Entry): void {
    if (entry.record.meta.harnessSessionId !== undefined) return
    const id = entry.thread?.harnessSessionId() ?? null
    if (id !== null) entry.record.setHarnessSession(id)
  }

  /** Continues a session an earlier office left, before a message to it goes: the host opens it through the
   *  harness's own resume. Refused past `MAX_LIVE` live sessions (unless for the `owner`'s message), and once the call
   *  was interrupted or cut. Null once it continues; else why not: `refused`, or nothing when the resume failed and
   *  failed the session. An office stopping meanwhile leaves it to continue after the next start. */
  private async continue(
    entry: Entry,
    signals: Signals,
    { owner = false }: { owner?: boolean } = {},
  ): Promise<{ refused?: string } | null> {
    const full = owner ? null : this.full(`continuing ${entry.name}`)
    if (full !== null) return { refused: full }
    if (signals.interrupted?.aborted) return { refused: NOT_SENT }
    if (signals.cut.aborted) return { refused: NOT_SENT_CUT }
    this.unrestore(entry)
    entry.state = "starting"
    entry.record.resume()
    this.host.changed(entry.id)
    try {
      entry.thread = await this.host.open(entry.id, entry.name, this.events(entry), {
        resume: entry.record.meta.harnessSessionId,
      })
    } catch (error) {
      // The office is stopping: the session waits for the next start, as the stop leaves it.
      if (this.suspended || error instanceof HarnessStopping) {
        entry.restored = true
        entry.state = "idle"
        entry.record.suspend()
        if (!this.suspended) {
          this.host.changed(entry.id)
          this.host.resumable(entry.id, (by) => this.ownerWrites(entry, by))
        }
        return { refused: this.notes.stopping }
      }
      entry.error = (error as Error).message
      this.state(entry, "failed")
      return {}
    }
    // Closed or cut off while it opened: nobody would read it, so it stops before any message.
    if (this.closed || signals.cut.aborted) {
      void entry.thread.stop().catch(() => {})
      return { refused: this.closed ? this.notes.closed : NOT_SENT_CUT }
    }
    return null
  }

  /** Sends `message` as the driver's, then waits for the turn that takes it; nothing is sent once the owner has
   *  interrupted the call. A session an earlier office left continues first. */
  private async send(entry: Entry, message: string, waitMs: number, signals: Signals): Promise<string> {
    if (entry.restored) {
      const not = await this.continue(entry, signals)
      if (not !== null) return this.reply(entry, not.refused === undefined ? {} : { refused: not.refused })
    }
    if (entry.thread === null || finished(entry)) return this.reply(entry, { refused: `${entry.name} has ${entry.state}` })
    if (signals.interrupted?.aborted) return this.reply(entry, { refused: NOT_SENT })
    if (signals.cut.aborted) return this.reply(entry, { refused: NOT_SENT_CUT })
    const before = entry.sent.length
    try {
      await entry.thread.send(message)
    } catch (error) {
      return this.reply(entry, { refused: (error as Error).message })
    }
    // Written before the send returned, and perhaps settled already: the turn may have ended meanwhile.
    const mine = entry.sent[before]
    const taken = () => (mine !== undefined && entry.settled.has(mine)) || entry.state === "waiting" || finished(entry)
    return await this.waitTurn(entry, taken, waitMs, signals)
  }

  /** Waits until `taken`, the wait or a signal. On the owner's Esc, and when the chat's run stopped, interrupts the
   *  turn (on a cut, only one the driver started) and waits for it to stop. */
  private async waitTurn(entry: Entry, taken: () => boolean, waitMs: number, signals: Signals): Promise<string> {
    const ended = await this.waitFor(entry, taken, waitMs, signals)
    if (ended === "interrupted") {
      await this.stopTurn(entry, { cut: signals.cut })
      return this.reply(entry, { note: this.notes.interrupted })
    }
    if (ended !== "cut") return this.reply(entry)
    if (signals.cut.reason === "close") return this.reply(entry, { note: this.notes.ended })
    if (signals.cut.reason === "stop") return this.reply(entry, { note: this.notes.stopping })
    if (!running(entry)) return this.reply(entry)
    if (this.ownersTurn(entry)) return this.reply(entry, { note: this.notes.ownersGoesOn })
    await this.stopTurn(entry, {})
    return this.reply(entry, { note: this.notes.runStopped })
  }

  /** Interrupts the running turn, and waits for it to stop (at most `STOP_WAIT_MS`, or until `signals` cut it). */
  private async stopTurn(entry: Entry, signals: Partial<Signals>): Promise<void> {
    await entry.thread?.interrupt().catch(() => {})
    await this.waitFor(entry, () => !running(entry), STOP_WAIT_MS, signals)
  }

  /** The driver's interrupt of its own running turn. */
  private async interrupt(entry: Entry): Promise<string> {
    if (!running(entry)) {
      return this.reply(entry, { refused: `${this.harness.title} isn't working on a turn in ${entry.name}` })
    }
    if (this.ownersTurn(entry)) return this.reply(entry, { refused: OWNERS_TURN })
    try {
      await entry.thread!.interrupt()
    } catch (error) {
      return this.reply(entry, { refused: (error as Error).message })
    }
    await this.waitFor(entry, () => !running(entry), STOP_WAIT_MS, {})
    return this.reply(entry)
  }

  /** Ends the session, unless the owner's turn runs; one an earlier office left ends as it is, never continued. */
  private async stop(entry: Entry): Promise<string> {
    if (entry.restored) {
      this.unrestore(entry)
      this.state(entry, "ended")
      return this.reply(entry)
    }
    if (entry.thread === null || finished(entry)) return this.reply(entry)
    if (running(entry) && this.ownersTurn(entry)) return this.reply(entry, { refused: OWNERS_TURN })
    try {
      await entry.thread.stop()
    } catch (error) {
      return this.reply(entry, { refused: (error as Error).message })
    }
    await this.waitFor(entry, () => finished(entry), STOP_WAIT_MS, {})
    return this.reply(entry)
  }

  /** Reads the record: the conversation (waiting for a running turn), the trace, or the trace's entries holding a
   *  text, each a page from `from`. */
  private async history(entry: Entry, parsed: Parsed & { tool: "history" }, signals: Signals): Promise<string> {
    const { trace, conversation } = entry.record
    if (parsed.query !== undefined) {
      const query = parsed.query.toLowerCase()
      const found = trace.entries.filter((e) => e.text.toLowerCase().includes(query))
      return this.reply(entry, { page: pageOf(found, parsed.from ?? 0, trace.end, trace.start) })
    }
    if (parsed.trace) return this.reply(entry, { page: pageOf(trace.entries, parsed.from ?? 0, trace.end, trace.start) })
    const from = Math.min(parsed.from ?? entry.read, conversation.end)
    const fresh = () => conversation.end > from || !running(entry)
    const ended = await this.waitFor(entry, fresh, parsed.waitMs, signals)
    if (ended === "interrupted") return this.reply(entry, { from, note: this.notes.interrupted })
    if (ended !== "cut") return this.reply(entry, { from })
    const cut = signals.cut.reason as CutWhy
    const note = cut === "close" ? this.notes.ended : cut === "stop" ? this.notes.stopping : this.notes.readGoesOn
    return this.reply(entry, { from, note })
  }

  /** The reply for `entry`: the conversation from `from` (where the driver last read, which moves past what it now
   *  reads, and is kept in the record), or the given page of the trace; a note on what to do next, unless one is
   *  given. */
  private reply(entry: Entry, o: { from?: number; note?: string; refused?: string; page?: Page } = {}): string {
    let shown = o.page
    if (shown === undefined) {
      const { conversation } = entry.record
      shown = pageOf(conversation.entries, o.from ?? entry.read, conversation.end, conversation.start)
      entry.read = shown.next
      // A reply after the office's stop reaches nobody, so the next office's reads go on from before it.
      if (!this.suspended) entry.record.setRead(entry.read)
    }
    const status = statusOf(entry.state)
    const note = o.note ?? (o.refused === undefined ? this.defaultNote(entry, status) : undefined)
    const reply: Reply = {
      session: entry.name, status, ...shown,
      ...(note === undefined ? {} : { note }),
      ...(entry.error === null ? {} : { error: entry.error }),
      ...(o.refused === undefined ? {} : { refused: o.refused }),
    }
    return replyText(this.harness, reply)
  }

  private defaultNote(entry: Entry, status: ReplyStatus): string | undefined {
    if (entry.restored) return this.notes.restored
    if (status === "running" || status === "starting") return this.notes.running
    if (status === "waiting") return this.notes.waiting
    if (status === "ended") return this.notes.sessionEnded
    return undefined
  }

  /** Folds `e` into the turn's messages, as a client folds the live events. A user message while no turn runs starts
   *  one: its author's, which the record keeps until the turn settles. */
  private event(entry: Entry, e: HarnessEvent): void {
    if (e.type === "message") {
      const message = structuredClone(e.message)
      if (entry.settled.has(message.id)) return
      const wasRunning = running(entry)
      const at = entry.open.findIndex((m) => m.id === message.id)
      if (at === -1) {
        entry.open.push(message)
        if (message.role === "user" && message.author === this.host.driver) entry.sent.push(message.id)
      } else entry.open[at] = message
      if (message.role === "user" && !wasRunning) {
        entry.turnBy = message.author ?? null
        entry.command = message.author === this.host.driver ? textOf(message) : null
        entry.record.setTurn({ by: entry.turnBy })
      }
    } else if (e.type === "part") {
      const message = entry.open.find((m) => m.id === e.messageId)
      if (message === undefined) return
      const at = message.parts.findIndex((p) => p.id === e.part.id)
      if (at === -1) message.parts.push(structuredClone(e.part))
      else message.parts[at] = structuredClone(e.part)
    } else if (e.type === "delta") {
      const part = entry.open.find((m) => m.id === e.messageId)?.parts.find((p) => p.id === e.partId)
      if (part?.type === "text") part.text += e.text
    }
    this.wake(entry)
  }

  /** The session's state changed: when no turn runs, its messages settle into the record; once it finishes, the
   *  record ends. The harness's own id for it is kept once it has one. */
  private state(entry: Entry, state: ThreadState): void {
    entry.state = state
    if (state === "idle" || state === "ended" || state === "failed") {
      const settled = entry.open
      entry.open = []
      for (const m of settled) entry.settled.add(m.id)
      entry.record.add(settled, (author) => this.host.label(author))
      entry.turnBy = null
      entry.command = null
      entry.record.setTurn(null)
      if (state === "failed") entry.error ??= lastError(settled)
    }
    this.learn(entry)
    if (state === "ended" || state === "failed") entry.record.end(state, entry.error)
    this.host.changed(entry.id)
    this.wake(entry)
  }

  /** Runs `step`, so an observer's failure never reaches the session that told it; after the office's stop, what a
   *  session tells changes nothing. */
  private guard(entry: Entry, step: () => void): void {
    if (this.suspended) return
    try {
      step()
    } catch {
      // The record or the listing failed; the session goes on, and its record says what it could.
      this.wake(entry)
    }
  }

  /** Whether the running turn is the owner's, whose word wins. */
  private ownersTurn(entry: Entry): boolean {
    return entry.turnBy !== null && entry.turnBy !== this.host.driver
  }

  /** `entry` as the chat's instrument. */
  private listing(entry: Entry): HarnessListing {
    const { host } = this
    return {
      id: entry.id,
      interactive: false,
      info: (): Instrument => ({
        id: entry.id,
        session_id: host.sessionId,
        kind: this.harness.kind,
        name: entry.name,
        driver: host.driver,
        profile: "harness",
        interactive: false,
        size: null,
        status: statusOf(entry.state),
        waiting: null,
        command: entry.command,
        error: entry.state === "failed" ? entry.error : null,
        created_at: entry.created,
        updated_at: now(),
      }),
      keys: () => {},
      // The owner's Ctrl-C on the listing: their interrupt, whoever started the turn.
      interrupt: () => void entry.thread?.interrupt().catch(() => {}),
      resize: () => {},
    }
  }

  /** Resolves once `done()` holds, after `ms`, or when a signal aborts, saying which. */
  private waitFor(entry: Entry, done: () => boolean, ms: number, signals: Partial<Signals>): Promise<Ended> {
    if (done()) return Promise.resolve("done")
    if (signals.cut?.aborted) return Promise.resolve("cut")
    if (signals.interrupted?.aborted) return Promise.resolve("interrupted")
    return new Promise((resolve) => {
      const finish = (how: Ended) => {
        clearTimeout(timer)
        entry.waiters.delete(check)
        signals.cut?.removeEventListener("abort", onCut)
        signals.interrupted?.removeEventListener("abort", onInterrupt)
        resolve(how)
      }
      const check = () => {
        if (done()) finish("done")
      }
      const onCut = () => finish("cut")
      const onInterrupt = () => finish("interrupted")
      const timer = setTimeout(() => finish("timeout"), ms)
      entry.waiters.add(check)
      signals.cut?.addEventListener("abort", onCut, { once: true })
      signals.interrupted?.addEventListener("abort", onInterrupt, { once: true })
    })
  }

  private wake(entry: Entry): void {
    for (const waiter of [...entry.waiters]) waiter()
  }

  /** Runs `job` after the calls on `entry` before it. */
  private queue<T>(entry: Entry, job: () => Promise<T>): Promise<T> {
    const turn = entry.calls.then(job)
    entry.calls = turn.catch(() => undefined)
    return turn
  }

  private unknown(name: string): string {
    const names = this.entries.map((e) => e.name)
    const listed = names.length > 0 ? `the sessions are ${names.join(", ")}` : "there are none yet"
    return `no ${this.harness.title} session is named ${JSON.stringify(name)}: ${listed}; start begins a new one`
  }
}

/** What ends a call's wait: the owner's Esc in the chat, and the instrument's cut, whose reason is a `CutWhy`. */
type Signals = { readonly interrupted?: AbortSignal; readonly cut: AbortSignal }

/** Whether a turn runs, or a message waits for the thread to load. */
function running(entry: Entry): boolean {
  return entry.state === "busy" || entry.state === "waiting" || (entry.state === "starting" && entry.open.length > 0)
}

/** Whether the session has finished. */
function finished(entry: Entry): boolean {
  return entry.state === "ended" || entry.state === "failed"
}

/** A state as replies and the listing name it. */
function statusOf(state: ThreadState): ReplyStatus {
  return state === "busy" ? "running" : state
}

/** A page of a log's entries. */
type Page = { output: Shown[]; next: number; more: boolean; skipped?: true }

/** One page of `entries` (each starting at its `at`; a log's, or the ones a search found) from `from`, at most
 *  `PAGE_CHARS` of their text: an entry that won't fit fills the page, cut at the last line end in the second half of
 *  the room left when it has one, and goes on in the next page; with less than a quarter page left, it starts the next
 *  page. `end` is where the log ends, and `start` where the part
 *  of it kept in memory starts: a `from` before that is `skipped`. */
function pageOf(entries: readonly Said[], from: number, end: number, start: number): Page {
  const skipped = from < start ? ({ skipped: true } as const) : {}
  const at = Math.max(from, start)
  const output: Shown[] = []
  let used = 0
  for (const e of entries) {
    const stop = e.at + e.text.length
    if (stop <= at || e.text === "") continue
    const offset = Math.max(0, at - e.at)
    const rest = e.text.slice(offset)
    if (rest.length <= PAGE_CHARS - used) {
      output.push({ author: e.author, text: rest })
      used += rest.length
      continue
    }
    // Little room left: it starts the next page rather than leave a scrap here.
    const room = PAGE_CHARS - used
    if (used > 0 && room < PAGE_CHARS / 4) return { output, next: e.at + offset, more: true, ...skipped }
    const window = rest.slice(0, room)
    const line = window.lastIndexOf("\n")
    const cut = line >= room / 2 ? line + 1 : room
    output.push({ author: e.author, text: window.slice(0, cut) })
    return { output, next: e.at + offset + cut, more: true, ...skipped }
  }
  return { output, next: end, more: false, ...skipped }
}

/** A message's text. */
function textOf(message: Message): string {
  return message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim()
}

/** The last error part among `messages`, which says why a session failed. */
function lastError(messages: readonly Message[]): string | null {
  for (const message of [...messages].reverse()) {
    const part = [...message.parts].reverse().find((p) => p.type === "error")
    if (part?.type === "error") return part.message
  }
  return null
}

/** The Codex instrument: one chat's Codex sessions, by name, as its host binds them. The agent starts a session, sends
 *  it messages, interrupts and stops it, and reads its record; it sets none of its trust.
 *
 *  **The host binds the trust**: each session is its own Codex thread, opened under the employee's permission (the
 *  host's `open`), on Codex's own login, asking nothing. The model names only the message.
 *
 *  **Two speakers.** The owner can open a session and write to Codex too. Every message carries its author, which the
 *  host labels for Codex and the record alike (`label`), and the owner's word wins: the driver can't interrupt or stop a
 *  turn the owner started, and every reply carries what the owner said since the driver last read.
 *
 *  **Replies.** A reply is the conversation from where the driver last read: each message once its turn has ended,
 *  labelled with its author and escaped, so neither Codex nor a command's output can pose as a speaker. It comes when
 *  the turn that took the driver's message ends, when Codex waits for the owner, or after the call's wait (at most two
 *  minutes), with Codex still working; `history` then follows it. A long one comes in pages.
 *
 *  **Esc.** A call's `interrupted` signal (the owner's Esc in the chat) interrupts the turn the call waits on, and the
 *  call replies once that turn has stopped, with what Codex did so far. `interruptWaits` (nobody is left to read a
 *  reply) ends every wait at once and leaves Codex working.
 *
 *  **Records.** Each session's record (`CodexRecord`) is in the host's folder for it: the conversation, the whole
 *  trace, and its state. Calls on one session queue; calls on different sessions run together. */
import { type Instrument, type Message, now } from "@opencorp/protocol"
import { newId } from "../../util/ids.ts"
import type { HarnessEvent } from "./adapter.ts"
import { CodexRecord } from "./record.ts"
import { type Parsed, parseArgs, refusalText, type Reply, type ReplyStatus, replyText, type ToolName, TOOLS,
  toolSpecs } from "./tools.ts"

/** A Codex session's state, as its host reports it: starting until its thread first loads; idle, busy or waiting
 *  while live; ended or failed once it finished. */
export type ThreadState = "starting" | "idle" | "busy" | "waiting" | "ended" | "failed"

/** What a Codex session tells its instrument, in order. Neither throws. */
export interface ThreadEvents {
  /** Each message, part and delta the session's translator writes. */
  event(e: HarnessEvent): void
  /** The session's state now. */
  state(state: ThreadState): void
}

/** One Codex session as its host opened it. */
export interface CodexThread {
  /** Sends `text` as the driver's: a new turn, a steer of the running one, or queued until the thread loads. Its
   *  user message is written (`ThreadEvents.event`) before this returns; rejects, with words the agent can act on,
   *  when the session takes no message. */
  send(text: string): Promise<unknown>
  /** Interrupts the running turn. */
  interrupt(): Promise<void>
  /** Ends the session: a running turn is interrupted and Codex closes. */
  stop(): Promise<void>
}

/** A Codex session as the chat's live instrument: the registry's `LiveInstrument`, by its shape. */
export interface CodexListing {
  readonly id: string
  readonly interactive: false
  info(): Instrument
  keys(data: string): void
  interrupt(): void
  resize(cols: number, rows: number): void
}

/** What a chat's Codex instrument is bound to; the model sets none of it. */
export interface CodexHost {
  /** The chat whose instrument it is. */
  readonly sessionId: string
  /** Who drives it: the employee's handle. */
  readonly driver: string
  /** The owner, whose turns the driver may not interrupt or stop. */
  readonly owner: string | null
  /** A message's author as the record and Codex name them, such as `@minh` or `Ngoc (owner)`. */
  label(author: string | null): string
  /** Opens Codex session `id` (named `name`) under the employee's permission; its events and states go to `events`.
   *  Rejects, with words the agent can act on, when it can't start. */
  open(id: string, name: string, events: ThreadEvents): Promise<CodexThread>
  /** Where session `id`'s record goes. */
  recordDir(id: string): string
  /** Lists `instrument` as the chat's; publishes a change of `id`; takes `id` out of the list. */
  list(instrument: CodexListing): void
  changed(id: string): void
  remove(id: string): void
}

/** A tool as the model calls it: an `OfficeTool`, by its shape. `interrupted` is the owner's Esc in the chat. */
export interface CodexTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(args: Record<string, unknown>, options?: { readonly interrupted?: AbortSignal }): Promise<unknown>
}

/** The most of a record one reply carries, in UTF-16 code units. */
export const PAGE_CHARS = 20_000
/** How long an interrupt or a stop waits for Codex's turn to end before it replies anyway. */
const STOP_WAIT_MS = 15_000
const CLOSED = "this chat's Codex instrument has closed"
const NOTES = {
  running: "Codex is still working: follow its reply with history, with a long wait; do other work meanwhile.",
  waiting: "Codex asked the owner a question and waits for their answer: follow it with history, with a long wait.",
  interrupted: "The owner interrupted you (Esc), so Codex's turn stopped: what Codex did so far is above.",
  cut: "Stopped waiting, as this chat's run stopped; Codex goes on, and history reads its reply.",
  ended: "This Codex session has ended; history still reads its record, and start begins a new one.",
} as const
const OWNERS_TURN = "the owner started this turn, and the owner's word wins: only they can interrupt or stop it"
const NOT_SENT = "not sent: the owner interrupted you (Esc)"

/** One of the chat's Codex sessions. */
interface Entry {
  readonly id: string
  readonly name: string
  readonly record: CodexRecord
  readonly created: string
  thread: CodexThread | null
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
}

/** How a wait ended. */
type Ended = "done" | "timeout" | "interrupted" | "cut"

/** One chat's Codex sessions, as its host binds them, and the tools the agent works them with. */
export class CodexInstrument {
  private readonly entries: Entry[] = []
  /** The waits of the calls running now: `interruptWaits` ends them. */
  private readonly cuts = new Set<AbortController>()
  private made = 0
  private closed = false

  constructor(private readonly host: CodexHost) {}

  /** The model-facing tools: description, parameters, `call(args, { interrupted })`. */
  tools(): Record<ToolName, CodexTool> {
    const specs = toolSpecs()
    const tool = (name: ToolName): CodexTool => ({ ...specs[name], call: (args, options = {}) => this.call(name, args, options) })
    return Object.fromEntries(TOOLS.map((name) => [name, tool(name)])) as Record<ToolName, CodexTool>
  }

  /** Ends every call's wait now: each replies with what has settled, and Codex goes on. */
  interruptWaits(): void {
    for (const cut of [...this.cuts]) cut.abort()
  }

  /** Ends every wait, asks every live session to stop and takes each listing out; later calls are refused. Never
   *  waits on Codex, which closes after: an office stop must not wait on a Codex that hangs. */
  async close(): Promise<void> {
    this.closed = true
    this.interruptWaits()
    for (const entry of this.entries) {
      // Already ending, or gone: nothing is left to stop.
      if (entry.thread !== null && !finished(entry)) void entry.thread.stop().catch(() => {})
      this.host.remove(entry.id)
    }
  }

  private async call(
    tool: ToolName,
    args: Record<string, unknown>,
    options: { readonly interrupted?: AbortSignal },
  ): Promise<string> {
    if (this.closed) return refusalText(CLOSED)
    const parsed = parseArgs(tool, args)
    if (typeof parsed === "string") return refusalText(parsed)
    const cut = new AbortController()
    this.cuts.add(cut)
    const signals = { interrupted: options.interrupted, cut: cut.signal }
    try {
      if (parsed.tool === "start") return await this.start(parsed, signals)
      const entry = this.entries.find((e) => e.name === parsed.codex)
      if (entry === undefined) return refusalText(this.unknown(parsed.codex))
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

  /** Opens the next session, lists it, and sends it the first message. */
  private async start(parsed: Parsed & { tool: "start" }, signals: Signals): Promise<string> {
    const id = newId()
    const name = `codex ${++this.made}`
    let record: CodexRecord
    try {
      record = new CodexRecord(this.host.recordDir(id), {
        id, name, driver: this.host.driver, chat: this.host.sessionId, started: now(),
      })
    } catch (error) {
      return refusalText(`a Codex session's record couldn't be made: ${(error as Error).message}`)
    }
    const entry: Entry = {
      id, name, record, created: now(), thread: null, state: "starting", error: null, open: [], settled: new Set(),
      sent: [], turnBy: null, command: null, read: 0, waiters: new Set(), calls: Promise.resolve(),
    }
    this.entries.push(entry)
    this.host.list(this.listing(entry))
    const events: ThreadEvents = {
      event: (e) => this.guard(entry, () => this.event(entry, e)),
      state: (state) => this.guard(entry, () => this.state(entry, state)),
    }
    return await this.queue(entry, async () => {
      try {
        entry.thread = await this.host.open(id, name, events)
      } catch (error) {
        entry.error = (error as Error).message
        this.state(entry, "failed")
        return this.reply(entry)
      }
      return await this.send(entry, parsed.message, parsed.waitMs, signals)
    })
  }

  /** Sends `message` as the driver's, then waits for the turn that takes it; nothing is sent once the owner has
   *  interrupted the call. */
  private async send(entry: Entry, message: string, waitMs: number, signals: Signals): Promise<string> {
    if (entry.thread === null || finished(entry)) return this.reply(entry, { refused: `${entry.name} has ${entry.state}` })
    if (signals.interrupted?.aborted) return this.reply(entry, { refused: NOT_SENT })
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

  /** Waits until `taken`, the wait or a signal; on the owner's Esc, interrupts the turn and waits for it to stop. */
  private async waitTurn(entry: Entry, taken: () => boolean, waitMs: number, signals: Signals): Promise<string> {
    const ended = await this.waitFor(entry, taken, waitMs, signals)
    if (ended === "interrupted") {
      await entry.thread?.interrupt().catch(() => {})
      await this.waitFor(entry, () => !running(entry), STOP_WAIT_MS, { cut: signals.cut })
      return this.reply(entry, { note: NOTES.interrupted })
    }
    return this.reply(entry, ended === "cut" ? { note: NOTES.cut } : {})
  }

  /** The driver's interrupt of its own running turn. */
  private async interrupt(entry: Entry): Promise<string> {
    if (!running(entry)) return this.reply(entry, { refused: `Codex isn't working on a turn in ${entry.name}` })
    if (this.ownersTurn(entry)) return this.reply(entry, { refused: OWNERS_TURN })
    try {
      await entry.thread!.interrupt()
    } catch (error) {
      return this.reply(entry, { refused: (error as Error).message })
    }
    await this.waitFor(entry, () => !running(entry), STOP_WAIT_MS, {})
    return this.reply(entry)
  }

  /** Ends the session, unless the owner's turn runs. */
  private async stop(entry: Entry): Promise<string> {
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
   *  text. */
  private async history(entry: Entry, parsed: Parsed & { tool: "history" }, signals: Signals): Promise<string> {
    const { record } = entry
    if (parsed.query !== undefined) {
      const query = parsed.query.toLowerCase()
      const found = record.entries.filter((e) => e.at >= (parsed.from ?? 0) && e.text.toLowerCase().includes(query))
      let output = ""
      let next = record.trace.length
      for (const [i, e] of found.entries()) {
        if (i > 0 && output.length + e.text.length > PAGE_CHARS) {
          next = e.at
          break
        }
        output += e.text
      }
      return this.reply(entry, { page: { output, next, more: next < record.trace.length } })
    }
    if (parsed.trace) return this.reply(entry, { page: page(record.trace, parsed.from ?? 0) })
    const from = Math.min(parsed.from ?? entry.read, record.conversation.length)
    const fresh = () => record.conversation.length > from || !running(entry)
    const ended = await this.waitFor(entry, fresh, parsed.waitMs, signals)
    if (ended === "interrupted") return this.reply(entry, { from, note: NOTES.interrupted })
    return this.reply(entry, { from, ...(ended === "cut" ? { note: NOTES.cut } : {}) })
  }

  /** The reply for `entry`: the conversation from `from` (where the driver last read, which moves past what it now
   *  reads), or the given page of the trace; a note on what to do next, unless one is given. */
  private reply(
    entry: Entry,
    o: { from?: number; note?: string; refused?: string; page?: { output: string; next: number; more: boolean } } = {},
  ): string {
    let shown = o.page
    if (shown === undefined) {
      shown = page(entry.record.conversation, o.from ?? entry.read)
      entry.read = shown.next
    }
    const status = statusOf(entry.state)
    const note = o.note ?? (o.refused === undefined ? defaultNote(status) : undefined)
    const reply: Reply = {
      codex: entry.name, status, ...shown,
      ...(note === undefined ? {} : { note }),
      ...(entry.error === null ? {} : { error: entry.error }),
      ...(o.refused === undefined ? {} : { refused: o.refused }),
    }
    return replyText(reply)
  }

  /** Folds `e` into the turn's messages, as a client folds the live events. A user message while no turn runs starts
   *  one: its author's. */
  private event(entry: Entry, e: HarnessEvent): void {
    if (e.type === "message") {
      const message = structuredClone(e.message)
      if (entry.settled.has(message.id)) return
      const at = entry.open.findIndex((m) => m.id === message.id)
      if (at === -1) {
        entry.open.push(message)
        if (message.role === "user" && message.author === this.host.driver) entry.sent.push(message.id)
      } else entry.open[at] = message
      if (message.role === "user" && !running(entry)) {
        entry.turnBy = message.author ?? null
        entry.command = message.author === this.host.driver ? textOf(message) : null
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
   *  record ends. */
  private state(entry: Entry, state: ThreadState): void {
    entry.state = state
    if (state === "idle" || state === "ended" || state === "failed") {
      const settled = entry.open
      entry.open = []
      for (const m of settled) entry.settled.add(m.id)
      entry.record.add(settled, (author) => this.host.label(author))
      entry.turnBy = null
      entry.command = null
      if (state === "failed") entry.error ??= lastError(settled)
    }
    if (state === "ended" || state === "failed") entry.record.end(state, entry.error)
    this.host.changed(entry.id)
    this.wake(entry)
  }

  /** Runs `step`, so an observer's failure never reaches the session that told it. */
  private guard(entry: Entry, step: () => void): void {
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
  private listing(entry: Entry): CodexListing {
    const { host } = this
    return {
      id: entry.id,
      interactive: false,
      info: (): Instrument => ({
        id: entry.id,
        session_id: host.sessionId,
        kind: "codex",
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
  private waitFor(entry: Entry, done: () => boolean, ms: number, signals: Signals): Promise<Ended> {
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
    return `no Codex session is named ${JSON.stringify(name)}: ${listed}; start begins a new one`
  }
}

/** What ends a call's wait: the owner's Esc in the chat, and the instrument's cut. */
type Signals = { readonly interrupted?: AbortSignal; readonly cut?: AbortSignal }

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

function defaultNote(status: ReplyStatus): string | undefined {
  if (status === "running" || status === "starting") return NOTES.running
  if (status === "waiting") return NOTES.waiting
  if (status === "ended") return NOTES.ended
  return undefined
}

/** `text` from `from`, one page of it: cut at the last blank line or line end in the page's second half when it has
 *  one. */
function page(text: string, from: number): { output: string; next: number; more: boolean } {
  const start = Math.max(0, Math.min(from, text.length))
  if (text.length - start <= PAGE_CHARS) return { output: text.slice(start), next: text.length, more: false }
  const window = text.slice(start, start + PAGE_CHARS)
  const half = PAGE_CHARS / 2
  const blank = window.lastIndexOf("\n\n")
  const line = window.lastIndexOf("\n")
  const cut = blank >= half ? blank + 2 : line >= half ? line + 1 : PAGE_CHARS
  return { output: window.slice(0, cut), next: start + cut, more: true }
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

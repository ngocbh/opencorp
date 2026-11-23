/** Each session's live instruments: the shells and Codex sessions (later, Claude Code's) its agents work, which the
 *  owner watches and steps into. The registry lists them, publishes their changes (`instrument.updated`), their output
 *  (`instrument.output`) and their removal (`instrument.removed`) as live events, and keeps each one's last output for
 *  a client that joins late.
 *
 *  **A late join** follows the upstream TUI's server attaching to a PTY: the replay, then live output from the same
 *  offset, with nothing in between. A client follows the session's live events, reads the screen (the bytes from
 *  `offset` to `end`), then applies only the bytes of each `instrument.output` past `end`. The registry counts the
 *  offsets of both, so they meet whatever the events' coalescing. A screen starts just after a line feed, so it never
 *  begins inside an escape sequence: with no line feed in what is kept, it starts at the first escape's ESC.
 *
 *  **Output events are coalesced**: at most one per instrument every `everyMs`, each of at most 64 KiB, so a busy
 *  shell can't fill a client's queue on the bus (which drops a subscriber 1000 items behind). The first output after a
 *  quiet spell goes at once, so an echo isn't held back. When output comes faster than that and bytes are dropped
 *  before they went, the events skip ahead to the newest 64 KiB: a client gets one event past its end, and reads the
 *  screen again, rather than trailing ever further behind. A change goes at once, after the output still waiting, so it
 *  never comes before the output that preceded it.
 *
 *  **Lifetime.** The registry lives in memory, so its instruments outlive the clients that watch them, and none
 *  outlives it. Their hosts add, update and remove them; it starts, closes, types into and records none, and it never
 *  sees the owner's keys, which the routes give the instrument. */
import type { Instrument, LiveEvent } from "@opencorp/protocol"

/** An instrument as its host adds it. */
export interface LiveInstrument {
  readonly id: string
  /** Whether it takes typed keys (a PTY), or not (pipes). */
  readonly interactive: boolean
  /** As clients list it, now. Its `command` is the agent's, never built from the owner's keys. */
  info(): Instrument
  /** The owner's keys, as typed: straight to the running program. Its host keeps and logs none of them. */
  keys(data: string): void
  /** The owner's Ctrl-C to an instrument that takes no keys (pipes): interrupts its command. The host gives the
   *  owner's interrupt (a shell's `ownerKeys`), never the agent's, so the agent's place in its output stays put. */
  interrupt(): void
  /** The owner's view's size, which its PTY takes. */
  resize(cols: number, rows: number): void
  /** The owner's close, as `by`: a terminal's shell ends as the agent's close ends it, signed by them. Only a shell
   *  an agent's terminal works has one. */
  close?(by: string): Promise<void>
}

/** What the registry still holds of an instrument's output: the bytes from `offset` to `end`, counted from the
 *  instrument's start. */
export interface Screen {
  offset: number
  end: number
  data: Uint8Array
}

const KEEP_BYTES = 1024 * 1024
const EVERY_MS = 50
/** The most bytes one output event carries. */
const EVENT_BYTES = 64 * 1024
const LINE_FEED = 0x0a
const ESC = 0x1b
/** The most chunks held before they are joined: a shell's echo comes a byte at a time. */
const CHUNKS_MAX = 1024

/** An instrument's last `keep` bytes of output. */
class Kept {
  private chunks: Uint8Array[] = []
  private length = 0
  /** The offset just past the last byte: every byte since the instrument's start. */
  end = 0

  constructor(private readonly keep: number) {}

  /** The offset of the first byte held. */
  get start(): number {
    return this.end - this.length
  }

  push(chunk: Uint8Array): void {
    // A copy: the host may reuse its buffer.
    this.chunks.push(chunk.slice())
    this.length += chunk.length
    this.end += chunk.length
    while (this.length > this.keep) {
      const first = this.chunks[0]!
      const over = this.length - this.keep
      if (first.length <= over) {
        this.chunks.shift()
        this.length -= first.length
      } else {
        this.chunks[0] = first.slice(over)
        this.length -= over
      }
    }
    if (this.chunks.length > CHUNKS_MAX) this.chunks = [this.bytes(this.start, this.end)]
  }

  /** The bytes from `from` to `to`, both within what is held. */
  bytes(from: number, to: number): Uint8Array {
    const out = new Uint8Array(to - from)
    let at = this.start
    let filled = 0
    for (const chunk of this.chunks) {
      const lo = Math.max(from, at)
      const hi = Math.min(to, at + chunk.length)
      if (lo < hi) {
        out.set(chunk.subarray(lo - at, hi - at), filled)
        filled += hi - lo
      }
      at += chunk.length
      if (at >= to) break
    }
    return out
  }
}

interface Entry {
  readonly sessionId: string
  readonly instrument: LiveInstrument
  readonly kept: Kept
  /** The offset up to which output events have gone. */
  sent: number
  /** When the last output event went, in ms since the epoch. */
  sentAt: number
  timer: ReturnType<typeof setTimeout> | null
}

/** The office's live instruments, by session. */
export class Instruments {
  private readonly sessions = new Map<string, Map<string, Entry>>()
  private readonly keepBytes: number
  private readonly everyMs: number

  constructor(
    private readonly publish: (event: LiveEvent) => void,
    { keepBytes = KEEP_BYTES, everyMs = EVERY_MS }: { keepBytes?: number; everyMs?: number } = {},
  ) {
    this.keepBytes = keepBytes
    this.everyMs = everyMs
  }

  /** Lists `instrument` in session `sessionId`, after those before it, and publishes it. Throws when the session
   *  lists its id already. */
  add(sessionId: string, instrument: LiveInstrument): void {
    const listed = this.sessions.get(sessionId) ?? new Map<string, Entry>()
    if (listed.has(instrument.id)) throw new Error(`instrument ${instrument.id} is already listed`)
    const entry: Entry = { sessionId, instrument, kept: new Kept(this.keepBytes), sent: 0, sentAt: 0, timer: null }
    listed.set(instrument.id, entry)
    this.sessions.set(sessionId, listed)
    this.changed(entry)
  }

  /** Publishes instrument `id` as it is now, once the output it printed before goes out. */
  updated(sessionId: string, id: string): void {
    const entry = this.entry(sessionId, id)
    if (entry === undefined) return
    this.drain(entry)
    this.changed(entry)
  }

  /** Keeps `chunk` of instrument `id`'s raw output and publishes it, coalesced. */
  output(sessionId: string, id: string, chunk: Uint8Array): void {
    const entry = this.entry(sessionId, id)
    if (entry === undefined || chunk.length === 0) return
    entry.kept.push(chunk)
    this.schedule(entry)
  }

  /** Session `sessionId`'s instruments as they are now, oldest first. */
  list(sessionId: string): Instrument[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].map((entry) => entry.instrument.info())
  }

  get(sessionId: string, id: string): LiveInstrument | undefined {
    return this.entry(sessionId, id)?.instrument
  }

  /** What is held of instrument `id`'s output, starting just after a line feed (with none in it, at the first ESC; with
   *  neither, from its start, since no escape begins in it); all of it from offset 0 while nothing has been dropped. */
  screen(sessionId: string, id: string): Screen | undefined {
    const entry = this.entry(sessionId, id)
    if (entry === undefined) return undefined
    const { kept } = entry
    const data = kept.bytes(kept.start, kept.end)
    if (kept.start === 0) return { offset: 0, end: kept.end, data }
    const line = data.indexOf(LINE_FEED)
    const at = line >= 0 ? line + 1 : Math.max(0, data.indexOf(ESC))
    return { offset: kept.start + at, end: kept.end, data: data.subarray(at) }
  }

  /** Takes instrument `id` out of the list, once the output it printed goes out, and publishes its removal. */
  remove(sessionId: string, id: string): void {
    const listed = this.sessions.get(sessionId)
    const entry = listed?.get(id)
    if (listed === undefined || entry === undefined) return
    this.drain(entry)
    listed.delete(id)
    if (listed.size === 0) this.sessions.delete(sessionId)
    this.publish({ type: "instrument.removed", session_id: sessionId, data: { id, session_id: sessionId } })
  }

  private entry(sessionId: string, id: string): Entry | undefined {
    return this.sessions.get(sessionId)?.get(id)
  }

  private changed(entry: Entry): void {
    this.publish({ type: "instrument.updated", session_id: entry.sessionId, data: entry.instrument.info() })
  }

  /** Sends the next output event now if the last went `everyMs` ago or more, else once it has. */
  private schedule(entry: Entry): void {
    if (entry.timer !== null) return
    const wait = entry.sentAt + this.everyMs - Date.now()
    if (wait <= 0) {
      if (this.send(entry)) this.schedule(entry)
      return
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (this.send(entry)) this.schedule(entry)
    }, wait)
    entry.timer.unref?.()
  }

  /** Sends every output event still to go, now. */
  private drain(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    while (this.send(entry));
  }

  /** Sends one output event of what hasn't gone, from where the last ended; or, when bytes were dropped before they
   *  went, of the newest bytes, past the gap. Whether more is left. */
  private send(entry: Entry): boolean {
    const { kept } = entry
    const from = entry.sent >= kept.start ? entry.sent : Math.max(kept.start, kept.end - EVENT_BYTES)
    if (from >= kept.end) return false
    const to = Math.min(kept.end, from + EVENT_BYTES)
    entry.sent = to
    entry.sentAt = Date.now()
    const bytes = kept.bytes(from, to)
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
    const output = { instrument_id: entry.instrument.id, offset: from, data }
    this.publish({ type: "instrument.output", session_id: entry.sessionId, data: output })
    return to < kept.end
  }
}

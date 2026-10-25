/** The live relay: one yian `LiveView` per running worker, built from its snapshot and fed its live frames, the bus
 *  events that show its run's replies as they change, and the viewers that follow the run's frames. */
import fs from "node:fs"
import {
  iterRunRecords,
  type LiveFollowFrame,
  type LiveFrame,
  type LiveSnapshot,
  LiveView,
  type LiveViewCall,
} from "@ngocbh/yian/run"
import type { LiveEvent, Message, Part } from "@opencorp/protocol"
import type { LiveCalls, Transcript } from "../chat/transcript.ts"
import type { Job } from "../worker/job.ts"
import { errorName } from "../worker/rpc.ts"
import { type Bus, PING } from "./bus.ts"

/** What the relay uses of a worker: its job's run, session and log, and a way to ask for a fresh snapshot. `Worker`
 *  fits. */
export type LiveWorker = { readonly job: Pick<Job, "run_id" | "session_id" | "log">; follow(): Promise<boolean> }

/** A worker's live frame once checked: a yian follow frame, a `record` maybe without its `line` (over the channel's
 *  frame limit). */
type WorkerFrame = Exclude<LiveFollowFrame, { type: "record" }> | { type: "record"; seq: number; line?: string }

/** The frame types a log line may name; any other is named `unknown`. */
const TYPES: ReadonlySet<string> = new Set<WorkerFrame["type"]>(["record", "start", "chunk", "end", "snapshot"])

/** How many snapshot builds in a row may fail before the relay stops following a worker. */
const MAX_FAILED_BUILDS = 3

/** What a viewer gets: a frame the run's view applied (a record always with its line), or the end of the worker. */
export type ViewerFrame = LiveFrame | { type: "run_end" }

/** One viewer's queue, with the bus subscription's rules, and a lagging viewer's chunks of one call merged. */
export class LiveViewer {
  readonly #remove: (viewer: LiveViewer) => void
  readonly #queueSize: number
  // null marks the end: a waiting reader gets it after every frame queued before it.
  readonly #queue: (ViewerFrame | null)[] = []
  #done = false
  #dropped = false
  #reading = false
  #wake: (() => void) | null = null

  constructor(remove: (viewer: LiveViewer) => void, queueSize: number) {
    this.#remove = remove
    this.#queueSize = queueSize
  }

  /** Whether the relay dropped this viewer: it fell behind, or its run's view had a gap. */
  get dropped(): boolean {
    return this.#dropped
  }

  /** How many items wait in the queue. */
  get queued(): number {
    return this.#queue.length
  }

  /** The next item, `PING` after `timeoutMs` idle, or null once ended (and forever after). One reader at a time. */
  async next(timeoutMs: number): Promise<ViewerFrame | typeof PING | null> {
    if (this.#reading) throw new Error("a viewer has one reader at a time")
    if (this.#done) return null
    this.#reading = true
    try {
      if (this.#queue.length === 0) {
        const woken = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            this.#wake = null
            resolve(false)
          }, timeoutMs)
          this.#wake = () => {
            clearTimeout(timer)
            this.#wake = null
            resolve(true)
          }
        })
        if (!woken) return PING
      }
      // Never empty here: a wake follows a push, and no other reader can take that item first.
      const item = this.#queue.shift()!
      if (item === null) this.#done = true
      return item
    } finally {
      this.#reading = false
    }
  }

  /** Stop receiving frames. A waiting `next()` is not woken; it returns `PING` at its timeout. */
  close(): void {
    this.#done = true
    this.#remove(this)
  }

  /** Queue `frame`, or merge a chunk into the latest queued chunk of its call while only chunks were queued after it;
   *  a viewer that would pass its cap is dropped instead. Called by the relay. */
  push(frame: LiveFrame): void {
    if (frame.type === "chunk") {
      for (let at = this.#queue.length - 1; at >= 0; at--) {
        const queued = this.#queue[at]
        if (queued?.type !== "chunk") break
        if (queued.node !== frame.node || queued.n !== frame.n) continue
        // A new frame, since every viewer of the run queues the same one. The newer index keeps a reader's next
        // index (index + 1) right.
        this.#queue[at] = { ...queued, index: frame.index, text: queued.text + frame.text }
        return
      }
    }
    if (this.#queue.length >= this.#queueSize) {
      this.drop()
      return
    }
    this.#add(frame)
  }

  /** End it after every queued frame, with `run_end` first when `runEnd`. Called by the relay. */
  end(runEnd: boolean): void {
    this.#remove(this)
    if (runEnd) this.#queue.push({ type: "run_end" })
    this.#add(null)
  }

  /** Mark it dropped, discard its backlog and end it. Called by the relay. */
  drop(): void {
    // The backlog is discarded: a dropped client joins again and reads the log anyway.
    this.#remove(this)
    this.#dropped = true
    this.#queue.length = 0
    this.#add(null)
  }

  #add(item: ViewerFrame | null): void {
    this.#queue.push(item)
    // The reader takes from the queue when it runs: a burst before then stays queued and can overflow it.
    this.#wake?.()
  }
}

/** A viewer's start: the run's view's last seq and calls in flight, then every later frame from `viewer`. */
export interface LiveJoin {
  lastSeq: number
  calls: readonly LiveViewCall[]
  viewer: LiveViewer
}

/** What the relay has published of a run: each assistant message from `floor` on, with its parts by id as shown. */
interface Shown {
  /** The id of the earliest message that can still change; earlier ones are final and not kept. "" until the run shows
   *  an assistant message. */
  floor: string
  messages: Map<string, Map<string, Part>>
}

/** A run's live state, held for the one worker that feeds it. */
interface Entry {
  readonly runId: string
  readonly worker: LiveWorker
  /** null until the worker's snapshot builds, and after a gap until the next one does. */
  view: LiveView | null
  /** The snapshot builds that failed in a row; at `MAX_FAILED_BUILDS` the worker's frames are ignored. */
  failedBuilds: number
  /** The run's viewers, joined while this view stood. */
  readonly viewers: Set<LiveViewer>
}

/**
 * Keeps, per running worker, a `LiveView` of its run: built per yian's recipe from the run log and the worker's
 * snapshot, then fed every later frame. A gap (a frame the view can't apply, a malformed frame, a snapshot that can't
 * be built) drops the view and asks the worker to follow again; frames are ignored until the next snapshot.
 *
 * After each snapshot that builds and each `start` or `record` it applies, it renders the worker's run with the
 * transcript and publishes, on the worker's session, what changed among its assistant messages since the run was last
 * shown; a `chunk` of a shown live part is published as a `part.delta`. What was shown is kept per run until `forget`.
 *
 * A viewer `join`s a run's view and gets every frame the view applies after it; a duplicate record or chunk the view
 * ignored isn't passed on. Each viewer queues at most `queueSize` items (a lagging viewer's chunks of one call merge
 * and don't count) and is dropped past it. A gap drops the run's viewers (they join again once the view is rebuilt);
 * the worker's exit or its replacement by a new worker ends them with `run_end`.
 */
export class LiveRelay implements LiveCalls {
  readonly #bus: Pick<Bus, "publishLive">
  readonly #transcript: Pick<Transcript, "messages">
  readonly #log: (line: string) => void
  readonly #queueSize: number
  readonly #runs = new Map<string, Entry>()
  readonly #shown = new Map<string, Shown>()

  constructor(options: {
    bus: Pick<Bus, "publishLive">
    transcript: Pick<Transcript, "messages">
    log: (line: string) => void
    queueSize?: number
  }) {
    this.#bus = options.bus
    this.#transcript = options.transcript
    this.#log = options.log
    this.#queueSize = options.queueSize ?? 1000
  }

  /** A `stream` frame's `frame` from `worker`. Synchronous; never throws. */
  frame(worker: LiveWorker, frame: unknown): void {
    try {
      // The run comes from the worker's own job, never from the frame, so a worker feeds only its run's view.
      const runId = worker.job.run_id
      let entry = this.#runs.get(runId)
      if (entry?.worker !== worker) {
        // One view per running worker: a new worker's view is built from its own snapshot, with nothing of the old.
        if (entry !== undefined) this.#endViewers(entry, true)
        entry = { runId, worker, view: null, failedBuilds: 0, viewers: new Set() }
        this.#runs.set(runId, entry)
      }
      if (entry.failedBuilds >= MAX_FAILED_BUILDS) return
      const checked = check(frame)
      if (checked === null) {
        const type = typeName(frame)
        if (type === "snapshot") this.#failedBuild(entry)
        else this.#gap(entry, type)
      } else if (checked.type === "snapshot") {
        if (this.#build(entry, checked.snapshot)) this.#show(worker)
      } else if (entry.view !== null) {
        this.#apply(entry, entry.view, checked)
      }
    } catch (error) {
      this.#log(`live relay: a frame was not handled (${errorName(error)})`)
    }
  }

  /** `worker` exited: drop its view if it holds the run's, end its viewers with `run_end`, and show the run once more
   *  with no live calls of its own. Never throws. */
  detach(worker: LiveWorker): void {
    try {
      const runId = worker.job.run_id
      const entry = this.#runs.get(runId)
      if (entry?.worker === worker) {
        this.#runs.delete(runId)
        this.#endViewers(entry, true)
      }
      // Shows what the worker appended outside the live channel (offline deliveries, the linger) and the tool calls it
      // left without a result as interrupted.
      this.#show(worker)
    } catch (error) {
      this.#log(`live relay: a worker was not detached (${errorName(error)})`)
    }
  }

  /** Drops what was shown of `runIds` (a session that ended). */
  forget(runIds: Iterable<string>): void {
    for (const runId of runIds) this.#shown.delete(runId)
  }

  /** The calls in flight of `runId`'s view; [] while its worker's view is being built; null when no worker feeds it. */
  calls(runId: string): readonly LiveViewCall[] | null {
    const entry = this.#runs.get(runId)
    if (entry === undefined) return null
    return entry.view?.calls() ?? []
  }

  /** In one synchronous step: the view's last seq and calls, and a viewer for every later frame. `"rebuilding"` while
   *  a worker feeds the run but its view isn't built; null when no worker feeds it or its view will never be built
   *  again (its snapshots kept failing). */
  join(runId: string): LiveJoin | "rebuilding" | null {
    const entry = this.#runs.get(runId)
    if (entry === undefined || entry.failedBuilds >= MAX_FAILED_BUILDS) return null
    if (entry.view === null) return "rebuilding"
    const viewer = new LiveViewer((v) => entry.viewers.delete(v), this.#queueSize)
    entry.viewers.add(viewer)
    return { lastSeq: entry.view.lastSeq, calls: entry.view.calls(), viewer }
  }

  /** Ends every viewer (office stop). */
  close(): void {
    for (const entry of this.#runs.values()) this.#endViewers(entry, false)
  }

  /** Builds `entry`'s view from its run log and `snapshot`; a failure counts toward the build cap. Returns whether it
   *  built. */
  #build(entry: Entry, snapshot: LiveSnapshot): boolean {
    // Matters only for a snapshot that comes while a view stands (a re-follow after a gap has no viewers, and the
    // worker sends no other): it may skip frames the viewers never got, so they join again.
    this.#dropViewers(entry)
    let view: LiveView
    try {
      view = LiveView.from(iterRunRecords(entry.worker.job.log, { payloads: false }), snapshot)
    } catch {
      this.#failedBuild(entry)
      return false
    }
    entry.view = view
    entry.failedBuilds = 0
    return true
  }

  /** Applies `frame` to `view`, `entry`'s, passes it to the run's viewers unless the view ignored it as a duplicate
   *  record or chunk, and publishes what it changed; a frame it can't apply is a gap. */
  #apply(entry: Entry, view: LiveView, frame: Exclude<WorkerFrame, { type: "snapshot" }>): void {
    // The call's text before a chunk that is its next one; a duplicate chunk changes nothing.
    const before =
      frame.type === "chunk"
        ? view.calls().find((call) => call.node === frame.node && call.n === frame.n && call.nextIndex === frame.index)
        : undefined
    // A duplicate record or chunk changes nothing, so viewers don't get it; and apply drops a duplicate or a gap
    // before decoding a record's line, so only the next record's line is worth a read.
    const fresh = frame.type === "record" ? frame.seq === view.lastSeq + 1 : frame.type !== "chunk" || before !== undefined
    let applied: LiveFrame | null
    try {
      applied =
        frame.type === "record"
          ? { ...frame, line: frame.line ?? (fresh ? readLine(entry.worker.job.log, frame.seq) : "") }
          : frame
      if (!view.apply(applied)) applied = null
    } catch {
      applied = null
    }
    if (applied === null) {
      this.#gap(entry, frame.type)
      return
    }
    if (fresh) for (const viewer of [...entry.viewers]) viewer.push(applied)
    if (frame.type === "chunk") {
      if (before !== undefined) this.#delta(entry.worker, frame.node, frame.n, before.text, frame.text)
    } else if (frame.type !== "end") this.#show(entry.worker)
  }

  /** Renders `worker`'s run with the relay's live calls of the run (none once no worker feeds it) and publishes its
   *  assistant messages' changes since it was last shown, then moves its floor. A render or publish that throws is
   *  logged. */
  #show(worker: LiveWorker): void {
    const { run_id: runId, session_id: sessionId } = worker.job
    try {
      const rendered = this.#transcript.messages(sessionId, [runId], this).filter((m) => m.role === "assistant")
      const live = new Set((this.calls(runId) ?? []).map((call) => `${runId}:${call.node}:${call.n}`))
      const floor = floorOf(rendered, live)
      let shown = this.#shown.get(runId)
      if (shown === undefined) {
        // A client fetched the run after this office started, and what was below the floor then was final.
        shown = { floor, messages: new Map() }
        this.#shown.set(runId, shown)
      }
      const byId = new Map<string, Message>()
      for (const message of rendered) {
        if (message.id < shown.floor) continue
        byId.set(message.id, message)
        const parts = shown.messages.get(message.id)
        if (parts === undefined) {
          this.#publish(worker, "message.updated", message)
          shown.messages.set(message.id, new Map(message.parts.map((part) => [part.id, part])))
          continue
        }
        for (const part of message.parts) {
          const was = parts.get(part.id)
          if (was !== undefined && JSON.stringify(was) === JSON.stringify(part)) continue
          this.#publish(worker, "part.updated", { message_id: message.id, part })
          parts.set(part.id, part)
        }
      }
      // Clients can't remove a part, so a text part that left the render (a failed attempt, the empty live part of a
      // call that only called tools) is emptied once; tool parts never leave.
      for (const [id, parts] of shown.messages) {
        const kept = new Set(byId.get(id)?.parts.map((part) => part.id))
        for (const [partId, part] of parts) {
          if (part.type !== "text" || kept.has(partId)) continue
          if (part.text !== "") this.#publish(worker, "part.updated", { message_id: id, part: { ...part, text: "" } })
          parts.delete(partId)
        }
        if (parts.size === 0) shown.messages.delete(id)
      }
      if (floor > shown.floor) shown.floor = floor
      for (const id of shown.messages.keys()) if (id < shown.floor) shown.messages.delete(id)
    } catch (error) {
      this.#log(`run ${runId}: live events were not published (${errorName(error)})`)
    }
  }

  /** Publishes `text`, the next chunk of `worker`'s call `node`/`n`, as a delta of the call's text part, if that part
   *  shows the call's text so far, `before`; a part that shows other text already shows the log's. */
  #delta(worker: LiveWorker, node: string, n: number, before: string, text: string): void {
    const runId = worker.job.run_id
    const partId = `${runId}:${node}:${n}`
    for (const [messageId, parts] of this.#shown.get(runId)?.messages ?? []) {
      const part = parts.get(partId)
      if (part?.type !== "text") continue
      if (part.text !== before) return
      this.#publish(worker, "part.delta", { message_id: messageId, part_id: partId, text })
      // A new value, since the bus may still hold the old one in a published event.
      parts.set(partId, { ...part, text: part.text + text })
      return
    }
  }

  /** Publishes an event of `type` with `data` on `worker`'s session. */
  #publish(worker: LiveWorker, type: LiveEvent["type"], data: LiveEvent["data"]): void {
    this.#bus.publishLive({ type, session_id: worker.job.session_id, data })
  }

  /** A snapshot of `entry` that didn't build: a gap, or past the cap, the end of following its worker. */
  #failedBuild(entry: Entry): void {
    entry.failedBuilds++
    if (entry.failedBuilds < MAX_FAILED_BUILDS) {
      this.#gap(entry, "snapshot")
      return
    }
    // A worker whose snapshots keep failing would be asked again forever.
    entry.view = null
    this.#log(`run ${entry.runId}: live view can't be built; not following`)
  }

  /** Drops `entry`'s view and viewers and asks its worker for a fresh snapshot; `type` names the frame that broke it. */
  #gap(entry: Entry, type: string): void {
    entry.view = null
    this.#dropViewers(entry)
    this.#log(`run ${entry.runId}: live frames have a gap (${type}); following again`)
    entry.worker.follow().catch((error: unknown) => {
      this.#log(`run ${entry.runId}: live follow failed (${errorName(error)})`)
    })
  }

  /** Drops `entry`'s viewers, which would miss frames: they join again once its view is built. */
  #dropViewers(entry: Entry): void {
    for (const viewer of [...entry.viewers]) viewer.drop()
  }

  /** Ends `entry`'s viewers after their queued frames, with `run_end` first when `runEnd`. */
  #endViewers(entry: Entry, runEnd: boolean): void {
    for (const viewer of [...entry.viewers]) viewer.end(runEnd)
  }
}

/** The id of the earliest of `messages` holding a part of a call in `live` or a running tool part, else of the last;
 *  "" when there are none. */
function floorOf(messages: readonly Message[], live: ReadonlySet<string>): string {
  const open = messages.find((message) =>
    message.parts.some((part) => live.has(part.id) || (part.type === "tool" && part.state === "running")),
  )
  return open?.id ?? messages.at(-1)?.id ?? ""
}

/** `frame`'s type for a log line: a known frame type, else `unknown`; never the frame's own string. */
function typeName(frame: unknown): string {
  if (typeof frame !== "object" || frame === null) return "unknown"
  const type = (frame as { type?: unknown }).type
  return typeof type === "string" && TYPES.has(type) ? type : "unknown"
}

/** `frame` as a worker frame, or null when its type is unknown or a field has the wrong shape. */
function check(frame: unknown): WorkerFrame | null {
  if (typeof frame !== "object" || frame === null) return null
  const f = frame as Record<string, unknown>
  switch (f.type) {
    case "snapshot":
      return isSnapshot(f.snapshot) ? (f as WorkerFrame) : null
    case "record":
      return isCount(f.seq) && (f.line === undefined || typeof f.line === "string") ? (f as WorkerFrame) : null
    case "start":
      return isStep(f) &&
        typeof f.purpose === "string" &&
        (f.model === null || typeof f.model === "string") &&
        typeof f.started_at === "string"
        ? (f as WorkerFrame)
        : null
    case "chunk":
      return isStep(f) && isCount(f.index) && typeof f.text === "string" ? (f as WorkerFrame) : null
    case "end":
      return isStep(f) && (f.error === null || typeof f.error === "string") ? (f as WorkerFrame) : null
    default:
      return null
  }
}

/** Whether `value` is a snapshot: `last_seq` an integer from -1, and each call a step with string chunks. */
function isSnapshot(value: unknown): value is LiveSnapshot {
  if (typeof value !== "object" || value === null) return false
  const { last_seq: last, calls } = value as Record<string, unknown>
  if (!Number.isSafeInteger(last) || (last as number) < -1 || !Array.isArray(calls)) return false
  return calls.every((call: unknown) => {
    if (typeof call !== "object" || call === null) return false
    const c = call as Record<string, unknown>
    return isStep(c) && isCount(c.next_index) && Array.isArray(c.chunks) && c.chunks.every((s) => typeof s === "string")
  })
}

/** Whether `f` names a step: `node` a string and `n` a count. */
function isStep(f: Record<string, unknown>): boolean {
  return typeof f.node === "string" && isCount(f.n)
}

/** Whether `value` is a safe integer from 0. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * The line of record `seq` in the run log `log`, without its newline: a record the worker sent without it.
 *
 * @throws when the log has no record `seq` or can't be read.
 */
function readLine(log: string, seq: number): string {
  for (const entry of iterRunRecords(log, { payloads: false })) {
    if (entry.seq !== seq) continue
    const bytes = Buffer.alloc(entry.end - 1 - entry.offset)
    const fd = fs.openSync(log, "r")
    try {
      if (fs.readSync(fd, bytes, 0, bytes.length, entry.offset) !== bytes.length) throw new RangeError("short read")
    } finally {
      fs.closeSync(fd)
    }
    return bytes.toString("utf8")
  }
  throw new RangeError("no such record")
}

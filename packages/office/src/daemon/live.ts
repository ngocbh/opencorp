/** The live relay: one yian `LiveView` per running worker, built from its snapshot and fed its live frames. */
import fs from "node:fs"
import { iterRunRecords, type LiveFollowFrame, type LiveSnapshot, LiveView, type LiveViewCall } from "@ngocbh/yian/run"
import type { LiveCalls, Transcript } from "../chat/transcript.ts"
import type { Job } from "../worker/job.ts"
import { errorName } from "../worker/rpc.ts"
import type { Bus } from "./bus.ts"

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

/** A run's live state, held for the one worker that feeds it. */
interface Entry {
  readonly runId: string
  readonly worker: LiveWorker
  /** null until the worker's snapshot builds, and after a gap until the next one does. */
  view: LiveView | null
  /** The snapshot builds that failed in a row; at `MAX_FAILED_BUILDS` the worker's frames are ignored. */
  failedBuilds: number
}

/**
 * Keeps, per running worker, a `LiveView` of its run: built per yian's recipe from the run log and the worker's
 * snapshot, then fed every later frame. A gap (a frame the view can't apply, a malformed frame, a snapshot that can't
 * be built) drops the view and asks the worker to follow again; frames are ignored until the next snapshot.
 */
export class LiveRelay implements LiveCalls {
  readonly #bus: Pick<Bus, "publishLive">
  readonly #transcript: Pick<Transcript, "messages">
  readonly #log: (line: string) => void
  readonly #queueSize: number
  readonly #runs = new Map<string, Entry>()

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
        entry = { runId, worker, view: null, failedBuilds: 0 }
        this.#runs.set(runId, entry)
      }
      if (entry.failedBuilds >= MAX_FAILED_BUILDS) return
      const checked = check(frame)
      if (checked === null) {
        const type = typeName(frame)
        if (type === "snapshot") this.#failedBuild(entry)
        else this.#gap(entry, type)
      } else if (checked.type === "snapshot") {
        this.#build(entry, checked.snapshot)
      } else if (entry.view !== null) {
        this.#apply(entry, entry.view, checked)
      }
    } catch (error) {
      this.#log(`live relay: a frame was not handled (${errorName(error)})`)
    }
  }

  /** The calls in flight of `runId`'s view; [] while its worker's view is being built; null when no worker feeds it. */
  calls(runId: string): readonly LiveViewCall[] | null {
    const entry = this.#runs.get(runId)
    if (entry === undefined) return null
    return entry.view?.calls() ?? []
  }

  /** Builds `entry`'s view from its run log and `snapshot`; a failure counts toward the build cap. */
  #build(entry: Entry, snapshot: LiveSnapshot): void {
    let view: LiveView
    try {
      view = LiveView.from(iterRunRecords(entry.worker.job.log, { payloads: false }), snapshot)
    } catch {
      this.#failedBuild(entry)
      return
    }
    entry.view = view
    entry.failedBuilds = 0
  }

  /** Applies `frame` to `view`, `entry`'s; a frame it can't apply is a gap. */
  #apply(entry: Entry, view: LiveView, frame: Exclude<WorkerFrame, { type: "snapshot" }>): void {
    let applied: boolean
    try {
      const log = entry.worker.job.log
      applied = view.apply(frame.type === "record" ? { ...frame, line: frame.line ?? readLine(log, frame.seq) } : frame)
    } catch {
      applied = false
    }
    if (!applied) this.#gap(entry, frame.type)
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

  /** Drops `entry`'s view and asks its worker for a fresh snapshot; `type` names the frame that broke it. */
  #gap(entry: Entry, type: string): void {
    entry.view = null
    this.#log(`run ${entry.runId}: live frames have a gap (${type}); following again`)
    entry.worker.follow().catch((error: unknown) => {
      this.#log(`run ${entry.runId}: live follow failed (${errorName(error)})`)
    })
  }
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
      return isStep(f) && typeof f.purpose === "string" && (f.model === null || typeof f.model === "string")
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

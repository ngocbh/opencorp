/** The run worker: read jobs from the office, run each with Yian and report it; exit after the last. */
import fs from "node:fs"
import path from "node:path"
import {
  advance,
  cancel,
  close as closeInbox,
  complete,
  DeliveryRefused,
  interrupt,
  RunBusyError,
  runFlow,
  send,
} from "@ngocbh/yian"
import {
  type EventHook,
  inspectRun,
  iterRunRecords,
  LiveChannel,
  type LiveFollowFrame,
  type RunInspection,
  type RunResult,
  runLogPath,
} from "@ngocbh/yian/run"
import { loadSkills, type Skill } from "@ngocbh/yian/skills"
import { cancelReplaced, readSeed } from "../chat/history.ts"
import { MAIN_CHAT } from "../chat/turns.ts"
import { loadConfined } from "../company/flows.ts"
import { type Channel, ChannelClosed, type Frame, FrameTooLarge, fdChannel } from "./channel.ts"
import { Delivery, type Job, parseJob, STOP_REASON } from "./job.ts"
import { RemoteMemory } from "./remote_memory.ts"
import { askUserStub, errnoFields, errorMessage, errorName, remoteTool, REPLY_TYPES, Rpc } from "./rpc.ts"

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_ORPHANED = 3
/** How long, in ms, a worker keeps answering deliveries after its last frame, waiting for the office to close. */
export const LINGER_MS = 5000

/** The worker's environment, passed in explicitly. */
export type WorkerEnv = Readonly<Record<string, string | undefined>>

/** How yian reads an environment variable (yian doesn't export its own `Env` type). */
type Env = (name: string) => string | undefined

/** The person's listed skills that exist, in `names` order; a personal skill shadows a shared one of the same name. */
export function pickSkills(pin: string, handle: string, names: string[]): Map<string, Skill> {
  const found = loadSkills([path.join(pin, "people", handle, "skills"), path.join(pin, "shared", "skills")], {
    skipInvalid: true,
  })
  return new Map(names.filter((name) => found.has(name)).map((name) => [name, found.get(name)!]))
}

/** Yian's `tools`: each office group as remote tools, plus the question stub under yian's `ask` slot, which serves
 *  the agent tool `ask_user` and a flow's `ask` node. */
export function jobTools(job: Job, rpc: Rpc) {
  return {
    ...Object.fromEntries(
      Object.entries(job.groups).map(([group, specs]) => [group, specs.map((spec) => remoteTool(rpc, group, spec))]),
    ),
    ask: askUserStub(rpc),
  }
}

/** The memory inputs of the job's flow, by name: each the office's memory of that name, over the channel. */
export function jobMemory(job: Job, rpc: Rpc): Record<string, RemoteMemory> {
  return Object.fromEntries(job.memory.map((name) => [name, new RemoteMemory(rpc, name)]))
}

/** A delivery's answer: a `deliver_reply` without its `type` and `id`. */
type Outcome = { seq: number | null; closed?: string[] } | { refused: string } | { failed: string }

/** A queued delivery; a `quiet` one is a message moved from the replaced run, which the office never sent. */
type Queued = { delivery: Delivery; quiet: boolean }

/**
 * The deliveries a worker applies to its run, in order, each answered by one `deliver_reply`; a quiet one is answered
 * by nobody, and writes a stderr line instead when it isn't applied.
 *
 * `held` keeps them queued until the run can take them; `open` applies them one at a time; `refusing` answers each
 * `refused: "not_started"` at once.
 */
class Deliveries {
  #state: "held" | "open" | "refusing" = "held"
  #queue: Queued[] = []
  #busy = false
  #idle: (() => void)[] = []
  #apply: ((delivery: Delivery) => Promise<Outcome>) | null = null
  readonly #reply: (frame: Frame) => Promise<void>
  /** Settles once the last reply is written (or couldn't be). */
  #written: Promise<void> = Promise.resolve()

  /** Deliveries answered through `reply`, which settles once the frame is written or can't be. */
  constructor(reply: (frame: Frame) => Promise<void>) {
    this.#reply = reply
  }

  /** Sets how a delivery is applied, once the run's log is known. */
  bind(apply: (delivery: Delivery) => Promise<Outcome>): void {
    this.#apply = apply
  }

  /** Queues `delivery` last. On an open, idle queue it is applied before this returns. */
  push(delivery: Delivery): void {
    this.#queue.push({ delivery, quiet: false })
    this.#pump()
  }

  /** Queues `deliveries` ahead of everything queued, in their order; `quiet` ones get no `deliver_reply`. */
  pushFront(deliveries: readonly Delivery[], { quiet = false }: { quiet?: boolean } = {}): void {
    this.#queue.unshift(...deliveries.map((delivery) => ({ delivery, quiet })))
    this.#pump()
  }

  /** Starts applying the queued deliveries, without waiting for them; a no-op unless held. */
  open(): void {
    if (this.#state !== "held") return
    this.#state = "open"
    this.#pump()
  }

  /** Answers every queued and later delivery `refused: "not_started"`; a no-op once open. */
  refuse(): void {
    if (this.#state === "open") return
    this.#state = "refusing"
    this.#pump()
  }

  /** Only for a held queue: applies the first `n` queued deliveries one at a time, each answered as usual, while
   *  the queue stays held; the rest wait for `open()`. */
  async applyFirst(n: number): Promise<void> {
    const first = this.#queue.splice(0, n)
    this.#busy = true
    try {
      for (const queued of first) await this.#run(queued)
    } finally {
      this.#busy = false
      this.#pump()
    }
  }

  /** Resolves once nothing is queued or being applied and every reply is written; on a held queue with deliveries
   *  queued, only after `open()` or `refuse()`. */
  async drained(): Promise<void> {
    if (this.#busy || this.#queue.length > 0) await new Promise<void>((resolve) => this.#idle.push(resolve))
    // The worker exits soon after, and a write still in flight at exit is lost. Frames are written in order, so the
    // last reply written means every one is.
    await this.#written
  }

  #pump(): void {
    if (this.#state === "refusing") {
      for (const queued of this.#queue.splice(0)) this.#answer(queued, { refused: "not_started" })
    } else if (this.#state === "open" && !this.#busy && this.#queue.length > 0) {
      this.#busy = true
      // `#run` never rejects: `#apply` is bound before `open()`, and the applier catches every error.
      void this.#run(this.#queue.shift()!).finally(() => {
        this.#busy = false
        this.#pump()
      })
      return
    }
    if (!this.#busy && this.#queue.length === 0) for (const resolve of this.#idle.splice(0)) resolve()
  }

  // Calls `apply` before its first await, so a delivery to the live run commits in this tick.
  async #run(queued: Queued): Promise<void> {
    this.#answer(queued, await this.#apply!(queued.delivery))
  }

  /** Sends `queued`'s `deliver_reply`; for a quiet one, a stderr line when it wasn't applied. */
  #answer({ delivery, quiet }: Queued, outcome: Outcome): void {
    if (!quiet) {
      this.#written = this.#reply({ type: "deliver_reply", id: delivery.id, ...outcome })
    } else if ("refused" in outcome || "failed" in outcome) {
      // The reason or the error's type only: the message's text is the person's.
      const why = "refused" in outcome ? outcome.refused : outcome.failed
      process.stderr.write(`opencorp __worker: a moved message was not delivered (${why})\n`)
    }
  }
}

/** Applies a delivery to the run at `log` through yian, confined to `codeRoot` as the run is; never rejects. A
 *  refusal is answered with its reason, any other error with its name only, since a yian message can quote a
 *  value. */
function applier(log: string, env: Env, codeRoot: string): (delivery: Delivery) => Promise<Outcome> {
  const options = { env, codeRoot }
  return async (delivery) => {
    try {
      switch (delivery.op) {
        case "send":
          return { seq: await send(log, delivery.inbox, delivery.event, options) }
        case "complete":
          return { seq: await complete(log, delivery.call_id, delivery.result, options) }
        case "close":
          return { seq: await closeInbox(log, delivery.inbox, options) }
        case "interrupt":
          return { seq: null, closed: (await interrupt(log, delivery.inbox, options)).calls.map((call) => call.callId) }
        case "cancel":
          return { seq: null, closed: (await cancel(log, options)).map((call) => call.callId) }
      }
    } catch (error) {
      if (error instanceof DeliveryRefused) return { refused: error.reason }
      return { failed: errorName(error) }
    }
  }
}

/** The calls a run waits on, in a frame's field names. */
function wireWaits(waits: RunInspection["waits"]): Frame[] {
  return waits.map((w) => ({
    node: w.node,
    call_id: w.callId,
    tool: w.tool,
    inbox: w.inbox,
    deadline: w.deadline,
    settled: w.settled,
  }))
}

/** A waiting run's `status`, `waits` and `failure` as its log says now. */
function waitingFields(log: string): Frame {
  const inspection = inspectRun(log)
  return { status: inspection.status, waits: wireWaits(inspection.waits), failure: inspection.failure }
}

/** Whether an `advance` that threw `error` was refused before it appended anything: a yian refusal (each is a
 *  `RangeError`: `LoadError`, `DefaultsMismatchError`, a resume refusal such as a memory whose settings differ from
 *  the recorded ones) and nothing of its own appended. */
export function notResumed(error: unknown, appended: boolean): boolean {
  return error instanceof RangeError && !appended
}

/** For an error reading a run log that a host can't fix by trying again, its errno code (`ENOENT`, `ENOTDIR`: the log
 *  or its folder is gone; `EINVAL`: it isn't a regular file, such as a FIFO, which yian refuses to read) or its type
 *  (a `RangeError`: a line that isn't a record this version reads); else null. Never its message, which quotes the
 *  log's path and values. */
export function unreadableLog(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL") return code
  return error instanceof RangeError ? errorName(error) : null
}

/** The record kinds an `advance` starts each of its appends with; no delivery writes any of them. */
const ADVANCE_KINDS = ["run_resumed", "node_woken", "node_started"]

/** Whether `advance` appended a record of its own to `log` after seq `before`; true when unsure. Each of its appends
 *  starts with a `run_resumed`, `node_woken` or `node_started` record, and no delivery writes any of them, so a
 *  delivery that lands after `advance` let go of the log, or a torn-tail repair, doesn't count. */
export function advanceAppended(log: string, before: number | null): boolean {
  if (before === null) return true
  try {
    for (const record of iterRunRecords(log, { payloads: false, kinds: ADVANCE_KINDS })) {
      if (record.seq > before) return true
    }
    return false
  } catch {
    return true
  }
}

/** The fields of an event's data that carry a run's values, which the office never reads from an event frame; a
 *  `NodeExpanded`'s `grow.seed` is one too. */
const VALUE_KEYS = ["output", "arguments", "result"]

/** The fields of an event's data the office reads (`SessionActor.#event`, `OpenNodes.apply`), besides `failure`'s
 *  `node_id`. */
export const READ_KEYS = ["node_id", "call_id", "call_ids", "reason", "usage", "model", "error_type"]

/** The smaller forms of an event's `data` to send when its frame is over the limit, largest first: when it has a
 *  value field, `data` with each value set to null (a `NodeExpanded` keeps its `grow.prune`), then only the fields
 *  the office reads, so a stubbed event still names its node, call and model call usage. */
export function eventStubs(data: Record<string, unknown>): Frame[] {
  const stubs: Frame[] = []
  const grow = data.grow
  const growing = typeof grow === "object" && grow !== null && !Array.isArray(grow)
  if (growing || VALUE_KEYS.some((key) => Object.hasOwn(data, key))) {
    const stub: Frame = { ...data }
    for (const key of VALUE_KEYS) if (Object.hasOwn(stub, key)) stub[key] = null
    if (growing) stub.grow = { ...grow, seed: null }
    stubs.push(stub)
  }
  const minimal: Frame = {}
  for (const key of READ_KEYS) if (Object.hasOwn(data, key)) minimal[key] = data[key]
  const failure = data.failure
  if (typeof failure === "object" && failure !== null && !Array.isArray(failure)) {
    minimal.failure = Object.hasOwn(failure, "node_id") ? { node_id: (failure as Frame).node_id } : {}
  }
  stubs.push(minimal)
  return stubs
}

/**
 * The worker's follow of its run's live channel: each follow frame goes to the office as `{type: "stream", frame}`.
 * `serve` makes one per job; `runJob` binds it to the run call's channel, which it follows from inside the first frame;
 * the office's `follow` frame restarts it with a fresh snapshot.
 */
class LiveFollow {
  readonly #channel: Channel
  #again: (() => void) | null = null
  #close: (() => void) | null = null

  /** A follow whose frames go out on `channel`. */
  constructor(channel: Channel) {
    this.#channel = channel
  }

  /** Follows `live` from inside its first frame. */
  bind(live: LiveChannel): void {
    const unsubscribe = live.subscribe(() => {
      unsubscribe()
      // `wrap` sets `last_seq` when the run boundary opens the log, so a snapshot before the first frame would be
      // stale for an advance. The channel updates its state before it sends, so this snapshot already includes this
      // frame.
      let stop = live.follow(this.#forward)
      this.#again = () => {
        stop()
        stop = live.follow(this.#forward)
      }
      this.#close = () => stop()
    })
  }

  /** Stops the current follow and follows again, from a fresh snapshot; a no-op until following has started. */
  again(): void {
    this.#again?.()
  }

  /** Stops the current follow for good: the worker moves on to its next job. */
  close(): void {
    this.#close?.()
    this.#again = null
    this.#close = null
  }

  /** Sends `frame` as a `stream` frame; a `record` frame over the channel's limit goes without its `line`, which the
   *  office reads from the log. */
  readonly #forward = (frame: LiveFollowFrame): void => {
    const bare =
      frame.type === "record" ? () => [{ type: "stream", frame: { type: "record", seq: frame.seq } }] : undefined
    // Not awaited: `send` hands the bytes over before its first await, so frames keep call order with the awaited
    // `event` and `result` frames.
    this.#channel.send({ type: "stream", frame }, bare).catch((error: unknown) => {
      if (error instanceof ChannelClosed) return
      process.stderr.write(`opencorp __worker: a live frame was not sent (${errorName(error)})\n`)
    })
  }
}

/** One job's state: whether it finished, its deliveries, its stop and its run's live follow. */
class JobState {
  finished = false
  readonly follow: LiveFollow
  readonly deliveries: Deliveries
  readonly stopper = new AbortController()

  constructor(channel: Channel) {
    this.follow = new LiveFollow(channel)
    // A reply that can't be sent (a closed channel) has nobody to read it.
    this.deliveries = new Deliveries((frame) => channel.send(frame).catch(() => {}))
  }
}

/** The frames that end a kept worker's waits, in order: `done`, `start`, a `stop` once the job finished, and null
 *  once the office closed the channel. */
class Mailbox {
  readonly #frames: (Frame | null)[] = []
  #waiter: ((frame: Frame | null) => void) | null = null

  put(frame: Frame | null): void {
    const waiter = this.#waiter
    this.#waiter = null
    if (waiter !== null) waiter(frame)
    else this.#frames.push(frame)
  }

  take(): Promise<Frame | null> {
    if (this.#frames.length > 0) return Promise.resolve(this.#frames.shift()!)
    return new Promise((resolve) => (this.#waiter = resolve))
  }
}

/** What `serve` and `readFrames` share: the current job's state, whether the worker is parked, and the mailbox. */
interface WorkerState {
  job: JobState
  parked: boolean
  readonly mail: Mailbox
}

/** Whether `job` is the next job a worker kept after `previous` may run: an `advance` of the same session, run, log
 *  and pin. */
function nextOf(previous: Job, job: Job): boolean {
  return (
    job.kind === "advance" &&
    job.session_id === previous.session_id &&
    job.run_id === previous.run_id &&
    job.log === previous.log &&
    job.pin === previous.pin
  )
}

/**
 * Runs the jobs the office sends on `channel`; returns the exit code. A `check` job sends only its result frame,
 * `{type: "result", problem}`, or its `error` frame when a `stop` frame ended it. A seeded chat job whose replaced
 * run's history can't be read sends `{type: "event", name: "history_not_seeded", data: {error_type}}` before its run
 * starts.
 *
 * Each delivery (the job's `deliver` list first, then each `deliver` frame) is applied to the run with a yian host
 * call once the run has started, in order, and answered by one `deliver_reply`; ones the run can't take because it
 * never started are refused `not_started`. The last frame is `result` (or `error`: `{type: "error", message,
 * traceback}`, with the errno `code` and `syscall` of a failed system call), sent once every delivery received so far
 * is answered. After it the worker keeps applying and answering deliveries until the office closes its side
 * (or `linger` ms pass). A run's result is `{type: "result", status, run_id, output, failure, waits}`, or, for an
 * advance yian refused before it appended anything, `{type: "result", status: "not_resumed", run_id, error_type}`; an
 * advance or delivery job whose log is gone or can't be read sends that result with `unreadable: true`, and refuses its
 * deliveries.
 * If the office closes the channel before the job finished, `exit` is called with `EXIT_ORPHANED`: nobody can answer
 * a question or read the result.
 *
 * A `keep` job whose result is `waiting`, and that no `stop` reached, sends it with `kept: true` and stays up: the
 * office answers `done`, the worker answers every delivery it got before that, then sends `{type: "parked"}`. A parked
 * worker runs the next `start` frame's job, which must be an `advance` of the same session, run, log and pin (any
 * other is an `error` and the worker exits `EXIT_FAILED`), and ignores `follow`; the office closing its side, or a
 * `stop`, ends it with the code of its last job. A `stop` or the office closing its side before `done` ends it once
 * its deliveries are answered.
 */
export async function serve(
  channel: Channel,
  { env, linger = LINGER_MS, exit }: { env: WorkerEnv; linger?: number; exit: (code: number) => void },
): Promise<number> {
  const started = channel.recv()
  try {
    await started
  } catch (error) {
    if (error instanceof ChannelClosed) {
      channel.close()
      return EXIT_ORPHANED
    }
  }
  const rpc = new Rpc(channel)
  const state: WorkerState = { job: new JobState(channel), parked: false, mail: new Mailbox() }
  const officeClosed = readFrames(channel, rpc, state, exit)
  let start: Promise<Frame> = started
  let previous: Job | null = null
  for (;;) {
    const ran = await serveJob(channel, rpc, state.job, start, previous, env)
    const code = await report(channel, [ran.last], ran.code)
    if (ran.last.kept !== true || code !== EXIT_OK) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        officeClosed.then(() => state.job.deliveries.drained()),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, linger))),
      ])
      clearTimeout(timer)
      channel.close()
      return code
    }
    const ended = await state.mail.take()
    // Every delivery the office sent before `done` is answered before `parked`, as before the end of stream.
    await state.job.deliveries.drained()
    if (ended?.type !== "done" || !(await sendQuietly(channel, { type: "parked" }))) {
      channel.close()
      return code
    }
    state.parked = true
    const next = await state.mail.take()
    state.parked = false
    if (next?.type !== "start") {
      channel.close()
      return code
    }
    state.job.follow.close()
    state.job = new JobState(channel)
    start = Promise.resolve(next)
    previous = ran.job
  }
}

/** Sends `frame`; false when it can't be sent. */
async function sendQuietly(channel: Channel, frame: Frame): Promise<boolean> {
  try {
    await channel.send(frame)
    return true
  } catch {
    return false
  }
}

/** Runs the job of the `start` frame `started` resolves to on `state`, once every delivery it got is answered;
 *  returns its closing frame (with `kept: true` for a `keep` job whose run waits), its exit code and the job. A
 *  worker kept after `previous` refuses any job but the run's next advance. */
async function serveJob(
  channel: Channel,
  rpc: Rpc,
  state: JobState,
  started: Promise<Frame>,
  previous: Job | null,
  env: WorkerEnv,
): Promise<{ last: Frame; code: number; job: Job | null }> {
  const { deliveries, stopper } = state
  let last: Frame
  let code: number
  let job: Job | null = null
  try {
    // A first frame that couldn't be read rejects again here, as the job's error.
    const start = await started
    if (start.type !== "start") throw new TypeError("expected a start frame")
    job = parseJob(start.job)
    if (previous !== null && !nextOf(previous, job)) {
      throw new TypeError("a kept worker runs only its run's next advance")
    }
    deliveries.pushFront(job.deliver)
    if (job.kind === "check") {
      // A check job has no run to deliver to.
      deliveries.refuse()
      // Loaded only here, so a chat worker doesn't load onboarding.
      const { runCheck } = await import("../chat/check.ts")
      last = { type: "result", problem: await runCheck(job, env, stopper.signal) }
    } else {
      last = {
        type: "result",
        ...(await runJob(job, channel, rpc, deliveries, state.follow, { env, signal: stopper.signal })),
      }
      // After the run call a delivery applies offline, with yian taking the lock; a no-op once RunStarted opened it.
      deliveries.open()
    }
    code = EXIT_OK
  } catch (error) {
    deliveries.refuse()
    last = {
      type: "error",
      message: `${errorName(error)}: ${errorMessage(error)}`,
      traceback: stackFrames(error),
      ...errnoFields(error),
    }
    code = EXIT_FAILED
  }
  state.finished = true
  await deliveries.drained()
  // No await from here to the send, so a reply already sent is in what the frame says.
  if (last.type === "result" && last.status === "waiting" && job !== null && job.kind !== "check") {
    try {
      const now = waitingFields(job.log)
      // `running`: a delivery after the drain holds the lock; it replies after this frame.
      if (now.status !== "running") Object.assign(last, now)
    } catch {
      // The run call's own fields still describe the run.
    }
    // A stop that came during the job still ends the worker, though the run waits.
    if (job.keep && last.status === "waiting" && !stopper.signal.aborted) last.kept = true
  }
  return { last, code, job }
}

/** Runs `job`, sending its event frames and, through `follow`, its live frames, and lets `deliveries` apply to the run
 *  once it can take them; returns the result frame's fields. A chat job runs its flow afresh; with a seed, its
 *  `summary` and `history` inputs are the replaced run's, read from that run's log (confined to the pin), or `""` and
 *  `[]` with a `history_not_seeded` event when they can't be read; the replaced run's unread messages go to the fresh
 *  run first, as quiet deliveries, and with `seed.cancel` that run is cancelled when it hasn't finished. An advance
 *  job applies the deliveries the run can take now, then moves the run on from its log with yian's `advance` (or,
 *  with `advance: false`, only delivers); when yian refuses the advance before appending anything, the fields are
 *  `{status: "not_resumed", run_id, error_type}` and the deliveries still held are refused `not_started`; so are they
 *  when the run's log is gone or can't be read, with `unreadable: true`. */
async function runJob(
  job: Job,
  channel: Channel,
  rpc: Rpc,
  deliveries: Deliveries,
  follow: LiveFollow,
  { env, signal }: { env: WorkerEnv; signal: AbortSignal },
): Promise<Frame> {
  const read = reader(env)
  const flow = job.kind === "chat" ? await loadConfined(job.pin, path.join(job.pin, job.flow)) : null
  const runs = path.dirname(path.dirname(job.log))
  if (job.log !== path.join(runs, job.run_id, "log.jsonl")) {
    throw new RangeError("a job's log must be <runs>/<run_id>/log.jsonl")
  }
  // A chat job makes the run's folder, and throws EEXIST if it is already there: each launch gets a fresh one. An
  // advance job's log must exist.
  const log = job.kind === "advance" ? job.log : runLogPath(runs, job.run_id)
  // An off-engine delivery recompiles the recorded flow, so it is confined to the pin as the run is.
  deliveries.bind(applier(log, read, job.pin))
  const onEvent: EventHook = (event) => {
    // Not awaited: a delivery waits for the run to go live, which happens after this observer returns.
    if (event.type === "RunStarted" || event.type === "RunResumed") deliveries.open()
    // A send that fails rejects the run. An event over the frame limit goes without its values: the office reads none
    // of them, and the log keeps them. `send` picks the stub before its first await, so frames keep call order.
    const data: Frame = event.toJSON()
    let stubbed = false
    const sent = channel.send({ type: "event", name: event.type, data }, () => {
      stubbed = true
      return eventStubs(data).map((stub) => ({ type: "event", name: event.type, data: stub }))
    })
    return sent.then(() => {
      // The type only: the values are the run's.
      if (stubbed) process.stderr.write(`opencorp __worker: a ${event.type} event frame went without its values\n`)
    })
  }
  // Each job makes at most one run call, so this is one channel per run call.
  const live = new LiveChannel({
    onSubscriberError: (error) =>
      process.stderr.write(`opencorp __worker: a live frame was dropped (${errorName(error)})\n`),
  })
  follow.bind(live)
  const memory = jobMemory(job, rpc)
  const common = {
    log,
    onEvent,
    live,
    tools: jobTools(job, rpc),
    skills: pickSkills(job.pin, job.person, job.skills),
    signal,
    env: read,
  }
  let result: RunResult
  if (flow !== null) {
    let inputs = job.inputs
    if (job.seed !== null) {
      const seedOptions = { env: reader(job.seed.env), codeRoot: job.pin }
      const seeded = await readSeed(job.seed.log, seedOptions)
      if (seeded.error !== null) {
        process.stderr.write(`opencorp __worker: history not seeded (${seeded.error})\n`)
        await channel.send({ type: "event", name: "history_not_seeded", data: { error_type: seeded.error } })
      }
      inputs = { ...job.inputs, summary: seeded.summary, history: seeded.history }
      // After a stop the fresh run won't start, so the replaced run stays as it is for the next fresh run.
      if (job.seed.cancel && !signal.aborted) await cancelReplaced(job.seed.log, seedOptions)
      // Ahead of the job's own deliveries, which `serve` queued first.
      deliveries.pushFront(
        seeded.unread.map((event, n) => ({ id: `moved-${n}`, op: "send", inbox: MAIN_CHAT.inbox, event })),
        { quiet: true },
      )
    }
    // A memory is a flow input.
    result = await runFlow(flow, { ...inputs, ...memory }, {
      ...common,
      runId: job.run_id,
      numWorkers: job.num_workers,
      llmConfig: job.llm_config,
      parent: job.parent && { runId: job.parent.run_id, node: job.parent.node },
    })
  } else {
    let inspection: ReturnType<typeof inspectRun>
    try {
      inspection = inspectRun(log)
    } catch (error) {
      const why = unreadableLog(error)
      if (why === null) throw error
      // Nothing was appended, so the run is as it was: the office starts a fresh run in its place.
      deliveries.refuse()
      return { status: "not_resumed", run_id: job.run_id, error_type: why, unreadable: true }
    }
    const status = inspection.status
    if (!job.advance) {
      // This job only delivers to a run at rest; a running one is someone else's to move.
      if (status === "running") throw new RunBusyError(log)
      deliveries.open()
      await deliveries.drained()
      return { run_id: job.run_id, output: null, ...waitingFields(log) }
    }
    if (status === "stopped" || status === "crashed") {
      // Offline, an interrupt or close finds no agent to cut, so it and everything after waits for RunResumed;
      // the ones before it reach the log before the resumed run replays it.
      const cut = job.deliver.findIndex((delivery) => delivery.op === "interrupt" || delivery.op === "close")
      await deliveries.applyFirst(cut === -1 ? job.deliver.length : cut)
    } else if (status !== "running") {
      // A waiting run reads its deliveries when it wakes, and an ended one refuses them; no RunResumed comes.
      deliveries.open()
      await deliveries.drained()
    }
    // A stop that came while the deliveries applied would make `advance` throw though it appended nothing; the run
    // is then as its log says, as after a job that only delivers.
    if (signal.aborted) return { run_id: job.run_id, output: null, ...waitingFields(log) }
    const config = job.llm_config ?? {}
    // Read before the deliveries applied: none writes a run_resumed, node_woken or node_started record.
    const before = inspection.lastSeq
    try {
      result = await advance({
        ...common,
        // Every advance of an unfinished run binds its memories again; a run with none takes no `memory`.
        ...(job.memory.length > 0 ? { memory } : {}),
        codeRoot: job.pin,
        // `null` keeps the recorded bound: a changed one would make a waiting run write RunResumed.
        numWorkers: null,
        apiKey: typeof config.api_key === "string" ? config.api_key : null,
        headers: stringRecord(config.headers),
      })
    } catch (error) {
      if (!notResumed(error, advanceAppended(log, before))) throw error
      deliveries.refuse()
      // The type only: a yian message can quote a value or a path.
      return { status: "not_resumed", run_id: job.run_id, error_type: errorName(error) }
    }
    // A crash resume keeps the recall the run started with; a memory that changed since is only worth a line.
    for (const drift of result.memoryDrift) {
      process.stderr.write(`opencorp __worker: memory ${drift.input} changed since the run started\n`)
    }
  }
  return {
    status: result.status,
    run_id: result.runId,
    output: result.output,
    failure: result.failure,
    waits: wireWaits(result.waits),
  }
}

/** How yian reads a variable of `env`: its own entries only. */
function reader(env: WorkerEnv): Env {
  return (name) => (Object.hasOwn(env, name) ? env[name] : undefined)
}

/** `value` when it is a record of strings, else `null`. */
function stringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return Object.values(value).every((v) => typeof v === "string") ? (value as Record<string, string>) : null
}

/**
 * Routes office frames until the channel closes or a frame can't be read: a delivery, `stop` and `follow` to the
 * current job (a `stop` after the job finished, `done` and `start` go to the mailbox; a parked worker ignores
 * `follow`). Then rejects pending and later requests and, unless the job has finished, stops the run and calls
 * `exit(EXIT_ORPHANED)`; then puts null in the mailbox. Never rejects.
 */
async function readFrames(
  channel: Channel,
  rpc: Rpc,
  state: WorkerState,
  exit: (code: number) => void,
): Promise<void> {
  try {
    for (;;) {
      const frame = await channel.recv()
      const job = state.job
      if (frame.type === "deliver") {
        const { type: _, ...fields } = frame
        const parsed = Delivery.safeParse(fields)
        if (!parsed.success) throw new TypeError("a deliver frame is malformed")
        // Never awaited here: a delivery can wait on the run, which may need store replies only this loop delivers.
        job.deliveries.push(parsed.data)
      } else if (frame.type === "stop") {
        if (!job.finished) job.stopper.abort(new Error(STOP_REASON))
        else state.mail.put(frame)
      } else if (frame.type === "follow") {
        // A no-op before the run's first frame and for a check job; after the run call it sends one last snapshot and
        // nothing after it.
        if (!state.parked) job.follow.again()
      } else if (frame.type === "done" || frame.type === "start") {
        state.mail.put(frame)
      } else if (typeof frame.type === "string" && REPLY_TYPES.has(frame.type)) {
        rpc.deliver(frame)
      }
    }
  } catch (error) {
    if (!(error instanceof ChannelClosed)) {
      process.stderr.write(`opencorp __worker: bad office frame (${errorName(error)})\n`)
    }
  }
  // Store requests take no signal; in process, they end here.
  rpc.close(new ChannelClosed())
  if (!state.job.finished) {
    // So an in-process run stops too; in the worker process `exit` ends everything first.
    state.job.stopper.abort(new Error("the office closed the channel"))
    exit(EXIT_ORPHANED)
  }
  state.mail.put(null)
}

/**
 * Sends the closing `frames` in order; returns the exit code. A frame too large to send, or one that fails to send
 * for another reason, is replaced by an `error` frame and makes the code `EXIT_FAILED`; a closed channel makes it
 * `EXIT_ORPHANED`.
 */
export async function report(channel: Channel, frames: Frame[], code: number): Promise<number> {
  for (const frame of frames) {
    try {
      await channel.send(frame)
    } catch (error) {
      if (error instanceof ChannelClosed) return EXIT_ORPHANED
      // Another error's message could quote the frame.
      const message =
        error instanceof FrameTooLarge
          ? `FrameTooLarge: ${error.message}`
          : `${errorName(error)}: the frame could not be sent`
      code = EXIT_FAILED
      try {
        await channel.send({ type: "error", message, traceback: "" })
      } catch (error) {
        return error instanceof ChannelClosed ? EXIT_ORPHANED : EXIT_FAILED
      }
    }
  }
  return code
}

/** The stack frame lines of `error`'s stack (never its message, which could quote the job); "" if it has none. */
function stackFrames(error: unknown): string {
  try {
    if (!(error instanceof Error) || typeof error.stack !== "string") return ""
    return error.stack
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .join("\n")
  } catch {
    // A getter or a revoked Proxy can throw.
    return ""
  }
}

/** Whether `fd` is a socket, as the office's channel is; false when `fd` isn't open. */
export function isOfficeChannel(fd: number): boolean {
  try {
    return fs.fstatSync(fd).isSocket()
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "EBADF") return false
    throw error
  }
}

/**
 * The `__worker` mode: serves the jobs the office sends on fd 3, then exits with the code. Exits
 * `EXIT_ORPHANED` at once when fd 3 isn't a socket: Bun keeps a pipe of its own at fd 3 when the parent passes
 * none, so an open fd 3 alone doesn't mean an office is there. An fstat error other than EBADF is thrown on purpose:
 * it means a broken process, not a missing channel.
 */
export async function main(_argv: string[], env: WorkerEnv): Promise<never> {
  if (!isOfficeChannel(3)) {
    process.stderr.write("opencorp __worker: no office channel on fd 3\n")
    process.exit(EXIT_ORPHANED)
  }
  // `process.exit`, not a return: a read blocked on fd 3 would keep the event loop alive.
  const code = await serve(fdChannel(3), { env, exit: (c) => process.exit(c) })
  process.exit(code)
}

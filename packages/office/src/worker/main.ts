/** The run worker: read one job from the office, run it with Yian, report, exit. */
import fs from "node:fs"
import path from "node:path"
import {
  cancel,
  close as closeInbox,
  complete,
  DeliveryRefused,
  interrupt,
  ProfileMemory,
  runFlow,
  send,
} from "@ngocbh/yian"
import { type EventHook, inspectRun, type RunInspection, runLogPath } from "@ngocbh/yian/run"
import { loadSkills, type Skill } from "@ngocbh/yian/skills"
import { loadConfined } from "../company/flows.ts"
import { type Channel, ChannelClosed, type Frame, FrameTooLarge, fdChannel } from "./channel.ts"
import { Delivery, type Job, parseJob } from "./job.ts"
import { RemoteMarkdownStore } from "./remote_store.ts"
import { askUserStub, errorMessage, errorName, remoteTool, REPLY_TYPES, Rpc } from "./rpc.ts"

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

/** Yian's `memory` for the job: a `ProfileMemory` over the office store of each spec; `null` when there is none. */
export function jobMemory(job: Job, rpc: Rpc, env: Env): Map<string, ProfileMemory> | null {
  const memory = new Map(
    Object.entries(job.memory).map(([name, spec]) => [
      name,
      new ProfileMemory(new RemoteMarkdownStore(rpc, spec.store), {
        llmConfig: spec.llm_config,
        maxChars: spec.max_chars,
        env,
      }),
    ]),
  )
  return memory.size > 0 ? memory : null
}

/** A delivery's answer: a `deliver_reply` without its `type` and `id`. */
type Outcome = { seq: number | null; closed?: string[] } | { refused: string } | { failed: string }

/**
 * The deliveries a worker applies to its run, in order, each answered by one `deliver_reply`.
 *
 * `held` keeps them queued until the run can take them; `open` applies them one at a time; `refusing` answers each
 * `refused: "not_started"` at once.
 */
class Deliveries {
  #state: "held" | "open" | "refusing" = "held"
  #queue: Delivery[] = []
  #busy = false
  #idle: (() => void)[] = []
  #apply: ((delivery: Delivery) => Promise<Outcome>) | null = null
  readonly #reply: (frame: Frame) => void

  /** Deliveries answered through `reply`. */
  constructor(reply: (frame: Frame) => void) {
    this.#reply = reply
  }

  /** Sets how a delivery is applied, once the run's log is known. */
  bind(apply: (delivery: Delivery) => Promise<Outcome>): void {
    this.#apply = apply
  }

  /** Queues `delivery` last. On an open, idle queue it is applied before this returns. */
  push(delivery: Delivery): void {
    this.#queue.push(delivery)
    this.#pump()
  }

  /** Queues `deliveries` ahead of everything queued, in their order. */
  pushFront(deliveries: readonly Delivery[]): void {
    this.#queue.unshift(...deliveries)
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
      for (const delivery of first) await this.#run(delivery)
    } finally {
      this.#busy = false
      this.#pump()
    }
  }

  /** Resolves once nothing is queued or being applied; on a held queue with deliveries queued, only after `open()`
   *  or `refuse()`. */
  drained(): Promise<void> {
    if (!this.#busy && this.#queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.#idle.push(resolve))
  }

  #pump(): void {
    if (this.#state === "refusing") {
      for (const { id } of this.#queue.splice(0)) this.#reply({ type: "deliver_reply", id, refused: "not_started" })
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
  async #run(delivery: Delivery): Promise<void> {
    const outcome = await this.#apply!(delivery)
    this.#reply({ type: "deliver_reply", id: delivery.id, ...outcome })
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
          return { seq: null, closed: (await interrupt(log, delivery.inbox, options)).map((call) => call.callId) }
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

/** What `serve` and `readFrames` share: whether the job finished. */
interface WorkerState {
  finished: boolean
}

/**
 * Runs the job the office sends on `channel`; returns the exit code. A `check` job sends only its result frame,
 * `{type: "result", problem}`.
 *
 * Each delivery (the job's `deliver` list first, then each `deliver` frame) is applied to the run with a yian host
 * call once the run has started, in order, and answered by one `deliver_reply`; ones the run can't take because it
 * never started are refused `not_started`. The last frame is `result` (or `error`), sent once every delivery received
 * so far is answered. After it the worker keeps applying and answering deliveries until the office closes its side
 * (or `linger` ms pass). If the office closes the channel before the job finished, `exit` is called with
 * `EXIT_ORPHANED`: nobody can answer a question or read the result.
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
  // A reply that can't be sent (a closed channel) has nobody to read it.
  const deliveries = new Deliveries((frame) => void channel.send(frame).catch(() => {}))
  const stopper = new AbortController()
  const state: WorkerState = { finished: false }
  const officeClosed = readFrames(channel, rpc, deliveries, stopper, state, exit)
  let last: Frame
  let code: number
  let log: string | undefined
  try {
    // A first frame that couldn't be read rejects again here, as the job's error.
    const start = await started
    if (start.type !== "start") throw new TypeError("expected a start frame")
    const job = parseJob(start.job)
    deliveries.pushFront(job.deliver)
    if (job.kind === "check") {
      // A check job has no run to deliver to.
      deliveries.refuse()
      // Loaded only here, so a chat worker doesn't load onboarding.
      const { runCheck } = await import("../chat/check.ts")
      last = { type: "result", problem: await runCheck(job, env) }
    } else {
      log = job.log
      last = { type: "result", ...(await runJob(job, channel, rpc, deliveries, { env, signal: stopper.signal })) }
      // After the run call a delivery applies offline, with yian taking the lock; a no-op once RunStarted opened it.
      deliveries.open()
    }
    code = EXIT_OK
  } catch (error) {
    deliveries.refuse()
    last = { type: "error", message: `${errorName(error)}: ${errorMessage(error)}`, traceback: stackFrames(error) }
    code = EXIT_FAILED
  }
  state.finished = true
  await deliveries.drained()
  // No await from here to the send, so a reply already sent is in what the frame says.
  if (last.type === "result" && last.status === "waiting" && log !== undefined) {
    try {
      const now = waitingFields(log)
      // `running`: a delivery after the drain holds the lock; it replies after this frame.
      if (now.status !== "running") Object.assign(last, now)
    } catch {
      // The run call's own fields still describe the run.
    }
  }
  code = await report(channel, [last], code)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    officeClosed.then(() => deliveries.drained()),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, linger))),
  ])
  clearTimeout(timer)
  channel.close()
  return code
}

/** Runs `job`, sending its event and stream frames, and lets `deliveries` apply to the run once it has started;
 *  returns the result frame's fields. */
async function runJob(
  job: Job,
  channel: Channel,
  rpc: Rpc,
  deliveries: Deliveries,
  { env, signal }: { env: WorkerEnv; signal: AbortSignal },
): Promise<Frame> {
  if (job.kind === "advance") throw new Error("this worker can't resume a run yet")
  const read: Env = (name) => (Object.hasOwn(env, name) ? env[name] : undefined)
  const flow = await loadConfined(job.pin, path.join(job.pin, job.flow))
  const runs = path.dirname(path.dirname(job.log))
  if (job.log !== path.join(runs, job.run_id, "log.jsonl")) {
    throw new RangeError("a chat job's log must be <runs>/<run_id>/log.jsonl")
  }
  // Makes the run's folder, and throws EEXIST if it is already there: each launch gets a fresh one.
  const log = runLogPath(runs, job.run_id)
  // An off-engine delivery recompiles the recorded flow, so it is confined to the pin as the run is.
  deliveries.bind(applier(log, read, job.pin))
  const onEvent: EventHook = (event) => {
    // Not awaited: a delivery waits for the run to go live, which happens after this observer returns.
    if (event.type === "RunStarted") deliveries.open()
    // A send that fails rejects the run.
    return channel.send({ type: "event", name: event.type, data: event.toJSON() })
  }
  const result = await runFlow(flow, job.inputs, {
    log,
    runId: job.run_id,
    numWorkers: job.num_workers,
    onEvent,
    onStream: (chunk) => channel.send({ type: "stream", ...chunk.toJSON() }),
    llmConfig: job.llm_config,
    memory: jobMemory(job, rpc, read),
    tools: jobTools(job, rpc),
    skills: pickSkills(job.pin, job.person, job.skills),
    signal,
    env: read,
  })
  return {
    status: result.status,
    run_id: result.runId,
    output: result.output,
    failure: result.failure,
    waits: wireWaits(result.waits),
  }
}

/**
 * Routes office frames until the channel closes or a frame can't be read; then rejects pending and later requests
 * and, unless the job has finished, stops the run and calls `exit(EXIT_ORPHANED)`. Never rejects.
 */
async function readFrames(
  channel: Channel,
  rpc: Rpc,
  deliveries: Deliveries,
  stopper: AbortController,
  state: WorkerState,
  exit: (code: number) => void,
): Promise<void> {
  try {
    for (;;) {
      const frame = await channel.recv()
      if (frame.type === "deliver") {
        const { type: _, ...fields } = frame
        const parsed = Delivery.safeParse(fields)
        if (!parsed.success) throw new TypeError("a deliver frame is malformed")
        // Never awaited here: a delivery can wait on the run, which may need store replies only this loop delivers.
        deliveries.push(parsed.data)
      } else if (frame.type === "stop") {
        if (!state.finished) stopper.abort(new Error("the office stopped the run"))
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
  if (!state.finished) {
    // So an in-process run stops too; in the worker process `exit` ends everything first.
    stopper.abort(new Error("the office closed the channel"))
    exit(EXIT_ORPHANED)
  }
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
 * The `__worker` mode: serves the one job the office sends on fd 3, then exits with the code. Exits
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

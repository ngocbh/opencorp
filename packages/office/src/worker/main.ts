/** The run worker: read one job from the office, run it with Yian, report, exit. */
import fs from "node:fs"
import path from "node:path"
import { ProfileMemory, runFlow, send } from "@ngocbh/yian"
import { type EventHook, runLogPath } from "@ngocbh/yian/run"
import { loadSkills, type Skill } from "@ngocbh/yian/skills"
import { loadConfined } from "../company/flows.ts"
import { type Channel, ChannelClosed, type Frame, FrameTooLarge, fdChannel } from "./channel.ts"
import { Interrupts } from "./inbox.ts"
import { type Job, parseJob } from "./job.ts"
import { RemoteMarkdownStore } from "./remote_store.ts"
import { askUserStub, errorMessage, errorName, remoteTool, REPLY_TYPES, Rpc } from "./rpc.ts"

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_ORPHANED = 3
/** How long, in ms, a worker keeps answering steers after its last frame, waiting for the office to close. */
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

/** What `serve`, `runJob` and `readFrames` share: whether the job finished, and how to forward a steer once the
 *  run's log is known. */
interface WorkerState {
  finished: boolean
  steer?: (inbox: string, text: string) => Promise<unknown>
}

/**
 * Runs the job the office sends on `channel`; returns the exit code. A `check` job sends only its result frame,
 * `{type: "result", problem}`.
 *
 * A steer is forwarded to yian's steer inbox of the run; a steer yian refuses or fails to take comes back, as
 * `steer_left`. The last frame is `result` (or `error`). After it the worker answers steers with `steer_left` until
 * the office closes its side (or `linger` ms pass), so every steer the office sent is applied, kept in the run's steer
 * inbox (in the log), or returned. If the office closes the channel before the job finished, `exit` is called with
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
  const interrupts = new Interrupts()
  const stopper = new AbortController()
  const state: WorkerState = { finished: false }
  const forwards = new Set<Promise<void>>()
  const officeClosed = readFrames(channel, rpc, interrupts, stopper, state, forwards, exit)
  let last: Frame
  let code: number
  try {
    // A first frame that couldn't be read rejects again here, as the job's error.
    const start = await started
    if (start.type !== "start") throw new TypeError("expected a start frame")
    const job = parseJob(start.job)
    if (job.kind === "check") {
      // Loaded only here, so a chat worker doesn't load onboarding.
      const { runCheck } = await import("../chat/check.ts")
      last = { type: "result", problem: await runCheck(job, env) }
    } else {
      const fields = await runJob(job, channel, rpc, interrupts, state, { env, signal: stopper.signal })
      last = { type: "result", ...fields }
    }
    code = EXIT_OK
  } catch (error) {
    last = { type: "error", message: `${errorName(error)}: ${errorMessage(error)}`, traceback: stackFrames(error) }
    code = EXIT_FAILED
  }
  interrupts.close()
  state.finished = true
  // A refused forward sends its steer_left before the last frame.
  await Promise.all(forwards)
  code = await report(channel, [last], code)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([officeClosed, new Promise<void>((resolve) => (timer = setTimeout(resolve, linger)))])
  clearTimeout(timer)
  channel.close()
  return code
}

/** Runs `job`, sending its event and stream frames, and sets `state.steer` once the log is known; returns the result
 *  frame's fields. */
async function runJob(
  job: Job,
  channel: Channel,
  rpc: Rpc,
  interrupts: Interrupts,
  state: WorkerState,
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
  state.steer = (inbox, text) => send(log, inbox, text, { env: read, codeRoot: job.pin })
  const onEvent: EventHook = (event) => {
    const data: Record<string, unknown> = { ...event.toJSON() }
    if (event.type === "NodeSucceeded" || event.type === "NodeSkipped" || event.type === "NodeFailed") {
      const id = event.type === "NodeFailed" ? event.failure.nodeId : event.nodeId
      if (id) {
        if (interrupts.cut(id)) data.interrupted = true
        // Finished before the office sees the event, so an interrupt it sends afterwards is refused.
        interrupts.finish(id)
      }
    }
    // A send that fails rejects the run.
    return channel.send({ type: "event", name: event.type, data })
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
    steering: interrupts,
    signal,
    env: read,
  })
  return { status: result.status, run_id: result.runId, output: result.output, failure: result.failure }
}

/**
 * Routes office frames until the channel closes or a frame can't be read; then rejects pending and later requests
 * and, unless the job has finished, stops the run and calls `exit(EXIT_ORPHANED)`. Each steer forwarded to yian
 * stays in `forwards` until it settles. Never rejects.
 */
async function readFrames(
  channel: Channel,
  rpc: Rpc,
  interrupts: Interrupts,
  stopper: AbortController,
  state: WorkerState,
  forwards: Set<Promise<void>>,
  exit: (code: number) => void,
): Promise<void> {
  try {
    for (;;) {
      const frame = await channel.recv()
      if (frame.type === "steer") {
        const { inbox, text } = frame
        if (typeof inbox !== "string" || typeof text !== "string") {
          throw new TypeError("a steer needs an inbox and text")
        }
        const left = () => channel.send({ type: "steer_left", inbox, texts: [text] }).catch(() => {})
        if (state.finished || !state.steer) {
          // Sent before the next read, so a steer refused as the run ends goes out before `serve` closes the
          // channel. The office's reader never waits on sending to the worker, so this can't deadlock.
          await left()
          continue
        }
        // Called now, with no await first: a send to the live run commits in this tick, before the next frame
        // (such as a tool reply) is read, so steers keep their order. Awaited off this loop, since a send can wait
        // for the run to close, and closing profile memory needs store replies only this loop delivers. Every
        // rejection returns the steer: only DeliveryRefused promises nothing was appended, so another error may
        // duplicate a steer, which beats losing one. Nothing is logged: a yian error can quote the text.
        const forward = state.steer(inbox, text).then(
          () => {},
          () => left(),
        )
        forwards.add(forward)
        void forward.finally(() => forwards.delete(forward))
      } else if (frame.type === "interrupt") {
        if (typeof frame.node_id !== "string") throw new TypeError("an interrupt needs a node_id")
        interrupts.interrupt(frame.node_id)
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

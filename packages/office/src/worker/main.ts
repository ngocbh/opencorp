/** The run worker: read one job from the office, run it with Yian, report, exit. */
import path from "node:path"
import { ProfileMemory, runFlow } from "@ngocbh/yian"
import { type EventHook, runLogPath } from "@ngocbh/yian/run"
import { loadSkills, type Skill } from "@ngocbh/yian/skills"
import { loadConfined } from "../company/flows.ts"
import { type Channel, ChannelClosed, type Frame, FrameTooLarge } from "./channel.ts"
import { Inbox } from "./inbox.ts"
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

/** Yian's `tools`: each office group as remote tools, plus the `ask_user` stub. */
export function jobTools(job: Job, rpc: Rpc) {
  return {
    ...Object.fromEntries(
      Object.entries(job.groups).map(([group, specs]) => [group, specs.map((spec) => remoteTool(rpc, group, spec))]),
    ),
    ask_user: askUserStub(rpc),
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

/**
 * Runs the job the office sends on `channel`; returns the exit code.
 *
 * The last frames are a `steer_left` for every steer the run never read, then `result` (or `error`). After them the
 * worker keeps answering steers with `steer_left` until the office closes its side (or `linger` ms pass), so a steer
 * the office sent as the run ended is never lost. If the office closes the channel before the job finished, `exit`
 * is called with `EXIT_ORPHANED`: nobody can answer a question or read the result.
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
  const inbox = new Inbox()
  const stopper = new AbortController()
  const state = { finished: false }
  const officeClosed = readFrames(channel, rpc, inbox, stopper, state, exit)
  let last: Frame
  let code: number
  try {
    // A first frame that couldn't be read rejects again here, as the job's error.
    const start = await started
    if (start.type !== "start") throw new TypeError("expected a start frame")
    const job = parseJob(start.job)
    last = { type: "result", ...(await runJob(job, channel, rpc, inbox, { env, signal: stopper.signal })) }
    code = EXIT_OK
  } catch (error) {
    last = { type: "error", message: `${errorName(error)}: ${errorMessage(error)}`, traceback: stackFrames(error) }
    code = EXIT_FAILED
  }
  const left = [...inbox.close()].map(([nodeId, texts]) => ({ type: "steer_left", node_id: nodeId, texts }))
  state.finished = true
  code = await report(channel, [...left, last], code)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([officeClosed, new Promise<void>((resolve) => (timer = setTimeout(resolve, linger)))])
  clearTimeout(timer)
  channel.close()
  return code
}

/** Runs `job`, sending its event, stream and `steer_left` frames; returns the result frame's fields. */
async function runJob(
  job: Job,
  channel: Channel,
  rpc: Rpc,
  inbox: Inbox,
  { env, signal }: { env: WorkerEnv; signal: AbortSignal },
): Promise<Frame> {
  if (job.kind === "resume") throw new Error("this worker can't resume a run yet")
  const read: Env = (name) => (Object.hasOwn(env, name) ? env[name] : undefined)
  const flow = await loadConfined(job.pin, path.join(job.pin, job.flow))
  const runs = path.dirname(path.dirname(job.log))
  if (job.log !== path.join(runs, job.run_id, "log.jsonl")) {
    throw new RangeError("a chat job's log must be <runs>/<run_id>/log.jsonl")
  }
  // Makes the run's folder, and throws EEXIST if it is already there: each launch gets a fresh one.
  const log = runLogPath(runs, job.run_id)
  const onEvent: EventHook = (event) => {
    const name = event.type
    const data: Record<string, unknown> = { ...event.toJSON() }
    let id: string | null = null
    let texts: string[] = []
    if (event.type === "NodeSucceeded" || event.type === "NodeSkipped" || event.type === "NodeFailed") {
      id = event.type === "NodeFailed" ? event.failure.nodeId : event.nodeId
      if (id) {
        if (inbox.cut(id)) data.interrupted = true
        // Finished before the office sees the event, so a steer it sends afterwards is refused.
        texts = inbox.finish(id)
      }
    }
    const sends = [channel.send({ type: "event", name, data })]
    if (texts.length > 0) sends.push(channel.send({ type: "steer_left", node_id: id, texts }))
    // A send that fails rejects the run.
    return Promise.all(sends)
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
    steering: inbox,
    signal,
    env: read,
  })
  return { status: result.status, run_id: result.runId, output: result.output, failure: result.failure }
}

/**
 * Routes office frames until the channel closes or a frame can't be read; then rejects pending and later requests
 * and, unless the job has finished, stops the run and calls `exit(EXIT_ORPHANED)`. Never rejects.
 */
async function readFrames(
  channel: Channel,
  rpc: Rpc,
  inbox: Inbox,
  stopper: AbortController,
  state: { finished: boolean },
  exit: (code: number) => void,
): Promise<void> {
  try {
    for (;;) {
      const frame = await channel.recv()
      if (frame.type === "steer") {
        const { node_id: nodeId, text } = frame
        if (typeof nodeId !== "string" || typeof text !== "string") {
          throw new TypeError("a steer needs a node_id and text")
        }
        // Sent before the next read, so a steer refused as the run ends goes out before `serve` closes the channel.
        // The office's reader never waits on sending to the worker, so this can't deadlock.
        if (!inbox.steer(nodeId, text)) {
          await channel.send({ type: "steer_left", node_id: nodeId, texts: [text] }).catch(() => {})
        }
      } else if (frame.type === "interrupt") {
        if (typeof frame.node_id !== "string") throw new TypeError("an interrupt needs a node_id")
        inbox.interrupt(frame.node_id)
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

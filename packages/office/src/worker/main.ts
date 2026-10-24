/** The run worker: read one job from the office, run it with Yian, report, exit. */
import { type Channel, ChannelClosed, type Frame, FrameTooLarge } from "./channel.ts"
import { Inbox } from "./inbox.ts"
import { type Job, parseJob } from "./job.ts"
import { errorMessage, errorName, REPLY_TYPES, Rpc } from "./rpc.ts"

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_ORPHANED = 3
/** How long, in ms, a worker keeps answering steers after its last frame, waiting for the office to close. */
export const LINGER_MS = 5000

/** The worker's environment, passed in explicitly. */
export type WorkerEnv = Readonly<Record<string, string | undefined>>

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
  _job: Job,
  _channel: Channel,
  _rpc: Rpc,
  _inbox: Inbox,
  _options: { env: WorkerEnv; signal: AbortSignal },
): Promise<Frame> {
  throw new Error("not built")
}

/**
 * Routes office frames until the channel closes or a frame can't be read; then, unless the job has finished, stops
 * the run and calls `exit(EXIT_ORPHANED)`. Never rejects.
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

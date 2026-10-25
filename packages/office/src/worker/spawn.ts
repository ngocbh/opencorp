/** Spawn run workers and route their frames to office handlers. */
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import type net from "node:net"
import os from "node:os"
import path from "node:path"
import { type Env, INHERITED_ENV } from "../install/launch.ts"
import { killGroup } from "../install/proc.ts"
import { selfCommand, selfSpawnEnv } from "../platform.ts"
import { type Channel, ChannelClosed, type Frame, socketChannel } from "./channel.ts"
import type { Job } from "./job.ts"
import { errorName, isRequest, type JobWorker, replyTo, type WorkerHandlers } from "./rpc.ts"

// Defined in launch.ts so the daemon's pre-re-exec check doesn't load this module's later imports.
export { INHERITED_ENV } from "../install/launch.ts"

/** The environment a worker starts with: `INHERITED_ENV` and `LC_*` from the office's (`environ`), set values
 *  only. */
export function workerEnv(environ: Env = process.env): Record<string, string> {
  const kept: readonly string[] = INHERITED_ENV
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(environ)) {
    if (value !== undefined && (kept.includes(key) || key.startsWith("LC_"))) env[key] = value
  }
  return env
}

/** The session already has a live worker. */
export class WorkerExists extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} already has a live worker`)
    this.name = "WorkerExists"
  }
}

/** The registry was closed: the office is stopping. */
export class RegistryClosed extends Error {
  constructor() {
    super("the office is stopping; no new workers")
    this.name = "RegistryClosed"
  }
}

/** How long, in ms, a worker has to exit after its channel closes, before its group is killed. */
export const EXIT_GRACE_MS = 5000

/** Where spawn code writes log lines; never handed an error's message. */
export type SpawnLog = (level: "INFO" | "WARNING" | "ERROR", line: string) => void

/**
 * Starts `opencorp __worker` through `selfCommand()`, with the office's end of a socket as the child's fd 3.
 *
 * The worker runs in `sessionDir` (made 0700 if missing; never a workspace, so nothing a model wrote is in its cwd)
 * as the leader of a new process group, with `selfSpawnEnv(env)` as its environment and its stdout and stderr
 * appended to `sessionDir/worker.log` (0600, never through a symlink). Returns the process and the office's channel,
 * whose frames are capped at `maxFrame`. Throws if the process can't be started.
 */
export function spawnProcess(
  sessionDir: string,
  env: Record<string, string>,
  { maxFrame }: { maxFrame?: number } = {},
): { child: ChildProcess; channel: Channel } {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(path.join(sessionDir, "worker.log"), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
  let child: ChildProcess
  try {
    const [command, ...args] = selfCommand()
    child = spawn(command, [...args, "__worker"], {
      cwd: sessionDir,
      env: selfSpawnEnv(env),
      detached: true,
      stdio: ["ignore", fd, fd, "pipe"],
    })
  } finally {
    // The child has its own copy; the office keeps no handle on the log.
    fs.closeSync(fd)
  }
  if (child.pid === undefined) {
    // The spawn error is also emitted as an event; a listener keeps it from becoming an uncaught exception.
    child.on("error", () => {})
    child.stdio[3]?.destroy()
    throw new Error("could not start a worker")
  }
  return { child, channel: socketChannel(child.stdio[3] as net.Socket, { maxFrame }) }
}

/** A live worker process and the office's end of its channel. */
export class Worker implements JobWorker {
  readonly job: Job
  readonly sessionId: string
  readonly pid: number
  /** The worker's process group: it leads its own. */
  readonly pgid: number
  readonly channel: Channel
  readonly handlers: WorkerHandlers<Worker>
  /** The exit code, or minus the signal number; null until the worker is gone. */
  returncode: number | null = null
  readonly #child: ChildProcess
  readonly #onExit: (worker: Worker) => void
  readonly #log: SpawnLog
  readonly #exit: Promise<number | null>
  readonly #done: Promise<number | null>
  #settle!: (returncode: number | null) => void
  #killed = false

  /** A worker over `child`, a process `spawnProcess` started, and the office's `channel` to it. Build it in the
   *  spawn's tick, before the child's `exit` can be emitted: an `exit` listener added after the event never fires.
   *  `onExit` runs once the worker is gone, before `handlers.exited`. */
  constructor(
    job: Job,
    child: ChildProcess,
    channel: Channel,
    handlers: WorkerHandlers<Worker>,
    onExit: (worker: Worker) => void,
    { log = noLog }: { log?: SpawnLog } = {},
  ) {
    if (child.pid === undefined) throw new TypeError("a worker needs a child that started")
    this.job = job
    this.sessionId = job.session_id
    this.pid = child.pid
    this.pgid = child.pid
    this.channel = channel
    this.handlers = handlers
    this.#child = child
    this.#onExit = onExit
    this.#log = (level, line) => {
      try {
        log(level, line)
      } catch {}
    }
    this.#exit =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve(returncodeOf(child.exitCode, child.signalCode))
        : new Promise((resolve) => child.once("exit", (code, signal) => resolve(returncodeOf(code, signal))))
    this.#done = new Promise((resolve) => (this.#settle = resolve))
  }

  /** Sends the `start` frame and begins reading the worker's frames. Rejects with `FrameTooLarge` or
   *  `ChannelClosed` if the frame can't be sent; nothing is read then. */
  async start(): Promise<void> {
    await this.channel.send({ type: "start", job: this.job })
    void this.#read()
  }

  /** Tears down a worker whose `start` failed: closes the channel, kills its group and waits for it. Calls neither
   *  `onExit` nor `handlers.exited`; never rejects. */
  async abandon(): Promise<void> {
    try {
      this.#attempt(() => this.channel.close())
      this.kill()
      this.returncode = await this.#exit
    } finally {
      this.#settle(this.returncode)
    }
  }

  /** SIGKILLs the worker's process group, unless the worker has exited or was killed already. */
  kill(): void {
    // Once the worker has exited, its pid (and so its group id) may belong to someone else.
    if (this.#killed || this.#child.exitCode !== null || this.#child.signalCode !== null) return
    this.#killed = true
    killGroup(this.pgid)
  }

  /** Sends `text` to the run's steer inbox `inbox`; false if the channel is closed. */
  steer(inbox: string, text: string): Promise<boolean> {
    return this.#send({ type: "steer", inbox, text })
  }

  /** Asks the steerable node `nodeId` to stop and return its text so far; false if the channel is closed. */
  interrupt(nodeId: string): Promise<boolean> {
    return this.#send({ type: "interrupt", node_id: nodeId })
  }

  /** Asks the run to stop; false if the channel is closed. */
  stop(): Promise<boolean> {
    return this.#send({ type: "stop" })
  }

  /** Closes the office's end; the worker exits (code 3) if its job has not finished. */
  closeChannel(): void {
    this.channel.close()
  }

  /** The return code once the worker is gone and `handlers.exited` has run (or `abandon` has); null if that takes
   *  longer than `ms`. */
  async wait(ms = 30_000): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))
    try {
      return await Promise.race([this.#done, timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  async #send(frame: Frame): Promise<boolean> {
    try {
      await this.channel.send(frame)
      return true
    } catch (error) {
      if (error instanceof ChannelClosed) return false
      throw error
    }
  }

  async #read(): Promise<void> {
    try {
      for (;;) this.#dispatch(await this.channel.recv())
    } catch (error) {
      if (!(error instanceof ChannelClosed)) {
        this.#log("WARNING", `worker ${this.sessionId} sent a bad frame (${errorName(error)}); closing its channel`)
      }
    }
    await this.#finish()
  }

  #dispatch(frame: Frame): void {
    const kind = frame.type
    if (isRequest(kind)) {
      // Requests may wait for a person, so the loop never awaits them.
      void replyTo(this.channel, frame, this.handlers, this, { log: this.#log })
    } else if (kind === "steer_left") {
      const { inbox, texts } = frame
      if (typeof inbox !== "string" || !Array.isArray(texts) || !texts.every((text) => typeof text === "string")) {
        throw new TypeError("a steer_left frame needs an inbox and texts")
      }
      this.#notify("steerLeft", () => this.handlers.steerLeft(this, inbox, texts))
    } else if (kind === "event" || kind === "stream" || kind === "result" || kind === "error") {
      this.#notify(kind, () => this.handlers[kind](this, frame))
      // The run is over: later steers fail here, and the worker, having answered the ones already sent, sees the end
      // of stream and exits.
      if (kind === "result" || kind === "error") this.channel.closeSend()
    } else {
      this.#log("WARNING", `worker ${this.sessionId} sent an unknown frame type`)
    }
  }

  // Each step runs even if an earlier one throws, and wait() always settles.
  async #finish(): Promise<void> {
    try {
      this.#attempt(() => this.channel.close())
      let timer: ReturnType<typeof setTimeout> | undefined
      const exited = await Promise.race([
        this.#exit.then(() => true),
        new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), EXIT_GRACE_MS))),
      ])
      clearTimeout(timer)
      if (!exited) {
        this.kill()
      } else if (!this.#killed) {
        // Kills what the worker left in its group (a subprocess of the run, say). The runtime has already reaped the
        // leader, so in theory its pid (the group id) could be reused before this kill if the group was empty by
        // then; every path the office starts (timeout, stop, abandon) kills before awaiting the exit.
        killGroup(this.pgid)
      }
      this.returncode = await this.#exit
      this.#attempt(() => this.#onExit(this))
      this.#notify("exited", () => this.handlers.exited(this, this.returncode))
    } finally {
      this.#settle(this.returncode)
    }
  }

  #notify(name: string, call: () => void): void {
    try {
      call()
    } catch (error) {
      this.#log("ERROR", `worker ${this.sessionId} handler ${name} failed (${errorName(error)})`)
    }
  }

  #attempt(step: () => void): void {
    try {
      step()
    } catch (error) {
      this.#log("ERROR", `worker ${this.sessionId}: an exit step failed (${errorName(error)})`)
    }
  }
}

/** A child's exit as a return code: its exit code, or minus the number of the signal that ended it. */
function returncodeOf(code: number | null, signal: NodeJS.Signals | null): number | null {
  if (code !== null) return code
  return signal === null ? null : -os.constants.signals[signal]
}

function noLog(): void {}

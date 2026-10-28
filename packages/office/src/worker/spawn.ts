/** Spawn run workers and route their frames to office handlers. */
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import type net from "node:net"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"
import type { WorkerPool } from "../daemon/office.ts"
import { type Env, INHERITED_ENV } from "../install/launch.ts"
import { killGroup, startTime } from "../install/proc.ts"
import { selfCommand, selfSpawnEnv } from "../platform.ts"
import type { Store } from "../store/store.ts"
import { type Channel, ChannelClosed, type Frame, socketChannel } from "./channel.ts"
import { Delivery, type Job } from "./job.ts"
import { reap } from "./reaper.ts"
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

/** How many workers an office keeps parked at most; each is an idle Bun process. */
export const MAX_PARKED = 16

/** Where spawn code writes log lines; never handed an error's message. */
export type SpawnLog = (level: "INFO" | "WARNING" | "ERROR", line: string) => void

/**
 * Starts `opencorp __worker` through `selfCommand()`, with the office's end of a socket as the child's fd 3.
 *
 * The worker runs in `sessionDir` (made 0700 if missing; never a workspace, so nothing a model wrote is in its cwd)
 * as the leader of a new process group, with `selfSpawnEnv(env)` as its environment and its stdout and stderr
 * appended to `sessionDir/worker.log` (0600, never through a symlink, and only a regular file: the open never blocks,
 * so a FIFO there is refused). Returns the process and the office's channel, whose frames are capped at `maxFrame`.
 * Throws if the log can't be opened or the process can't be started.
 */
export function spawnProcess(
  sessionDir: string,
  env: Record<string, string>,
  { maxFrame }: { maxFrame?: number } = {},
): { child: ChildProcess; channel: Channel } {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  // O_NONBLOCK: opening a FIFO with no reader would otherwise block the office's loop; it fails with ENXIO instead.
  const flags = O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK
  const fd = fs.openSync(path.join(sessionDir, "worker.log"), flags, 0o600)
  let child: ChildProcess
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("the worker log is not a regular file")
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
  /** The job it runs, or last ran while parked; `next` replaces it. */
  job: Job
  readonly sessionId: string
  readonly pid: number
  /** The worker's process group: it leads its own. */
  readonly pgid: number
  readonly channel: Channel
  /** The handlers of its job's frames; `next` replaces them. */
  handlers: WorkerHandlers<Worker>
  /** The exit code, or minus the signal number; null until the worker is gone. */
  returncode: number | null = null
  readonly #child: ChildProcess
  readonly #onExit: (worker: Worker) => void
  readonly #log: SpawnLog
  readonly #exit: Promise<number | null>
  readonly #done: Promise<number | null>
  #settle!: (returncode: number | null) => void
  #killed = false
  #started = false
  /** Whether its job sent its `result` with `kept: true`, so the worker runs no job until `next`. */
  #between = false
  /** Whether it sent `parked`, and no `next` has started a job since. */
  #parked = false

  /** A worker over `child`, a process `spawnProcess` started, and the office's `channel` to it. Build it in the
   *  spawn's tick, before the child's `exit` can be emitted: an `exit` listener added after the event never fires.
   *  The worker's group is killed as soon as its leader exits. `onExit` runs once the worker is gone, before
   *  `handlers.exited`. */
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
    this.#log = neverThrows(log)
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#exit = Promise.resolve(returncodeOf(child.exitCode, child.signalCode))
      this.#leaderExited()
    } else {
      this.#exit = new Promise((resolve) =>
        child.once("exit", (code, signal) => {
          this.#leaderExited()
          resolve(returncodeOf(code, signal))
        }),
      )
    }
    this.#done = new Promise((resolve) => (this.#settle = resolve))
  }

  /** Sends the `start` frame and begins reading the worker's frames. Rejects with `FrameTooLarge` or
   *  `ChannelClosed` if the frame can't be sent; nothing is read then. A worker starts once: a second call throws
   *  before sending anything. */
  async start(): Promise<void> {
    // A second reader would run the exit steps twice.
    if (this.#started) throw new Error("the worker was already started")
    this.#started = true
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

  /** Whether the worker is parked: it kept its last job's process and runs nothing until `next`. */
  get parked(): boolean {
    return this.#parked
  }

  /**
   * Runs `job` with `handlers` in this parked worker: both replace the current ones, then the `start` frame goes.
   * False, with nothing changed, unless the worker is parked and the frame was sent (the channel closed meanwhile);
   * rejects with `FrameTooLarge`, nothing changed, for a frame over the limit.
   */
  async next(job: Job, handlers: WorkerHandlers<Worker>): Promise<boolean> {
    if (!this.#parked) return false
    const before = { job: this.job, handlers: this.handlers }
    // Swapped first: the worker's first frames for the job can come before the send reports back.
    this.job = job
    this.handlers = handlers
    this.#parked = false
    this.#between = false
    try {
      if (await this.#send({ type: "start", job })) return true
    } catch (error) {
      this.#restore(before)
      throw error
    }
    this.#restore(before)
    return false
  }

  #restore({ job, handlers }: { job: Job; handlers: WorkerHandlers<Worker> }): void {
    this.job = job
    this.handlers = handlers
    this.#between = true
    this.#parked = true
  }

  /** Sends `delivery` to the worker as a `deliver` frame.
   *
   *  Once this returns true, the worker answers it with one `deliver_reply` (before or after `result`) unless it
   *  exits first, in which case the caller resends it per its lost-ack rule; rejects for a malformed delivery or a
   *  frame over the limit (`FrameTooLarge`); false once the channel is closed, or once a job it keeps the process
   *  after has sent its result. Call it off the read loop: a notification handler must not await it. */
  async deliver(delivery: Delivery): Promise<boolean> {
    // Checked here, so an actor's bug fails at its call instead of making the worker drop the channel and orphan
    // the run.
    const parsed = Delivery.parse(delivery)
    // As after the end of stream: a delivery between jobs belongs to the next one.
    if (this.#between) return false
    return this.#send({ ...parsed, type: "deliver" })
  }

  /** Asks the run to stop; false if the channel is closed. */
  stop(): Promise<boolean> {
    return this.#send({ type: "stop" })
  }

  /** Asks the worker for a fresh live snapshot (a `follow` frame); false if the channel is closed. */
  follow(): Promise<boolean> {
    return this.#send({ type: "follow" })
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

  /** What logging or inspecting a worker shows: never the job, which holds the provider key. */
  [inspect.custom](): { sessionId: string; pid: number } {
    return { sessionId: this.sessionId, pid: this.pid }
  }

  /** What `JSON.stringify` shows of a worker: never the job, which holds the provider key. */
  toJSON(): { sessionId: string; pid: number } {
    return { sessionId: this.sessionId, pid: this.pid }
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
    } else if (kind === "deliver_reply") {
      if (!isDeliverReply(frame)) throw new TypeError("a deliver_reply frame is malformed")
      this.#notify("deliverReply", () => this.handlers.deliverReply(this, frame))
    } else if (kind === "event" || kind === "stream" || kind === "result" || kind === "error") {
      const kept = kind === "result" && frame.kept === true
      if (kept) this.#between = true
      this.#notify(kind, () => this.handlers[kind](this, frame))
      if (kept) {
        // The worker answers the deliveries already sent, then parks.
        void this.#send({ type: "done" }).catch(() => {})
      } else if (kind === "result" || kind === "error") {
        // The run is over: later deliveries fail here, and the worker, having answered the ones already sent, sees
        // the end of stream and exits.
        this.channel.closeSend()
      }
    } else if (kind === "parked") {
      this.#parked = true
      this.#notify(kind, () => this.handlers.parked(this))
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
      if (!exited) this.kill()
      this.returncode = await this.#exit
      this.#attempt(() => this.#onExit(this))
      this.#notify("exited", () => this.handlers.exited(this, this.returncode))
    } finally {
      this.#settle(this.returncode)
    }
  }

  // Kills what the worker left in its group (a subprocess of the run, say), whatever the channel does: a holder of
  // fd 3 outside the group can keep it open long after the leader is gone.
  #leaderExited(): void {
    if (this.#killed) return
    this.#killed = true
    // The runtime has just reaped the leader, so in theory its pid (the group id) could be reused before this kill
    // if the group was empty by then; running in the exit listener keeps that window to one turn of the loop.
    killGroup(this.pgid)
  }

  // An async handler's rejection is caught too: unhandled, it would take the office down.
  #notify(name: string, call: () => unknown): void {
    const failed = (error: unknown) =>
      this.#log("ERROR", `worker ${this.sessionId} handler ${name} failed (${errorName(error)})`)
    try {
      const out = call()
      if (typeof (out as PromiseLike<unknown> | null)?.then === "function") Promise.resolve(out).catch(failed)
    } catch (error) {
      failed(error)
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

/** The office's live workers, at most one per session, each recorded in the store for `reap`. */
export class WorkerRegistry implements WorkerPool {
  readonly #store: Store
  readonly #log: SpawnLog
  readonly #environ: Env
  readonly #maxFrame: number | undefined
  readonly #spawn: typeof spawnProcess
  readonly #onExit: (worker: Worker) => void
  readonly #workers = new Map<string, Worker>()
  readonly #maxParked: number
  /** The parked workers by session, least recently parked first, with what releases each. */
  readonly #parked = new Map<string, { worker: Worker; release: () => void }>()
  #closed = false

  /** A registry recording its workers in `store`. Workers start with `workerEnv(environ)`, frames capped at
   *  `maxFrame`, through `spawn`; `log` gets the spawn code's lines; `onExit` runs once a started worker is gone and
   *  forgotten, before its `handlers.exited`. At most `maxParked` workers stay `park`ed. */
  constructor(
    store: Store,
    {
      log = noLog,
      environ = process.env,
      maxFrame,
      spawn = spawnProcess,
      onExit = () => {},
      maxParked = MAX_PARKED,
    }: {
      log?: SpawnLog
      environ?: Env
      maxFrame?: number
      spawn?: typeof spawnProcess
      onExit?: (worker: Worker) => void
      maxParked?: number
    } = {},
  ) {
    this.#store = store
    this.#log = neverThrows(log)
    this.#environ = environ
    this.#maxFrame = maxFrame
    this.#spawn = spawn
    this.#onExit = onExit
    this.#maxParked = maxParked
  }

  /**
   * Starts a worker for `job.session_id` in `sessionDir` running `job`, with the provider's `env` added to the
   * worker env. Rejects with `RegistryClosed` once `closeAll` ran, and `WorkerExists` if the session has a live
   * worker. A worker of the session left by an earlier office is reaped first. If the worker can't be started (a
   * start frame over `maxFrame`, say), nothing is left behind: no process, entry, store record or socket.
   */
  async spawn(
    job: Job,
    sessionDir: string,
    handlers: WorkerHandlers<Worker>,
    { env = {} }: { env?: Record<string, string> } = {},
  ): Promise<Worker> {
    // Everything up to the registration runs in one tick, so two spawns for a session can't both pass the check.
    const sessionId = job.session_id
    if (this.#closed) throw new RegistryClosed()
    if (this.#workers.has(sessionId)) throw new WorkerExists(sessionId)
    reap(this.#store, sessionId)
    const spawnEnv = { ...workerEnv(this.#environ), ...env }
    const { child, channel } = this.#spawn(sessionDir, spawnEnv, { maxFrame: this.#maxFrame })
    let worker: Worker
    try {
      worker = new Worker(job, child, channel, handlers, (exited) => this.#exited(exited), { log: this.#log })
      this.#store.recordWorker(sessionId, { pid: worker.pid, pgid: worker.pgid, startTime: startTime(worker.pid) ?? 0 })
      this.#workers.set(sessionId, worker)
    } catch (error) {
      if (child.pid !== undefined) killGroup(child.pid)
      channel.close()
      throw error
    }
    try {
      await worker.start()
    } catch (error) {
      await worker.abandon()
      if (this.#workers.get(sessionId) === worker) this.#workers.delete(sessionId)
      this.#forget(worker)
      throw error
    }
    return worker
  }

  /** Runs `job` with `handlers` in the session's parked `worker` (`Worker.next`). Rejects with `RegistryClosed` once
   *  `closeAll` ran; false when `worker` isn't the session's live worker, or `Worker.next` is. */
  async next(worker: Worker, job: Job, handlers: WorkerHandlers<Worker>): Promise<boolean> {
    if (this.#closed) throw new RegistryClosed()
    if (job.session_id !== worker.sessionId || this.#workers.get(worker.sessionId) !== worker) return false
    this.unpark(worker)
    return worker.next(job, handlers)
  }

  /** Counts `worker` as parked, most recently; past `maxParked`, the least recently parked one is unparked and its
   *  `release` called, which must end it. */
  park(worker: Worker, release: () => void): void {
    this.#parked.delete(worker.sessionId)
    this.#parked.set(worker.sessionId, { worker, release })
    for (const [sessionId, oldest] of this.#parked) {
      if (this.#parked.size <= this.#maxParked) break
      this.#parked.delete(sessionId)
      try {
        oldest.release()
      } catch (error) {
        this.#log("ERROR", `worker ${sessionId} could not be released (${errorName(error)})`)
      }
    }
  }

  /** No longer counts `worker` as parked. */
  unpark(worker: Worker): void {
    if (this.#parked.get(worker.sessionId)?.worker === worker) this.#parked.delete(worker.sessionId)
  }

  /** Whether `closeAll` ran: the office is stopping. */
  get closed(): boolean {
    return this.#closed
  }

  /** The session's live worker, if any. */
  get(sessionId: string): Worker | undefined {
    return this.#workers.get(sessionId)
  }

  /** Stops the session's worker: asks its run to stop, and after `ms` closes its channel and kills its group, then
   *  waits up to `ms` again. Returns its return code (null if it outlived both waits, or the session has none). */
  async close(sessionId: string, ms = 5000): Promise<number | null> {
    const worker = this.#workers.get(sessionId)
    if (worker === undefined) return null
    await this.#stop([worker], ms)
    return worker.returncode
  }

  /** Stops every live worker, as `close` does, all at once; later spawns are refused. */
  async closeAll(ms = 5000): Promise<void> {
    this.#closed = true
    await this.#stop([...this.#workers.values()], ms)
  }

  async #stop(workers: Worker[], ms: number): Promise<void> {
    // Not awaited: a worker that stopped reading never takes the frame, and must not hold up the others.
    for (const worker of workers) void worker.stop().catch(() => {})
    const codes = await Promise.all(workers.map((worker) => worker.wait(ms)))
    const running = workers.filter((_, i) => codes[i] === null)
    for (const worker of running) {
      worker.closeChannel()
      worker.kill()
    }
    await Promise.all(running.map((worker) => worker.wait(ms)))
  }

  #exited(worker: Worker): void {
    this.unpark(worker)
    if (this.#workers.get(worker.sessionId) !== worker) return
    this.#forget(worker)
    this.#workers.delete(worker.sessionId)
    try {
      this.#onExit(worker)
    } catch (error) {
      this.#log("ERROR", `worker ${worker.sessionId} on exit callback failed (${errorName(error)})`)
    }
  }

  #forget(worker: Worker): void {
    try {
      this.#store.removeWorker(worker.sessionId, worker.pid)
    } catch (error) {
      this.#log("ERROR", `could not remove the record of worker ${worker.sessionId} (${errorName(error)})`)
    }
  }
}

/** Whether `frame` is a well-formed `deliver_reply`: a non-empty `id` and exactly one of `seq` (a non-negative
 *  safe integer or null, with `closed` absent or a list of call ids), `refused` or `failed` (strings). */
function isDeliverReply(frame: Frame): boolean {
  if (typeof frame.id !== "string" || frame.id === "") return false
  const has = (key: string) => Object.hasOwn(frame, key)
  if (has("seq")) {
    const { seq, closed } = frame
    // The codec revives NaN and the infinities, so a number alone is not enough.
    return (
      (seq === null || (Number.isSafeInteger(seq) && (seq as number) >= 0)) &&
      (!has("closed") || (Array.isArray(closed) && closed.every((id) => typeof id === "string"))) &&
      !has("refused") &&
      !has("failed")
    )
  }
  if (has("closed")) return false
  return has("refused") ? typeof frame.refused === "string" && !has("failed") : typeof frame.failed === "string"
}

/** A child's exit as a return code: its exit code, or minus the number of the signal that ended it. */
function returncodeOf(code: number | null, signal: NodeJS.Signals | null): number | null {
  if (code !== null) return code
  return signal === null ? null : -os.constants.signals[signal]
}

/** `log`, made never to throw: a log line that fails mustn't stop the step that writes it. */
function neverThrows(log: SpawnLog): SpawnLog {
  return (level, line) => {
    try {
      log(level, line)
    } catch {}
  }
}

function noLog(): void {}

/** The worker tests' helpers (Python's tests/worker/conftest.py). */
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { onTestFinished, spyOn } from "bun:test"
import { killGroup, sameProcess, startTime } from "../../src/install/proc.ts"
import { selfCommand, selfSpawnEnv } from "../../src/platform.ts"
import type { Store } from "../../src/store/store.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { Channel, ChannelClosed, type Frame, socketChannel } from "../../src/worker/channel.ts"
import { encode } from "../../src/worker/codec.ts"
import { type Delivery, Job, groupSpecs, type JobInput } from "../../src/worker/job.ts"
import { EXIT_FAILED, serve, type WorkerEnv } from "../../src/worker/main.ts"
import {
  type AskRequest,
  BaseHandlers,
  isRequest,
  type JobWorker,
  REPLY_TYPES,
  replyTo,
  Rpc,
  type RpcLog,
  type WorkerHandlers,
} from "../../src/worker/rpc.ts"
import { spawnProcess, type Worker, WorkerRegistry } from "../../src/worker/spawn.ts"
import { CHAT } from "../company/helpers.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"

/** Records, in the wire form the codec's `encode` writes, every frame this process's channels send and receive until
 *  the test finishes: for a spawned worker, both directions of the office's end. */
export function recordFrames(): string[] {
  const frames: string[] = []
  const { send, recv } = Channel.prototype
  const sending = spyOn(Channel.prototype, "send").mockImplementation(function (this: Channel, frame: Frame) {
    frames.push(encode(frame))
    return send.call(this, frame)
  })
  const receiving = spyOn(Channel.prototype, "recv").mockImplementation(async function (this: Channel) {
    const frame = await recv.call(this)
    frames.push(encode(frame))
    return frame
  })
  onTestFinished(() => {
    sending.mockRestore()
    receiving.mockRestore()
  })
  return frames
}

/** A one-agent flow: input `message`, output the agent's reply. `node` adds lines to the agent node, `top` to the
 *  flow, `inputs` to its inputs; `output` is the agent's output type. */
export function agentFlow(name: string, { node = "", top = "", inputs = "", output = "str" } = {}): string {
  return (
    `id: ${name}\nname: ${name}\n${top}input:\n${inputs}  message: !str\nnodes:\n  reply:\n    kind: agent\n` +
    `${node}    input:\n      message: \${input.message}\n    output: ${output}\n` +
    `    prompt: "\${message}"\noutput: \${reply.output}\n`
  )
}

// The flows the worker tests run; `writePin` writes them.
export const ECHO = agentFlow("echo")
export const ASK = agentFlow("ask", { node: "    tools: [ask_user]\n" })
export const TOOLS = agentFlow("tools", { node: "    tools: [toolbox]\n" })
export const STEERABLE = agentFlow("steerable", {
  inputs: "  steers: !Inbox(str)\n",
  node: "    tools: [toolbox]\n    steer_inbox: \${input.steers}\n",
})
// Steerable, but a cut reply's null output still succeeds.
export const CUTTABLE = agentFlow("cuttable", {
  inputs: "  steers: !Inbox(str)\n",
  node: "    tools: [toolbox]\n    steer_inbox: \${input.steers}\n",
  output: "Optional(str)",
})
// One take that waits for a message on the `messages` inbox, so the run quiesces as waiting.
export const INBOX =
  "id: inbox\nname: inbox\ninput:\n  messages: !Inbox(str)\nnodes:\n  heard:\n    kind: tool\n    tool_id: take\n" +
  "    input:\n      from: ${input.messages}\n      take: all\noutput: ${heard.output}\n"
// The inbox flow's take feeding an agent that answers what it heard, so the run waits, then calls the model.
export const HEARD =
  "id: heard\nname: heard\ninput:\n  messages: !Inbox(str)\nnodes:\n  heard:\n    kind: tool\n    tool_id: take\n" +
  "    input:\n      from: ${input.messages}\n      take: all\n  reply:\n    kind: agent\n    input:\n" +
  '      said: ${heard.output.events}\n    output: str\n    prompt: "${said}"\noutput: ${reply.output}\n'
// A CODE node whose function is in a file beside the flow, then the inbox flow's take, so the run waits with a CODE
// reference recorded.
export const CODED =
  "id: coded\nname: coded\ninput:\n  messages: !Inbox(str)\nnodes:\n  prep:\n    kind: code\n" +
  "    code: ./helpers.ts:fn\n    output: str\n  heard:\n    kind: tool\n    tool_id: take\n" +
  "    depends_on: [prep]\n    input:\n      from: ${input.messages}\n      take: all\noutput: ${heard.output}\n"
export const CODED_HELPERS = 'export function fn(): string {\n  return "ready"\n}\n'
export const PROFILED = agentFlow("profiled", { top: "long_term_memory: profile\n" })
export const SKILLED = agentFlow("skilled", { node: "    skills: all\n" })
// A run whose one node sleeps an hour, so it quiesces as waiting.
export const NAP =
  "id: nap\nname: nap\nnodes:\n  nap:\n    kind: tool\n    tool_id: sleep\n    input:\n      for: 1h\n" +
  "output: ${nap.output}\n"

/** Writes each of `files` (relative path -> text) under `root`, making parent directories; returns `root`. */
export function writeFiles(root: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  return root
}

/** Writes the worker tests' flows under `<root>/flows/`; returns `root`. */
export function writePin(root: string): string {
  return writeFiles(root, {
    "flows/echo.yaml": ECHO,
    "flows/ask.yaml": ASK,
    "flows/chat.yaml": CHAT,
    "flows/tools.yaml": TOOLS,
    "flows/steerable.yaml": STEERABLE,
    "flows/cuttable.yaml": CUTTABLE,
    "flows/inbox.yaml": INBOX,
    "flows/heard.yaml": HEARD,
    "flows/coded.yaml": CODED,
    "flows/helpers.ts": CODED_HELPERS,
    "flows/profiled.yaml": PROFILED,
    "flows/skilled.yaml": SKILLED,
    "flows/nap.yaml": NAP,
  })
}

/** The office's and the worker's channels over a connected unix socket pair, each with `options`; both channels and
 *  the server close when the test finishes. */
export async function channelPair(options?: { maxFrame?: number }): Promise<{ office: Channel; worker: Channel }> {
  const where = path.join(shortDir(), "s")
  const server = net.createServer({ allowHalfOpen: true })
  await new Promise<void>((resolve) => server.listen(where, resolve))
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve))
  const workerSocket = net.createConnection({ path: where, allowHalfOpen: true })
  await new Promise<void>((resolve, reject) => workerSocket.once("connect", resolve).once("error", reject))
  const office = socketChannel(await accepted, options)
  const worker = socketChannel(workerSocket, options)
  onTestFinished(() => {
    office.close()
    worker.close()
    server.close()
  })
  return { office, worker }
}

/**
 * A connected channel pair: returns the worker side's `Rpc`; the office side answers its requests with `handlers`
 * for `worker` (by default `workerFor(handlers)`), passing `log` to `replyTo`. With `concurrent`, the office answers
 * each request without waiting for the one before, as the office's worker does. Both channels and the server close
 * when the test finishes.
 */
export async function officeEnd(
  handlers: WorkerHandlers,
  {
    concurrent = false,
    worker = workerFor(handlers),
    log,
  }: { concurrent?: boolean; worker?: JobWorker; log?: RpcLog } = {},
): Promise<Rpc> {
  const { office, worker: workerSide } = await channelPair()
  const rpc = new Rpc(workerSide)
  // Each loop ends at the first frame that can't be read, as Python's helper did, never as an unhandled rejection.
  const serveOffice = async () => {
    for (;;) {
      const frame = await office.recv()
      if (!isRequest(frame.type)) continue
      const replied = replyTo(office, frame, handlers, worker, { log })
      if (!concurrent) await replied
    }
  }
  const serveWorker = async () => {
    for (;;) {
      const frame = await workerSide.recv()
      if (typeof frame.type === "string" && REPLY_TYPES.has(frame.type)) rpc.deliver(frame)
    }
  }
  serveOffice().catch(() => {})
  serveWorker().catch(() => {})
  return rpc
}

/** A worker whose job is a fixed chat job; for `BaseHandlers`, its groups are the handlers' tools and its memory
 *  names each of their stores. `over` replaces job fields. */
export function workerFor(handlers: WorkerHandlers, over: Partial<JobInput> = {}): JobWorker {
  const granted =
    handlers instanceof BaseHandlers
      ? {
          groups: groupSpecs(handlers.tools),
          memory: Object.fromEntries(Object.keys(handlers.stores).map((name) => [name, { store: name }])),
        }
      : {}
  const job = Job.parse({
    kind: "chat",
    session_id: "s1",
    run_id: "r1",
    person: "minh",
    pin: "/pin",
    flow: "flows/echo.yaml",
    log: "/runs/r1/log.jsonl",
    ...granted,
    ...over,
  })
  return { job }
}

/** A fresh temp root holding the worker tests' pin and an empty runs folder. */
export function base(): { root: string; pin: string; runs: string } {
  const root = tempDir()
  return { root, pin: writePin(path.join(root, "pin")), runs: path.join(root, "runs") }
}

/** A chat job running `flow` from `base.pin`, logging to `<base.runs>/<run_id>/log.jsonl`; `over` replaces fields.
 *  With `handlers`, its groups are the handlers' tools and its memory names each of their stores, unless `over` sets
 *  them. */
export function makeJob(
  base: { pin: string; runs: string },
  flow = "flows/echo.yaml",
  over: Partial<JobInput> = {},
  handlers?: BaseHandlers,
): Job {
  const runId = over.run_id ?? "r1"
  const granted = handlers
    ? {
        groups: groupSpecs(handlers.tools),
        memory: Object.fromEntries(Object.keys(handlers.stores).map((name) => [name, { store: name }])),
      }
    : {}
  return Job.parse({
    kind: "chat",
    session_id: "s1",
    run_id: runId,
    person: "minh",
    pin: base.pin,
    flow,
    log: path.join(base.runs, runId, "log.jsonl"),
    inputs: { message: "hi" },
    llm_config: LLM_CONFIG,
    ...granted,
    ...over,
  })
}

/**
 * A `WorkerRegistry` over `store` with `options` (its `log` a no-op unless given). Each child it spawns, through
 * `options.spawn` or `spawnProcess`, is noted with its start time. At test end the registry closes all its workers,
 * then the group of each noted child still running with its start time is killed. Tests that made their temp root
 * or store first have lost both by then: the registry logs the store failures, and the kills still run.
 */
export function makeRegistry(
  store: Store = openStore(),
  options: NonNullable<ConstructorParameters<typeof WorkerRegistry>[1]> = {},
): WorkerRegistry {
  const spawned: { pid: number; started: number | null }[] = []
  const spawnChild = options.spawn ?? spawnProcess
  const registry = new WorkerRegistry(store, {
    log: () => {},
    ...options,
    spawn: (...args) => {
      const out = spawnChild(...args)
      if (out.child.pid !== undefined) spawned.push({ pid: out.child.pid, started: startTime(out.child.pid) })
      return out
    },
  })
  onTestFinished(async () => {
    await registry.closeAll(5000)
    for (const { pid, started } of spawned) if (started !== null && sameProcess(pid, started)) killGroup(pid)
  })
  return registry
}

/** Spawns `job` through `registry` in `sessionDir`, with the provider `env`, and waits for its worker to exit;
 *  returns `handlers`. */
export async function runWorker<H extends WorkerHandlers<Worker>>(
  registry: WorkerRegistry,
  job: Job,
  handlers: H,
  sessionDir: string,
  { env, timeout = 30_000 }: { env?: Record<string, string>; timeout?: number } = {},
): Promise<H> {
  const worker = await registry.spawn(job, sessionDir, handlers, { env })
  if ((await worker.wait(timeout)) === null) throw new Error("the worker did not exit")
  return handlers
}

/** What an in-process worker did: the first code it asked to `exit` with, and the code `serve` returned. */
export interface WorkerOut {
  exit?: number
  code?: number
}

/**
 * Runs the worker's `serve` in process over a connected channel pair; returns the office's channel, a promise that
 * resolves when `serve` returns, and its `out`. At test end the office end closes, and the test fails if `serve`
 * hasn't returned within 10 s.
 */
export async function startWorker({ env = {}, linger }: { env?: WorkerEnv; linger?: number } = {}): Promise<{
  office: Channel
  done: Promise<void>
  out: WorkerOut
}> {
  const { office, worker } = await channelPair()
  const out: WorkerOut = {}
  const exit = (code: number) => {
    out.exit ??= code
  }
  const done = serve(worker, { env, linger, exit }).then((code) => {
    out.code = code
  })
  onTestFinished(async () => {
    office.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), 10_000)
    })
    const late = await Promise.race([done.then(() => false), timedOut])
    clearTimeout(timer)
    if (late) throw new Error("the worker did not return within 10 s of the office closing")
  })
  return { office, done, out }
}

/** Handlers that record every frame and answer questions from a list. */
export class Recorder extends BaseHandlers {
  readonly frames: Frame[] = []
  readonly asked: AskRequest[] = []
  readonly answers: unknown[]
  /** Each `deliver_reply` frame, in order. */
  readonly replies: Frame[] = []
  /** The types of the `deliver_reply`, `result` and `error` frames, in order. */
  readonly order: string[] = []
  outcome: Frame | null = null
  returncode: number | null = null

  constructor({
    answers = [],
    ...options
  }: { answers?: unknown[] } & ConstructorParameters<typeof BaseHandlers>[0] = {}) {
    super(options)
    this.answers = [...answers]
  }

  override event(_worker: unknown, frame: Frame): void {
    this.frames.push(frame)
  }

  override stream(_worker: unknown, frame: Frame): void {
    this.frames.push(frame)
  }

  override deliverReply(_worker: unknown, frame: Frame): void {
    this.replies.push(frame)
    this.order.push("deliver_reply")
  }

  override result(_worker: unknown, frame: Frame): void {
    this.outcome = frame
    this.order.push("result")
  }

  override error(_worker: unknown, frame: Frame): void {
    this.outcome = frame
    this.order.push("error")
  }

  override exited(_worker: unknown, returncode: number | null): void {
    this.returncode = returncode
  }

  override askUser(_worker: unknown, request: AskRequest): unknown {
    this.asked.push(request)
    if (this.answers.length === 0) throw new Error("no answer left")
    return this.answers.shift()
  }

  /** Each recorded frame's `name`, or its `type` when it has none. */
  names(): string[] {
    return this.frames.map((frame) => String(frame.name ?? frame.type))
  }
}

/** The office's handle on an in-process worker, as handlers receive it. */
export interface TestWorker extends JobWorker {
  /** Sends `delivery` as a `deliver` frame; false if the channel is closed. */
  deliver(delivery: Delivery): Promise<boolean>
  /** Sends a stop; false if the channel is closed. */
  stop(): Promise<boolean>
  /** Closes the office end; the worker exits 3 if its job has not finished. */
  closeChannel(): void
  /** The exit code once `handlers.exited` has run; `null` if that takes longer than `ms`. Rethrows the first error
   *  a notification handler threw, or the office read loop met. */
  wait(ms?: number): Promise<number | null>
}

/**
 * Runs `job` in an in-process worker (`serve` over a channel pair) and reads its frames as the office's worker does:
 * requests are answered by `handlers` without waiting, notifications go to the handler of that name, and after
 * `result` or `error` the office stops sending. A throwing notification handler doesn't end the read loop; `wait`
 * rethrows the first such error. Once the office read loop has ended and the worker's code is known, the office end
 * closes and `handlers.exited` runs; a `serve` that rejects is `EXIT_FAILED`. At test end the office end closes and
 * the test fails if `serve` hasn't returned within 10 s. Each of `early` goes as a `deliver` frame right after the
 * start frame, both written before the worker reads anything.
 */
export async function inProcessWorker(
  job: Job,
  handlers: WorkerHandlers<TestWorker>,
  { env = {}, linger, early = [] }: { env?: WorkerEnv; linger?: number; early?: Delivery[] } = {},
): Promise<TestWorker> {
  const { office, worker: workerSide } = await channelPair()
  await office.send({ type: "start", job })
  for (const delivery of early) await office.send({ type: "deliver", ...delivery })
  let settle!: (code: number) => void
  // Resolving twice does nothing, so the first of `exit` and the return value wins.
  const code = new Promise<number>((resolve) => (settle = resolve))
  const served = serve(workerSide, { env, linger, exit: settle })
  served.then(settle, () => settle(EXIT_FAILED))
  let failure: { error: unknown } | undefined
  // A handler's error is kept, never thrown into the read loop or left unobserved.
  const notify = (call: () => void) => {
    try {
      call()
    } catch (error) {
      failure ??= { error }
    }
  }
  const send = async (frame: Frame): Promise<boolean> => {
    try {
      await office.send(frame)
      return true
    } catch (error) {
      if (error instanceof ChannelClosed) return false
      throw error
    }
  }
  const worker: TestWorker = {
    job,
    deliver: (delivery) => send({ type: "deliver", ...delivery }),
    stop: () => send({ type: "stop" }),
    closeChannel: () => office.close(),
    wait: async (ms = 30_000) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))
      const result = await Promise.race([finished, timedOut])
      clearTimeout(timer)
      if (failure) throw failure.error
      return result
    },
  }
  const readLoop = async () => {
    try {
      for (;;) {
        const frame = await office.recv()
        const kind = frame.type
        if (isRequest(kind)) {
          void replyTo(office, frame, handlers, worker)
        } else if (kind === "deliver_reply") {
          notify(() => handlers.deliverReply(worker, frame))
        } else if (kind === "event" || kind === "stream" || kind === "result" || kind === "error") {
          notify(() => handlers[kind](worker, frame))
          // The run is over: later deliveries fail here, and the worker, having answered the ones already sent, sees
          // the end of stream and returns.
          if (kind === "result" || kind === "error") office.closeSend()
        }
      }
    } catch (error) {
      if (!(error instanceof ChannelClosed)) failure ??= { error }
    }
  }
  // Not closed when the code settles: late deliver_reply frames may still be buffered. Both waits are bounded, since
  // `serve` always closes the worker's channel on its way out.
  const finished = (async () => {
    await readLoop()
    const returncode = await code
    office.close()
    notify(() => handlers.exited(worker, returncode))
    return returncode
  })()
  onTestFinished(async () => {
    office.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), 10_000)))
    const late = await Promise.race([served.then(() => false), timedOut])
    clearTimeout(timer)
    if (late) throw new Error("the worker did not return within 10 s of the office closing")
  })
  return worker
}

/** Runs `job` in an in-process worker and waits for it to exit; returns `handlers`. */
export async function run<H extends WorkerHandlers<TestWorker>>(
  job: Job,
  handlers: H,
  { env, timeout = 30_000 }: { env?: WorkerEnv; timeout?: number } = {},
): Promise<H> {
  const worker = await inProcessWorker(job, handlers, { env })
  if ((await worker.wait(timeout)) === null) throw new Error("the worker did not exit")
  return handlers
}

/** A worker process's exit: its code, or the signal that ended it; `error` when it couldn't be spawned. */
export interface WorkerExit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

/**
 * Starts `opencorp __worker` as the office does: through `selfCommand()`, leading its own process group, in `cwd`,
 * with only `PATH`, `HOME` and `TMPDIR` of this process's env plus `env`. With `channel`, the office's end of the
 * socket at the child's fd 3 is `office`; without, fd 3 is left to Bun. At test end the office end closes and the
 * group is killed if its leader is still the process that started (pid and start time). `exited` waits for stderr
 * to close after `exit`, so a grandchild holding the worker's stderr keeps it pending until the test times out; the
 * test-end kill then skips the group, since its leader is gone (pid and start time no longer match).
 */
export function spawnWorker({
  cwd,
  env = {},
  channel = true,
}: {
  cwd: string
  env?: Record<string, string>
  channel?: boolean
}): { office: Channel | undefined; pid: number; exited: Promise<WorkerExit>; stderr: () => string } {
  const [command, ...args] = selfCommand()
  const child = spawn(command, [...args, "__worker"], {
    cwd,
    env: selfSpawnEnv({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env }),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", channel ? "pipe" : "ignore"],
  })
  let err = ""
  child.stderr!.setEncoding("utf8").on("data", (text: string) => (err += text))
  child.stdout!.resume()
  // Settles after stderr ends too, since `exit` can come before the last of it is read.
  const stderrEnded = new Promise<void>((resolve) => child.stderr!.once("close", () => resolve()))
  const exited = new Promise<WorkerExit>((resolve) => {
    child.once("exit", (code, signal) => void stderrEnded.then(() => resolve({ code, signal })))
    // A spawn failure emits `error` and no `exit`; settling here fails the test instead of the runner.
    child.once("error", (error) => resolve({ code: null, signal: null, error }))
  })
  if (child.pid === undefined) throw new Error("spawnWorker: spawn failed")
  const pid = child.pid
  const started = startTime(pid)
  const office = channel ? socketChannel(child.stdio[3] as net.Socket) : undefined
  onTestFinished(() => {
    office?.close()
    if (started !== null && sameProcess(pid, started)) killGroup(pid)
  })
  return { office, pid, exited, stderr: () => err }
}

/** Reads `office`'s frames until a `result` or `error`; returns that frame. */
export async function lastFrame(office: Channel): Promise<Frame> {
  for (;;) {
    const frame = await office.recv()
    if (frame.type === "result" || frame.type === "error") return frame
  }
}

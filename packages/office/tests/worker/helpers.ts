/** The worker tests' helpers (Python's tests/worker/conftest.py). */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { type Channel, socketChannel } from "../../src/worker/channel.ts"
import { Job, groupSpecs, type JobInput } from "../../src/worker/job.ts"
import { serve, type WorkerEnv } from "../../src/worker/main.ts"
import {
  BaseHandlers,
  isRequest,
  type JobWorker,
  REPLY_TYPES,
  replyTo,
  Rpc,
  type RpcLog,
  type WorkerHandlers,
} from "../../src/worker/rpc.ts"
import { CHAT } from "../company/helpers.ts"
import { shortDir } from "../helpers.ts"

/** A one-agent flow: input `message`, output the agent's reply. `node` adds lines to the agent node, `top` to the
 *  flow. */
export function agentFlow(name: string, { node = "", top = "" } = {}): string {
  return (
    `id: ${name}\nname: ${name}\n${top}input:\n  message: !str\nnodes:\n  reply:\n    kind: agent\n` +
    `${node}    input:\n      message: \${input.message}\n    output: str\n` +
    `    prompt: "\${message}"\noutput: \${reply.output}\n`
  )
}

// The flows the worker tests run; `writePin` writes them.
export const ECHO = agentFlow("echo")
export const ASK = agentFlow("ask", { node: "    tools: [ask_user]\n" })
export const TOOLS = agentFlow("tools", { node: "    tools: [toolbox]\n" })
export const STEERABLE = agentFlow("steerable", { node: "    tools: [toolbox]\n    steerable: true\n" })
export const PROFILED = agentFlow("profiled", { top: "long_term_memory: profile\n" })
export const SKILLED = agentFlow("skilled", { node: "    skills: all\n" })

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
    "flows/profiled.yaml": PROFILED,
    "flows/skilled.yaml": SKILLED,
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

/** A chat job running `flow` from `base.pin`, logging to `<base.runs>/<run_id>/log.jsonl`; `over` replaces fields. */
export function makeJob(
  base: { pin: string; runs: string },
  flow = "flows/echo.yaml",
  over: Partial<JobInput> = {},
): Job {
  const runId = over.run_id ?? "r1"
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
    ...over,
  })
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

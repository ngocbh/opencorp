/** The worker tests' helpers (Python's tests/worker/conftest.py). */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { socketChannel } from "../../src/worker/channel.ts"
import { Job, groupSpecs, type JobInput } from "../../src/worker/job.ts"
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

/** Writes each of `files` (relative path -> text) under `root`, making parent directories; returns `root`. */
export function writeFiles(root: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  return root
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
  const where = path.join(shortDir(), "s")
  const server = net.createServer({ allowHalfOpen: true })
  await new Promise<void>((resolve) => server.listen(where, resolve))
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve))
  const workerSocket = net.createConnection({ path: where, allowHalfOpen: true })
  await new Promise<void>((resolve, reject) => workerSocket.once("connect", resolve).once("error", reject))
  const office = socketChannel(await accepted)
  const workerSide = socketChannel(workerSocket)
  onTestFinished(() => {
    office.close()
    workerSide.close()
    server.close()
  })
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

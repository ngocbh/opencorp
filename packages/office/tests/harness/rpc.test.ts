/** The JSON-RPC client over a child's stdio. */
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, test } from "bun:test"
import { JsonRpc, MAX_LINE, RpcClosed, RpcError, type RpcHandlers } from "../../src/harness/rpc.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { tempDir, waitFor } from "../helpers.ts"

const TIMEOUT = 30_000
const BIG_TIMEOUT = 60_000
const FAKE = fileURLToPath(new URL("../../src/testing/fake_codex.ts", import.meta.url))
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]
const CHUNK = (1 << 20) + 7

type Msg = Record<string, any>

/** What a `JsonRpc` told its handlers, in order. */
type Spy = {
  notes: [string, unknown][]
  requests: [unknown, string, unknown][]
  order: string[]
  closed: number
  killed: number
  logs: string[]
}

/** Handlers that record into a fresh `Spy`, with `over` replacing any of them (still counted for `closed`/`kill`). */
function spied(over: Partial<RpcHandlers> = {}): { spy: Spy; handlers: RpcHandlers } {
  const spy: Spy = { notes: [], requests: [], order: [], closed: 0, killed: 0, logs: [] }
  const handlers: RpcHandlers = {
    onNotification:
      over.onNotification ??
      ((method, params) => {
        spy.notes.push([method, params])
        spy.order.push(method)
      }),
    onRequest:
      over.onRequest ??
      ((id, method, params) => {
        spy.requests.push([id, method, params])
        spy.order.push(method)
      }),
    onClosed: () => {
      spy.closed++
      spy.order.push("closed")
      over.onClosed?.()
    },
    kill: () => {
      spy.killed++
      over.kill?.()
    },
    log: (line) => spy.logs.push(line),
  }
  return { spy, handlers }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    // macOS answers EPERM for a group left with only an unreaped zombie.
    const code = (error as { code?: unknown }).code
    if (code !== "ESRCH" && code !== "EPERM") throw error
  }
}

/** Starts `command` leading its own process group, which is killed when the test finishes. */
function start(
  command: string[],
  options: { cwd?: string; env?: Record<string, string>; stderr?: "pipe" | "ignore" | "inherit" } = {},
) {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env ?? { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", options.stderr ?? "inherit"],
    detached: true,
  })
  onTestFinished(() => {
    killGroup(child.pid)
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
  })
  return child
}

/** The fake app-server on `script`, with a started `JsonRpc` over its stdio. */
function connect(script: Msg, over: Partial<RpcHandlers> = {}) {
  const dir = tempDir()
  const where = path.join(dir, "s.json")
  fs.writeFileSync(where, JSON.stringify(script))
  const child = start([process.execPath, ...BUN_FLAGS, FAKE, "--script", where, "--log", path.join(dir, "log.jsonl")], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
  })
  const { spy, handlers } = spied(over)
  const rpc = new JsonRpc(child.stdin!, child.stdout!, handlers)
  rpc.start()
  return { dir, child, rpc, spy }
}

/** How `child` ended, or a rejection naming the wait once `ms` pass. */
function exited(child: ChildProcess, ms: number): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child (pid ${child.pid}) didn't exit in ${ms} ms`)), ms)
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

/** Unhandled rejections and uncaught errors while the current test runs. */
function unhandled(): unknown[] {
  const seen: unknown[] = []
  const record = (error: unknown) => seen.push(error)
  process.on("unhandledRejection", record)
  process.on("uncaughtException", record)
  onTestFinished(() => {
    process.off("unhandledRejection", record)
    process.off("uncaughtException", record)
  })
  return seen
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const turn = () => new Promise(setImmediate)

/** The rejection of `promise`; fails if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}

test(
  "requests get their results and errors",
  async () => {
    const { child, rpc, spy } = connect({})
    expect(((await rpc.request("initialize", {})) as Msg).userAgent).toBe("fake-codex/0.0.0")
    const error = await rejection(rpc.request("no/such", {}))
    expect(error).toBeInstanceOf(RpcError)
    expect((error as RpcError).code).toBe(-32601)
    child.stdin!.end()
    await waitFor(() => spy.closed, { timeout: 5000, what: "onClosed" })
    const closed = await rejection(rpc.request("initialize", {}))
    expect(closed).toBeInstanceOf(RpcClosed)
    expect(closed.message).toContain("the app-server closed before answering initialize")
    await exited(child, 5000)
  },
  TIMEOUT,
)

test(
  "server requests and notifications reach the handlers in order",
  async () => {
    // ids start at 0
    const script = { turns: [[fc.commandApproval(0, "c1", "touch a"), ...fc.agentMessage("m1", "ok")]] }
    const { dir, child, rpc, spy } = connect(script)
    await rpc.request("thread/start", { cwd: dir })
    await rpc.request("turn/start", { threadId: "thr_fake", input: [] })
    const request = await waitFor(() => spy.requests[0], { timeout: 5000, what: "the approval" })
    expect(request.slice(0, 2)).toEqual([0, "item/commandExecution/requestApproval"])
    await rpc.reply(0, { decision: "accept" })
    await waitFor(() => spy.notes.some(([m]) => m === "turn/completed"), { timeout: 5000, what: "the turn's end" })
    expect(spy.notes.map(([m]) => m).slice(0, 3)).toEqual(["turn/started", "serverRequest/resolved", "item/started"])
    const log = fs
      .readFileSync(path.join(dir, "log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).msg)
    expect(log).toContainEqual({ id: 0, result: { decision: "accept" } })
    child.stdin!.end()
    await exited(child, 5000)
  },
  TIMEOUT,
)

/** The other end of a `JsonRpc` over two `PassThrough`s, written and read by the test. */
class Server {
  /** The server's output: the client's stdout. */
  readonly out = new PassThrough()
  /** What the client writes: its stdin. */
  readonly inbox = new PassThrough()
  readonly spy: Spy
  readonly rpc: JsonRpc
  #lines: string[] = []
  #partial = ""

  constructor(over: Partial<RpcHandlers> = {}) {
    this.inbox.setEncoding("utf8")
    this.inbox.on("data", (text: string) => {
      const parts = (this.#partial + text).split("\n")
      this.#partial = parts.pop()!
      this.#lines.push(...parts)
    })
    const { spy, handlers } = spied(over)
    this.spy = spy
    this.rpc = new JsonRpc(this.inbox, this.out, handlers)
    this.rpc.start()
  }

  /** Ends the server's output and waits for the client's `onClosed`. */
  async close(): Promise<void> {
    this.out.end()
    await waitFor(() => this.spy.closed, { timeout: 5000, what: "onClosed" })
  }

  write(line: string | object): void {
    this.out.write((typeof line === "string" ? line : JSON.stringify(line)) + "\n")
  }

  /** The next line the client wrote, parsed. */
  async read(): Promise<Msg> {
    return JSON.parse(await waitFor(() => this.#lines.shift(), { timeout: 5000, what: "a line from the client" }))
  }

  /** Answers the next request the client sends with `result`. */
  async answerNext(result: unknown): Promise<void> {
    this.write({ id: (await this.read()).id, result })
  }
}

/** Writes `bytes` to `stream` in `CHUNK`-byte pieces, letting the reader run between them. */
async function writeInChunks(stream: PassThrough, bytes: Buffer): Promise<void> {
  for (let at = 0; at < bytes.length; at += CHUNK) {
    stream.write(bytes.subarray(at, at + CHUNK))
    await turn()
  }
}

test(
  "a handler that raises leaves the connection reading",
  async () => {
    const seen: string[] = []
    const server = new Server({
      onNotification: (method) => {
        seen.push(method)
        if (method === "boom") throw new Error("a bug in a handler")
      },
    })
    server.write({ method: "boom", params: {} })
    const answer = server.rpc.request("initialize", {}, { timeout: 5000 })
    await server.answerNext({ ok: true })
    expect(await answer).toEqual({ ok: true })
    expect(server.spy.closed).toBe(0)
    server.write({ method: "after", params: {} })
    await waitFor(() => seen.includes("after"), { timeout: 5000, what: "the next notification" })
    expect(server.spy.logs).toEqual(["codex: the boom handler failed (Error)"])
    await server.close()
  },
  TIMEOUT,
)

test(
  "a line that isnt a json object is skipped",
  async () => {
    const server = new Server()
    for (const line of ["123", "[1, 2]", '"text"', "null", "not json"]) server.write(line)
    server.write({ method: "after", params: {} })
    await waitFor(() => server.spy.notes.length, { timeout: 5000, what: "the notification after the bad lines" })
    expect(server.spy.notes.map(([m]) => m)).toEqual(["after"])
    expect(server.spy.closed).toBe(0)
    await server.close()
  },
  TIMEOUT,
)

test(
  "a request handler that raises answers codex with an error",
  async () => {
    const server = new Server({
      onRequest: () => {
        throw new Error("a bug in a handler")
      },
    })
    server.write({ id: 0, method: "item/commandExecution/requestApproval", params: {} })
    const reply = await server.read()
    expect([reply.id, reply.error.code]).toEqual([0, -32603])
    expect(server.spy.closed).toBe(0)
    await server.close()
  },
  TIMEOUT,
)

test(
  "a line over 16 MiB closes the connection and kills the app-server",
  async () => {
    // MAX_LINE + 84 bytes and no newline, then the child stays alive: only the injected kill ends it. `head` is
    // bounded, so a broken cap can't eat memory.
    const child = start(["/bin/sh", "-c", "head -c 16777300 /dev/zero; exec sleep 30"], { stderr: "ignore" })
    const { spy, handlers } = spied({ kill: () => process.kill(-child.pid!, "SIGKILL") })
    const calls: string[] = []
    const rpc = new JsonRpc(child.stdin!, child.stdout!, {
      ...handlers,
      onNotification: () => calls.push("notification"),
      onRequest: () => calls.push("request"),
    })
    rpc.start()
    const error = await rejection(rpc.request("initialize"))
    expect(error).toBeInstanceOf(RpcClosed)
    expect(error.message).toBe("the app-server sent a line over the 16 MiB limit")
    expect((await exited(child, 5000)).signal).toBe("SIGKILL")
    await sleep(100)
    expect(spy.closed).toBe(1)
    expect(spy.killed).toBe(1)
    expect(calls).toEqual([])
    expect(spy.logs.length).toBeGreaterThan(0)
    for (const line of spy.logs) expect(line.length).toBeLessThan(300)
    expect(await rejection(rpc.request("initialize"))).toBeInstanceOf(RpcClosed)
  },
  BIG_TIMEOUT,
)

test(
  "a line of exactly 16 MiB is read and one byte more is not",
  async () => {
    const server = new Server()
    const prefix = '{"method":"n","params":{"p":"'
    const suffix = '"}}'
    const line = prefix + "x".repeat(MAX_LINE - prefix.length - suffix.length) + suffix
    expect(Buffer.byteLength(line)).toBe(MAX_LINE)
    await writeInChunks(server.out, Buffer.from(line))
    server.out.write("\n")
    await waitFor(() => server.spy.notes.length, { timeout: 20_000, what: "the 16 MiB notification" })
    expect((server.spy.notes[0]![1] as Msg).p.length).toBe(MAX_LINE - prefix.length - suffix.length)
    expect(server.spy.killed).toBe(0)

    // 2-byte characters: about MAX_LINE / 2 characters, MAX_LINE + 1 bytes.
    const over = prefix + "é".repeat((MAX_LINE + 1 - prefix.length) / 2)
    expect(Buffer.byteLength(over)).toBe(MAX_LINE + 1)
    await writeInChunks(server.out, Buffer.from(over))
    await waitFor(() => server.spy.closed, { timeout: 20_000, what: "onClosed" })
    await sleep(50)
    expect(server.spy.killed).toBe(1)
    expect(server.spy.closed).toBe(1)
    expect(server.spy.notes.length).toBe(1)
  },
  BIG_TIMEOUT,
)

test(
  "a write to an app server that closed its stdin fails as rpc closed",
  async () => {
    const child = start(["/bin/sh", "-c", "exec 0<&-; echo ready >&2; exec sleep 30"], { stderr: "pipe" })
    let stderr = ""
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (text: string) => (stderr += text))
    await waitFor(() => stderr.includes("ready"), { timeout: 10_000, what: "the child to close its stdin" })
    expect(child.stdin!.listenerCount("error")).toBe(0)
    const { spy, handlers } = spied()
    const rpc = new JsonRpc(child.stdin!, child.stdout!, handlers)
    expect(child.stdin!.listenerCount("error")).toBeGreaterThanOrEqual(1)
    rpc.start()
    // Only a write bigger than the pipe buffer gets EPIPE.
    const error = await rejection(rpc.request("initialize", { pad: "x".repeat(1 << 20) }))
    expect(error).toBeInstanceOf(RpcClosed)
    expect(error.message).toMatch(/stdin is closed/)
    expect(await rejection(rpc.notify("initialized"))).toBeInstanceOf(RpcClosed)
    expect(await rejection(rpc.reply(0, {}))).toBeInstanceOf(RpcClosed)
    // A late `error` event fires while the test still runs.
    await sleep(200)
    expect(spy.closed).toBe(0)
  },
  TIMEOUT,
)

test(
  "a line that isnt a json object is logged cut to 200 characters",
  async () => {
    const server = new Server()
    server.write("x".repeat(2000))
    server.write("[1, 2]")
    server.write({ method: "after", params: {} })
    await waitFor(() => server.spy.notes.length, { timeout: 5000, what: "the notification after the bad lines" })
    expect(server.spy.logs.length).toBe(2)
    for (const line of server.spy.logs) expect(line.length).toBeLessThanOrEqual(300)
    expect(server.spy.logs[0]).toContain(JSON.stringify("x".repeat(200)))
    expect(server.spy.logs[0]).not.toContain("x".repeat(201))
    expect(server.spy.logs[1]).toContain("[1, 2]")
    await server.close()
  },
  TIMEOUT,
)

test(
  "a broken stdin fails requests notifications and replies as rpc closed",
  async () => {
    const errors = unhandled()
    const server = new Server()
    server.inbox.destroy(Object.assign(new Error("EPIPE"), { code: "EPIPE" }))
    await turn()
    for (const call of [
      server.rpc.request("initialize", {}, { timeout: 5000 }),
      server.rpc.notify("initialized"),
      server.rpc.reply(0, {}),
    ]) {
      const error = await rejection(call)
      expect(error).toBeInstanceOf(RpcClosed)
      expect(error.message).toBe("the app-server's stdin is closed (EPIPE)")
    }
    await sleep(50)
    expect(errors).toEqual([])
    await server.close()
  },
  TIMEOUT,
)

test(
  "a character split across two writes arrives whole and a last line without a newline is read at the end",
  async () => {
    const server = new Server()
    const bytes = Buffer.from(JSON.stringify({ method: "check", params: { p: "✓" } }) + "\n")
    const cut = bytes.indexOf(Buffer.from("✓")) + 1
    server.out.write(bytes.subarray(0, cut))
    await turn()
    server.out.write(bytes.subarray(cut))
    await waitFor(() => server.spy.notes.length, { timeout: 5000, what: "the notification" })
    expect(server.spy.notes[0]).toEqual(["check", { p: "✓" }])
    server.out.write(JSON.stringify({ method: "last", params: {} }))
    await server.close()
    expect(server.spy.order).toEqual(["check", "last", "closed"])
  },
  TIMEOUT,
)

test(
  "a request handler that raises when stdin is broken leaves the connection reading",
  async () => {
    const errors = unhandled()
    const server = new Server({
      onRequest: () => {
        throw new Error("a bug in a handler")
      },
    })
    server.inbox.destroy(Object.assign(new Error("EPIPE"), { code: "EPIPE" }))
    await turn()
    server.write({ id: 0, method: "item/commandExecution/requestApproval", params: {} })
    await sleep(100)
    expect(errors).toEqual([])
    server.write({ method: "after", params: {} })
    await waitFor(() => server.spy.notes.length, { timeout: 5000, what: "the notification after the request" })
    expect(server.spy.notes.map(([m]) => m)).toEqual(["after"])
    expect(server.spy.logs).toEqual([
      "codex: the item/commandExecution/requestApproval handler failed (Error)",
      "codex: couldn't answer item/commandExecution/requestApproval: the app-server's stdin is closed",
    ])
    await server.close()
  },
  TIMEOUT,
)

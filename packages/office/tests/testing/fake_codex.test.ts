/** The fake Codex app-server: scripted turns over stdio, every message it sends valid against the pinned schema. */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { Ajv, type ValidateFunction } from "ajv"
import { expect, onTestFinished, test } from "bun:test"
import * as fc from "../../src/testing/fake_codex.ts"
import { tempDir } from "../helpers.ts"

const TIMEOUT = 30_000
const FAKE = fileURLToPath(new URL("../../src/testing/fake_codex.ts", import.meta.url))
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]
const SCHEMA = fileURLToPath(new URL("../fixtures/codex/schema/", import.meta.url))

type Msg = Record<string, any>

// Python's Draft7Validator checks no `format`.
const ajv = new Ajv({ strict: false, validateFormats: false })

function validator(name: string): ValidateFunction {
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(SCHEMA, `${name}.json`), "utf8")))
}

const NOTES = validator("ServerNotification")
const REQUESTS = validator("ServerRequest")

/** Fails, with ajv's errors, unless `msg` is valid against `validate`. */
function validate(validate: ValidateFunction, msg: unknown): void {
  expect(validate(msg), ajv.errorsText(validate.errors)).toBe(true)
}

const SCRIPTS: [string, Msg][] = [
  ["e2e", fc.e2e()],
  [
    "builders",
    {
      turns: [
        [
          ...fc.agentMessage("m1", "hi"),
          ...fc.command("c1", "ls", { output: "a" }),
          fc.commandApproval(0, "c1", "touch a"),
          ...fc.fileChange("f1", "notes.md", "hi\n"),
          ...fc.fileChange("f2", "a.py", "@@ -1 +1 @@\n-a\n+b\n", { kind: "update" }),
          ...fc.fileChange("f3", "b.py", "gone\n", { kind: "delete" }),
          fc.fileChangeApproval(2, "f1"),
          fc.permissionsApproval(3, "p1"),
          fc.userInput(4, "u1", [fc.question("token", "Token", "Token?", { secret: true })]),
          fc.mcpApproval(5, "docs", "search"),
          fc.mcpApprovalQuestion(6, "u2", "docs", "search"),
          fc.networkApproval(7, "c2", "example.com"),
          fc.urlElicitation(8, "gh", "Sign in", "https://example.com/l"),
          fc.formElicitation(9, "jira", "Ticket", { points: { type: "integer" } }),
          fc.tokenUsage(10, 4, 2),
          fc.error("rate limited", { willRetry: true }),
          fc.threadClosed(),
        ],
      ],
    },
  ],
]

test.each(SCRIPTS)("fake scripts match the pinned schema [%s]", (_name, script) => {
  for (const turn of script.turns as Msg[][])
    for (const step of turn) {
      if ("notify" in step)
        validate(NOTES, fc.fill({ method: step.notify, params: step.params ?? {} }, "turn_0", "/w"))
      else if ("request" in step)
        validate(REQUESTS, fc.fill({ id: step.id, method: step.request, params: step.params ?? {} }, "turn_0", "/w"))
    }
})

test("a new file is sent as its content and an update as a diff", () => {
  const added = fc.fileChange("f1", "notes.md", "hi\n")[1]!.params.item.changes[0]
  const updated = fc.fileChange("f2", "a.py", "@@ -1 +1 @@\n-a\n+b\n", { kind: "update" })[1]!.params.item.changes[0]
  expect([added.kind, added.diff]).toEqual([{ type: "add" }, "hi\n"])
  expect(updated.kind).toEqual({ type: "update", move_path: null })
})

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

/** Starts the fake with `args` in `dir`, leading its own process group, which is killed when the test finishes. */
function start(dir: string, args: string[]) {
  const child = spawn(process.execPath, [...BUN_FLAGS, FAKE, ...args], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
  })
  onTestFinished(() => {
    killGroup(child.pid)
    child.stdin.destroy()
    child.stdout.destroy()
  })
  return child
}

/** `promise`, or a rejection saying `what` once `ms` pass. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Starts the fake and returns everything it printed on stdout, once it exits. */
async function output(dir: string, args: string[], input = ""): Promise<string> {
  const child = start(dir, args)
  let out = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => (out += chunk))
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve())
    child.once("error", () => resolve())
  })
  child.stdin.end(input)
  await within(closed, 20_000, "the fake to exit")
  return out
}

/** The fake run on `script` with `lines` as all of its stdin; the messages it sent. */
async function run(dir: string, script: Msg, ...lines: Msg[]): Promise<Msg[]> {
  const where = path.join(dir, "s.json")
  fs.writeFileSync(where, JSON.stringify(script))
  const out = await output(
    dir,
    ["--script", where, "--log", path.join(dir, "log.jsonl")],
    lines.map((m) => JSON.stringify(m) + "\n").join(""),
  )
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function log(dir: string): Msg[] {
  return fs
    .readFileSync(path.join(dir, "log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const START = [
  { id: 1, method: "initialize", params: {} },
  { id: 2, method: "thread/start", params: { cwd: "/w" } },
  { id: 3, method: "turn/start", params: { threadId: "thr_fake", input: [] } },
]

test(
  "it answers the handshake and a load and refuses the rest",
  async () => {
    const dir = tempDir()
    const out = await run(
      dir,
      { thread: { id: "thr_9", model: "gpt-x" } },
      START[0]!,
      { id: 2, method: "account/read", params: {} },
      { id: 3, method: "thread/resume", params: { threadId: "thr_7", cwd: "/w" } },
      { id: 4, method: "no/such", params: {} },
    )
    const answers = Object.fromEntries(out.map((m) => [m.id, m]))
    expect(answers[1].result).toEqual({ userAgent: "fake-codex/0.0.0" })
    expect(answers[2].result.account).toEqual({ type: "chatgpt" })
    expect([answers[3].result.thread.id, answers[3].result.model]).toEqual(["thr_7", "gpt-x"])
    expect(answers[4].error.code).toBe(-32601)
    expect(new Set(log(dir).map((e) => e.dir))).toEqual(new Set(["in", "out"]))
  },
  TIMEOUT,
)

test(
  "doctor questions get fake answers",
  async () => {
    const version = await output(tempDir(), ["--version"])
    expect(version.trim()).toBe("codex-cli 0.0.0-fake")
  },
  TIMEOUT,
)

/** A fake app-server driven line by line: each read waits for what the fake actually sent. */
class Live {
  readonly out: Msg[] = []
  private readonly queue: Msg[] = []
  private wakers: (() => void)[] = []
  private ended = false
  private readonly child: ReturnType<typeof start>
  private readonly exited: Promise<void>

  constructor(dir: string, script: Msg) {
    const where = path.join(dir, "s.json")
    fs.writeFileSync(where, JSON.stringify(script))
    this.child = start(dir, ["--script", where, "--log", path.join(dir, "log.jsonl")])
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve())
      this.child.once("error", () => resolve())
    })
    // One interface for the child's whole life: a `for await` left early would close it.
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on("line", (line) => {
      this.queue.push(JSON.parse(line))
      this.wake()
    })
    lines.on("close", () => {
      this.ended = true
      this.wake()
    })
  }

  private wake(): void {
    const wakers = this.wakers
    this.wakers = []
    for (const wake of wakers) wake()
  }

  send(...msgs: Msg[]): void {
    this.child.stdin.write(msgs.map((m) => JSON.stringify(m) + "\n").join(""))
  }

  /** Reads what the fake sends until a message `predicate` takes; returns it. */
  async until(predicate: (m: Msg) => boolean): Promise<Msg> {
    for (;;) {
      while (this.queue.length) {
        const m = this.queue.shift()!
        this.out.push(m)
        if (predicate(m)) return m
      }
      if (this.ended) throw new Error("the fake exited")
      await new Promise<void>((resolve) => this.wakers.push(resolve))
    }
  }

  methods(): (string | undefined)[] {
    return this.out.map((m) => m.method)
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    await within(this.exited, 5_000, "the fake to exit")
    this.child.stdout.destroy()
  }
}

function method(name: string): (m: Msg) => boolean {
  return (m) => m.method === name
}

test(
  "a turn runs its steps and completes",
  async () => {
    const live = new Live(tempDir(), { turns: [fc.agentMessage("m1", "hello")] })
    live.send(...START)
    const completed = await live.until(method("turn/completed"))
    expect(live.out.map((m) => ("method" in m ? m.method : "result")).slice(0, 4)).toEqual([
      "result",
      "result",
      "result",
      "turn/started",
    ])
    expect(completed.params.turn.status).toBe("completed")
    await live.close()
  },
  TIMEOUT,
)

test(
  "a turn start during a turn answers with the running turn",
  async () => {
    const live = new Live(tempDir(), { turns: [[{ sleep: 30 }]] })
    live.send(...START)
    await live.until(method("turn/started"))
    live.send({ id: 4, method: "turn/start", params: { threadId: "thr_fake", input: [] } })
    const steer = await live.until((m) => m.id === 4)
    const answers = Object.fromEntries(live.out.filter((m) => "result" in m).map((m) => [m.id, m.result]))
    expect(answers[3].turn.id).toBe(steer.result.turn.id)
    expect(steer.result.turn.id).toBe("turn_1")
    expect(live.methods().filter((m) => m === "turn/started").length).toBe(1)
    await live.close()
  },
  TIMEOUT,
)

test(
  "a reply is followed by server request resolved before the turn goes on",
  async () => {
    const live = new Live(tempDir(), {
      turns: [[fc.commandApproval(7, "c1", "touch a"), ...fc.agentMessage("m1", "ok")]],
    })
    live.send(...START)
    await live.until(method("item/commandExecution/requestApproval"))
    live.send({ id: 7, result: { decision: "accept" } })
    await live.until(method("turn/completed"))
    const methods = live.methods()
    expect(methods.filter((m) => m === "serverRequest/resolved").length).toBe(1)
    expect(methods.indexOf("serverRequest/resolved")).toBeLessThan(methods.indexOf("item/agentMessage/delta"))
    expect(live.out.find((m) => m.method === "serverRequest/resolved")!.params.requestId).toBe(7)
    // What the fake makes itself is Codex's shape too.
    for (const m of live.out.filter((m) => "method" in m)) validate("id" in m ? REQUESTS : NOTES, m)
    await live.close()
  },
  TIMEOUT,
)

test(
  "a spawn step logs its childs pid",
  async () => {
    const dir = tempDir()
    const live = new Live(dir, { turns: [[{ spawn: 1 }]] })
    live.send(...START)
    await live.until(method("turn/completed"))
    await live.close()
    const spawned = log(dir).filter((e) => e.dir === "spawn")
    expect(spawned.length).toBe(1)
    expect(spawned[0]!.pid).toBeGreaterThan(0)
  },
  TIMEOUT,
)

const INTERRUPT = { id: 4, method: "turn/interrupt", params: { threadId: "thr_fake", turnId: "turn_1" } }

test(
  "an interrupt completes the turn before it resolves the waiting requests",
  async () => {
    // Real Codex (sessions/interrupt.jsonl) sends turn/completed, then serverRequest/resolved; its ids start at 0.
    const live = new Live(tempDir(), { turns: [[fc.commandApproval(0, "c1", "touch a")]] })
    live.send(...START)
    await live.until(method("item/commandExecution/requestApproval"))
    live.send(INTERRUPT)
    const resolved = await live.until(method("serverRequest/resolved"))
    expect(resolved.params.requestId).toBe(0)
    const completed = live.out.find((m) => m.method === "turn/completed")!
    expect(completed.params.turn.status).toBe("interrupted")
    expect(live.methods().indexOf("turn/completed")).toBeLessThan(live.methods().indexOf("serverRequest/resolved"))
    await live.close()
  },
  TIMEOUT,
)

test(
  "a turn start once a turn ends never starts the next turn before the old one completes",
  async () => {
    // Many requests still waiting make the end of the interrupted turn long, and the first serverRequest/resolved
    // says it has ended: a turn/start sent then must not have turn_2 start before turn_1 completes.
    const waiting = Array.from({ length: 200 }, (_, n) => fc.commandApproval(n, `c${n}`, "touch a", { wait: false }))
    const live = new Live(tempDir(), { turns: [[...waiting, { sleep: 30 }], [{ sleep: 30 }]] })
    live.send(...START)
    await live.until((m) => m.id === 199 && "method" in m)
    live.send(INTERRUPT)
    await live.until(method("serverRequest/resolved"))
    live.send({ id: 5, method: "turn/start", params: { threadId: "thr_fake", input: [] } })
    await live.until((m) => m.method === "turn/started" && m.params.turn.id === "turn_2")
    expect(live.methods().slice(0, -1)).toContain("turn/completed")
    await live.close()
  },
  TIMEOUT,
)

test(
  "a codex that hangs on interrupt never answers it and the turn runs on",
  async () => {
    const live = new Live(tempDir(), {
      interrupt_hangs: true,
      turns: [[{ sleep: 1 }, ...fc.agentMessage("m1", "done")]],
    })
    live.send(...START)
    await live.until(method("turn/started"))
    live.send(INTERRUPT)
    const completed = await live.until(method("turn/completed"))
    expect(completed.params.turn.status).toBe("completed")
    expect(live.out.some((m) => m.id === INTERRUPT.id)).toBe(false)
    await live.close()
  },
  TIMEOUT,
)

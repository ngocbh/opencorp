/** The fake Claude Code: scripted turns over its stream-json stdio, run through its shim with an explicit env, and
 *  every line it writes shaped as a line real Claude Code wrote (`tests/fixtures/claude/stream.jsonl`). */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type FakeClaude, type FakeClaudeScript, installFakeClaude } from "../../src/testing/fake_claude.ts"
import { tempDir } from "../helpers.ts"

setDefaultTimeout(30_000)

/** A JSON object from the wire: `any`, since the assertions read whatever the fake wrote. */
type Msg = Record<string, any>

const ENV = { PATH: "/usr/bin:/bin" }
const STREAM = ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
const FIXTURE = fileURLToPath(new URL("../fixtures/claude/stream.jsonl", import.meta.url))
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the " +
  "new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

/** A fake in a fresh folder, and a working folder beside it for the fake to run in. */
function fakeClaude(script?: FakeClaudeScript): { fake: FakeClaude; work: string } {
  const dir = tempDir()
  const work = path.join(dir, "work")
  fs.mkdirSync(work)
  return { fake: installFakeClaude(path.join(dir, "fake"), script), work }
}

/** One running fake: what it wrote, read in order. */
class Claude {
  readonly child: ChildProcess
  readonly out: Msg[] = []
  stderr = ""
  readonly exited: Promise<number | null>
  #taken = 0
  #wake: (() => void) | null = null

  constructor(fake: FakeClaude, args: string[], cwd: string) {
    this.child = spawn(fake.claude, [...STREAM, ...args], { cwd, env: ENV, stdio: ["pipe", "pipe", "pipe"] })
    const child = this.child
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    })
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      this.out.push(JSON.parse(line))
      this.#wake?.()
    })
    child.stderr!.on("data", (d: Buffer) => (this.stderr += d.toString("utf8")))
    this.exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)))
    void this.exited.then(() => this.#wake?.())
  }

  send(msg: Msg): void {
    this.child.stdin!.write(JSON.stringify(msg) + "\n")
  }

  /** The lines written after the last ones taken, up to and including the first that `match`es. */
  async until(match: (m: Msg) => boolean, what: string, ms = 15_000): Promise<Msg[]> {
    const deadline = performance.now() + ms
    for (;;) {
      const at = this.out.findIndex((m, i) => i >= this.#taken && match(m))
      if (at >= 0) {
        const lines = this.out.slice(this.#taken, at + 1)
        this.#taken = at + 1
        return lines
      }
      const left = deadline - performance.now()
      if (left <= 0 || this.child.exitCode !== null)
        throw new Error(`no ${what} in ${JSON.stringify(this.out.slice(this.#taken).map(brief))}; ${this.stderr}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 200))
        this.#wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  /** The lines up to the end of the turn: its result, the lifecycle after it and the idle state. */
  async turn(what = "a turn's end"): Promise<Msg[]> {
    return await this.until((m) => m.subtype === "session_state_changed" && m.state === "idle", what)
  }

  async close(): Promise<number | null> {
    this.child.stdin!.end()
    return await this.exited
  }
}

const user = (text: string, uuid?: string, priority?: string): Msg => ({
  type: "user",
  ...(uuid === undefined ? {} : { uuid }),
  ...(priority === undefined ? {} : { priority }),
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
})
const request = (id: string, body: Msg): Msg => ({ type: "control_request", request_id: id, request: body })
const answer = (id: string, body?: Msg): Msg => ({
  type: "control_response",
  response: { subtype: "success", request_id: id, ...(body === undefined ? {} : { response: body }) },
})
const hookAnswer = (id: string, decision?: string, reason?: string): Msg => {
  if (decision === undefined) return answer(id, {})
  const out = { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason }
  return answer(id, { hookSpecificOutput: out })
}
const isRequest = (subtype: string) => (m: Msg) => m.type === "control_request" && m.request.subtype === subtype
const isResponse = (id: string) => (m: Msg) => m.type === "control_response" && m.response.request_id === id
const isText = (text: string) => (m: Msg) => m.type === "assistant" && m.message.content[0]?.text === text

/** A line in a few words, to compare sequences. */
function brief(m: Msg): string {
  if (m.type === "system") return `system/${m.subtype}${m.state === undefined ? "" : `=${m.state}`}`
  if (m.type === "command_lifecycle") return `${m.state}:${m.command_uuid}`
  if (m.type === "assistant") {
    const parts = m.message.content.map((c: Msg) => (c.type === "text" ? c.text : `tool_use ${c.name}`))
    return `assistant:${parts.join(",")}`
  }
  if (m.type === "user") {
    const c = m.message.content[0]
    return c.type === "tool_result" ? `tool_result${c.is_error ? "!" : ""}:${c.content}` : `user:${c.text}`
  }
  if (m.type === "result") return `result/${m.subtype}/${m.terminal_reason}`
  if (m.type === "control_request") return `request/${m.request.subtype}`
  if (m.type === "control_response") return `response/${m.response.subtype}`
  return String(m.type)
}

const isToolResult = (m: Msg) => m.type === "user" && m.message.content[0]?.type === "tool_result"
const toolResult = (lines: Msg[]) => lines.find(isToolResult)
const resultOf = (lines: Msg[]) => lines.find((m) => m.type === "result")

/** Runs the fake to its end (at most 10 s). */
const runOnce = (fake: FakeClaude, args: string[], cwd: string) =>
  spawnSync(fake.claude, args, { cwd, env: ENV, encoding: "utf8", timeout: 10_000 })

test("the fake answers initialize with its version, models and account, and with no token when scripted signed out", async () => {
  const { fake, work } = fakeClaude()
  const signedIn = new Claude(fake, ["--permission-mode", "acceptEdits"], work)
  signedIn.send(request("init-1", { subtype: "initialize" }))
  const [init] = await signedIn.until(isResponse("init-1"), "the initialize answer")
  const r = init!.response.response
  expect(init!.response.subtype).toBe("success")
  expect(r.claude_code_version).toBe("2.1.319")
  expect(r.models.length).toBeGreaterThan(0)
  for (const model of r.models) expect([typeof model.value, typeof model.resolvedModel]).toEqual(["string", "string"])
  expect(r.account.email).toBeString()
  expect(r.account.tokenSource).toBeUndefined()
  expect(r.commands).toEqual([])
  expect(r.current_permission_mode).toBe("acceptEdits")
  expect(r.pid).toBe(signedIn.child.pid)
  expect(await signedIn.close()).toBe(0)

  fake.set({ signed_out: true, version: "2.1.300" })
  const signedOut = new Claude(fake, [], work)
  signedOut.send(request("init-2", { subtype: "initialize" }))
  const [out] = await signedOut.until(isResponse("init-2"), "the initialize answer")
  expect(out!.response.response.account).toEqual({ tokenSource: "none", apiProvider: "firstParty" })
  expect(out!.response.response.claude_code_version).toBe("2.1.300")
  expect(out!.response.response.current_permission_mode).toBe("default")
  expect(await signedOut.close()).toBe(0)
})

test("a turn writes the message's lifecycle, init, the scripted text and a success result carrying the session's id", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ say: "COPPER-OTTER" }]] })
  const claude = new Claude(fake, ["--session-id", "s-1", "--model=haiku"], work)
  claude.send(user("Reply with the marker.", "u-1"))
  const lines = await claude.turn()
  expect(lines.map(brief)).toEqual([
    "system/session_state_changed=running",
    "queued:u-1",
    "started:u-1",
    "system/init",
    "assistant:COPPER-OTTER",
    "result/success/completed",
    "completed:u-1",
    "system/session_state_changed=idle",
  ])
  for (const m of lines) expect(m.session_id).toBe("s-1")
  const init = lines[3]!
  expect([init.cwd, init.model, init.permissionMode, init.user_message_uuids]).toEqual([
    work,
    "claude-haiku-5-5",
    "default",
    ["u-1"],
  ])
  expect(lines[4]!.user_message_uuids).toEqual(["u-1"])
  const result = resultOf(lines)!
  expect([result.is_error, result.result, result.user_message_uuids, result.permission_denials]).toEqual([
    false,
    "COPPER-OTTER",
    ["u-1"],
    [],
  ])
  expect(await claude.close()).toBe(0)
})

test("a tool step asks through the PreToolUse hook the host registered, and runs only on allow", async () => {
  const turn = (file: string) => [
    { tool: "Bash", input: { command: `touch ${file} && echo made ${file}` } },
    { say: "done" },
  ]
  const { fake, work } = fakeClaude({ turns: [turn("one"), turn("two"), turn("three")] })
  const claude = new Claude(fake, ["--session-id", "s-hook"], work)
  const hooks = { PreToolUse: [{ matcher: "Bash", hookCallbackIds: ["hook_0"] }] }
  claude.send(request("init", { subtype: "initialize", hooks }))
  const [init] = await claude.until(isResponse("init"), "the initialize answer")
  expect(init!.response.response.hooks_applied).toBe(true)

  claude.send(user("Make one.", "u-1"))
  const [hook] = (await claude.until(isRequest("hook_callback"), "the hook's callback")).slice(-1)
  expect(hook!.request.callback_id).toBe("hook_0")
  const use = claude.out.find((m) => m.type === "assistant" && m.message.content[0].type === "tool_use")!
  const id = use.message.content[0].id
  expect(hook!.request.tool_use_id).toBe(id)
  expect(hook!.request.input).toMatchObject({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "touch one && echo made one" },
    tool_use_id: id,
    permission_mode: "default",
    cwd: work,
    session_id: "s-hook",
  })
  claude.send(hookAnswer(hook!.request_id, "allow"))
  const first = await claude.turn()
  expect(toolResult(first)!.message.content[0]).toEqual({ tool_use_id: id, type: "tool_result", content: "made one" })
  expect(fs.existsSync(path.join(work, "one"))).toBe(true)

  claude.send(user("Make two.", "u-2"))
  const [deny] = (await claude.until(isRequest("hook_callback"), "the hook's callback")).slice(-1)
  claude.send(hookAnswer(deny!.request_id, "deny", "Not two."))
  const second = await claude.turn()
  expect(toolResult(second)!.message.content[0]).toMatchObject({ is_error: true, content: "Not two." })
  expect(resultOf(second)!.permission_denials).toEqual([
    {
      tool_name: "Bash",
      tool_use_id: deny!.request.tool_use_id,
      tool_input: { command: "touch two && echo made two" },
    },
  ])

  // No decision leaves it to the permission mode, and a default mode with nobody to ask refuses.
  claude.send(user("Make three.", "u-3"))
  const [none] = (await claude.until(isRequest("hook_callback"), "the hook's callback")).slice(-1)
  claude.send(hookAnswer(none!.request_id))
  const third = await claude.turn()
  expect(toolResult(third)!.message.content[0].is_error).toBe(true)
  expect(fs.existsSync(path.join(work, "two")) || fs.existsSync(path.join(work, "three"))).toBe(false)
  expect(await claude.close()).toBe(0)
})

test("with --permission-prompt-tool stdio a tool step asks can_use_tool, and a deny becomes an error tool result", async () => {
  const step = { tool: "Bash", input: { command: "touch asked && echo asked" } }
  const { fake, work } = fakeClaude({ turns: [[step], [step]] })
  const claude = new Claude(fake, ["--permission-prompt-tool", "stdio"], work)
  claude.send(user("Ask first.", "u-1"))
  const [ask] = (await claude.until(isRequest("can_use_tool"), "the permission request")).slice(-1)
  expect(ask!.request).toMatchObject({ tool_name: "Bash", input: step.input })
  claude.send(answer(ask!.request_id, { behavior: "deny", message: "Not now." }))
  const denied = await claude.turn()
  expect(toolResult(denied)!.message.content[0]).toMatchObject({
    tool_use_id: ask!.request.tool_use_id,
    is_error: true,
    content: "Not now.",
  })
  expect(fs.existsSync(path.join(work, "asked"))).toBe(false)

  claude.send(user("Ask again.", "u-2"))
  const [again] = (await claude.until(isRequest("can_use_tool"), "the permission request")).slice(-1)
  claude.send(answer(again!.request_id, { behavior: "allow", updatedInput: step.input }))
  expect(toolResult(await claude.turn())!.message.content[0].content).toBe("asked")
  expect(await claude.close()).toBe(0)
})

test("acceptEdits with sandbox auto-allow runs Bash, and dontAsk refuses it", async () => {
  const settings = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })
  const bash = { tool: "Bash", input: { command: "echo sandboxed" } }
  const { fake, work } = fakeClaude({
    turns: [
      [
        bash,
        { tool: "Edit", input: { file_path: "notes.md", old_string: "a", new_string: "b" }, result: "edited" },
        { tool: "Write", input: { file_path: "/elsewhere/notes.md", content: "b" }, result: "written" },
      ],
    ],
  })
  const accept = new Claude(fake, ["--permission-mode", "acceptEdits", "--settings", settings], work)
  accept.send(user("Go.", "u-1"))
  const results = (await accept.turn()).filter((m) => m.type === "user").map(brief)
  expect(results).toEqual([
    "tool_result:sandboxed",
    "tool_result:edited",
    "tool_result!:Permission to use Write has been denied.",
  ])
  expect(await accept.close()).toBe(0)

  // dontAsk refuses without asking, though a prompt tool is there; a later mode change takes effect.
  fake.set({ turns: [[bash], [bash]] })
  const dontAsk = new Claude(
    fake,
    ["--permission-mode=dontAsk", "--permission-prompt-tool=stdio", `--settings=${settings}`],
    work,
  )
  dontAsk.send(user("Go.", "u-2"))
  const refused = await dontAsk.turn()
  expect(refused.some(isRequest("can_use_tool"))).toBe(false)
  expect(toolResult(refused)!.message.content[0].is_error).toBe(true)
  dontAsk.send(request("mode", { subtype: "set_permission_mode", mode: "acceptEdits" }))
  expect((await dontAsk.until(isResponse("mode"), "the mode's answer"))[0]!.response).toEqual({
    subtype: "success",
    request_id: "mode",
  })
  dontAsk.send(user("Again.", "u-3"))
  const ran = await dontAsk.turn()
  expect(ran.find((m) => m.subtype === "init")!.permissionMode).toBe("acceptEdits")
  expect(brief(toolResult(ran)!)).toBe("tool_result:sandboxed")
  expect(await dontAsk.close()).toBe(0)
})

test("a Bash step's result is its command's real output and exit", async () => {
  const { fake, work } = fakeClaude({
    turns: [
      [
        { tool: "Bash", input: { command: "pwd; echo made > made.txt" } },
        { tool: "Bash", input: { command: "echo out; echo err >&2; exit 3" } },
        { tool: "Bash", input: { command: "touch scripted.txt" }, result: "scripted" },
      ],
    ],
  })
  const claude = new Claude(fake, ["--permission-mode", "bypassPermissions"], work)
  claude.send(user("Run them.", "u-1"))
  const [pwd, failed, scripted] = (await claude.turn()).filter((m) => m.type === "user")
  expect(pwd!.message.content[0]).toEqual({ tool_use_id: expect.any(String), type: "tool_result", content: work })
  expect(pwd!.tool_use_result).toEqual({ stdout: `${work}\n`, stderr: "", interrupted: false, isImage: false })
  expect(fs.readFileSync(path.join(work, "made.txt"), "utf8")).toBe("made\n")
  expect(failed!.message.content[0]).toMatchObject({ is_error: true, content: "Exit code 3\nout\nerr" })
  expect(failed!.tool_use_result).toBe("Error: Exit code 3\nout\nerr")
  expect(scripted!.message.content[0].content).toBe("scripted")
  expect(fs.existsSync(path.join(work, "scripted.txt"))).toBe(false)
  expect(await claude.close()).toBe(0)
})

test("an interrupt mid-turn ends it as Claude Code does", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ say: "1" }, { sleep: 30 }, { say: "never" }], [{ say: "after" }]] })
  const claude = new Claude(fake, [], work)
  claude.send(user("Count.", "u-1"))
  await claude.until(isText("1"), "the first text")
  claude.send(request("stop", { subtype: "interrupt" }))
  const lines = await claude.turn()
  expect(lines.map(brief)).toEqual([
    "response/success",
    "user:[Request interrupted by user]",
    "result/error_during_execution/aborted_streaming",
    "cancelled:u-1",
    "system/session_state_changed=idle",
  ])
  expect(lines[0]!.response).toEqual({ subtype: "success", request_id: "stop", response: { still_queued: [] } })
  expect(resultOf(lines)!.is_error).toBe(true)
  // The session goes on with the next turn.
  claude.send(user("Again.", "u-2"))
  expect((await claude.turn()).map(brief)).toContain("assistant:after")
  expect(await claude.close()).toBe(0)
})

test("an interrupt while a tool waits on the host rejects that tool's result", async () => {
  const { fake, work } = fakeClaude({
    turns: [[{ tool: "Bash", input: { command: "touch never" } }, { say: "never" }]],
  })
  const claude = new Claude(fake, ["--permission-prompt-tool", "stdio"], work)
  claude.send(user("Wait.", "u-1"))
  const [ask] = (await claude.until(isRequest("can_use_tool"), "the permission request")).slice(-1)
  claude.send(request("stop", { subtype: "interrupt" }))
  const lines = await claude.turn()
  expect(lines.map(brief)).toEqual([
    "response/success",
    `tool_result!:${REJECTED}`,
    "user:[Request interrupted by user for tool use]",
    "result/error_during_execution/aborted_tools",
    "cancelled:u-1",
    "system/session_state_changed=idle",
  ])
  expect(lines[1]!.message.content[0].tool_use_id).toBe(ask!.request.tool_use_id)
  expect([lines[1]!.tool_use_result, lines[1]!.tool_result_meta]).toEqual([
    "User rejected tool use",
    [{ id: ask!.request.tool_use_id, non_execution_kind: "user-rejected" }],
  ])
  // A late answer runs nothing.
  claude.send(answer(ask!.request_id, { behavior: "allow" }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(fs.existsSync(path.join(work, "never"))).toBe(false)
  expect(await claude.close()).toBe(0)
})

test("a message with priority next joins the running turn, and one without waits", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ say: "a" }, { sleep: 1 }, { say: "b" }], [{ say: "second" }]] })
  const claude = new Claude(fake, [], work)
  claude.send(user("First.", "u-1"))
  await claude.until(isText("a"), "the first text")
  claude.send(user("Join.", "u-2", "next"))
  claude.send(user("Wait.", "u-3"))
  const first = await claude.turn("the first turn's end")
  expect(first.map(brief)).toEqual([
    "queued:u-2",
    "queued:u-3",
    "started:u-2",
    "assistant:b",
    "result/success/completed",
    "completed:u-1",
    "completed:u-2",
    "system/session_state_changed=idle",
  ])
  expect(resultOf(first)!.user_message_uuids).toEqual(["u-1", "u-2"])
  expect(resultOf(first)!.queued_turn_count).toBe(1)
  const second = await claude.turn("the second turn's end")
  expect(second.map(brief)).toEqual([
    "system/session_state_changed=running",
    "started:u-3",
    "system/init",
    "assistant:second",
    "result/success/completed",
    "completed:u-3",
    "system/session_state_changed=idle",
  ])
  expect(await claude.close()).toBe(0)
})

test("--resume goes on with the session's turns", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ say: "one" }], [{ say: "two" }]] })
  const first = new Claude(fake, ["--session-id", "s-1"], work)
  first.send(user("One.", "u-1"))
  expect((await first.turn()).map(brief)).toContain("assistant:one")
  expect(await first.close()).toBe(0)

  const resumed = new Claude(fake, ["--resume=s-1"], work)
  resumed.send(user("Two.", "u-2"))
  const lines = await resumed.turn()
  expect(lines.map(brief)).toContain("assistant:two")
  expect(resultOf(lines)!.session_id).toBe("s-1")
  expect(await resumed.close()).toBe(0)
  const saved = fake.sessions()["s-1"]!
  expect(saved.filter((m) => m.type === "assistant").map(brief)).toEqual(["assistant:one", "assistant:two"])
  expect(saved.filter((m) => m.type === "user" && m.uuid?.startsWith("u-")).map((m) => m.uuid)).toEqual(["u-1", "u-2"])

  const missing = runOnce(fake, [...STREAM, "--resume", "s-none"], work)
  expect([missing.status, missing.stdout]).toEqual([1, ""])
  expect(missing.stderr).toContain("s-none")
})

test("the fake logs the settings and setting sources it was started with, and a scripted unavailable sandbox stops its start", async () => {
  const settings = { sandbox: { enabled: true, failIfUnavailable: true }, permissions: { deny: ["WebFetch"] } }
  const { fake, work } = fakeClaude()
  const args = [
    "--settings",
    JSON.stringify(settings),
    "--setting-sources=",
    "--strict-mcp-config",
    "--model",
    "haiku",
    "--append-system-prompt",
    "Be brief.",
    "--allowedTools=Bash",
    "--session-id",
    "s-1",
    "--permission-mode",
    "acceptEdits",
    "--unknown-flag",
  ]
  expect(await new Claude(fake, args, work).close()).toBe(0)
  const file = path.join(work, "settings.json")
  fs.writeFileSync(file, JSON.stringify({ sandbox: { enabled: false } }))
  const fromFile = new Claude(fake, ["--settings", "settings.json", "--setting-sources", "user,project"], work)
  expect(await fromFile.close()).toBe(0)
  const starts = fake.log().filter((entry) => entry.dir === "start")
  expect(starts.map((s) => s.argv)).toEqual([
    [...STREAM, ...args],
    [...STREAM, "--settings", "settings.json", "--setting-sources", "user,project"],
  ])
  expect(starts[0]!.cwd).toBe(work)
  // What the host gave, with the shim's own variable left out (sh adds PWD and SHLVL).
  expect(starts[0]!.env).toMatchObject(ENV)
  expect(Object.keys(starts[0]!.env!)).not.toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH")
  expect(starts[0]!.flags).toEqual({
    "input-format": "stream-json",
    "output-format": "stream-json",
    verbose: true,
    settings,
    "setting-sources": "",
    "strict-mcp-config": true,
    model: "haiku",
    "append-system-prompt": "Be brief.",
    allowedTools: ["Bash"],
    "session-id": "s-1",
    "permission-mode": "acceptEdits",
  })
  expect([starts[1]!.flags!.settings, starts[1]!.flags!["setting-sources"]]).toEqual([
    { sandbox: { enabled: false } },
    "user,project",
  ])

  // With the sandbox unavailable, failIfUnavailable stops the start; without it, Claude Code goes on unsandboxed.
  fake.set({ sandbox_unavailable: true })
  const stopped = runOnce(fake, [...STREAM, "--settings", JSON.stringify(settings)], work)
  expect([stopped.status, stopped.stdout]).toEqual([1, ""])
  expect(stopped.stderr).toContain("sandbox")
  const goesOn = new Claude(fake, ["--settings", JSON.stringify({ sandbox: { enabled: true } })], work)
  goesOn.send(request("init", { subtype: "initialize" }))
  await goesOn.until(isResponse("init"), "the initialize answer")
  expect(await goesOn.close()).toBe(0)
})

/** What a kind of line is: its type and subtype, or what it answers or carries. */
function kindOf(m: Msg): string {
  if (m.type === "control_response") return `control_response/${m.response.subtype}`
  if (m.type === "control_request") return `control_request/${m.request.subtype}`
  if (m.type === "system" || m.type === "result") return `${m.type}/${m.subtype}`
  if (m.type === "assistant" || m.type === "user") return `${m.type}/${m.message.content[0]?.type}`
  return String(m.type)
}

/** A line's keys, and those of the objects inside it that a driver reads. */
function shapeOf(m: Msg): string {
  const keys = (o: unknown) =>
    o !== null && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().join(",") : typeof o
  const inner =
    m.type === "control_response"
      ? [m.response, m.response.response]
      : m.type === "control_request"
        ? [m.request]
        : m.type === "assistant" || m.type === "user"
          ? [m.message, m.message.content[0]]
          : []
  return [m, ...inner].map(keys).join(" | ")
}

test("every line the fake writes has the type, subtype and keys real Claude Code writes", async () => {
  const recorded = new Map<string, Set<string>>()
  for (const line of fs.readFileSync(FIXTURE, "utf8").trim().split("\n")) {
    const { message } = JSON.parse(line) as { message: Msg }
    recorded.set(kindOf(message), (recorded.get(kindOf(message)) ?? new Set()).add(shapeOf(message)))
  }
  const bash = (command: string) => ({ tool: "Bash", input: { command } })

  // Signed out with no hooks: a mode change, text and tools, an API error, and an interrupt mid-turn.
  const { fake, work } = fakeClaude({
    signed_out: true,
    turns: [
      [{ say: "a" }, bash("echo ran"), bash("exit 2"), { say: "b" }],
      [{ fail: "API Error: 500 Internal server error", status: 500 }],
      [bash("echo first"), { sleep: 30 }],
    ],
  })
  const plain = new Claude(fake, [], work)
  plain.send(request("init", { subtype: "initialize" }))
  plain.send(request("mode", { subtype: "set_permission_mode", mode: "bypassPermissions" }))
  await plain.until(isResponse("mode"), "the mode's answer")
  plain.send(user("Tools.", "u-1"))
  await plain.turn()
  plain.send(user("Fail.", "u-2"))
  await plain.turn()
  plain.send(user("Stop me.", "u-3"))
  await plain.until(isToolResult, "the tool's result")
  plain.send(request("stop", { subtype: "interrupt" }))
  await plain.turn()
  expect(await plain.close()).toBe(0)

  // Signed in with a hook: allowed, denied, and interrupted while it waits.
  fake.set({ turns: [[bash("echo hooked"), bash("echo denied"), bash("echo waits")]] })
  const hooked = new Claude(fake, [], work)
  hooked.send(request("init", { subtype: "initialize", hooks: { PreToolUse: [{ hookCallbackIds: ["hook_0"] }] } }))
  hooked.send(user("Hooks.", "u-4"))
  const decide = async (decision?: string) => {
    const [hook] = (await hooked.until(isRequest("hook_callback"), "the hook's callback")).slice(-1)
    if (decision !== undefined) hooked.send(hookAnswer(hook!.request_id, decision))
  }
  await decide("allow")
  await decide("deny")
  await decide()
  hooked.send(request("stop", { subtype: "interrupt" }))
  await hooked.turn()
  expect(await hooked.close()).toBe(0)

  const written = fake
    .log()
    .filter((entry) => entry.dir === "out")
    .map((entry) => entry.msg as Msg)
    // No recording holds a permission request yet.
    .filter((m) => !isRequest("can_use_tool")(m))
  for (const m of written) {
    expect(recorded.get(kindOf(m)), `${kindOf(m)}: ${JSON.stringify(m)}`).toBeDefined()
    expect([...recorded.get(kindOf(m))!], `${kindOf(m)}: ${JSON.stringify(m)}`).toContain(shapeOf(m))
  }
  // And the fixture holds no kind the fake never writes.
  expect([...recorded.keys()].sort()).toEqual([...new Set(written.map(kindOf))].sort())
})

test("stdin's end exits 0, and --version prints a version", async () => {
  const { fake, work } = fakeClaude()
  const version = runOnce(fake, ["--version"], work)
  expect([version.status, version.stdout]).toEqual([0, "2.1.319 (Claude Code)\n"])
  const claude = new Claude(fake, [], work)
  expect(await claude.close()).toBe(0)
  expect(claude.out).toEqual([])
  const wrong = runOnce(fake, ["--output-format", "stream-json"], work)
  expect(wrong.status).toBe(2)
  expect(wrong.stderr).toContain("stream-json")
})

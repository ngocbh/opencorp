/** The fake Claude Code: scripted turns over its stream-json stdio, run through its shim with an explicit env, and
 *  every line it writes shaped as a line real Claude Code wrote (`tests/fixtures/claude/stream-2.1.330.jsonl`, and
 *  `stream.jsonl` for what no 2.1.330 recording holds). */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import {
  FAKE_CLAUDE_UNMODELLED,
  type FakeClaude,
  type FakeClaudeScript,
  type FakeClaudeStep,
  installFakeClaude,
} from "../../src/testing/fake_claude.ts"
import { psStat, tempDir, waitFor } from "../helpers.ts"

setDefaultTimeout(30_000)

/** A JSON object from the wire: `any`, since the assertions read whatever the fake wrote. */
type Msg = Record<string, any>

const ENV = { PATH: "/usr/bin:/bin" }
const STREAM = ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
const FIXTURE = fileURLToPath(new URL("../fixtures/claude/stream-2.1.330.jsonl", import.meta.url))
/** The upstream TUI's recordings, of 2.1.301 to 2.1.309; the fake writes those no 2.1.330 recording holds as they were. */
const OLDER = fileURLToPath(new URL("../fixtures/claude/stream.jsonl", import.meta.url))
const OLDER_KEPT = new Set(["billing-error.jsonl:8", "billing-error.jsonl:9", "controls.jsonl:24"])
/** What 2.1.330 writes that the office reads none of, and the fake leaves out. */
const LEFT_OUT = new Set([
  "rate_limit_event",
  "assistant/thinking",
  "system/thinking_tokens",
  "system/task_started",
  "system/task_updated",
  "system/task_notification",
  "system/background_tasks_changed",
])
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
  #respond: (m: Msg) => Msg | undefined = () => undefined

  constructor(fake: FakeClaude, args: string[], cwd: string) {
    this.child = spawn(fake.claude, [...STREAM, ...args], { cwd, env: ENV, stdio: ["pipe", "pipe", "pipe"] })
    const child = this.child
    // SIGTERM, which the fake answers by ending the commands it started.
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    })
    child.stdin!.on("error", () => {})
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      const m = JSON.parse(line) as Msg
      this.out.push(m)
      const reply = this.#respond(m)
      if (reply !== undefined) this.send(reply)
      this.#wake?.()
    })
    child.stderr!.on("data", (d: Buffer) => (this.stderr += d.toString("utf8")))
    // On close, once stderr is read whole.
    this.exited = new Promise((resolve) => child.on("close", (code) => resolve(code)))
    void this.exited.then(() => this.#wake?.())
  }

  send(msg: Msg): void {
    this.child.stdin!.write(JSON.stringify(msg) + "\n")
  }

  /** Answers each later line `reply` returns an answer for, such as every hook callback. */
  respond(reply: (m: Msg) => Msg | undefined): void {
    this.#respond = reply
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

  /** The lines up to the end of the turn: its result, and the lifecycle after it of each line it took. */
  async turn(what = "a turn's end"): Promise<Msg[]> {
    const lines = await this.until((m) => m.type === "result", what)
    const took: string[] = lines.at(-1)!.user_message_uuids ?? []
    const ended = (uuid: string) => (m: Msg) =>
      m.type === "command_lifecycle" && m.command_uuid === uuid && (m.state === "completed" || m.state === "cancelled")
    for (const uuid of took) {
      if (!lines.some(ended(uuid))) lines.push(...(await this.until(ended(uuid), `${what}: ${uuid}'s end`)))
    }
    return lines
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
/** Whether each tool of the lines ran or was refused (an error result; the scripts' commands succeed). */
const verdicts = (lines: Msg[]) =>
  lines.filter(isToolResult).map((m) => (m.message.content[0].is_error === true ? "refused" : "ran"))
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
  expect(r.claude_code_version).toBe("2.1.330")
  // As 2.1.330 answers with no hook registered.
  expect([r.hook_on_failure_supported, r.hooks_when_unanswered_kept, r.other_hook_ask_outranks_host]).toEqual([
    true,
    0,
    true,
  ])
  expect(r.hooks_applied).toBeUndefined()
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
  // As recorded: no session_state_changed lines.
  expect(lines.map(brief)).toEqual([
    "queued:u-1",
    "started:u-1",
    "system/init",
    "assistant:COPPER-OTTER",
    "result/success/completed",
    "completed:u-1",
  ])
  for (const m of lines) expect(m.session_id).toBe("s-1")
  const init = lines[2]!
  expect([init.cwd, init.model, init.permissionMode, init.user_message_uuids]).toEqual([
    work,
    "claude-haiku-5-5",
    "default",
    ["u-1"],
  ])
  expect(lines[3]!.user_message_uuids).toEqual(["u-1"])
  const result = resultOf(lines)!
  expect([result.is_error, result.result, result.user_message_uuids, result.permission_denials]).toEqual([
    false,
    "COPPER-OTTER",
    ["u-1"],
    [],
  ])
  expect(await claude.close()).toBe(0)
})

test("init lists the default tools, or --tools' names, less those a bare deny rule names, as 2.1.330 did", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ say: "a" }], [{ say: "b" }], [{ say: "c" }]] })
  const tools = async (args: string[]) => {
    const claude = new Claude(fake, args, work)
    claude.send(user("Hi."))
    const lines = await claude.turn()
    expect(await claude.close()).toBe(0)
    return lines.find((m) => m.subtype === "init")!.tools
  }
  expect(await tools([])).toEqual([
    "Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "Monitor", "NotebookEdit",
    "PushNotification", "Read", "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "Skill", "TaskStop", "ToolSearch",
    "Workflow", "Write",
  ])
  const deny = JSON.stringify({ permissions: { deny: ["Edit", "Write", "Read(/secret)"] } })
  expect(await tools(["--tools=Bash,Read,Edit,Write,Glob", "--settings", deny])).toEqual(["Bash", "Glob", "Read"])
  fake.set({ tools_added: ["RemoteTrigger"], turns: [[{ say: "d" }]] })
  expect(await tools(["--tools=Bash"])).toEqual(["Bash", "RemoteTrigger"])
})

test("a tool the session doesn't list gets the recorded no-such-tool error, and a hook isn't modelled", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ tool: "Write", input: { file_path: "a", content: "x" } }]] })
  const claude = new Claude(fake, ["--tools=Bash,Read"], work)
  claude.send(user("Write."))
  const block = toolResult(await claude.turn())!.message.content[0]
  expect(block).toMatchObject({
    is_error: true,
    content: "<tool_use_error>Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here.</tool_use_error>",
  })
  expect(fs.existsSync(path.join(work, "a"))).toBe(false)
  expect(await claude.close()).toBe(0)
  const hooked = new Claude(fake, [], work)
  hooked.send(request("init", { subtype: "initialize", hooks: { PreToolUse: [{ hookCallbackIds: ["hook_0"] }] } }))
  expect(await hooked.exited).toBe(FAKE_CLAUDE_UNMODELLED)
  expect(hooked.stderr).toContain("not modelled: hooks")
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

/** How each step of a one-turn script fared in a fake started with `args`, which must not ask the host. */
async function outcome(args: string[], steps: FakeClaudeStep[], script: FakeClaudeScript = {}): Promise<string[]> {
  const { fake, work } = fakeClaude({ ...script, turns: [steps] })
  const claude = new Claude(fake, args, work)
  claude.send(user("Go.", "u-1"))
  const lines = await claude.turn()
  expect(lines.some(isRequest("can_use_tool"))).toBe(false)
  expect(await claude.close()).toBe(0)
  return verdicts(lines)
}

test("sandbox auto-allow runs Bash in every mode but plan, unless the command leaves the sandbox", async () => {
  const sandbox = (extra: Msg = {}) =>
    JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, ...extra } })
  // Neither read-only nor a file operation inside the folder: only auto-allow runs it unasked.
  const rm = (extra: Msg = {}) => ({ tool: "Bash", input: { command: "rm -f ../absent.txt", ...extra } })
  const { fake, work } = fakeClaude({ turns: [[rm()], [rm()], [rm()]] })
  const modes = new Claude(fake, ["--permission-prompt-tool", "stdio", "--settings", sandbox()], work)
  for (const [i, mode] of ["default", "dontAsk", "acceptEdits"].entries()) {
    modes.send(request(`mode-${i}`, { subtype: "set_permission_mode", mode }))
    await modes.until(isResponse(`mode-${i}`), "the mode's answer")
    modes.send(user("Go.", `u-${i}`))
    const lines = await modes.turn()
    expect([verdicts(lines), lines.some(isRequest("can_use_tool"))]).toEqual([["ran"], false])
  }
  expect(await modes.close()).toBe(0)

  const dontAsk = (settings: string) => ["--permission-mode", "dontAsk", "--settings", settings]
  // Outside the sandbox the regular flow decides, and dontAsk refuses: an excluded command, one behind a variable,
  // and a retry unsandboxed, unless the settings turn the retry off.
  expect(await outcome(dontAsk(sandbox({ excludedCommands: ["rm *"] })), [rm()])).toEqual(["refused"])
  expect(await outcome(dontAsk(sandbox()), [{ tool: "Bash", input: { command: "X=1 rm -f ../absent.txt" } }])).toEqual([
    "refused",
  ])
  expect(await outcome(dontAsk(sandbox()), [rm({ dangerouslyDisableSandbox: true })])).toEqual(["refused"])
  const strict = sandbox({ allowUnsandboxedCommands: false })
  expect(await outcome(dontAsk(strict), [rm({ dangerouslyDisableSandbox: true })])).toEqual(["ran"])
  // Unset, auto-allow is on before 2.1.325 and off from it; a sandbox that can't start runs nothing sandboxed.
  const enabled = JSON.stringify({ sandbox: { enabled: true } })
  expect(await outcome(dontAsk(enabled), [rm()])).toEqual(["refused"])
  expect(await outcome(dontAsk(enabled), [rm()], { version: "2.1.324" })).toEqual(["ran"])
  expect(await outcome(dontAsk(enabled), [rm()], { version: "2.1.325" })).toEqual(["refused"])
  expect(await outcome(dontAsk(sandbox()), [rm()], { sandbox_unavailable: true })).toEqual(["refused"])
})

test("allow, ask and deny rules from the flags and the settings decide before the mode and can_use_tool", async () => {
  const { fake, work } = fakeClaude()
  const locked = path.join(path.dirname(work), "locked")
  fs.mkdirSync(locked)
  const settings = JSON.stringify({
    // An absolute path rule is `//` and the path without its first slash.
    permissions: { ask: ["Bash(git push *)"], deny: ["Bash(rm *)", `Edit(//${locked.slice(1)}/**)`] },
  })
  const bash = (command: string) => ({ tool: "Bash", input: { command } })
  const write = (file: string) => ({ tool: "Write", input: { file_path: file, content: "x" }, result: "written" })
  fake.set({
    turns: [[bash("touch allowed"), bash("touch half && mkdir other"), bash("git push origin main"), write("w.txt")]],
  })
  const flags = ["--allowedTools", "Bash(touch *)", "--disallowedTools=Write", "--settings", settings]
  const dontAsk = new Claude(fake, ["--permission-mode", "dontAsk", ...flags], work)
  dontAsk.send(user("Go.", "u-1"))
  // An allow rule runs its command; a compound command runs only when every part is allowed.
  expect(verdicts(await dontAsk.turn())).toEqual(["ran", "refused", "refused", "refused"])
  expect(await dontAsk.close()).toBe(0)
  expect(["allowed", "half", "other", "w.txt"].map((f) => fs.existsSync(path.join(work, f)))).toEqual([
    true,
    false,
    false,
    false,
  ])

  // Deny rules hold in bypassPermissions; an ask rule asks even there.
  fake.set({
    turns: [[bash("rm -f absent"), bash("git push origin main"), write(path.join(locked, "f")), write("mine.txt")]],
  })
  const asking = ["--permission-prompt-tool", "stdio", "--settings", settings]
  const bypass = new Claude(fake, ["--permission-mode", "bypassPermissions", ...asking], work)
  bypass.respond((m) =>
    isRequest("can_use_tool")(m) ? answer(m.request_id, { behavior: "deny", message: "Asked, and no." }) : undefined,
  )
  bypass.send(user("Go.", "u-2"))
  const lines = await bypass.turn()
  expect(verdicts(lines)).toEqual(["refused", "refused", "refused", "ran"])
  expect(lines.filter(isRequest("can_use_tool")).map((m) => m.request.input.command)).toEqual(["git push origin main"])
  expect(lines.filter(isToolResult)[1]!.message.content[0].content).toBe("Asked, and no.")
  expect(await bypass.close()).toBe(0)
})

test("acceptEdits approves edits and mkdir, touch, mv and cp inside the working folders, --add-dir ones too, and nothing outside", async () => {
  const { fake, work } = fakeClaude()
  const [extra, outside] = ["extra", "outside"].map((name) => path.join(path.dirname(work), name)) as [string, string]
  for (const dir of [extra, outside]) fs.mkdirSync(dir)
  const write = (file: string) => ({ tool: "Write", input: { file_path: file, content: "x" }, result: "written" })
  fake.set({
    turns: [
      [
        write(path.join(extra, "a.txt")),
        { tool: "Bash", input: { command: `mkdir sub && touch sub/a && cp sub/a sub/b && mv sub/b ${extra}/c` } },
        // touch with an option, outside, a protected path, a write outside, and a command that isn't a file operation
        { tool: "Bash", input: { command: "touch -c sub/a" } },
        { tool: "Bash", input: { command: `touch ${outside}/x` } },
        write(".git/config"),
        write(path.join(outside, "y")),
        { tool: "Bash", input: { command: "chmod 600 sub/a" } },
      ],
    ],
  })
  const claude = new Claude(fake, ["--permission-mode", "acceptEdits", "--add-dir", extra], work)
  claude.send(user("Go.", "u-1"))
  const lines = await claude.turn()
  expect(lines.find((m) => m.subtype === "init")!.additional_directories).toEqual([extra])
  expect(verdicts(lines)).toEqual(["ran", "ran", "refused", "refused", "refused", "refused", "refused"])
  const made = [path.join(work, "sub", "a"), path.join(extra, "c"), path.join(outside, "x")]
  expect(made.map((f) => fs.existsSync(f))).toEqual([true, true, false])
  expect(await claude.close()).toBe(0)
})

test("reads inside the working folders and --add-dir ones run in every mode, and so do read-only commands", async () => {
  const { fake, work } = fakeClaude()
  const [extra, outside] = ["extra", "outside"].map((name) => path.join(path.dirname(work), name)) as [string, string]
  for (const dir of [extra, outside]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(work, "f.txt"), "one\ntwo\n")
  const read = (file: string) => ({ tool: "Read", input: { file_path: file }, result: "read" })
  fake.set({
    turns: [
      [
        read(path.join(extra, "f.txt")),
        read(path.join(outside, "f.txt")),
        { tool: "Bash", input: { command: "cat f.txt | wc -l" } },
        // A redirect writes, which dontAsk refuses.
        { tool: "Bash", input: { command: "ls > listing.txt" } },
      ],
    ],
  })
  const dontAsk = new Claude(fake, ["--permission-mode", "dontAsk", "--add-dir", extra], work)
  dontAsk.send(user("Go.", "u-1"))
  const lines = await dontAsk.turn()
  expect(verdicts(lines)).toEqual(["ran", "refused", "ran", "refused"])
  expect(lines.filter(isToolResult)[2]!.message.content[0].content).toBe("2")
  expect(fs.existsSync(path.join(work, "listing.txt"))).toBe(false)
  expect(await dontAsk.close()).toBe(0)

  // blockReadsOutsideWorkingDirectories refuses a read outside in every mode.
  const block = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } })
  const steps = [read(path.join(outside, "f.txt")), read("f.txt")]
  const bypass = ["--permission-mode", "bypassPermissions", "--settings", block]
  expect(await outcome(bypass, steps)).toEqual(["refused", "ran"])
})

test("no command a Bash step starts outlives the step, an interrupt, the fake's exit or a SIGTERM", async () => {
  const { fake, work } = fakeClaude()
  const pidIn = async (file: string) =>
    Number(
      await waitFor(
        () => {
          const p = path.join(work, file)
          return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() || null : null
        },
        { timeout: 10_000, what: file },
      ),
    )
  const gone = (pid: number) => {
    const stat = psStat(pid)
    return stat === "" || stat.startsWith("Z")
  }
  const bypass = ["--permission-mode", "bypassPermissions"]
  const bash = (command: string) => [{ tool: "Bash", input: { command } }]
  fake.set({ turns: [bash("sleep 31 & echo $! > a.pid"), bash("sleep 32 & echo $! > b.pid; sleep 33")] })
  const claude = new Claude(fake, bypass, work)
  // What a step leaves running in the background ends with the step, which doesn't wait for it.
  claude.send(user("Leave one.", "u-1"))
  await claude.turn()
  const left = await pidIn("a.pid")
  await waitFor(() => gone(left), { timeout: 5000, what: "the left sleep's end" })
  claude.send(user("Wait.", "u-2"))
  const waited = await pidIn("b.pid")
  claude.send(request("stop", { subtype: "interrupt" }))
  await claude.turn()
  await waitFor(() => gone(waited), { timeout: 5000, what: "the interrupted sleep's end" })
  expect(await claude.close()).toBe(0)

  for (const [end, file, code] of [["stdin", "c.pid", 0], ["SIGTERM", "d.pid", 143]] as const) {
    fake.set({ turns: [bash(`sleep 34 & echo $! > ${file}; sleep 35`)] })
    const run = new Claude(fake, bypass, work)
    run.send(user("Go.", "u-3"))
    const pid = await pidIn(file)
    if (end === "stdin") run.child.stdin!.end()
    else run.child.kill("SIGTERM")
    expect(await run.exited).toBe(code)
    await waitFor(() => gone(pid), { timeout: 5000, what: `the sleep's end after ${end}` })
  }
})

test("the fake exits loudly on what it doesn't model, so no test can rely on it", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ tool: "Bash", input: { command: 'touch "$(date)"' } }]] })
  const loud = (code: number | null, stderr: string) => {
    expect(code).toBe(FAKE_CLAUDE_UNMODELLED)
    expect(stderr).toContain("not modelled")
  }
  // At the start: a rule's form, a mode, a flag it doesn't know, a short flag, an argument no flag takes, and a value
  // of --permission-prompts it doesn't model.
  const rule = JSON.stringify({ permissions: { allow: ["WebFetch(domain:example.com)"] } })
  for (const args of [
    ["--settings", rule],
    ["--permission-mode", "plan"],
    ["--unknown-flag"],
    ["-p"],
    ["a prompt"],
    ["--permission-prompts", "sometimes"],
  ]) {
    const ran = runOnce(fake, [...STREAM, ...args], work)
    loud(ran.status, ran.stderr)
  }
  // In a session: a hook, a mode, a command it can't parse that a scoped rule would have to match, and a message's
  // priority now or one the docs don't name.
  const sessions: [string[], Msg[]][] = [
    [[], [request("init", { subtype: "initialize", hooks: { Stop: [{ hookCallbackIds: ["hook_0"] }] } })]],
    [[], [request("mode", { subtype: "set_permission_mode", mode: "auto" })]],
    [["--allowedTools", "Bash(touch *)"], [user("Go.", "u-1")]],
    [[], [user("Now.", "u-1", "now")]],
    [[], [user("Soon.", "u-1", "soon")]],
    [[], [request("stop", { subtype: "interrupt", cancel_queued: "yes" })]],
  ]
  for (const [args, lines] of sessions) {
    const claude = new Claude(fake, args, work)
    for (const line of lines) claude.send(line)
    loud(await claude.exited, claude.stderr)
  }
  // Answers it doesn't model: a deny that interrupts.
  fake.set({ turns: [[{ tool: "Bash", input: { command: "touch x" } }]] })
  const interrupting = new Claude(fake, ["--permission-prompt-tool", "stdio"], work)
  interrupting.respond((m) =>
    isRequest("can_use_tool")(m)
      ? answer(m.request_id, { behavior: "deny", message: "No.", interrupt: true })
      : undefined,
  )
  interrupting.send(user("Go.", "u-1"))
  loud(await interrupting.exited, interrupting.stderr)
  // A command in the background, which the office's start turns off.
  fake.set({ turns: [[{ tool: "Bash", input: { command: "sleep 5", run_in_background: true } }]] })
  const background = new Claude(fake, ["--permission-mode", "bypassPermissions"], work)
  background.send(user("Go.", "u-1"))
  loud(await background.exited, background.stderr)
  // An allow without updatedInput, which old versions refused.
  const bare = new Claude(fake, ["--permission-prompt-tool", "stdio"], work)
  bare.respond((m) => (isRequest("can_use_tool")(m) ? answer(m.request_id, { behavior: "allow" }) : undefined))
  bare.send(user("Go.", "u-1"))
  loud(await bare.exited, bare.stderr)
  // A command behind an assignment or a wrapper where acceptEdits or the read-only set must judge it; the docs say
  // only that such a touch isn't approved.
  for (const command of ["LANG=C rm -f gone", "timeout 5 mkdir made", "timeout 5 ls"]) {
    fake.set({ turns: [[{ tool: "Bash", input: { command } }]] })
    const prefixed = new Claude(fake, ["--permission-mode", "acceptEdits"], work)
    prefixed.send(user("Go.", "u-1"))
    loud(await prefixed.exited, prefixed.stderr)
  }
  const touch = [{ tool: "Bash", input: { command: "LANG=C touch t" } }]
  expect(await outcome(["--permission-mode", "acceptEdits"], touch)).toEqual(["refused"])
  expect(fake.log().filter((entry) => entry.dir === "unmodelled").length).toBe(18)
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
  expect(pwd!.message.content[0]).toEqual({
    tool_use_id: expect.any(String),
    type: "tool_result",
    content: work,
    is_error: false,
  })
  expect(pwd!.tool_use_result).toEqual({
    stdout: `${work}\n`,
    stderr: "",
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  })
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

test("a message with priority next, or with none, joins the running turn, and one with priority later waits", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ say: "a" }, { sleep: 1 }, { say: "b" }], [{ say: "second" }]] })
  const claude = new Claude(fake, [], work)
  claude.send(user("First.", "u-1"))
  await claude.until(isText("a"), "the first text")
  claude.send(user("Join.", "u-2", "next"))
  claude.send(user("Wait.", "u-3", "later"))
  claude.send(user("Join too.", "u-4"))
  const first = await claude.turn("the first turn's end")
  expect(first.map(brief)).toEqual([
    "queued:u-2",
    "queued:u-3",
    "queued:u-4",
    "started:u-2",
    "started:u-4",
    "assistant:b",
    // As recorded: the lines that joined complete before the result, the first one after it.
    "completed:u-2",
    "completed:u-4",
    "result/success/completed",
    "completed:u-1",
  ])
  expect(resultOf(first)!.user_message_uuids).toEqual(["u-1", "u-2", "u-4"])
  expect(resultOf(first)!.queued_turn_count).toBe(1)
  const second = await claude.turn("the second turn's end")
  expect(second.map(brief)).toEqual([
    "started:u-3",
    "system/init",
    "assistant:second",
    "result/success/completed",
    "completed:u-3",
  ])
  expect(await claude.close()).toBe(0)
})

test("an interrupt with cancel_queued cancels the lines waiting, which never run, and lists them", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ say: "a" }, { sleep: 30 }], [{ say: "never" }]] })
  const claude = new Claude(fake, [], work)
  claude.send(user("First.", "u-1"))
  await claude.until(isText("a"), "the first text")
  claude.send(user("Join.", "u-2"))
  claude.send(user("Wait.", "u-3", "later"))
  await claude.until((m) => m.type === "command_lifecycle" && m.command_uuid === "u-3", "the second queued")
  claude.send(request("stop", { subtype: "interrupt", cancel_queued: true }))
  const lines = await claude.turn()
  // As recorded: each line is cancelled before the answer.
  expect(lines.map(brief)).toEqual([
    "cancelled:u-2",
    "cancelled:u-3",
    "response/success",
    "user:[Request interrupted by user]",
    "result/error_during_execution/aborted_streaming",
    "cancelled:u-1",
  ])
  expect(lines[2]!.response.response).toEqual({ still_queued: [], cancelled: ["u-2", "u-3"] })
  // Nothing runs after: the next line starts the next scripted turn.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(claude.out.some(isText("never"))).toBe(false)
  // The capability says so, and with no turn the answer comes at once.
  expect(claude.out.find((m) => m.subtype === "init")!.capabilities).toContain("interrupt_cancel_queued_v1")
  claude.send(request("idle", { subtype: "interrupt", cancel_queued: true }))
  const [idle] = await claude.until(isResponse("idle"), "the idle answer")
  expect(idle!.response.response).toEqual({ still_queued: [], cancelled: [] })
  expect(await claude.close()).toBe(0)
})

test("a spawn step leaves its child in the fake's group past an exit, slow_start holds initialize, and background holds the exit", async () => {
  const { fake, work } = fakeClaude({ slow_start: 0.5, turns: [[{ spawn: 30 }, { exit: 1 }]] })
  const claude = new Claude(fake, [], work)
  const asked = performance.now()
  claude.send(request("init", { subtype: "initialize" }))
  await claude.until(isResponse("init"), "initialize's answer")
  expect(performance.now() - asked).toBeGreaterThanOrEqual(450)
  claude.send(user("Go.", "u-1"))
  expect(await claude.exited).toBe(1)
  const child = fake.log().find((e) => e.dir === "spawn")!.pid
  const pgid = (pid: number) => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[2])
  // Still running, in the group the fake ran in (this test's, as it isn't detached).
  expect(pgid(child)).toBe(pgid(process.pid))
  process.kill(child, "SIGKILL")

  // Background work keeps a run open past its stdin's end.
  fake.set({ background: 0.5 })
  const lingering = new Claude(fake, [], work)
  const closed = performance.now()
  expect(await lingering.close()).toBe(0)
  expect(performance.now() - closed).toBeGreaterThanOrEqual(450)
})

test("--permission-prompts none asks the host nothing, --no-session-persistence keeps no session, and an appended system prompt file is read at the start", async () => {
  const { fake, work } = fakeClaude({ turns: [[{ tool: "Bash", input: { command: "touch made" } }]] })
  // With a prompt tool the fake would ask; with none, nothing is asked and the call is refused.
  const none = new Claude(fake, ["--permission-prompt-tool", "stdio", "--permission-prompts=none"], work)
  none.send(user("Go.", "u-1"))
  const lines = await none.turn()
  expect(lines.some(isRequest("can_use_tool"))).toBe(false)
  expect(verdicts(lines)).toEqual(["refused"])
  expect(await none.close()).toBe(0)

  fake.set({ turns: [[{ say: "kept nowhere" }]] })
  const prompt = path.join(work, "instructions.md")
  fs.writeFileSync(prompt, "Be brief.\n")
  const unsaved = new Claude(fake, ["--session-id", "s-gone", "--no-session-persistence", `--append-system-prompt-file=${prompt}`], work)
  unsaved.send(user("Hi.", "u-2"))
  await unsaved.turn()
  expect(await unsaved.close()).toBe(0)
  expect(Object.keys(fake.sessions())).not.toContain("s-gone")
  const start = fake.log().filter((e) => e.dir === "start").at(-1)!
  expect(start.flags).toMatchObject({ "no-session-persistence": true, "append-system-prompt-file": prompt })
  expect(start.appended).toBe("Be brief.\n")
  // A file that isn't there stops the start (its wording unrecorded).
  const missing = runOnce(fake, [...STREAM, `--append-system-prompt-file=${path.join(work, "none.md")}`], work)
  expect([missing.status, missing.stdout]).toEqual([1, ""])
})

test("an --mcp-config file's servers are read at the start and started in the fake's folder, their tools listed whatever --tools says, and run only where an allow rule names them", async () => {
  const dir = tempDir()
  const servers = {
    github: { command: "sh", args: ["-c", `pwd > ${dir}/pwd; env | cut -d= -f1 > ${dir}/names`], env: { O5_TOKEN: "t" } },
    web: { type: "http", url: "https://e.example/mcp" },
  }
  const step = { tool: "mcp__github__get_me", input: {}, result: "me" }
  const { fake, work } = fakeClaude({ mcp_tools: { github: ["get_me"], docs: ["search"] }, turns: [[step], [step]] })
  const config = path.join(work, "mcp.json")
  fs.writeFileSync(config, JSON.stringify({ mcpServers: servers }))
  const allow = JSON.stringify({ permissions: { allow: ["mcp__github__*"] } })
  const base = ["--strict-mcp-config", `--mcp-config=${config}`, "--tools=Bash", "--permission-prompts=none"]
  const allowed = new Claude(fake, [...base, "--settings", allow], work)
  allowed.send(user("Who am I?", "u-1"))
  const lines = await allowed.turn()
  const init = lines.find((m) => m.subtype === "init")!
  expect(init.tools).toEqual(["Bash", "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__github__get_me"])
  expect(init.mcp_servers).toEqual([
    { name: "github", status: "connected" },
    { name: "web", status: "connected" },
  ])
  expect(verdicts(lines)).toEqual(["ran"])
  expect(await allowed.close()).toBe(0)
  expect(fs.readFileSync(path.join(dir, "pwd"), "utf8").trim()).toBe(fs.realpathSync(work))
  expect(fs.readFileSync(path.join(dir, "names"), "utf8").split("\n")).toContain("O5_TOKEN")
  expect(fake.log().filter((e) => e.dir === "start").at(-1)!.mcp).toEqual([{ path: config, servers }])
  // With no allow rule, nothing approves it here.
  const asked = new Claude(fake, base, work)
  asked.send(user("Who am I?", "u-2"))
  expect(verdicts(await asked.turn())).toEqual(["refused"])
  expect(await asked.close()).toBe(0)
  // A file that isn't there stops the start; a JSON string isn't modelled.
  const missing = runOnce(fake, [...STREAM, `--mcp-config=${path.join(work, "none.json")}`], work)
  expect([missing.status, missing.stdout]).toEqual([1, ""])
  const inline = runOnce(fake, [...STREAM, "--mcp-config", JSON.stringify({ mcpServers: servers })], work)
  expect(inline.status).toBe(FAKE_CLAUDE_UNMODELLED)
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
  const fixture = (file: string) =>
    fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { source: string; message: Msg })
  const lines = [...fixture(FIXTURE), ...fixture(OLDER).filter((line) => OLDER_KEPT.has(line.source))]
  for (const { message } of lines.filter((line) => !LEFT_OUT.has(kindOf(line.message)))) {
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

  // Signed in and started as the office starts it: a refusal by a rule, one that would ask with nobody to ask, a tool
  // the session doesn't list, a command interrupted with a message queued, which runs after, and an interrupt that
  // cancels the message queued.
  const read = (file: string) => ({ tool: "Read", input: { file_path: file } })
  const write = (file: string) => ({ tool: "Write", input: { file_path: file, content: "x" } })
  const edit = (file: string) => ({ tool: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } })
  fake.set({
    turns: [
      [read(path.join(work, "secret")), write("../outside.txt"), edit("e.txt"), bash("sleep 30")],
      [{ say: "queued" }],
      [{ say: "c" }, { sleep: 30 }],
      [{ say: "never" }],
    ],
  })
  const settings = JSON.stringify({ permissions: { deny: ["Read(./secret)"] } })
  const args = [
    "--tools=Bash,Read,Write",
    "--allowedTools=Bash(sleep *)",
    "--permission-prompts=none",
    "--permission-mode=acceptEdits",
    "--settings",
    settings,
  ]
  const office = new Claude(fake, args, work)
  office.send(request("init", { subtype: "initialize" }))
  office.send(user("Refusals.", "u-4"))
  await office.until((m) => m.type === "assistant" && m.message.content[0].input?.command === "sleep 30", "the command")
  office.send(user("Queued.", "u-5"))
  await office.until((m) => m.type === "command_lifecycle" && m.command_uuid === "u-5", "the queued line")
  office.send(request("stop-1", { subtype: "interrupt" }))
  const [stop] = (await office.until(isResponse("stop-1"), "the interrupt's answer")).slice(-1)
  expect(stop!.response.response).toEqual({ still_queued: ["u-5"] })
  await office.turn()
  await office.until(isText("queued"), "the queued line's own turn")
  await office.turn()
  office.send(user("Cancel what waits.", "u-6"))
  await office.until(isText("c"), "the text")
  office.send(user("Never.", "u-7"))
  await office.until((m) => m.type === "command_lifecycle" && m.command_uuid === "u-7", "the queued line")
  office.send(request("stop-2", { subtype: "interrupt", cancel_queued: true }))
  await office.turn()
  expect(await office.close()).toBe(0)

  // A start the sandbox stops.
  fake.set({ sandbox_unavailable: true })
  const sandbox = JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } })
  const stopped = new Claude(fake, ["--settings", sandbox], work)
  stopped.send(request("init", { subtype: "initialize" }))
  await stopped.until((m) => m.type === "result", "the start's result")
  expect(await stopped.close()).toBe(1)

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
  expect([version.status, version.stdout]).toEqual([0, "2.1.330 (Claude Code)\n"])
  const claude = new Claude(fake, [], work)
  expect(await claude.close()).toBe(0)
  expect(claude.out).toEqual([])
  const wrong = runOnce(fake, ["--output-format", "stream-json"], work)
  expect(wrong.status).toBe(2)
  expect(wrong.stderr).toContain("stream-json")
})

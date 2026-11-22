/** Claude Code as the office runs it: the binary, the start under an employee's permission (its flag settings, its
 *  listed folders, no settings files, hooks, plugins or MCP servers, edits accepted, nothing asked, a fixed PATH and
 *  temp folder, auto memory off), the sign-in and version checks of `initialize`, a start the sandbox stops, turns,
 *  interrupts, and the process group. Every run is D4's fake, never a real Claude Code. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { type EmployeePermission, claudeStart } from "../../../src/runtime/sandbox/harness_profile.ts"
import { type FakeClaude, type FakeClaudeScript, installFakeClaude } from "../../../src/testing/fake_claude.ts"
import {
  CLAUDE_FLOOR,
  ClaudeMissing,
  ClaudeProcess,
  ClaudeSandboxUnavailable,
  ClaudeSignedOut,
  ClaudeStartError,
  ClaudeTooOld,
  STREAM_ARGS,
  claudeArgs,
  claudeCommand,
  claudeSession,
  nativeClaude,
  refusal,
  signedIn,
} from "../../../src/tools/claude/claude.ts"
import { isGone, tempDir, waitFor } from "../../helpers.ts"
import { startTime } from "../../../src/util/proc.ts"

setDefaultTimeout(30_000)

/** A JSON object from the fake's log: `any`, since the assertions read whatever was logged. */
type Obj = Record<string, any>

/** What a worker gives every harness, before the harness's own fixed variables. */
const BASE = { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", LANG: "C.UTF-8" }

/** A temp layout: a home with credentials and an office, a workspace, a private empty temp folder, the fence, a
 *  read-only and a writable listed folder, and the fake Claude Code (2.1.325 unless scripted), all resolved and
 *  the user's alone to write. `permission` builds an employee's permission over it. */
function layout(script: FakeClaudeScript = {}) {
  const root = fs.realpathSync(tempDir())
  const home = path.join(root, "home")
  for (const dir of [".ssh", ".claude", ".opencorp/office"]) fs.mkdirSync(path.join(home, dir), { recursive: true })
  const ws = path.join(root, "ws")
  const tmp = path.join(root, "tmp")
  const fence = path.join(root, "fence")
  const cargo = path.join(root, "cargo")
  const data = path.join(root, "data")
  for (const dir of [ws, path.join(cargo, "bin"), data]) fs.mkdirSync(dir, { recursive: true })
  for (const dir of [cargo, path.join(cargo, "bin")]) fs.chmodSync(dir, 0o755)
  fs.mkdirSync(tmp, { mode: 0o700 })
  fs.chmodSync(tmp, 0o700)
  fs.writeFileSync(fence, "")
  const fake = installFakeClaude(path.join(root, "fake"), { version: "2.1.325", ...script })
  const permission = (fields: Partial<EmployeePermission> = {}): EmployeePermission => ({
    workspace: ws,
    gitRoot: null,
    writable: true,
    network: false,
    tmpdir: tmp,
    fence,
    folders: [
      { path: cargo, access: "read" },
      { path: data, access: "write" },
    ],
    home,
    officeHome: path.join(home, ".opencorp"),
    ...fields,
  })
  return { root, home, ws, tmp, cargo, data, fake, permission }
}

/** A Claude Code process on `fake` for `p`, logging to `<root>/claude.log`, with the lines it writes kept. */
function proc(
  root: string,
  fake: FakeClaude,
  p: EmployeePermission,
  { environ = {}, command }: { environ?: Record<string, string>; command?: string[] } = {},
) {
  const start = claudeStart(p)
  const lines: Obj[] = []
  const logged: string[] = []
  let exited!: () => void
  const exits = new Promise<void>((resolve) => (exited = resolve))
  const claude = new ClaudeProcess({
    command: command ?? [fake.claude, ...claudeArgs(start)],
    cwd: p.workspace,
    env: { ...BASE, ...start.env },
    log: path.join(root, "claude.log"),
    environ,
    onMessage: (msg) => lines.push(msg),
    onExit: () => exited(),
    logLine: (line) => logged.push(line),
  })
  return { claude, start, lines, logged, exits }
}

/** The first start the fake logged. */
function started(fake: FakeClaude): Obj {
  const entry = fake.log().find((e) => e.dir === "start")
  if (entry === undefined) throw new Error("the fake never started")
  return entry
}

/** The lines the office sent the fake. */
function sent(fake: FakeClaude): Obj[] {
  return fake
    .log()
    .filter((e) => e.dir === "in")
    .map((e) => e.msg!)
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (e) {
    return e as Error
  }
  throw new Error("did not reject")
}

test("a start runs claude in the folder with the employee's settings and folders, no settings files, hooks, plugins or MCP servers, edits accepted and nothing asked", async () => {
  const { root, ws, cargo, data, fake, permission } = layout()
  const { claude, start } = proc(root, fake, permission())
  await claude.start()
  const at = started(fake)
  expect(at.argv).toEqual([
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--setting-sources=",
    "--strict-mcp-config",
    "--permission-mode=acceptEdits",
    "--permission-prompts=none",
    // Only these: the rest act on the owner's account, outside the sandbox, or after the turn.
    "--tools=Bash,Read,Edit,Write,NotebookEdit,Glob,Grep,TaskStop,ToolSearch",
    "--settings",
    JSON.stringify(start.settings),
    `--add-dir=${cargo}`,
    `--add-dir=${data}`,
  ])
  expect(at.argv.slice(0, STREAM_ARGS.length)).toEqual([...STREAM_ARGS])
  for (const flag of ["--mcp-config", "--plugin-dir", "--plugin-url", "--permission-prompt-tool", "-p"]) {
    expect(at.argv.some((arg: string) => arg === flag || arg.startsWith(`${flag}=`)), flag).toBe(false)
  }
  expect(at.cwd).toBe(ws)
  expect(at.flags).toMatchObject({
    settings: start.settings,
    "setting-sources": "",
    "strict-mcp-config": true,
    "permission-mode": "acceptEdits",
    "add-dir": [cargo, data],
  })
  // initialize registers no hook, so Claude Code sends no hook callback.
  const init = sent(fake).find((m) => m.type === "control_request")!
  expect(init.request).toEqual({ subtype: "initialize" })
  await claude.close(2000)
})

test("a start's environment is the worker's with the fixed PATH, its own temp folder for TMPDIR and Claude Code's, auto memory off and no background commands", async () => {
  const { root, tmp, fake, permission } = layout()
  const p = permission()
  const { claude, start } = proc(root, fake, p)
  await claude.start()
  const env = started(fake).env as Record<string, string>
  // sh adds PWD and SHLVL.
  const { PWD: _pwd, SHLVL: _shlvl, ...given } = env
  expect(given).toEqual({ ...BASE, ...start.env })
  expect(given).toMatchObject({ TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })
  // No command runs in the background, where it would outlive Esc and the turn.
  expect(given.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1")
  expect(given.PATH).toBe(start.env.PATH)
  expect(given.PATH.split(":")).toContain(path.join(p.folders[0]!.path, "bin"))
  expect(Object.keys(given)).not.toContain("CLAUDE_CONFIG_DIR")
  await claude.close(2000)

  // The office's own Claude Code config folder, when it sets one, so Claude Code keeps its own sign-in.
  const elsewhere = proc(root, fake, p, { environ: { CLAUDE_CONFIG_DIR: "/owner/.claude-work", CODEX_HOME: "/x" } })
  await elsewhere.claude.start()
  const second = fake.log().filter((e) => e.dir === "start")[1]!.env as Record<string, string>
  expect(second.CLAUDE_CONFIG_DIR).toBe("/owner/.claude-work")
  expect(Object.keys(second)).not.toContain("CODEX_HOME")
  await elsewhere.claude.close(2000)
})

test("a session's start passes the owner's and the project's CLAUDE.md from a file in its own temp folder, removed when Claude Code exits", async () => {
  const { root, home, ws, tmp, fake, permission } = layout()
  const config = path.join(home, ".claude")
  fs.writeFileSync(path.join(config, "CLAUDE.md"), "Owner says: be brief.\n")
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "Project says: use tabs.\n")
  const p = permission()
  const session = claudeSession(p, { claude: fake.claude, configDir: config, sessionId: "550e8400-e29b-41d4-a716-446655440000" })
  const file = path.join(tmp, "opencorp.instructions.md")
  expect(session.command).toContain(`--append-system-prompt-file=${file}`)
  expect(session.command[0]).toBe(fake.claude)
  expect(session.instructions).toBe(file)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.statSync(file).uid).toBe(process.getuid!())
  const text = fs.readFileSync(file, "utf8")
  expect(text).toContain("Owner says: be brief.")
  expect(text).toContain("Project says: use tabs.")
  const logged: string[] = []
  const claude = new ClaudeProcess({
    command: session.command,
    cwd: p.workspace,
    env: { ...BASE, ...session.env },
    log: path.join(root, "claude.log"),
    instructions: session.instructions,
    onMessage() {},
    onExit() {},
    logLine: (line) => logged.push(line),
  })
  await claude.start()
  expect(started(fake).appended).toBe(text)
  await claude.close(2000)
  expect(fs.existsSync(file)).toBe(false)
  expect(logged).toEqual([])

  // With no CLAUDE.md anywhere, no file and no flag.
  fs.rmSync(path.join(config, "CLAUDE.md"))
  fs.rmSync(path.join(ws, "CLAUDE.md"))
  const bare = claudeSession(p, { claude: fake.claude, configDir: config })
  expect(bare.instructions).toBeNull()
  expect(bare.command.some((arg) => arg.startsWith("--append-system-prompt"))).toBe(false)
  expect(fs.readdirSync(tmp)).toEqual([])
  // The rest is the permission's start, as claudeArgs builds it.
  expect(bare.command.slice(1)).toEqual(claudeArgs(claudeStart(p)))
  expect(bare.env).toEqual(claudeStart(p).env)

  // The office's own words for the session come first, with no CLAUDE.md too.
  const told = claudeSession(p, { claude: fake.claude, configDir: config, prompt: "Two people write to you." })
  expect(told.instructions).toBe(file)
  expect(fs.readFileSync(file, "utf8")).toBe("Two people write to you.\n")
  // Each start's temp folder is fresh.
  fs.rmSync(file)
  fs.writeFileSync(path.join(config, "CLAUDE.md"), "Owner says: be brief.\n")
  const both = claudeSession(p, { claude: fake.claude, configDir: config, prompt: "Two people write to you." })
  const text2 = fs.readFileSync(both.instructions!, "utf8")
  expect(text2.startsWith("Two people write to you.\n\n")).toBe(true)
  expect(text2).toContain("Owner says: be brief.")
})

test("a session resumed or new, and its model, go on the command line", () => {
  const start = { settings: { disableAllHooks: true }, addDirs: ["/a b"] }
  const tail = claudeArgs(start, { sessionId: "550e8400-e29b-41d4-a716-446655440000", model: "sonnet" })
  expect(tail.slice(-3)).toEqual(["--add-dir=/a b", "--session-id=550e8400-e29b-41d4-a716-446655440000", "--model=sonnet"])
  expect(claudeArgs(start, { resume: "s-1" }).slice(-1)).toEqual(["--resume=s-1"])
  expect(() => claudeArgs(start, { resume: "s-1", sessionId: "x" })).toThrow()
  // A start that keeps no session (doctor's), and the owner's and the project's instructions from a file.
  expect(claudeArgs(start, { persist: false, instructions: "/private/p.md" }).slice(-2)).toEqual([
    "--no-session-persistence",
    "--append-system-prompt-file=/private/p.md",
  ])
  expect(claudeArgs(start).some((arg) => arg.startsWith("--no-session") || arg.startsWith("--append-system"))).toBe(
    false,
  )
})

test("the sign-in check reads initialize's account with no model call: signed out refuses the start and leaves nothing running", async () => {
  const { root, fake, permission } = layout({ signed_out: true })
  const { claude } = proc(root, fake, permission())
  const e = await rejection(claude.start())
  expect(e).toBeInstanceOf(ClaudeSignedOut)
  expect(e.message).toContain("/login")
  expect(claude.alive).toBe(false)
  // Only initialize went: no message, so no model call.
  expect(sent(fake).map((m) => m.type)).toEqual(["control_request"])
  expect(signedIn({ tokenSource: "none", apiProvider: "firstParty" })).toBe(false)
  expect(signedIn({ tokenSource: "none", apiKeySource: "user" })).toBe(true)
  expect(signedIn({ email: "user@example.com", subscriptionType: "Claude Team" })).toBe(true)
  expect(signedIn(undefined)).toBe(false)
})

test("a claude older than the floor, or one that says no version, is refused at start with how to update it", async () => {
  expect(CLAUDE_FLOOR).toBe("2.1.325")
  for (const version of ["2.1.324", "2.0.400", "garbled"]) {
    const { root, fake, permission } = layout({ version })
    const { claude } = proc(root, fake, permission())
    const e = await rejection(claude.start())
    expect(e, version).toBeInstanceOf(ClaudeTooOld)
    expect(e.message).toContain("2.1.325")
    expect(e.message).toContain("claude update")
    expect(claude.alive).toBe(false)
  }
  const { root, fake, permission } = layout({ version: "2.1.330" })
  const { claude } = proc(root, fake, permission())
  await claude.start()
  await claude.close(2000)
})

test("a start that its sandbox stops says what to fix and where Claude Code's output is, and holds none of that output", async () => {
  const { root, fake, permission } = layout({ sandbox_unavailable: true })
  const log = path.join(root, "claude.log")
  // An earlier start's output in the same log isn't this start's reason.
  fs.writeFileSync(log, "an earlier run\n", { mode: 0o600 })
  const { claude } = proc(root, fake, permission())
  const e = await rejection(claude.start())
  expect(e).toBeInstanceOf(ClaudeSandboxUnavailable)
  expect(e).toBeInstanceOf(ClaudeStartError)
  expect(e.message).toContain("sandbox")
  expect(e.message).toContain("bubblewrap")
  expect(e.message).toContain("opencorp doctor")
  expect(e.message).toContain(log)
  expect(e.message).not.toContain("failIfUnavailable")
  expect(fs.readFileSync(log, "utf8")).toContain("failIfUnavailable")
  expect(claude.alive).toBe(false)

  // Each failure Claude Code's docs name for a sandbox that can't run is the sandbox's.
  const dies = layout({ turns: [] })
  const broken = path.join(dies.root, "broken")
  for (const said of [
    "Sandbox is required but failed to initialize: bwrap missing. Restart to retry.",
    "Sandbox is required (sandbox.failIfUnavailable) and stopped being available in this session: socat",
    "Ubuntu's AppArmor restriction on user namespaces stops bubblewrap here",
    "bwrap: setting up uid map: Permission denied",
  ]) {
    fs.writeFileSync(broken, `#!/bin/sh\necho '${said.replaceAll("'", "")}' >&2\nexit 1\n`, { mode: 0o700 })
    const stopped = proc(root, dies.fake, dies.permission(), { command: [broken] })
    expect(await rejection(stopped.claude.start()), said).toBeInstanceOf(ClaudeSandboxUnavailable)
  }
  // A start that dies for another reason isn't the sandbox's, though its output says "sandbox".
  fs.writeFileSync(log, "the sandbox was fine last time\n", { mode: 0o600 })
  fs.writeFileSync(broken, "#!/bin/sh\necho 'no luck: invalid sandbox.network setting' >&2\nexit 1\n", {
    mode: 0o700,
  })
  const other = proc(root, dies.fake, dies.permission(), { command: [broken] })
  const died = await rejection(other.claude.start())
  expect(died).toBeInstanceOf(ClaudeStartError)
  expect(died).not.toBeInstanceOf(ClaudeSandboxUnavailable)
  expect(died.message).toContain("opencorp doctor")
  expect(died.message).toContain(log)
  expect(died.message).not.toContain("no luck")
  expect(died.message).not.toContain("bubblewrap")
})

test("a command that cant be run says to run opencorp doctor and leaves nothing", async () => {
  const { root, fake, permission } = layout()
  const notAProgram = path.join(root, "claude")
  fs.writeFileSync(notAProgram, "not a program", { mode: 0o644 })
  const { claude } = proc(root, fake, permission(), { command: [notAProgram] })
  const e = await rejection(claude.start())
  expect(e).toBeInstanceOf(ClaudeStartError)
  expect(e.message).toContain("Claude Code couldn't start")
  expect(e.message).toContain("opencorp doctor")
  expect(claude.proc).toBeNull()
})

test("a message goes as written, never as a command or a file mention, and its turn's lines come back", async () => {
  const { root, fake, permission } = layout({ turns: [[{ say: "COPPER-OTTER" }]] })
  const { claude, lines } = proc(root, fake, permission())
  await claude.start()
  const uuid = await claude.send("/config sandbox.enabled=false @~/.ssh/id_test")
  await waitFor(() => lines.some((m) => m.type === "result"), { what: "the turn's result" })
  const message = sent(fake).find((m) => m.type === "user")!
  expect(message).toEqual({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text: "/config sandbox.enabled=false @~/.ssh/id_test" }] },
    parent_tool_use_id: null,
    client_composed: true,
  })
  const result = lines.find((m) => m.type === "result")!
  expect([result.subtype, result.result]).toEqual(["success", "COPPER-OTTER"])
  // A message mid-turn may join it.
  const next = await claude.send("and this", { priority: "next" })
  const joined = await waitFor(() => sent(fake).find((m) => m.uuid === next), { what: "the second message" })
  expect(joined.priority).toBe("next")
  // A sender may name the message's uuid, to follow its lifecycle from before it is written.
  expect(await claude.send("and that", { uuid: "6f1d2c3b-0000-4000-8000-000000000001" })).toBe(
    "6f1d2c3b-0000-4000-8000-000000000001",
  )
  await waitFor(() => sent(fake).some((m) => m.uuid === "6f1d2c3b-0000-4000-8000-000000000001"), { what: "the third" })
  await claude.close(2000)
})

test("an interrupt ends the running turn as Claude Code does", async () => {
  const { root, fake, permission } = layout({ turns: [[{ say: "working" }, { sleep: 20 }]] })
  const { claude, lines } = proc(root, fake, permission())
  await claude.start()
  await claude.send("go")
  await waitFor(() => lines.some((m) => m.type === "assistant"), { what: "the turn to start" })
  expect(await claude.interrupt()).toEqual({ still_queued: [] })
  await waitFor(() => lines.some((m) => m.type === "result"), { what: "the interrupted result" })
  expect(lines.find((m) => m.type === "result")!.subtype).toBe("error_during_execution")
  await claude.close(2000)
})

test("an interrupt that cancels what waits takes the messages sent mid-turn out too, and none of them runs", async () => {
  const { root, fake, permission } = layout({ turns: [[{ say: "working" }, { sleep: 20 }], [{ say: "never" }]] })
  const { claude, lines } = proc(root, fake, permission())
  await claude.start()
  await claude.send("go")
  await waitFor(() => lines.some((m) => m.type === "assistant"), { what: "the turn to start" })
  const waiting = await claude.send("and this", { priority: "next" })
  await waitFor(() => lines.some((m) => m.type === "command_lifecycle" && m.command_uuid === waiting), {
    what: "the second message queued",
  })
  expect(await claude.interrupt({ cancelQueued: true })).toEqual({ still_queued: [], cancelled: [waiting] })
  const sent = fake.log().find((e) => e.dir === "in" && e.msg?.request?.subtype === "interrupt")!
  expect(sent.msg!.request).toEqual({ subtype: "interrupt", cancel_queued: true })
  await waitFor(() => lines.some((m) => m.type === "result"), { what: "the interrupted result" })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(lines.some((m) => m.type === "assistant" && m.message?.content?.[0]?.text === "never")).toBe(false)
  await claude.close(2000)
})

test("a request Claude Code sends is refused at once: a tool's permission is denied, and nothing else is served", () => {
  const tool = refusal({ subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } })
  expect(tool).toMatchObject({ response: { behavior: "deny" } })
  expect((tool as { response: { message: string } }).response.message).toContain("permission")
  for (const subtype of ["hook_callback", "mcp_message", "elicitation", "something_new"]) {
    expect(refusal({ subtype }), subtype).toMatchObject({ error: expect.any(String) })
  }
})

test("close ends claude, its group and its pipes, and calls on exit once", async () => {
  const { root, fake, permission } = layout({ turns: [[{ tool: "Bash", input: { command: "sleep 30" } }]] })
  const { claude, exits } = proc(root, fake, permission())
  await claude.start()
  const pid = claude.pid
  const at = startTime(pid)
  await claude.send("run it")
  await waitFor(() => fake.log().some((e) => e.dir === "out" && e.msg?.type === "assistant"), { what: "the tool" })
  await claude.close(1000)
  await exits
  expect(claude.alive).toBe(false)
  await waitFor(() => isGone(pid, at), { what: "claude gone" })
  // Its log is the user's alone.
  expect(fs.statSync(path.join(root, "claude.log")).mode & 0o777).toBe(0o600)
})

test("a linked log refuses to start", async () => {
  const { root, fake, permission } = layout()
  fs.symlinkSync(path.join(root, "elsewhere.log"), path.join(root, "claude.log"))
  const { claude } = proc(root, fake, permission())
  expect(await rejection(claude.start())).toBeInstanceOf(ClaudeStartError)
  expect(fs.existsSync(path.join(root, "elsewhere.log"))).toBe(false)
})

test("claude command finds claude on the office path, or the binary opencorp claude bin names, and says how to install it", () => {
  const root = fs.realpathSync(tempDir())
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin)
  const exe = (p: string) => fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 })
  exe(path.join(bin, "claude"))
  exe(path.join(bin, "claude-work"))
  expect(claudeCommand({ PATH: bin }, {})).toBe(path.join(bin, "claude"))
  expect(claudeCommand({ PATH: bin }, { OPENCORP_CLAUDE_BIN: "claude-work" })).toBe(path.join(bin, "claude-work"))
  expect(claudeCommand({ PATH: bin }, { OPENCORP_CLAUDE_BIN: "" })).toBe(path.join(bin, "claude"))
  const missing = (() => {
    try {
      claudeCommand({ PATH: root }, {})
    } catch (e) {
      return e as Error
    }
  })()
  expect(missing).toBeInstanceOf(ClaudeMissing)
  expect(missing!.message).toContain("opencorp doctor")
  expect(() => claudeCommand({ PATH: bin }, { OPENCORP_CLAUDE_BIN: "./claude" })).toThrow(/OPENCORP_CLAUDE_BIN/)
})

test("the native installer's launcher runs as the version it links to, installed in that version's folder", () => {
  const root = fs.realpathSync(tempDir())
  const versions = path.join(root, "share/claude/versions")
  fs.mkdirSync(versions, { recursive: true })
  fs.writeFileSync(path.join(versions, "2.1.325"), "\x7fELF", { mode: 0o755 })
  fs.mkdirSync(path.join(root, "bin"))
  fs.symlinkSync(path.join(versions, "2.1.325"), path.join(root, "bin/claude"))
  expect(nativeClaude(path.join(root, "bin/claude"))).toEqual({ run: path.join(versions, "2.1.325"), install: versions })
  // A script (a wrapper, or a package manager's shim) runs as itself, from its own folder.
  fs.writeFileSync(path.join(root, "bin/wrapper"), "#!/bin/sh\n", { mode: 0o755 })
  expect(nativeClaude(path.join(root, "bin/wrapper"))).toEqual({
    run: path.join(root, "bin/wrapper"),
    install: path.join(root, "bin"),
  })
})

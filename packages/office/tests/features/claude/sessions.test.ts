/** The office's Claude Code sessions, each an employee chat's instrument and its child session, on the fake Claude
 *  Code: a start under the employee's permission with the speakers' instructions, both speakers' messages labelled and
 *  sent as `next`, Esc, the end, the idle stop and the resume, a crash, a start that can't, an office restart, and the
 *  chat's next instrument continuing a session after it. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { ClaudeSessions } from "../../../src/features/claude/sessions.ts"
import { HarnessError } from "../../../src/runtime/sessions/state.ts"
import { ClaudeProcess } from "../../../src/tools/claude/claude.ts"
import { CLAUDE, readClaudeRecord } from "../../../src/tools/claude/instrument.ts"
import { HarnessRecord } from "../../../src/tools/harness/record.ts"
import { person } from "../../company/helpers.ts"
import { startTime } from "../../../src/util/proc.ts"
import { isGone, tempDir, waitFor } from "../../helpers.ts"
import { type Claude, Heard, allGone, chatOf, label, makeClaude, reopened } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

const OWNER = "Hong Ngoc Bui (owner)"

/** Session `id` of `h`'s chat, started as its instrument, and what it heard. */
async function started(h: Claude, id = "01JA1H0000000000000000CA01") {
  const chat = await chatOf(h)
  const heard = new Heard()
  const session = await h.sessions.startInstrument(chat, id, { observer: heard, label, owner: "ngocbh" })
  return { chat, heard, session, id }
}

/** The user lines the fake read, in order. */
const users = (h: Claude) =>
  h.fake
    .log()
    .filter((e) => e.dir === "in" && e.msg?.type === "user")
    .map((e) => e.msg!)

/** The fake's starts, in order. */
const starts = (h: Claude) => h.fake.log().filter((e) => e.dir === "start")

const status = (h: Claude, id: string) => h.store.getSession(id)?.status

/** The interrupts the fake was sent. */
const interrupts = (h: Claude) =>
  h.fake
    .log()
    .filter((e) => e.dir === "in" && e.msg?.request?.subtype === "interrupt")
    .map((e) => e.msg!.request)

/** Whether the fake wrote `text` as Claude Code's words. */
const wrote = (h: Claude, text: string) =>
  h.fake.log().some((e) => e.dir === "out" && e.msg?.type === "assistant" && e.msg.message.content[0]?.text === text)

/** A process of the fake's, by its pid, with its start time while it runs. */
function processOf(pid: number) {
  const started = startTime(pid)
  return { pid, gone: () => isGone(pid, started) }
}

/** The fake's Claude Code processes, in the order they started, and the children its spawn steps left. */
const leaders = (h: Claude) => h.fake.log().filter((e) => e.dir === "start").map((e) => e.pid)
const children = (h: Claude) => h.fake.log().filter((e) => e.dir === "spawn").map((e) => e.pid)

test("a start is the chat's child session, under the employee's permission, told who its two speakers are", async () => {
  const h = makeClaude()
  const { chat, heard, session } = await started(h)
  expect(session).toMatchObject({ kind: "instrument", harness: "claude", instrument_of: chat.id, person: "minh" })
  expect(session.status).toBe("idle")
  expect(heard.states).toEqual(["idle"])
  const [start] = starts(h)
  expect(start!.flags!["session-id"]).toBe(session.harness_session_id)
  expect(start!.cwd).toBe(h.workspace)
  // The speakers' instructions, appended to Claude Code's own system prompt.
  expect(start!.appended).toContain("Two people write to you in this session")
  expect(start!.appended).toContain(OWNER)
  // The employee's permission: Claude Code's sandbox, its settings files off, and the session's own temp folder.
  expect(start!.flags!.settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true })
  expect(start!.flags!["setting-sources"]).toBe("")
  expect(start!.env!.TMPDIR).toBe(path.join(h.sessions.root(), session.id))
  // No MCP server is allowed: none loads, and no MCP folder is made.
  expect(start!.flags!["strict-mcp-config"]).toBe(true)
  expect(start!.flags!["mcp-config"]).toBeUndefined()
  expect(fs.existsSync(path.join(h.sessions.mcpRoot(), session.id))).toBe(false)
})

/** Commits minh's person file `file` to `h`'s company: its head moves on, the session's commit stays. */
async function commitPerson(h: Claude, file: Record<string, unknown>): Promise<void> {
  fs.writeFileSync(path.join(h.office.paths.company, "people/minh/person.yaml"), JSON.stringify(file))
  await h.office.git.commit(["people/minh/person.yaml"], "minh")
}

/** The owner's user-scope MCP servers, two holding a token, as `.claude.json` keeps them. */
const SERVERS = {
  github: { type: "stdio", command: "gh-mcp", args: [], env: { GITHUB_TOKEN: "ghp_decoy-token" } },
  docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer decoy-bearer" } },
}
const TOKENS = ["ghp_decoy-token", "decoy-bearer"]

test("an employee allowed an MCP server gets only its definition, in a 0600 file in the office's MCP folder of the session, never on the command line or in a log; it starts in that folder's empty folder, not theirs; its tools run, the file goes when Claude Code stops, the folder with the session", async () => {
  const home = tempDir()
  // The stand-in logs where it started and the names of the variables it got, never their values.
  const logs = fs.realpathSync(tempDir())
  const script = `pwd > ${logs}/pwd; env | cut -d= -f1 | sort > ${logs}/names`
  const github = { type: "stdio", command: "sh", args: ["-c", script], env: { GITHUB_TOKEN: "ghp_decoy-token" } }
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ numStartups: 2, mcpServers: { ...SERVERS, github } }))
  const policy = { sandbox: "workspace-write", network: false, mcp_servers: ["github", "linear"] }
  const minh = person("minh", { harnesses: ["composer", "claude"], harness_policy: policy })
  const call = { tool: "mcp__github__get_me", input: {}, result: "you are minh" }
  const h = makeClaude({
    home,
    files: { "people/minh/person.yaml": minh },
    idleMs: 300,
    script: { mcp_tools: { github: ["get_me"], docs: ["search"] }, turns: [[call, { say: "You are minh." }]] },
  })
  const { heard, id } = await started(h)
  const folder = path.join(h.office.paths.mcp, "claude", id)
  const file = path.join(folder, "opencorp.mcp.json")
  const [start] = starts(h)
  expect(Object.keys(start!.mcp![0]!.servers)).toEqual(["github"])
  expect(start!.mcp![0]!.path).toBe(file)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.statSync(folder).mode & 0o777).toBe(0o700)
  // Claude Code starts it in the session's folder; it moves to the office's empty folder first, its env as given.
  expect(start!.cwd).toBe(h.workspace)
  expect(fs.readFileSync(path.join(logs, "pwd"), "utf8").trim()).toBe(path.join(folder, "cwd"))
  const names = fs.readFileSync(path.join(logs, "names"), "utf8").split("\n")
  expect(names).toContain("GITHUB_TOKEN")
  // Claude Code passes its session's inbox socket and token down; the server never gets them.
  for (const name of ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_CHILD_NOTES_DIR"]) {
    expect(names, name).not.toContain(name)
  }
  expect(names).toContain("CLAUDE_PROJECT_DIR")
  expect(fs.readFileSync(path.join(logs, "names"), "utf8")).not.toContain("ghp_decoy-token")
  // Beside the session's temp folder, which its commands may read and write, and closed to them by name.
  expect(file.startsWith(start!.env!.TMPDIR + "/")).toBe(false)
  expect(start!.flags!.settings.sandbox.filesystem.denyRead).toContain(folder)
  expect(start!.flags!.settings.permissions.allow).toEqual(["mcp__github__*"])
  for (const token of TOKENS) expect(start!.argv!.join("\n"), token).not.toContain(token)

  await h.sessions.prompt(id, "Who am I?", { by: "minh" })
  await waitFor(() => heard.said().includes("You are minh.") && status(h, id) === "idle", { what: "the turn" })
  // The server's tool is the session's, not one beyond the allowlist, and it ran unasked.
  const blocks = h.fake.log().flatMap((e) => (e.dir === "out" && e.msg?.type === "user" ? [e.msg.message.content[0]] : []))
  expect(blocks.filter((b) => b?.type === "tool_result").map((b) => b.is_error ?? false)).toEqual([false])
  expect(h.lines).toEqual([
    `claude session ${id}: @minh's allowed MCP server linear isn't defined in your Claude Code config ` +
      `(${path.join(home, ".claude.json")}), or that file can't be read, so it doesn't load`,
  ])
  const proc = h.sessions.get(id)!.proc!
  await waitFor(() => !proc.alive, { what: "the idle stop" })
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.existsSync(folder)).toBe(true)
  await h.sessions.end(id)
  expect(fs.existsSync(folder)).toBe(false)
  const output = fs.readFileSync(path.join(h.office.paths.runDir(id), "claude.log"), "utf8")
  for (const token of TOKENS) {
    expect(output, token).not.toContain(token)
    expect(h.lines.join("\n"), token).not.toContain(token)
  }
})

test("each message goes inside its author's label as next, and a message mid-turn joins the turn", async () => {
  const h = makeClaude({ script: { turns: [[{ say: "Reading." }, { sleep: 1 }, { say: "Done, on staging." }]] } })
  const { heard, id } = await started(h)
  expect(await h.sessions.prompt(id, "Fix the build.", { by: "minh" })).toBe("turn")
  await waitFor(() => heard.said().includes("Reading."), { what: "Claude Code's first words" })
  expect(status(h, id)).toBe("busy")
  // The owner writes mid-turn, as the TUI sends it.
  expect(await h.sessions.prompt(id, "Use staging.", { by: "ngocbh" })).toBe("steer")
  await waitFor(() => status(h, id) === "idle", { what: "the turn's end" })
  const [first, second] = users(h)
  expect(first!.message.content[0].text).toBe('<authored_message author="@minh">\nFix the build.\n</authored_message>')
  expect(second!.message.content[0].text).toBe(`<authored_message author="${OWNER}">\nUse staging.\n</authored_message>`)
  expect([first!.priority, second!.priority]).toEqual(["next", "next"])
  expect(first!.client_composed).toBe(true)
  // One turn took both, in arrival order; the transcript holds each message as written, with its author.
  const result = h.fake.log().find((e) => e.dir === "out" && e.msg?.type === "result")!.msg!
  expect(result.user_message_uuids).toEqual([first!.uuid, second!.uuid])
  expect(heard.said()).toEqual(["Fix the build.", "Reading.", "Use staging.", "Done, on staging."])
  const authors = heard.events.flatMap((e) => (e.type === "message" && e.message.role === "user" ? [e.message.author] : []))
  expect(authors).toEqual(["minh", "ngocbh"])
  expect(heard.states).toEqual(["idle", "busy", "idle"])
  expect(h.events.some((e) => e.type === "message.updated" && e.session_id === id)).toBe(true)
  expect(h.store.getSession(id)!.harness_usage).not.toBeNull()
  expect(h.sessions.messages(id).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
})

test("Esc interrupts the running turn, which ends marked interrupted", async () => {
  const h = makeClaude({ script: { turns: [[{ say: "Working." }, { sleep: 30 }]] } })
  const { heard, id } = await started(h)
  await h.sessions.prompt(id, "Work.", { by: "minh" })
  await waitFor(() => heard.said().includes("Working."), { what: "Claude Code's words" })
  await h.sessions.interrupt(id)
  await waitFor(() => status(h, id) === "idle", { what: "the turn to stop" })
  expect(h.fake.log().some((e) => e.dir === "in" && e.msg?.request?.subtype === "interrupt")).toBe(true)
  expect(heard.said()).toContain("Working.\n\n[interrupted]")
})

test("an end stops a running turn and Claude Code, and the session ends with nothing left of it", async () => {
  const h = makeClaude({ script: { turns: [[{ say: "Working." }, { sleep: 30 }]] } })
  const { heard, id } = await started(h)
  await h.sessions.prompt(id, "Work.", { by: "minh" })
  await waitFor(() => heard.said().includes("Working."), { what: "Claude Code's words" })
  const proc = h.sessions.get(id)!.proc!
  await h.sessions.end(id)
  expect(status(h, id)).toBe("ended")
  expect(heard.states.at(-1)).toBe("ended")
  expect(proc.alive).toBe(false)
  expect(fs.existsSync(path.join(h.sessions.root(), id))).toBe(false)
  expect(h.sessions.get(id)).toBeUndefined()
  await expect(h.sessions.prompt(id, "More.", { by: "minh" })).rejects.toMatchObject({ status: 409 })
})

test("an idle session's Claude Code stops, and the next message resumes the same conversation", async () => {
  const h = makeClaude({ idleMs: 200, script: { turns: [[{ say: "First." }], [{ say: "Second." }]] } })
  const { heard, id, session } = await started(h)
  await h.sessions.prompt(id, "One.", { by: "minh" })
  await waitFor(() => heard.said().includes("First.") && status(h, id) === "idle", { what: "the first turn" })
  const first = h.sessions.get(id)!.proc!
  await waitFor(() => !first.alive, { what: "the idle stop" })
  expect(h.sessions.get(id)!.proc).toBeNull()
  expect(status(h, id)).toBe("idle")
  await h.sessions.prompt(id, "Two.", { by: "ngocbh" })
  await waitFor(() => heard.said().includes("Second."), { what: "the resumed turn" })
  const [, again] = starts(h)
  expect(again!.flags!.resume).toBe(session.harness_session_id)
  expect(again!.flags!["session-id"]).toBeUndefined()
  // Each start's own fresh temp folder held its instructions.
  expect(again!.appended).toContain("Two people write to you in this session")
})

test("Claude Code exiting on its own marks the turn interrupted, and the next message resumes it", async () => {
  const h = makeClaude({ script: { turns: [[{ say: "Halfway." }, { exit: 1 }], [{ say: "Back." }]] } })
  const { heard, id, session } = await started(h)
  await h.sessions.prompt(id, "Go.", { by: "minh" })
  await waitFor(() => heard.said().some((s) => s.includes("exited on its own")), { what: "the crash" })
  expect(heard.said()).toContain("Halfway.\n\n[interrupted]")
  await waitFor(() => status(h, id) === "idle", { what: "idle" })
  await h.sessions.prompt(id, "Again.", { by: "minh" })
  await waitFor(() => heard.said().includes("Back."), { what: "the resumed turn" })
  expect(starts(h)[1]!.flags!.resume).toBe(session.harness_session_id)
})

test("a start whose sandbox can't run fails the session and says what to fix", async () => {
  const h = makeClaude({ script: { sandbox_unavailable: true } })
  const chat = await chatOf(h)
  const heard = new Heard()
  const id = "01JA1H0000000000000000CA02"
  const error = await h.sessions.startInstrument(chat, id, { observer: heard, label, owner: "ngocbh" }).catch((e) => e)
  expect(error).toBeInstanceOf(HarnessError)
  expect(error.message).toContain("Claude Code's sandbox can't start on this machine")
  expect(error.message).toContain("install bubblewrap and socat")
  expect(status(h, id)).toBe("failed")
  // The instrument hears it from the start's refusal, not twice.
  expect(heard.states).toEqual([])
})

test("on Linux, an employee whose folder is read-only is refused Claude Code, saying why and what to use; on macOS it starts", async () => {
  const readOnly = {
    "people/minh/person.yaml": person("minh", {
      harnesses: ["composer", "claude"],
      harness_policy: { sandbox: "read-only", network: false },
    }),
  }
  const h = makeClaude({ files: readOnly, platform: "linux" })
  const chat = await chatOf(h)
  const id = "01JA1H0000000000000000CA04"
  const error = await h.sessions.startInstrument(chat, id, { observer: new Heard(), label, owner: "ngocbh" }).catch((e) => e)
  expect(error).toMatchObject({ status: 422, code: "start_failed" })
  expect(error.message).toContain("read-only")
  expect(error.message).toContain("workspace-write")
  expect(error.message).toContain("Codex")
  expect(status(h, id)).toBe("failed")
  expect(starts(h)).toEqual([])

  const mac = makeClaude({ files: readOnly, platform: "darwin" })
  const { session } = await started(mac)
  expect(session.status).toBe("idle")
})

test("an employee who doesn't use the claude harness is refused, and no session is made", async () => {
  const h = makeClaude({ files: { "people/minh/person.yaml": person("minh", { harnesses: ["composer", "codex"] }) } })
  const chat = await chatOf(h)
  const error = await h.sessions.startInstrument(chat, "01JA1H0000000000000000CA03", {
    observer: new Heard(), label, owner: "ngocbh",
  }).catch((e) => e)
  expect(error).toMatchObject({ status: 422, code: "unsupported_harness" })
  expect(error.message).toContain("adds claude to their person's harnesses")
  expect(h.store.listSessions({ kind: "instrument" })).toEqual([])
})

test("a session's cost cap, model and mode aren't Claude Code's to change, and it isn't continued", async () => {
  const h = makeClaude()
  const { id } = await started(h)
  await expect(h.sessions.notSupported(id)).rejects.toMatchObject({ status: 422, code: "not_supported" })
  await expect(h.sessions.continueSession(id)).rejects.toMatchObject({ status: 422, code: "not_continuable" })
})

test("an office stop ends every session, and a restart ends what a crash left live, its record interrupted", async () => {
  const h = makeClaude()
  const { id, chat, heard } = await started(h)
  await h.sessions.closeAll()
  expect(status(h, id)).toBe("ended")
  // Not told to its instrument, which keeps the session to continue after the restart.
  expect(heard.states).toEqual(["idle"])
  // A crash leaves one live, with its record running.
  const left = h.store.createSession({ ...h.store.getSession(id)!, id: "01JA1H0000000000000000CA04", status: "busy" })
  const dir = h.sessions.recordDir(chat.id, left.id)
  new HarnessRecord(CLAUDE, dir, { id: left.id, name: "claude 2", driver: "minh", chat: chat.id, started: left.created_at })
  fs.mkdirSync(path.join(h.sessions.root(), left.id))
  fs.mkdirSync(path.join(h.sessions.root(), `${left.id}.bin`))
  fs.mkdirSync(path.join(h.sessions.mcpRoot(), left.id, "cwd"), { recursive: true })
  fs.writeFileSync(path.join(h.sessions.mcpRoot(), left.id, "opencorp.mcp.json"), "{}")
  // Another office's, or one that isn't a session's, stays.
  fs.mkdirSync(path.join(h.sessions.mcpRoot(), "not-a-session"))
  // The next start's sessions.
  const restarted = new ClaudeSessions(h.office, { claude: h.fake.claude, environ: {}, tmpBase: h.tmpBase, log: () => {} })
  await restarted.restore()
  expect(status(h, left.id)).toBe("ended")
  expect(readClaudeRecord(dir)!.state).toBe("interrupted")
  expect(fs.existsSync(path.join(h.sessions.root(), left.id))).toBe(false)
  expect(fs.existsSync(path.join(h.sessions.root(), `${left.id}.bin`))).toBe(false)
  expect(fs.existsSync(path.join(h.sessions.mcpRoot(), left.id))).toBe(false)
  expect(fs.existsSync(path.join(h.sessions.mcpRoot(), "not-a-session"))).toBe(true)
})

test("a server revoked at head no longer loads when the session resumes, though its commit allowed it", async () => {
  const home = tempDir()
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: SERVERS }))
  const policy = (mcp_servers: string[]) => ({ sandbox: "workspace-write", network: false, mcp_servers })
  const file = (mcp_servers: string[]) =>
    person("minh", { harnesses: ["composer", "claude"], harness_policy: policy(mcp_servers) })
  const h = makeClaude({
    home,
    files: { "people/minh/person.yaml": file(["github", "docs"]) },
    idleMs: 200,
    script: { turns: [[{ say: "One." }], [{ say: "Two." }]] },
  })
  const { heard, id } = await started(h)
  expect(Object.keys(starts(h)[0]!.mcp![0]!.servers)).toEqual(["github", "docs"])
  await h.sessions.prompt(id, "One.", { by: "minh" })
  await waitFor(() => heard.said().includes("One.") && status(h, id) === "idle", { what: "the first turn" })
  const first = h.sessions.get(id)!.proc!
  await waitFor(() => !first.alive, { what: "the idle stop" })
  // The owner revokes docs; the session's commit still allows it.
  await commitPerson(h, file(["github"]))
  await h.sessions.prompt(id, "Two.", { by: "minh" })
  await waitFor(() => heard.said().includes("Two."), { what: "the resumed turn" })
  const resumed = starts(h)[1]!
  expect(resumed.flags!.resume).toBeDefined()
  expect(Object.keys(resumed.mcp![0]!.servers)).toEqual(["github"])
  expect(resumed.flags!.settings.permissions.allow).toEqual(["mcp__github__*"])
})

test("Esc right after a send interrupts the turn before it runs, cancelling the message", async () => {
  const h = makeClaude({ script: { turns: [[{ sleep: 1 }, { say: "Ran anyway." }]] } })
  const { heard, id } = await started(h)
  await h.sessions.prompt(id, "Go.", { by: "minh" })
  await h.sessions.interrupt(id)
  await waitFor(() => status(h, id) === "idle", { what: "the session idle" })
  expect(interrupts(h)).toEqual([{ subtype: "interrupt", cancel_queued: true }])
  await Bun.sleep(1500)
  expect(wrote(h, "Ran anyway.")).toBe(false)
  expect(heard.said().at(-1)).toContain("[interrupted]")
})

test("Esc with a message waiting mid-turn stops the turn and cancels the message, which never runs", async () => {
  const script = { turns: [[{ say: "First." }, { sleep: 2 }, { say: "First done." }], [{ say: "Second turn ran." }]] }
  const h = makeClaude({ script })
  const { heard, id } = await started(h)
  await h.sessions.prompt(id, "One.", { by: "minh" })
  await waitFor(() => heard.said().includes("First."), { what: "Claude Code's first words" })
  await h.sessions.prompt(id, "Two.", { by: "ngocbh" })
  const two = users(h).at(-1)!.uuid
  await waitFor(() => h.fake.log().some((e) => e.msg?.type === "command_lifecycle" && e.msg.command_uuid === two), {
    what: "the second message queued",
  })
  await h.sessions.interrupt(id)
  await waitFor(() => status(h, id) === "idle", { what: "the session idle" })
  await Bun.sleep(2500)
  expect(wrote(h, "Second turn ran.")).toBe(false)
  expect(wrote(h, "First done.")).toBe(false)
  expect(interrupts(h)).toEqual([{ subtype: "interrupt", cancel_queued: true }])
  expect(status(h, id)).toBe("idle")
})

test("Esc while Claude Code resumes drops the message that waits for it, unsent", async () => {
  const h = makeClaude({ idleMs: 200, script: { slow_start: 0.5, turns: [[{ say: "First." }], [{ say: "Never." }]] } })
  const { heard, id } = await started(h)
  await h.sessions.prompt(id, "One.", { by: "minh" })
  await waitFor(() => heard.said().includes("First.") && status(h, id) === "idle", { what: "the first turn" })
  await waitFor(() => h.sessions.get(id)!.proc === null, { what: "the idle stop" })
  const sending = h.sessions.prompt(id, "Two.", { by: "ngocbh" })
  await h.sessions.interrupt(id)
  await sending
  await waitFor(() => status(h, id) === "idle" && h.sessions.get(id)!.proc !== null, { what: "the resumed start" })
  expect(users(h).map((m) => m.message.content[0].text)).toHaveLength(1)
  expect(heard.said().slice(-2)).toEqual(["Two.", "[interrupted]"])
  await Bun.sleep(300)
  expect(wrote(h, "Never.")).toBe(false)
})

test("Claude Code exiting on its own has its group killed, so nothing it started outlives it, or the session's end", async () => {
  const h = makeClaude({ script: { turns: [[{ spawn: 60 }, { exit: 1 }]] } })
  const { heard, id } = await started(h)
  await h.sessions.prompt(id, "Go.", { by: "minh" })
  const child = processOf(await waitFor(() => children(h)[0], { what: "the spawned child" }))
  await waitFor(() => heard.said().some((s) => s.includes("exited on its own")), { what: "the crash" })
  await waitFor(child.gone, { timeout: 10_000, what: "the group's kill" })
  await h.sessions.end(id)
  expect(status(h, id)).toBe("ended")
})

test("an end during an idle stop waits for that Claude Code and its group to go", async () => {
  // Background work keeps it open past its stdin's end, so the idle stop's close waits.
  const h = makeClaude({ idleMs: 200, script: { background: 5, turns: [[{ spawn: 60 }, { say: "Done." }]] } })
  const { heard, id } = await started(h)
  const leader = processOf(leaders(h)[0]!)
  await h.sessions.prompt(id, "Go.", { by: "minh" })
  const child = processOf(await waitFor(() => children(h)[0], { what: "the spawned child" }))
  await waitFor(() => heard.said().includes("Done.") && status(h, id) === "idle", { what: "the turn" })
  await waitFor(() => h.sessions.get(id)!.proc === null, { timeout: 5000, what: "the idle stop" })
  await h.sessions.end(id)
  expect(status(h, id)).toBe("ended")
  expect([leader.gone(), child.gone()]).toEqual([true, true])
})

test("an end during a start stops that Claude Code and ends the session, not fails it", async () => {
  const h = makeClaude({ script: { slow_start: 3 } })
  const chat = await chatOf(h)
  const id = "01JA1H0000000000000000CA05"
  const starting = h.sessions.startInstrument(chat, id, { observer: new Heard(), label, owner: "ngocbh" }).catch((e) => e)
  const leader = processOf(await waitFor(() => leaders(h)[0], { what: "the start" }))
  await waitFor(() => h.sessions.get(id) !== undefined, { what: "the live session" })
  await h.sessions.end(id)
  expect(status(h, id)).toBe("ended")
  expect(leader.gone()).toBe(true)
  expect(await starting).toMatchObject({ status: 409 })
})

test("an end while Claude Code resumes for a message stops that start and ends the session, not fails it", async () => {
  const h = makeClaude({ idleMs: 200, script: { turns: [[{ say: "First." }], [{ say: "Never." }]] } })
  const { heard, id } = await started(h)
  await h.sessions.prompt(id, "One.", { by: "minh" })
  await waitFor(() => heard.said().includes("First.") && status(h, id) === "idle", { what: "the first turn" })
  await waitFor(() => h.sessions.get(id)!.proc === null, { what: "the idle stop" })
  h.fake.set({ version: "2.1.325", slow_start: 3, turns: [[{ say: "First." }], [{ say: "Never." }]] })
  const sending = h.sessions.prompt(id, "Two.", { by: "ngocbh" }).catch((e) => e)
  const resumed = processOf(await waitFor(() => leaders(h)[1], { what: "the resume" }))
  await h.sessions.end(id)
  expect(status(h, id)).toBe("ended")
  expect(heard.states.at(-1)).toBe("ended")
  expect(resumed.gone()).toBe(true)
  expect(await sending).toMatchObject({ status: 409 })
  expect(wrote(h, "Never.")).toBe(false)
})

test("a Claude Code whose first turn lists a tool outside the office's allowlist is stopped before it acts, and the session fails saying why", async () => {
  const h = makeClaude()
  // The model's first call takes a moment, as a real one does: the stop comes before it.
  h.fake.set({ tools_added: ["RemoteTrigger"], turns: [[{ sleep: 2 }, { tool: "Bash", input: { command: "touch acted" } }]] })
  const { heard, id } = await started(h)
  const [leader] = leaders(h)
  // Killed at once, with no SIGTERM and wait first.
  const kills = spyOn(ClaudeProcess.prototype, "kill")
  onTestFinished(() => kills.mockRestore())
  await h.sessions.prompt(id, "Go.", { by: "minh" }).catch(() => {})
  await waitFor(() => kills.mock.calls.length > 0, { what: "the kill" })
  expect(kills.mock.calls[0]).toEqual([{ now: true }])
  await waitFor(() => status(h, id) === "failed", { what: "the session to fail" })
  expect(processOf(leader!).gone()).toBe(true)
  expect(fs.existsSync(path.join(h.workspace, "acted"))).toBe(false)
  expect(heard.states.at(-1)).toBe("failed")
  const errors = heard.events.flatMap((e) =>
    e.type === "message" ? e.message.parts.flatMap((p) => (p.type === "error" ? [p.message] : [])) : [],
  )
  expect(errors.at(-1)).toContain("RemoteTrigger")
  expect(errors.at(-1)).toContain("act on your account or outside your employee's permission")
})

test("on Linux, the office's own socat, linked alone into a private folder first on the harness PATH, with the folders it loads from read, is what Claude Code's sandbox finds; with none, the start is refused saying how to fix it", async () => {
  // A stand-in for socat installed as conda-forge lays one out: <prefix>/bin/socat -> socat1, loading $ORIGIN/../lib.
  // In the owner's home, as conda-forge installs one for the user.
  const home = tempDir()
  const prefix = path.join(home, ".local/opt/socat")
  const [bin, lib] = [path.join(prefix, "bin"), path.join(prefix, "lib")]
  for (const dir of [bin, lib]) fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(bin, "socat1"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "other-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  fs.symlinkSync("socat1", path.join(bin, "socat"))
  fs.writeFileSync(path.join(lib, "libssl.so.3"), "", { mode: 0o644 })
  const libraries = () => [path.join(bin, "../lib/libssl.so.3")]
  const h = makeClaude({
    home,
    script: { needs_socat: true },
    socat: path.join(bin, "socat"),
    socatLibraries: libraries,
    platform: "linux",
  })
  const { id } = await started(h)
  const env = starts(h)[0]!.env as Record<string, string>
  const [first, ...rest] = env.PATH!.split(":")
  expect(first).toBe(path.join(h.sessions.root(), `${id}.bin`))
  expect(rest).not.toContain(bin)
  expect(fs.readdirSync(first!)).toEqual(["socat"])
  expect(fs.readlinkSync(path.join(first!, "socat"))).toBe(fs.realpathSync(path.join(bin, "socat1")))
  // Claude Code's sandbox reads the link's folder, socat's own and its libraries', and writes none of them.
  const sandbox = (starts(h)[0]!.flags!.settings as Record<string, any>).sandbox.filesystem
  const real = (dir: string) => fs.realpathSync(dir)
  for (const dir of [first!, real(bin), real(lib)]) expect(sandbox.allowRead).toContain(dir)
  expect(sandbox.allowRead).not.toContain(real(prefix))
  for (const dir of [first!, real(bin), real(lib)]) expect(sandbox.allowWrite).not.toContain(dir)
  await h.sessions.end(id)
  await waitFor(() => !fs.existsSync(first!), { what: "the folder to go with the session" })

  const none = makeClaude({ script: { needs_socat: true }, socat: null, platform: "linux" })
  const chat = await chatOf(none)
  const error = await none.sessions
    .startInstrument(chat, "01JA1H0000000000000000CA05", { observer: new Heard(), label, owner: "ngocbh" })
    .catch((e) => e)
  expect(error).toMatchObject({ status: 422, code: "start_failed" })
  expect(error.message).toContain("socat")
  expect(error.message).toContain("OPENCORP_SOCAT_BIN")
  expect(starts(none)).toEqual([])
  // On macOS, Claude Code's sandbox needs none.
  const mac = makeClaude({ platform: "darwin" })
  expect((await started(mac)).session.status).toBe("idle")
})

test("a socat others could change isn't run for Claude Code", async () => {
  const dir = tempDir()
  fs.chmodSync(dir, 0o777)
  const socat = path.join(dir, "socat")
  fs.writeFileSync(socat, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const h = makeClaude({ script: { needs_socat: true }, socat, platform: "linux" })
  const chat = await chatOf(h)
  const error = await h.sessions
    .startInstrument(chat, "01JA1H0000000000000000CA06", { observer: new Heard(), label, owner: "ngocbh" })
    .catch((e) => e)
  expect(error).toMatchObject({ status: 422, code: "start_failed" })
  expect(error.message).toContain("socat")
  expect(error.message).toContain("others than the user may write")
  expect(starts(h)).toEqual([])
})

test("a socat that doesn't run is refused before Claude Code starts, saying so", async () => {
  const home = tempDir()
  const dir = path.join(home, ".local/bin")
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const socat = path.join(dir, "socat")
  fs.writeFileSync(socat, "#!/bin/sh\necho 'error while loading shared libraries: libssl.so.3' >&2\nexit 127\n", { mode: 0o755 })
  const h = makeClaude({ home, script: { needs_socat: true }, socat, platform: "linux" })
  const chat = await chatOf(h)
  const error = await h.sessions
    .startInstrument(chat, "01JA1H0000000000000000CA07", { observer: new Heard(), label, owner: "ngocbh" })
    .catch((e) => e)
  expect(error).toMatchObject({ status: 422, code: "start_failed" })
  expect(error.message).toContain("doesn't run")
  expect(error.message).toContain("libssl.so.3")
  expect(starts(h)).toEqual([])
})

test("after a restart, the chat's instrument continues its session with --resume, by the start's path", async () => {
  const h = makeClaude({ script: { turns: [[{ say: "First." }], [{ say: "Second." }]] } })
  const { chat, heard, id, session } = await started(h)
  await h.sessions.prompt(id, "One.", { by: "minh" })
  await waitFor(() => heard.said().includes("First.") && status(h, id) === "idle", { what: "the first turn" })
  await h.sessions.closeAll()
  const r = reopened(h)
  await r.sessions.restore()
  // What the first office counted of its turns.
  const counted = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 }
  r.store.updateSession(id, { harness_usage: counted })
  const again = new Heard()
  const resumed = await r.sessions.resumeInstrument(chat, id, session.harness_session_id!, { observer: again, label, owner: "ngocbh" })
  expect(resumed).toMatchObject({ id, status: "idle", instrument_of: chat.id })
  await r.sessions.prompt(id, "Two.", { by: "minh" })
  await waitFor(() => again.said().includes("Second."), { what: "the resumed turn" })
  const [, start] = starts(h)
  expect(start!.flags!.resume).toBe(session.harness_session_id)
  expect(start!.flags!["session-id"]).toBeUndefined()
  expect(start!.appended).toContain("Two people write to you in this session")
  // Its token counts go on from the first office's (the fake counts none of its own).
  await waitFor(() => status(r, id) === "idle", { what: "the turn's end" })
  expect(r.store.getSession(id)!.harness_usage).toEqual(counted)
})

test("a continue is refused for a session that isn't the chat's, for one live here, and once the chat ended", async () => {
  const h = makeClaude()
  const { chat, id, session } = await started(h)
  const claudeId = session.harness_session_id!
  const resume = (c: Claude, row = chat, sid = claudeId) =>
    c.sessions.resumeInstrument(row, id, sid, { observer: new Heard(), label, owner: "ngocbh" })
  await expect(resume(h)).rejects.toMatchObject({ status: 409, code: "live" })
  await h.sessions.closeAll()
  const r = reopened(h)
  await r.sessions.restore()
  await expect(resume(r, chat, "01JA1H0000000000000000OTHR")).rejects.toMatchObject({ status: 409, code: "not_resumable" })
  expect(r.lines.some((l) => l.includes(id) && l.includes("doesn't match"))).toBe(true)
  r.store.updateSession(chat.id, { status: "ended" })
  await expect(resume(r)).rejects.toMatchObject({ status: 409, code: "not_live" })
  expect(starts(h)).toHaveLength(1)
  expect(status(r, id)).toBe("ended")
})

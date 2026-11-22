/** The office's Claude Code sessions, each an employee chat's instrument and its child session, on the fake Claude
 *  Code: a start under the employee's permission with the speakers' instructions, both speakers' messages labelled and
 *  sent as `next`, Esc, the end, the idle stop and the resume, a crash, a start that can't, and an office restart. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { ClaudeSessions } from "../../../src/features/claude/sessions.ts"
import { HarnessError } from "../../../src/runtime/sessions/state.ts"
import { CLAUDE, readClaudeRecord } from "../../../src/tools/claude/instrument.ts"
import { HarnessRecord } from "../../../src/tools/harness/record.ts"
import { person } from "../../company/helpers.ts"
import { startTime } from "../../../src/util/proc.ts"
import { isGone, tempDir, waitFor } from "../../helpers.ts"
import { type Claude, Heard, allGone, chatOf, label, makeClaude } from "./helpers.ts"

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
  const { id, chat } = await started(h)
  await h.sessions.closeAll()
  expect(status(h, id)).toBe("ended")
  // A crash leaves one live, with its record running.
  const left = h.store.createSession({ ...h.store.getSession(id)!, id: "01JA1H0000000000000000CA04", status: "busy" })
  const dir = h.sessions.recordDir(chat.id, left.id)
  new HarnessRecord(CLAUDE, dir, { id: left.id, name: "claude 2", driver: "minh", chat: chat.id, started: left.created_at })
  fs.mkdirSync(path.join(h.sessions.root(), left.id))
  fs.mkdirSync(path.join(h.sessions.root(), `${left.id}.bin`))
  // The next start's sessions.
  const restarted = new ClaudeSessions(h.office, { claude: h.fake.claude, environ: {}, tmpBase: h.tmpBase, log: () => {} })
  await restarted.restore()
  expect(status(h, left.id)).toBe("ended")
  expect(readClaudeRecord(dir)!.state).toBe("interrupted")
  expect(fs.existsSync(path.join(h.sessions.root(), left.id))).toBe(false)
  expect(fs.existsSync(path.join(h.sessions.root(), `${left.id}.bin`))).toBe(false)
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
  await h.sessions.prompt(id, "Go.", { by: "minh" }).catch(() => {})
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

test("on Linux, the office's own socat, copied alone into a private folder first on the harness PATH, is what Claude Code's sandbox finds; with none, the start is refused saying how to fix it", async () => {
  // A stand-in for socat, only the user's to change.
  const dir = tempDir()
  const socat = path.join(dir, "socat")
  fs.writeFileSync(socat, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  fs.writeFileSync(path.join(dir, "other-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const h = makeClaude({ script: { needs_socat: true }, socat, platform: "linux" })
  const { id } = await started(h)
  const env = starts(h)[0]!.env as Record<string, string>
  const [first, ...rest] = env.PATH!.split(":")
  expect(first).toBe(path.join(h.sessions.root(), `${id}.bin`))
  expect(rest).not.toContain(dir)
  expect(fs.readdirSync(first!)).toEqual(["socat"])
  const copy = fs.lstatSync(path.join(first!, "socat"))
  expect([copy.isFile(), copy.mode & 0o777]).toEqual([true, 0o500])
  expect(fs.readFileSync(path.join(first!, "socat"), "utf8")).toBe(fs.readFileSync(socat, "utf8"))
  // Claude Code's sandbox reads it, and writes nothing there.
  const sandbox = (starts(h)[0]!.flags!.settings as Record<string, any>).sandbox.filesystem
  expect(sandbox.allowRead).toContain(first)
  expect(sandbox.allowWrite).not.toContain(first)
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

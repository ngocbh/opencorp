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
import { waitFor } from "../../helpers.ts"
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
  // The next start's sessions.
  const restarted = new ClaudeSessions(h.office, { claude: h.fake.claude, environ: {}, tmpBase: h.tmpBase, log: () => {} })
  await restarted.restore()
  expect(status(h, left.id)).toBe("ended")
  expect(readClaudeRecord(dir)!.state).toBe("interrupted")
  expect(fs.existsSync(path.join(h.sessions.root(), left.id))).toBe(false)
})

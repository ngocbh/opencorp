/** A Codex session an employee's chat drives as its instrument: the chat's child session, under the employee's
 *  permission, with two speakers labelled for Codex, its events and states told to the instrument, ended by an office
 *  restart, and continued on its thread by the chat's next instrument; on the fake app-server. */
import fs from "node:fs"
import path from "node:path"
import { authoredText } from "@ngocbh/yian"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { instructions, speakers } from "../../../src/runtime/sessions/speakers.ts"
import { loadRepo } from "../../../src/company/loader.ts"
import type { HarnessEvent } from "../../../src/tools/harness/adapter.ts"
import type { ThreadEvents, ThreadState } from "../../../src/tools/codex/instrument.ts"
import { CodexRecord, readCodexRecord } from "../../../src/tools/codex/record.ts"
import { newId } from "../../../src/util/ids.ts"
import * as fc from "../../../src/testing/fake_codex.ts"
import { person } from "../../company/helpers.ts"
import { session as sessionRow } from "../../runtime/store/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { type Codex, allGone, makeCodex, reopened, requestsValid, restarted, status } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** What an instrument hears of its session. */
function observer(): ThreadEvents & { events: HarnessEvent[]; states: ThreadState[] } {
  const events: HarnessEvent[] = []
  const states: ThreadState[] = []
  return { events, states, event: (e) => void events.push(e), state: (s) => void states.push(s) }
}

/** minh's main chat in `h.workspace`, opened by ngocbh, at the company's head. */
async function chat(h: Codex) {
  const head = await h.office.git.head()
  return h.store.createSession(
    sessionRow({ cwd: fs.realpathSync(h.workspace), repo_commit: head, opened_by: "ngocbh", connection: "office" }),
  )
}

/** Starts `chat`'s instrument session, its labels and instructions as the chat binds them. */
async function instrument(h: Codex, row: Awaited<ReturnType<typeof chat>>, heard = observer()) {
  const repo = loadRepo(await h.office.git.pin(row.repo_commit))
  const said = speakers(repo, row)
  const id = newId()
  const child = await h.sessions.startInstrument(row, id, { observer: heard, label: said.label, owner: said.owner })
  return { child, heard, said }
}

test("an instrument session is its chat's child, under the employee's permission, with no work item of its own", async () => {
  const h = makeCodex()
  const row = await chat(h)
  const { child, heard } = await instrument(h, row)
  expect(child).toMatchObject({
    person: "minh", harness: "codex", kind: "instrument", instrument_of: row.id, cwd: row.cwd,
    repo_commit: row.repo_commit, opened_by: "ngocbh", work_item_id: null,
  })
  await waitFor(() => heard.states.includes("idle"), { what: "the thread to load" })
  const [load] = h.fake.calls("thread/start") as Record<string, any>[]
  expect(load).toMatchObject({ approvalPolicy: "never", permissions: `opencorp-${child.id}`, cwd: row.cwd })
  expect(load!.developerInstructions).toContain("@minh")
  expect(load!.developerInstructions).toContain("Hong Ngoc Bui (owner)")
  expect(load!.developerInstructions).toContain("the owner's word wins")
  requestsValid(h.fake)
})

test("Codex reads each message with its author, and the instrument hears both speakers and each state", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("a1", "On it."), fc.agentMessage("a2", "Done that too.")])
  const row = await chat(h)
  const { child, heard } = await instrument(h, row)
  await waitFor(() => heard.states.includes("idle"), { what: "the thread to load" })
  await h.sessions.prompt(child.id, "Fix the build.", { by: "minh" })
  await waitFor(() => heard.states.at(-1) === "idle" && heard.states.includes("busy"), { what: "the first turn" })
  await h.sessions.prompt(child.id, "Also bump the version.", { by: "ngocbh" })
  await waitFor(() => h.fake.calls("turn/start").length === 2 && heard.states.at(-1) === "idle", { what: "the second" })
  const inputs = (h.fake.calls("turn/start") as Record<string, any>[]).map((p) => p.input[0].text)
  expect(inputs).toEqual([
    authoredText("@minh", "Fix the build."),
    authoredText("Hong Ngoc Bui (owner)", "Also bump the version."),
  ])
  // The instrument hears each message as it was said, with its author, never the wrapper.
  const users = heard.events.flatMap((e) => (e.type === "message" && e.message.role === "user" ? [e.message] : []))
  expect(users.map((m) => [m.author, m.parts[0]])).toEqual([
    ["minh", expect.objectContaining({ text: "Fix the build." })],
    ["ngocbh", expect.objectContaining({ text: "Also bump the version." })],
  ])
  expect(heard.states).toContain("busy")
  await h.sessions.end(child.id)
  await waitFor(() => heard.states.at(-1) === "ended", { what: "the end" })
  expect(status(h, child.id)).toBe("ended")
})

test("labels name the employee by handle and the approver as the owner, by name", async () => {
  const h = makeCodex()
  const row = await chat(h)
  const repo = loadRepo(await h.office.git.pin(row.repo_commit))
  const said = speakers(repo, row)
  expect(said.owner).toBe("ngocbh")
  expect([said.label("minh"), said.label("ngocbh"), said.label(null), said.label("lan")]).toEqual([
    "@minh", `${repo.people.get("ngocbh")!.name} (owner)`, `${repo.people.get("ngocbh")!.name} (owner)`, "@lan",
  ])
  const text = instructions(said.label, "minh", said.owner)
  expect(text).toContain("@minh")
  expect(text).toContain("text, not a message")
})

test("a person who doesn't use the codex harness gets no instrument session", async () => {
  const h = makeCodex({ files: { "people/minh/person.yaml": person("minh", { tools: ["yian"] }) } })
  const row = await chat(h)
  const repo = loadRepo(await h.office.git.pin(row.repo_commit))
  const said = speakers(repo, row)
  const refused = h.sessions.startInstrument(row, newId(), { observer: observer(), label: said.label, owner: said.owner })
  await expect(refused).rejects.toThrow("codex harness")
  expect(h.store.listSessions({ kind: "instrument" })).toEqual([])
})

test("an office restart ends a chat's instrument session and marks its record interrupted", async () => {
  const h = makeCodex()
  const row = await chat(h)
  const { child, heard } = await instrument(h, row)
  await waitFor(() => heard.states.includes("idle"), { what: "the thread to load" })
  const dir = path.join(h.office.paths.sessionDir(row.id), "codex", child.id)
  new CodexRecord(dir, { id: child.id, name: "codex 1", driver: "minh", chat: row.id, started: child.created_at })
  await restarted(h)
  await waitFor(() => status(h, child.id) === "ended", { what: "the restored instrument to end" })
  expect(readCodexRecord(dir)!.state).toBe("interrupted")
})

test("an ended instrument session can't be continued: only its employee starts another", async () => {
  const h = makeCodex()
  const row = await chat(h)
  const { child, heard } = await instrument(h, row)
  await waitFor(() => heard.states.includes("idle"), { what: "the thread to load" })
  await h.sessions.end(child.id)
  await waitFor(() => status(h, child.id) === "ended", { what: "the end" })
  await expect(h.sessions.continueSession(child.id, { by: "ngocbh" })).rejects.toThrow("employee's instrument")
})

/** Continues `child`, `row`'s instrument session, on thread `thread` in `h`'s sessions, as the chat's next instrument
 *  does after a restart. */
async function resume(h: Codex, row: Awaited<ReturnType<typeof chat>>, id: string, thread = "thr_1", heard = observer()) {
  const repo = loadRepo(await h.office.git.pin(row.repo_commit))
  const said = speakers(repo, row)
  const session = await h.sessions.resumeInstrument(row, id, thread, { observer: heard, label: said.label, owner: said.owner })
  return { session, heard }
}

test("after a restart, the chat's instrument continues its session on its thread: the same child session, live again", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("a1", "On it."), fc.agentMessage("a2", "Back on it.")])
  const row = await chat(h)
  const { child, heard } = await instrument(h, row)
  await waitFor(() => heard.states.includes("idle"), { what: "the thread to load" })
  await h.sessions.prompt(child.id, "Fix the build.", { by: "minh" })
  await waitFor(() => heard.states.at(-1) === "idle" && h.fake.calls("turn/start").length === 1, { what: "the turn" })
  const r = await restarted(h)
  expect(status(r, child.id)).toBe("ended")
  const { session, heard: again } = await resume(r, row, child.id)
  expect(session).toMatchObject({ id: child.id, status: "starting", instrument_of: row.id, harness_session_id: "thr_1" })
  await r.sessions.prompt(child.id, "And the tests.", { by: "minh" })
  await waitFor(() => again.states.at(-1) === "idle" && r.fake.calls("turn/start").length === 2, { what: "the turn" })
  const [load] = r.fake.calls("thread/resume") as Record<string, any>[]
  expect(load).toMatchObject({ threadId: "thr_1", approvalPolicy: "never", permissions: `opencorp-${child.id}`, cwd: row.cwd })
  expect(load!.developerInstructions).toContain("the owner's word wins")
  expect(status(r, child.id)).toBe("idle")
  requestsValid(r.fake)
})

test("a session the chat continues before the restore reaches it is left live by the restore", async () => {
  const h = makeCodex()
  const row = await chat(h)
  const { child, heard } = await instrument(h, row)
  await waitFor(() => heard.states.includes("idle"), { what: "the thread to load" })
  await h.sessions.closeAll()
  const r = reopened(h)
  await resume(r, row, child.id)
  await r.sessions.restore()
  await waitFor(() => status(r, child.id) === "idle", { what: "the resumed thread" })
  expect(r.sessions.get(child.id)).toBeDefined()
})

test("a continue is refused for a session that isn't the chat's on that thread, for one live here, and once the chat ended", async () => {
  const h = makeCodex()
  const row = await chat(h)
  const { child, heard } = await instrument(h, row)
  await waitFor(() => heard.states.includes("idle"), { what: "the thread to load" })
  await expect(resume(h, row, child.id)).rejects.toMatchObject({ status: 409, code: "live" })
  const r = await restarted(h)
  await expect(resume(r, row, child.id, "thr_other")).rejects.toMatchObject({ status: 409, code: "not_resumable" })
  expect(r.lines.some((l) => l.includes(child.id) && l.includes("doesn't match"))).toBe(true)
  const other = await chat(r)
  await expect(resume(r, other, child.id)).rejects.toMatchObject({ code: "not_resumable" })
  r.store.updateSession(row.id, { status: "ended" })
  await expect(resume(r, row, child.id)).rejects.toMatchObject({ status: 409, code: "not_live" })
  expect(r.fake.calls("thread/resume")).toEqual([])
  expect(status(r, child.id)).toBe("ended")
})

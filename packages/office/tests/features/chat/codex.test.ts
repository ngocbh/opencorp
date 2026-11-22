/** A main chat's Codex instrument: the employee drives Codex sessions, each the chat's child session under the
 *  employee's permission, listed as the chat's instrument with its record in the chat's `codex/` folder, and the
 *  owner's messages to Codex reach the employee's next reply; after an office restart, a session goes on from its
 *  record and its thread; on the fake app-server. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { EmployeeCodex } from "../../../src/features/chat/codex.ts"
import { speakers } from "../../../src/runtime/sessions/speakers.ts"
import { loadRepo } from "../../../src/company/loader.ts"
import { readCodexRecord } from "../../../src/tools/codex/record.ts"
import * as fc from "../../../src/testing/fake_codex.ts"
import { person } from "../../company/helpers.ts"
import { session as sessionRow } from "../../runtime/store/helpers.ts"
import type { SessionRecord } from "../../../src/runtime/store/store.ts"
import { sameProcess, startTime } from "../../../src/util/proc.ts"
import { isGone, waitFor } from "../../helpers.ts"
import { fakeLlm, makeHarness, PRICES } from "./helpers.ts"
import { type Codex, allGone, makeCodex, reopened, status } from "../codex/helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** minh's main chat in `h.workspace`, opened by ngocbh, and its Codex instrument. */
async function employee(h: Codex) {
  const head = await h.office.git.head()
  const chat = h.store.createSession(
    sessionRow({ cwd: fs.realpathSync(h.workspace), repo_commit: head, opened_by: "ngocbh", connection: "office" }),
  )
  return { chat, ...(await instrumentOf(h, chat)) }
}

/** `chat`'s Codex instrument on `h`'s sessions, and a call of its tools. */
async function instrumentOf(h: Codex, chat: SessionRecord) {
  const repo = loadRepo(await h.office.git.pin(chat.repo_commit))
  const codex = new EmployeeCodex({
    chat,
    sessions: h.sessions,
    folder: h.office.paths.sessionDir(chat.id),
    instruments: h.office.instruments,
    speakers: speakers(repo, chat),
  })
  const tools = codex.tools()
  const call = async (name: keyof typeof tools, args: Record<string, unknown>) =>
    JSON.parse(String(await tools[name].call(args))) as Record<string, any>
  return { codex, call }
}

/** The office's stop and its next start, as the daemon runs them: the Codex sessions stop, then the chat's instrument
 *  keeps them; the next office's sessions restore theirs, and the chat's new instrument takes its calls. */
async function restart(h: Codex, codex: EmployeeCodex, chat: SessionRecord) {
  await h.sessions.closeAll()
  await codex.suspend()
  const r = reopened(h)
  await r.sessions.restore()
  return { r, ...(await instrumentOf(r, chat)) }
}

/** The Codex session's id, its record's folder, and the record's conversation log. */
function recordOf(h: Codex, chat: SessionRecord) {
  const id = h.store.listSessions({ kind: "instrument" }).find((s) => s.instrument_of === chat.id)!.id
  const dir = path.join(h.office.paths.sessionDir(chat.id), "codex", id)
  return { id, dir, conversation: () => fs.readFileSync(path.join(dir, "conversation.log"), "utf8") }
}

test("the employee starts Codex as the chat's instrument, a child session, and reads its answer", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("a1", "The build is fixed.")])
  const { chat, call } = await employee(h)
  const reply = await call("start", { message: "Fix the build." })
  expect(reply).toMatchObject({ codex: "codex 1", status: "idle" })
  expect(reply.output).toEqual([
    { author: "@minh", text: "Fix the build." },
    { author: "codex", text: "The build is fixed." },
  ])
  const [listed] = h.office.instruments.list(chat.id)
  expect(listed).toMatchObject({ kind: "codex", profile: "harness", name: "codex 1", driver: "minh", status: "idle" })
  // The instrument's id is its child session's.
  expect(h.store.getSession(listed!.id)).toMatchObject({ kind: "instrument", instrument_of: chat.id, harness: "codex" })
  const dir = path.join(h.office.paths.sessionDir(chat.id), "codex", listed!.id)
  expect(fs.readFileSync(path.join(dir, "conversation.log"), "utf8")).toContain("The build is fixed.")
  expect(fs.statSync(path.join(h.office.paths.sessionDir(chat.id), "codex")).mode & 0o777).toBe(0o700)
})

test("what the owner tells Codex reaches the employee's next reply, and the owner's turn is theirs to stop", async () => {
  const h = makeCodex()
  h.fake.script([
    fc.agentMessage("a1", "Started."),
    [...fc.agentMessage("a2", "Using staging."), { sleep: 0.3 }],
    fc.agentMessage("a3", "Migrated."),
  ])
  const { chat, call } = await employee(h)
  await call("start", { message: "Set up the database." })
  const [listed] = h.office.instruments.list(chat.id)
  // The owner writes to Codex in the child session, as the TUI sends it.
  await h.sessions.prompt(listed!.id, "Use the staging database.", { by: "ngocbh" })
  await waitFor(() => h.sessions.get(listed!.id)?.turnId != null, { what: "the owner's turn" })
  expect((await call("stop", { codex: "codex 1" })).refused).toContain("owner")
  await waitFor(() => status(h, listed!.id) === "idle", { what: "the owner's turn to end" })
  const reply = await call("send", { codex: "codex 1", message: "Run the migrations." })
  expect(reply.output).toEqual([
    { author: "Hong Ngoc Bui (owner)", text: "Use the staging database." },
    { author: "codex", text: "Using staging." },
    { author: "@minh", text: "Run the migrations." },
    { author: "codex", text: "Migrated." },
  ])
})

test("close ends every Codex session of the chat and takes its listing out; the record says it ended", async () => {
  const h = makeCodex()
  const { chat, codex, call } = await employee(h)
  await call("start", { message: "Look around." })
  const [listed] = h.office.instruments.list(chat.id)
  await codex.close()
  await waitFor(() => status(h, listed!.id) === "ended", { what: "the session's end" })
  expect(h.office.instruments.list(chat.id)).toEqual([])
  const dir = path.join(h.office.paths.sessionDir(chat.id), "codex", listed!.id)
  await waitFor(() => readCodexRecord(dir)?.state === "ended", { what: "the record's end" })
})

test("the employee's interrupt stops Codex's turn and the command it runs", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("a1", "Started."), [fc.commandStarted("c1", "make", { processId: "p1" }), { spawn: 300, process: "p1" }, { sleep: 30 }]])
  const { call } = await employee(h)
  await call("start", { message: "Look around." })
  expect((await call("send", { codex: "codex 1", message: "Run the long check.", wait: 0 })).status).toBe("running")
  const command = await running(h)
  const reply = await call("interrupt", { codex: "codex 1" })
  expect(reply.status).toBe("idle")
  expect(h.fake.calls("thread/backgroundTerminals/terminate")).toEqual([{ threadId: "thr_1", processId: "p1" }])
  await waitFor(command.gone, { what: "Codex's command to stop" })
})

test("an employee who doesn't use the codex harness is told so, and no session starts", async () => {
  const h = makeCodex({ files: { "people/minh/person.yaml": person("minh", { harnesses: ["composer"] }) } })
  const { chat, call } = await employee(h)
  const reply = await call("start", { message: "Hi." })
  expect(reply.status).toBe("failed")
  expect(reply.error).toContain("doesn't use the codex harness")
  expect(h.store.listSessions({ kind: "instrument" })).toEqual([])
  expect(h.office.instruments.list(chat.id)[0]).toMatchObject({ status: "failed" })
})

test("Esc in the chat reaches a running Codex turn through the call's interrupt, and the call replies with it", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "codex_start", arguments: { message: "Fix the build.", wait: 120 } }] })
  const h = await makeHarness(fake, { codex: true })
  h.codex!.fake.script([[...fc.agentMessage("a1", "Reading the build files."), fc.commandStarted("c1", "make", { processId: "p1" }), { spawn: 300, process: "p1" }, { sleep: 30 }]])
  const s = await h.harness.startSession("minh", h.folder, { openedBy: "ngocbh" })
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's first turn" })
  await h.harness.prompt(s.id, "Hand the build to Codex.", { by: "ngocbh" })
  const listed = await waitFor(() => h.office.instruments.list(s.id).find((i) => i.status === "running"), {
    what: "Codex's turn",
  })
  const command = await running(h.codex!)
  await h.harness.interrupt(s.id)
  await waitFor(() => h.codex!.fake.calls("turn/interrupt").length === 1, { what: "Codex's interrupt" })
  // The command the turn ran stops with it.
  await waitFor(command.gone, { what: "Codex's command to stop" })
  expect(h.codex!.fake.calls("thread/backgroundTerminals/terminate")).toEqual([{ threadId: "thr_1", processId: "p1" }])
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's turn to end" })
  const log = fs.readFileSync(path.join(h.office.paths.runs, h.store.getSession(s.id)!.run_ids.at(-1)!, "log.jsonl"), "utf8")
  // The call's own reply, with what Codex said before the interrupt, is what the run recorded.
  expect(log).toContain("Reading the build files.")
  expect(log).toContain("[interrupted]")
  expect(log).toContain("The owner interrupted you (Esc)")
  expect(h.office.instruments.list(s.id).find((i) => i.id === listed.id)?.status).toBe("idle")
  // The agent ended interrupted: no model call came after the tool's reply.
  expect(fake.requests()).toHaveLength(1)
})

/** minh's chat, its reply calling codex_start (`usage` its model call's), and Codex's turn running until stopped. */
async function codexTurn(o: { usage?: { prompt_tokens: number; completion_tokens: number } } = {}) {
  const fake = await fakeLlm()
  const call = { name: "codex_start", arguments: { message: "Fix the build.", wait: 120 } }
  fake.script({ tool_calls: [call], ...(o.usage ? { usage: o.usage } : {}) }, { content: "spare" })
  const h = await makeHarness(fake, { codex: true, ...(o.usage ? { prices: PRICES } : {}) })
  h.codex!.fake.script([[...fc.agentMessage("a1", "Reading the build files."), fc.commandStarted("c1", "make", { processId: "p1" }), { spawn: 300, process: "p1" }, { sleep: 30 }]])
  const s = await h.harness.startSession("minh", h.folder, { openedBy: "ngocbh" })
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's first turn" })
  await h.harness.prompt(s.id, "Hand the build to Codex.", { by: "ngocbh" })
  return { fake, h, s }
}

/** The command Codex's turn runs (the fake's first `spawn`), once it runs; `gone` once it has stopped. */
async function running(codex: Codex): Promise<{ gone: () => boolean }> {
  const [pid] = await waitFor(() => (codex.fake.spawned().length > 0 ? codex.fake.spawned() : undefined), {
    what: "Codex's command",
  })
  const started = startTime(pid!)
  onTestFinished(() => {
    if (started !== null && sameProcess(pid!, started)) process.kill(pid!, "SIGKILL")
  })
  return { gone: () => isGone(pid!, started) }
}

/** Whether the chat's Codex session runs no turn: interrupted, or never sent its message. */
function noTurnRuns(h: Awaited<ReturnType<typeof codexTurn>>["h"], chat: string): boolean {
  const [listed] = h.office.instruments.list(chat)
  return listed !== undefined && listed.status !== "running" && listed.status !== "starting"
}

test("a worker that dies while the employee waits on Codex stops the Codex turn it started", async () => {
  const { h, s } = await codexTurn()
  await waitFor(() => h.office.instruments.list(s.id).find((i) => i.status === "running"), { what: "Codex's turn" })
  const command = await running(h.codex!)
  h.registry.get(s.id)!.kill()
  await waitFor(() => h.codex!.fake.calls("turn/interrupt").length === 1, { what: "Codex's interrupt" })
  await waitFor(() => noTurnRuns(h, s.id), { what: "the turn's end" })
  await waitFor(command.gone, { what: "Codex's command to stop" })
})

test("a cost-cap stop while the employee waits on Codex stops the Codex turn, so it spends nothing more", async () => {
  // The reply that calls codex_start costs $6, over the company's $5 cap: the cap stops the run as the call runs.
  const { h, s } = await codexTurn({ usage: { prompt_tokens: 6, completion_tokens: 1 } })
  await waitFor(() => h.office.instruments.list(s.id).length === 1, { what: "Codex's session" })
  await waitFor(() => h.store.getSession(s.id)?.capped === true, { what: "the cap" })
  await waitFor(() => noTurnRuns(h, s.id), { timeout: 20_000, what: "no Codex turn to run on" })
  // Either the turn was interrupted, or the session stopped before its message went.
  const [listed] = h.office.instruments.list(s.id)
  const sent = h.codex!.fake.calls("turn/start").length
  expect(sent === 0 || h.codex!.fake.calls("turn/interrupt").length === 1).toBe(true)
  expect(listed!.status).not.toBe("running")
})

test("after an office restart, history reads the Codex session's record, and send resumes its thread", async () => {
  const h = makeCodex()
  h.fake.script([
    fc.agentMessage("a1", "The build is fixed."),
    fc.agentMessage("a2", "The tests pass too."),
    fc.agentMessage("a3", "Docs written."),
  ])
  const { chat, codex, call } = await employee(h)
  await call("start", { message: "Fix the build." })
  const { id, dir } = recordOf(h, chat)
  const { r, call: next } = await restart(h, codex, chat)
  // Ended in the store and not listed until the employee writes to it; the record waits.
  expect([status(r, id), h.office.instruments.list(chat.id)]).toEqual(["ended", []])
  expect(readCodexRecord(dir)).toMatchObject({ state: "interrupted", harnessSessionId: "thr_1" })
  const read = await next("history", { codex: "codex 1", from: 0 })
  expect(read.output).toEqual([
    { author: "@minh", text: "Fix the build." },
    { author: "codex", text: "The build is fixed." },
  ])
  expect(r.fake.calls("thread/resume")).toEqual([])
  const reply = await next("send", { codex: "codex 1", message: "Run the tests." })
  expect(reply).toMatchObject({ codex: "codex 1", status: "idle" })
  expect(reply.output).toEqual([
    { author: "@minh", text: "Run the tests." },
    { author: "codex", text: "The tests pass too." },
  ])
  // The same thread, loaded by the start's own path: the employee's permission, and Codex told of its speakers.
  const [resume] = r.fake.calls("thread/resume") as Record<string, any>[]
  expect(resume).toMatchObject({ threadId: "thr_1", approvalPolicy: "never", permissions: `opencorp-${id}` })
  expect(resume!.developerInstructions).toContain("the owner's word wins")
  expect(r.fake.calls("thread/start")).toHaveLength(1)
  // The same child session, live again and listed again.
  expect(r.store.getSession(id)).toMatchObject({ status: "idle", instrument_of: chat.id, harness_session_id: "thr_1" })
  expect(h.office.instruments.list(chat.id)).toMatchObject([{ id, name: "codex 1", status: "idle" }])
  expect(readCodexRecord(dir)!.state).toBe("running")
  // A new session takes the next name.
  expect((await next("start", { message: "Write the docs." })).codex).toBe("codex 2")
})

test("a Codex turn an office restart cut off is marked interrupted in the record, and send resumes the session", async () => {
  const h = makeCodex()
  h.fake.script([
    fc.agentMessage("a1", "Started."),
    [...fc.agentMessage("a2", "Reading the parser."), { sleep: 30 }],
    fc.agentMessage("a3", "Rewritten."),
  ])
  const { chat, codex, call } = await employee(h)
  await call("start", { message: "Look around." })
  expect((await call("send", { codex: "codex 1", message: "Rewrite the parser.", wait: 0 })).status).toBe("running")
  const { id } = recordOf(h, chat)
  await waitFor(() => h.sessions.get(id)?.turnId != null, { what: "the turn" })
  const { r, call: next } = await restart(h, codex, chat)
  const reply = await next("send", { codex: "codex 1", message: "Go on." })
  const said = (reply.output as { author: string; text: string }[]).map((e) => [e.author, e.text])
  // From where the employee last read: its message, what Codex said before the stop, the restart's mark, then on.
  expect(said[0]).toEqual(["@minh", "Rewrite the parser."])
  expect(said.slice(1, -2).map(([, t]) => t).join("\n")).toContain("[interrupted]")
  expect(said.at(-3)![1]).toContain("The office restarted while Codex worked on a turn @minh started")
  expect(said.slice(-2)).toEqual([["@minh", "Go on."], ["codex", "Rewritten."]])
  expect(r.fake.calls("thread/resume")).toHaveLength(1)
})

test("a resume goes through a new session's checks: a project config Codex would load fails the session, saying so", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("a1", "The build is fixed.")])
  const { chat, codex, call } = await employee(h)
  await call("start", { message: "Fix the build." })
  const { id, dir } = recordOf(h, chat)
  const { r, call: next } = await restart(h, codex, chat)
  const cwd = fs.realpathSync(h.workspace)
  r.fake.script([], { project_layers: { [cwd]: [{ dotCodexFolder: path.join(cwd, ".codex") }] } })
  const reply = await next("send", { codex: "codex 1", message: "Run the tests." })
  expect(reply.status).toBe("failed")
  expect(reply.error).toContain("Codex would load this project's own config")
  expect(r.fake.calls("thread/resume")).toEqual([])
  expect(status(r, id)).toBe("failed")
  expect(readCodexRecord(dir)!.state).toBe("failed")
})

test("an office restart doesn't continue a session whose record names another thread than the office's", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("a1", "The build is fixed.")])
  const { chat, codex, call } = await employee(h)
  await call("start", { message: "Fix the build." })
  const { id, dir } = recordOf(h, chat)
  await h.sessions.closeAll()
  await codex.suspend()
  const meta = path.join(dir, "meta.json")
  fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), harnessSessionId: "thr_other" }))
  const r = reopened(h)
  await r.sessions.restore()
  const { call: next } = await instrumentOf(r, chat)
  const reply = await next("send", { codex: "codex 1", message: "Run the tests." })
  expect(reply.status).toBe("failed")
  expect(reply.error).toContain("doesn't match")
  expect(r.lines.some((l) => l.includes(id) && l.includes("doesn't match"))).toBe(true)
  expect(r.fake.calls("thread/resume")).toEqual([])
})

test("across an office restart the chat keeps its Codex session: the employee's next message to it resumes its thread", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [{ name: "codex_start", arguments: { message: "Fix the build.", wait: 120 } }] },
    { content: "Codex fixed the build." },
    { tool_calls: [{ name: "codex_send", arguments: { codex: "codex 1", message: "Run the tests.", wait: 120 } }] },
    { content: "The tests pass." },
  )
  const h = await makeHarness(fake, { codex: true })
  h.codex!.fake.script([fc.agentMessage("a1", "The build is fixed."), fc.agentMessage("a2", "The tests pass too.")])
  const s = await h.harness.startSession("minh", h.folder, { openedBy: "ngocbh" })
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's first turn" })
  await h.harness.prompt(s.id, "Hand the build to Codex.", { by: "ngocbh" })
  await waitFor(() => fake.requests().length === 2 && h.store.getSession(s.id)?.status === "idle", {
    what: "the chat's turn",
  })
  const [listed] = h.office.instruments.list(s.id)
  // The office's stop and its next start, with the next office's Codex sessions.
  await h.reopen()
  const dir = path.join(h.office.paths.sessionDir(s.id), "codex", listed!.id)
  // The chat's stop left the session to continue, not ended.
  expect(readCodexRecord(dir)!.state).toBe("interrupted")
  h.office.codex = reopened(h.codex!).sessions
  await h.harness.restore()
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's restore" })
  expect(h.office.instruments.list(s.id)).toEqual([])
  await h.harness.prompt(s.id, "Now the tests.", { by: "ngocbh" })
  await waitFor(() => fake.requests().length === 4 && h.store.getSession(s.id)?.status === "idle", {
    what: "the chat's next turn",
  })
  expect(h.codex!.fake.calls("thread/start")).toHaveLength(1)
  expect(h.codex!.fake.calls("thread/resume")).toMatchObject([{ threadId: "thr_1" }])
  expect(h.office.instruments.list(s.id)).toMatchObject([{ id: listed!.id, name: "codex 1", status: "idle" }])
  const reply = (fake.requests()[3]!.messages as Record<string, any>[]).filter((m) => m.role === "tool").at(-1)
  expect(JSON.parse(String(reply?.content))).toMatchObject({
    codex: "codex 1",
    status: "idle",
    output: [{ author: "@minh", text: "Run the tests." }, { author: "codex", text: "The tests pass too." }],
  })
})

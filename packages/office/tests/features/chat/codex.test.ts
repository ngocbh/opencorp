/** A main chat's Codex instrument: the employee drives Codex sessions, each the chat's child session under the
 *  employee's permission, listed as the chat's instrument with its record in the chat's `codex/` folder, and the
 *  owner's messages to Codex reach the employee's next reply; on the fake app-server. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { EmployeeCodex } from "../../../src/features/chat/codex.ts"
import { speakers } from "../../../src/features/codex/instrument.ts"
import { loadRepo } from "../../../src/company/loader.ts"
import { readCodexRecord } from "../../../src/tools/codex/record.ts"
import * as fc from "../../../src/testing/fake_codex.ts"
import { person } from "../../company/helpers.ts"
import { session as sessionRow } from "../../runtime/store/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { fakeLlm, makeHarness } from "./helpers.ts"
import { type Codex, allGone, makeCodex, status } from "../codex/helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** minh's main chat in `h.workspace`, opened by ngocbh, and its Codex instrument. */
async function employee(h: Codex) {
  const head = await h.office.git.head()
  const chat = h.store.createSession(
    sessionRow({ cwd: fs.realpathSync(h.workspace), repo_commit: head, opened_by: "ngocbh", connection: "office" }),
  )
  const repo = loadRepo(await h.office.git.pin(head))
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
  return { chat, codex, call }
}

test("the employee starts Codex as the chat's instrument, a child session, and reads its answer", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("a1", "The build is fixed.")])
  const { chat, call } = await employee(h)
  const reply = await call("start", { message: "Fix the build." })
  expect(reply).toMatchObject({ codex: "codex 1", status: "idle" })
  expect(reply.output).toContain('<authored_message author="@minh">\nFix the build.')
  expect(reply.output).toContain('<authored_message author="Codex">\nThe build is fixed.')
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
  expect(reply.output).toContain('author="Hong Ngoc Bui (owner)">\nUse the staging database.')
  expect(reply.output).toContain("Using staging.")
  expect(reply.output).toContain("Migrated.")
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
  h.codex!.fake.script([[...fc.agentMessage("a1", "Reading the build files."), { sleep: 30 }]])
  const s = await h.harness.startSession("minh", h.folder, { openedBy: "ngocbh" })
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's first turn" })
  await h.harness.prompt(s.id, "Hand the build to Codex.", { by: "ngocbh" })
  const listed = await waitFor(() => h.office.instruments.list(s.id).find((i) => i.status === "running"), {
    what: "Codex's turn",
  })
  await waitFor(() => h.codex!.fake.messages("out").some((m) => m.method === "item/completed"), { what: "Codex's words" })
  await h.harness.interrupt(s.id)
  await waitFor(() => h.codex!.fake.calls("turn/interrupt").length === 1, { what: "Codex's interrupt" })
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

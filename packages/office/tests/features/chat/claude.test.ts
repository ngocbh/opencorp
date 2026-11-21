/** A main chat's Claude Code instrument: the employee drives Claude Code sessions, each the chat's child session
 *  under the employee's permission, listed as the chat's instrument with its record in the chat's `claude/` folder;
 *  the owner's messages to Claude Code reach the employee's next reply; Esc and a stopped run reach a running turn;
 *  on the fake Claude Code. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { EmployeeClaude } from "../../../src/features/chat/claude.ts"
import { speakers } from "../../../src/features/codex/instrument.ts"
import { loadRepo } from "../../../src/company/loader.ts"
import { readClaudeRecord } from "../../../src/tools/claude/instrument.ts"
import type { FakeClaudeScript } from "../../../src/testing/fake_claude.ts"
import { waitFor } from "../../helpers.ts"
import { fakeLlm, makeHarness } from "./helpers.ts"
import { type Claude, allGone, chatOf, makeClaude } from "../claude/helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** minh's main chat in `h.workspace`, opened by ngocbh, and its Claude Code instrument. */
async function employee(h: Claude) {
  const chat = await chatOf(h)
  const repo = loadRepo(await h.office.git.pin(chat.repo_commit))
  const claude = new EmployeeClaude({
    chat,
    sessions: h.sessions,
    folder: h.office.paths.sessionDir(chat.id),
    instruments: h.office.instruments,
    speakers: speakers(repo, chat),
  })
  const tools = claude.tools()
  const call = async (name: keyof typeof tools, args: Record<string, unknown>, options = {}) =>
    JSON.parse(String(await tools[name].call(args, options))) as Record<string, any>
  return { chat, claude, call }
}

const OWNER = "Hong Ngoc Bui (owner)"

test("the employee starts Claude Code as the chat's instrument, a child session, and reads its answer", async () => {
  const h = makeClaude({ script: { turns: [[{ say: "The build is fixed." }]] } })
  const { chat, call } = await employee(h)
  const reply = await call("start", { message: "Fix the build." })
  expect(reply).toMatchObject({ claude: "claude 1", status: "idle" })
  expect(reply.output).toEqual([
    { author: "@minh", text: "Fix the build." },
    { author: "claude", text: "The build is fixed." },
  ])
  const [listed] = h.office.instruments.list(chat.id)
  expect(listed).toMatchObject({ kind: "claude", profile: "harness", name: "claude 1", driver: "minh", status: "idle" })
  // The instrument's id is its child session's.
  expect(h.store.getSession(listed!.id)).toMatchObject({ kind: "instrument", instrument_of: chat.id, harness: "claude" })
  const dir = path.join(h.office.paths.sessionDir(chat.id), "claude", listed!.id)
  expect(fs.readFileSync(path.join(dir, "conversation.log"), "utf8")).toContain("The build is fixed.")
  expect(fs.statSync(path.join(h.office.paths.sessionDir(chat.id), "claude")).mode & 0o777).toBe(0o700)
})

test("the owner's message mid-turn goes as next, joins the turn, and reaches the employee's reply", async () => {
  const script: FakeClaudeScript = { turns: [[{ say: "Looking." }, { sleep: 1 }, { say: "Using staging." }]] }
  const h = makeClaude({ script })
  const { chat, call } = await employee(h)
  const starting = call("start", { message: "Set up the database.", wait: 30 })
  const listed = await waitFor(() => h.office.instruments.list(chat.id)[0], { what: "the listing" })
  await waitFor(() => h.fake.log().some((e) => e.dir === "out" && e.msg?.message?.content?.[0]?.text === "Looking."), {
    what: "Claude Code's first words",
  })
  // The owner writes to Claude Code in the child session, as the TUI sends it.
  await h.office.claude!.prompt(listed.id, "Use the staging database.", { by: "ngocbh" })
  const reply = await starting
  expect(reply.output).toEqual([
    { author: "@minh", text: "Set up the database." },
    { author: "claude", text: "Looking." },
    { author: OWNER, text: "Use the staging database." },
    { author: "claude", text: "Using staging." },
  ])
  const owners = h.fake.log().find((e) => e.dir === "in" && e.msg?.message?.content?.[0]?.text?.includes("staging database"))
  expect(owners!.msg!.priority).toBe("next")
})

test("a turn the owner started is theirs: the employee can't interrupt or stop it", async () => {
  const h = makeClaude({ script: { turns: [[{ say: "Started." }], [{ say: "On it." }, { sleep: 30 }]] } })
  const { chat, call } = await employee(h)
  await call("start", { message: "Look around." })
  const [listed] = h.office.instruments.list(chat.id)
  await h.office.claude!.prompt(listed!.id, "Run the long check.", { by: "ngocbh" })
  await waitFor(() => h.office.instruments.list(chat.id)[0]?.status === "running", { what: "the owner's turn" })
  expect((await call("interrupt", { claude: "claude 1" })).refused).toContain("owner")
  expect((await call("stop", { claude: "claude 1" })).refused).toContain("owner")
  expect(h.fake.log().some((e) => e.dir === "in" && e.msg?.request?.subtype === "interrupt")).toBe(false)
})

test("a start whose sandbox can't run tells the employee what to fix, and the listing shows it failed", async () => {
  const h = makeClaude({ script: { sandbox_unavailable: true } })
  const { chat, call } = await employee(h)
  const reply = await call("start", { message: "Hi." })
  expect(reply).toMatchObject({ claude: "claude 1", status: "failed" })
  expect(reply.error).toContain("install bubblewrap and socat")
  const [listed] = h.office.instruments.list(chat.id)
  expect(listed).toMatchObject({ status: "failed", error: expect.stringContaining("sandbox can't start") })
  expect(h.store.getSession(listed!.id)!.status).toBe("failed")
})

test("close ends every Claude Code session of the chat and takes its listing out; the record says it ended", async () => {
  const h = makeClaude()
  const { chat, claude, call } = await employee(h)
  await call("start", { message: "Look around." })
  const [listed] = h.office.instruments.list(chat.id)
  await claude.close()
  await waitFor(() => h.store.getSession(listed!.id)?.status === "ended", { what: "the session's end" })
  expect(h.office.instruments.list(chat.id)).toEqual([])
  const dir = path.join(h.office.paths.sessionDir(chat.id), "claude", listed!.id)
  await waitFor(() => readClaudeRecord(dir)?.state === "ended", { what: "the record's end" })
})

/** minh's chat, its reply calling claude_start, and Claude Code's turn running until stopped. */
async function claudeTurn() {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "claude_start", arguments: { message: "Fix the build.", wait: 120 } }] })
  const h = await makeHarness(fake, { claude: true })
  h.claude!.fake.set({ version: "2.1.325", turns: [[{ say: "Reading the build files." }, { sleep: 30 }]] })
  const s = await h.harness.startSession("minh", h.folder, { openedBy: "ngocbh" })
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's first turn" })
  await h.harness.prompt(s.id, "Hand the build to Claude Code.", { by: "ngocbh" })
  const listed = await waitFor(() => h.office.instruments.list(s.id).find((i) => i.status === "running"), {
    what: "Claude Code's turn",
  })
  await waitFor(() => h.claude!.fake.log().some((e) => e.dir === "out" && e.msg?.type === "assistant"), {
    what: "Claude Code's words",
  })
  return { fake, h, s, listed }
}

/** Whether the fake was asked to interrupt. */
const interrupted = (h: Awaited<ReturnType<typeof claudeTurn>>["h"]) =>
  h.claude!.fake.log().some((e) => e.dir === "in" && e.msg?.request?.subtype === "interrupt")

test("Esc in the chat reaches a running Claude Code turn through the call's interrupt, and the call replies with it", async () => {
  const { fake, h, s, listed } = await claudeTurn()
  await h.harness.interrupt(s.id)
  await waitFor(() => interrupted(h), { what: "Claude Code's interrupt" })
  await waitFor(() => h.store.getSession(s.id)?.status === "idle", { what: "the chat's turn to end" })
  const log = fs.readFileSync(path.join(h.office.paths.runs, h.store.getSession(s.id)!.run_ids.at(-1)!, "log.jsonl"), "utf8")
  // The call's own reply, with what Claude Code said before the interrupt, is what the run recorded.
  expect(log).toContain("Reading the build files.")
  expect(log).toContain("[interrupted]")
  expect(log).toContain("The owner interrupted you (Esc)")
  expect(h.office.instruments.list(s.id).find((i) => i.id === listed.id)?.status).toBe("idle")
  // The agent ended interrupted: no model call came after the tool's reply.
  expect(fake.requests()).toHaveLength(1)
})

test("a worker that dies while the employee waits on Claude Code stops the Claude Code turn it started", async () => {
  const { h, s } = await claudeTurn()
  h.registry.get(s.id)!.kill()
  await waitFor(() => interrupted(h), { what: "Claude Code's interrupt" })
  await waitFor(() => h.office.instruments.list(s.id)[0]?.status === "idle", { what: "the turn's end" })
})

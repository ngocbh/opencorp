/** Approval cards on a real office: a held terminal command survives the office's restart and runs once on Yes, End
 *  closes a card with nothing run, and in auto Auto's check runs in a classify worker of the office. */
import fs from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import type { Question } from "@opencorp/protocol"
import type { ScriptedReply } from "../../src/testing/fake_llm.ts"
import { waitFor } from "../helpers.ts"
import { sandboxAvailable } from "../runtime/sandbox/helpers.ts"
import { folder, openOffice, type RunningOffice } from "./helpers.ts"

const TIMEOUT = 180_000

/** Words only the chat's requests hold, from its system prompt, so a check's request never takes Minh's reply. */
const CHAT = "You work in the office alongside"

/** Minh's reply that runs `command` in a new shell of his terminal. */
function shell(command: string): ScriptedReply {
  return { match: CHAT, tool_calls: [{ name: "terminal_run", arguments: { command, why: "as asked" } }] }
}

/** What a request holds once a command's reply, exit 0, reached it: the reply's JSON, escaped in the tool's result. */
const EXITED = JSON.stringify('"exit":0').slice(1, -1)

/** An audit row as the office's store holds it. */
type Row = { kind: string; tool: string; outcome: string; detail: string | null; run_id: string | null; args: string }

/** Session `sid`'s audit rows, read from the office's store while it runs. */
function audit(office: RunningOffice, sid: string): Row[] {
  const db = new Database(office.paths.store, { readonly: true })
  try {
    return db
      .prepare("SELECT kind, tool, outcome, detail, run_id, args FROM audit WHERE session_id = ? ORDER BY id")
      .all(sid) as Row[]
  } finally {
    db.close()
  }
}

/** Session `sid`'s cards. */
function cards(office: RunningOffice, sid: string): Promise<Question[]> {
  return office.get("/questions", { session: sid })
}

/** Starts Minh's chat in a fresh project folder in `ask` mode, sends `text` and waits for the approval card it holds
 *  on; returns the folder, the session and the card. */
async function heldInAsk(office: RunningOffice, text: string): Promise<{ workspace: string; sid: string; card: Question }> {
  const workspace = folder(path.join(office.root, "project"))
  const sid = await office.startChat(await office.person("minh"), workspace)
  expect((await office.post(`/sessions/${sid}/mode`, { mode: "ask" })).mode).toBe("ask")
  await office.prompt(sid, text)
  const card = await waitFor(
    async () => (await cards(office, sid)).find((q) => q.source === "approval" && q.status === "open"),
    { timeout: 60_000, what: "the approval card" },
  )
  await waitFor(async () => (await office.status(sid)) === "waiting", { timeout: 60_000, what: "waiting on it" })
  return { workspace, sid, card }
}

test.skipIf(!sandboxAvailable())(
  "an approval card left open survives the office's restart, and Yes after it runs the command once",
  async () => {
    const office = await openOffice()
    office.llm.script(shell("echo ran >> runs.txt"), { match: EXITED, content: "Recorded." })
    const { workspace, sid, card } = await heldInAsk(office, "Record a run")
    await office.opencorp(["restart"], { cwd: workspace })
    await waitFor(async () => (await office.status(sid)) === "waiting", { timeout: 60_000, what: "the restored chat" })
    expect(((await office.get(`/questions/${card.id}`)) as Question).status).toBe("open")
    expect(fs.existsSync(path.join(workspace, "runs.txt"))).toBe(false)

    await office.post(`/questions/${card.id}/answer`, { answer: "Yes", answer_kind: "option" })
    await office.settled(sid, ["Recorded."])
    expect(fs.readFileSync(path.join(workspace, "runs.txt"), "utf8")).toBe("ran\n")
    expect(((await office.get(`/questions/${card.id}`)) as Question).status).toBe("consumed")
    const rows = audit(office, sid).filter((row) => row.kind === "workspace")
    expect(rows.map((row) => row.outcome)).toEqual(["held", "ok"])
    expect(rows[1]!.detail).toEndWith(" approved by @ngocbh")
  },
  TIMEOUT,
)

test.skipIf(!sandboxAvailable())(
  "End with an approval card open ends the session and runs nothing",
  async () => {
    const office = await openOffice()
    office.llm.script(shell("echo ran >> runs.txt"))
    const { workspace, sid, card } = await heldInAsk(office, "Record a run")
    expect(await office.post(`/sessions/${sid}/end`)).toEqual({ ok: true })
    await office.ended(sid)
    const closed: Question = await office.get(`/questions/${card.id}`)
    expect([closed.status, closed.answer_kind]).toEqual(["consumed", "interrupted"])
    expect(fs.existsSync(path.join(workspace, "runs.txt"))).toBe(false)
    expect(audit(office, sid).map((row) => [row.kind, row.outcome])).toEqual([["workspace", "held"]])
  },
  TIMEOUT,
)

test.skipIf(!sandboxAvailable())(
  "in auto a command runs after Auto's check in a classify worker of the real office, and the check's audit row names it",
  async () => {
    const office = await openOffice()
    const workspace = folder(path.join(office.root, "project"))
    fs.writeFileSync(path.join(workspace, "Makefile"), "all:\n\ttouch built.txt\n")
    office.llm.script(
      shell("make"),
      {
        match: "<command>\\nmake\\n</command>",
        tool_calls: [{ name: "Record", arguments: { verdict: "run", reason: "builds the project" } }],
      },
      { match: EXITED, content: "Built." },
    )
    const sid = await office.startChat(await office.person("minh"), workspace)
    expect(((await office.session(sid)) as { mode: string }).mode).toBe("auto")
    await office.prompt(sid, "Build it")
    await office.settled(sid, ["Built."])
    expect(fs.existsSync(path.join(workspace, "built.txt"))).toBe(true)
    const [check, ran] = audit(office, sid)
    expect(check).toMatchObject({ kind: "check", tool: "classify_command", outcome: "run", detail: "builds the project" })
    expect(JSON.parse(check!.args)).toMatchObject({ command: "make", profile: "workspace", cwd: workspace })
    expect(ran).toMatchObject({ kind: "workspace", tool: "terminal_run", outcome: "ok" })
    expect(ran!.detail).toEndWith(" by Auto's check: builds the project")
    // The check ran as its own yian run, its log in the session's folder.
    expect(fs.existsSync(path.join(office.paths.sessionDir(sid), "checks", `${check!.run_id}.jsonl`))).toBe(true)
  },
  TIMEOUT,
)

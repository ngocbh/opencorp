/** What a real office survives: a killed worker, a killed office, and racing answers. */
import path from "node:path"
import { expect, test } from "bun:test"
import { waitFor } from "../helpers.ts"
import { alive, asked, folder, openOffice, type RunningOffice } from "./helpers.ts"

const TIMEOUT = 180_000

/** Starts a session with Minh in `workspace` and takes one turn; returns the session id. */
async function firstTurn(office: RunningOffice, workspace: string): Promise<string> {
  office.llm.script({ content: "One." })
  const sid = await office.startChat(await office.person("minh"), workspace)
  await office.prompt(sid, "first")
  await office.settled(sid, ["One."])
  return sid
}

test(
  "a worker killed mid run is respawned and finishes the turn",
  async () => {
    const office = await openOffice()
    const workspace = folder(path.join(office.root, "project"))
    const fake = office.llm
    const sid = await firstTurn(office, workspace)
    fake.script({ content: "Lost.", hold: true }, { content: "Recovered.", hold: true })
    await office.prompt(sid, "mid-run")
    await fake.waitForRequests(2, 40_000)
    const killed = await office.worker(sid)
    process.kill(-killed, "SIGKILL")
    await fake.waitForRequests(3, 40_000)
    // No worker lives between turns, so the respawned one is looked up while its call is held; the lookup fails
    // unless a worker other than the killed one runs.
    await office.worker(sid, { otherThan: killed })
    fake.release() // both held calls; nobody reads the dead worker's
    await office.settled(sid, ["One.", "Recovered."])
    expect(await office.users(sid)).toEqual(["first", "mid-run"])
    expect((await office.session(sid)).run_ids).toHaveLength(1) // resumed, not a new run
    expect(fake.requests()).toHaveLength(3)
    expect(asked(fake.requests()[2]!)).toContain("mid-run")
    fake.script({ content: "Next." })
    await office.prompt(sid, "second")
    await office.settled(sid, ["One.", "Recovered.", "Next."])
  },
  TIMEOUT,
)

test(
  "an office killed mid turn comes back with opencorp start and finishes the turn",
  async () => {
    const office = await openOffice()
    const workspace = folder(path.join(office.root, "project"))
    const fake = office.llm
    const sid = await firstTurn(office, workspace)
    fake.script({ content: "Lost.", hold: true }, { content: "Resumed." })
    await office.prompt(sid, "mid-turn")
    await fake.waitForRequests(2, 40_000)
    const orphan = await office.worker(sid)
    const old = await office.killOffice()
    await waitFor(() => !alive(orphan), {
      timeout: 40_000,
      what: "the orphaned worker to exit when its office dies",
    })
    const down = await office.opencorp(["end"], { cwd: workspace, check: false })
    expect([down.code, down.stderr.trim()]).toEqual([3, "The office isn't running. Run `opencorp doctor`."])
    await office.opencorp(["start"], { cwd: workspace })
    expect(office.pid()).not.toBe(old)
    await office.settled(sid, ["One.", "Resumed."])
    fake.release() // the dead worker's call: nobody reads its reply
    expect((await office.session(sid)).run_ids).toHaveLength(1) // resumed, not a new run
    expect(fake.requests()).toHaveLength(3)
    expect(asked(fake.requests()[2]!)).toContain("mid-turn")
    fake.script({ content: "Next." })
    await office.prompt(sid, "second")
    await office.settled(sid, ["One.", "Resumed.", "Next."])
  },
  TIMEOUT,
)

test(
  "two clients answer one question and the first answer wins",
  async () => {
    const office = await openOffice()
    const workspace = folder(path.join(office.root, "project"))
    const fake = office.llm
    const sid = await office.startChat(await office.person("minh"), workspace)
    fake.script(
      {
        tool_calls: [
          { name: "ask_user", arguments: { question: "Which database?", options: ["Postgres", "SQLite"] } },
        ],
      },
      { content: "Going with it." },
    )
    await office.prompt(sid, "Pick a database with me")
    const asks = await waitFor(
      async () => {
        const open: { id: string; source: string }[] = await office.get("/questions", { session: sid, status: "open" })
        const found = open.filter((q) => q.source === "ask_user")
        return found.length ? found : null
      },
      { timeout: 40_000, what: "Minh's question" },
    )
    expect(asks).toHaveLength(1)
    const question = asks[0]!

    // Both requests in flight at once, so each has its own connection: a second TUI.
    const answer = async (choice: string) => {
      const response = await office.request("POST", `/questions/${question.id}/answer`, {
        body: { answer: choice, answer_kind: "option" },
      })
      const body = (await response.json()) as { error?: string }
      return { choice, code: response.status, error: body.error ?? null }
    }
    const results = await Promise.all(["Postgres", "SQLite"].map(answer))
    expect([...results].sort((a, b) => a.code - b.code).map((r) => [r.code, r.error])).toEqual([
      [200, null],
      [409, "not_open"],
    ])
    const winner = results.find((r) => r.code === 200)!.choice
    const loser = results.find((r) => r.code !== 200)!.choice
    await office.settled(sid, ["Going with it."])
    expect((await office.get(`/questions/${question.id}`)).answer).toBe(winner)
    const messages = fake.requests().at(-1)!.messages as { role: string; content: string }[]
    const tools = messages.filter((m) => m.role === "tool").map((m) => m.content)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toContain(winner)
    expect(tools[0]).not.toContain(loser)
  },
  TIMEOUT,
)

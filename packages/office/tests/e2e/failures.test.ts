/** What a real office survives: a killed worker, a killed office, racing answers, and a company repo a human left
 *  mid-merge, conflicted or locked. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { newToken, tokenSha256 } from "../../src/auth/tokens.ts"
import { git, gitStatus, startMerge, stashPopConflict } from "../company/helpers.ts"
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
    // The killed worker is the one parked after the first turn, which took this message. The respawned one is looked
    // up while its call is held; the lookup fails unless a worker other than the killed one runs.
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
  "a worker killed between turns is respawned and finishes the next turn",
  async () => {
    const office = await openOffice()
    const workspace = folder(path.join(office.root, "project"))
    const fake = office.llm
    const sid = await firstTurn(office, workspace)
    // Between turns the session's worker stays parked.
    const parked = await office.worker(sid)
    process.kill(-parked, "SIGKILL")
    await waitFor(() => !alive(parked), { timeout: 40_000, what: "the parked worker to die" })
    fake.script({ content: "Next." })
    await office.prompt(sid, "second")
    await office.settled(sid, ["One.", "Next."])
    expect(await office.worker(sid, { otherThan: parked })).not.toBe(parked)
    expect(await office.users(sid)).toEqual(["first", "second"])
    expect((await office.session(sid)).run_ids).toHaveLength(1) // resumed, not a new run
    expect(fake.requests()).toHaveLength(2)
  },
  TIMEOUT,
)

/** Takes a first turn in a session with Minh, then starts a reply whose model call is held, scripting `next` for the
 *  model call after it; returns the session id and its worker's pid. */
async function replyHeld(office: RunningOffice, next: string): Promise<{ sid: string; worker: number }> {
  const sid = await firstTurn(office, folder(path.join(office.root, "project")))
  office.llm.script({ content: "Busy.", hold: true }, { content: next })
  await office.prompt(sid, "go")
  await office.llm.waitForRequests(2, 40_000)
  await office.replying(sid)
  return { sid, worker: await office.worker(sid) }
}

test(
  "an end whose worker is killed before it answers still cuts the reply",
  async () => {
    const office = await openOffice()
    const { sid, worker } = await replyHeld(office, "AfterEnd.")
    expect((await office.request("POST", `/sessions/${sid}/end`)).status).toBe(200)
    process.kill(-worker, "SIGKILL")
    await office.ended(sid)
    // The respawned worker resumes the reply End cut, and gets End's interrupt again.
    expect(await office.texts(sid)).toEqual(["One.", "[interrupted]"])
  },
  TIMEOUT,
)

test(
  "an esc whose worker is killed before it answers still cuts the reply",
  async () => {
    const office = await openOffice()
    const { sid, worker } = await replyHeld(office, "Redone.")
    const esc = office.request("POST", `/sessions/${sid}/interrupt`)
    process.kill(-worker, "SIGKILL")
    expect((await esc).status).toBe(200)
    await office.settled(sid, ["One.", "[interrupted]"])
  },
  TIMEOUT,
)

test(
  "an office killed between turns leaves no worker and opencorp start continues the chat",
  async () => {
    const office = await openOffice()
    const workspace = folder(path.join(office.root, "project"))
    const fake = office.llm
    const sid = await firstTurn(office, workspace)
    const parked = await office.worker(sid)
    await office.killOffice()
    await waitFor(() => !alive(parked), {
      timeout: 40_000,
      what: "the parked worker to exit when its office dies",
    })
    await office.opencorp(["start"], { cwd: workspace })
    fake.script({ content: "Next." })
    await office.prompt(sid, "second")
    await office.settled(sid, ["One.", "Next."])
    expect((await office.session(sid)).run_ids).toHaveLength(1) // resumed, not a new run
    expect(fake.requests()).toHaveLength(2)
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
    expect([down.code, down.stderr.trim()]).toEqual([
      3,
      "The office isn't running. Run `opencorp start` (or `opencorp doctor` if it won't start).",
    ])
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

const PROFILE = "people/minh/profile.md"

test(
  "a device change mid-merge or under a stale lock is refused as company_repo_busy and stays out of the index",
  async () => {
    const office = await openOffice()
    const company = office.paths.company
    const person = "people/ngocbh/person.yaml"
    startMerge(company, "notes.md")
    const device = { name: "laptop", token_sha256: tokenSha256(newToken()) }
    let reply = await office.request("POST", "/people/ngocbh/devices", { body: device })
    expect(reply.status).toBe(409)
    expect(await reply.json()).toEqual({
      error: "company_repo_busy",
      message: "the company repo has a merge in progress; finish or abort it",
    })
    expect(git(company, "diff", "--cached", "--name-only")).not.toContain(person)
    expect(gitStatus(company, "merge", "--abort")).toBe(0)

    const lock = path.join(company, ".git/index.lock")
    fs.writeFileSync(lock, "")
    reply = await office.request("PUT", "/people/ngocbh/password", { body: { password: "correct horse battery" } })
    expect(reply.status).toBe(503)
    expect(await reply.json()).toEqual({
      error: "company_repo_busy",
      message: "the company repo is locked by .git/index.lock; if no git command is running there, remove it",
    })
    expect(fs.existsSync(lock)).toBe(true)
    fs.unlinkSync(lock)
    expect(git(company, "status", "--porcelain")).toBe("")
    expect((await office.post("/people/ngocbh/devices", device)).devices).toEqual([device])
  },
  TIMEOUT,
)

test(
  "a chat starts mid-merge from HEAD and leaves a profile hand edit for after the merge",
  async () => {
    const office = await openOffice()
    const company = office.paths.company
    startMerge(company, "notes.md")
    const head = git(company, "rev-parse", "HEAD")
    fs.appendFileSync(path.join(company, PROFILE), "Likes tests.\n")
    await firstTurn(office, folder(path.join(office.root, "project")))
    expect(git(company, "rev-parse", "HEAD")).toBe(head)
    expect(fs.readFileSync(path.join(company, PROFILE), "utf8")).toEndWith("Likes tests.\n")
    expect(gitStatus(company, "merge", "--abort")).toBe(0)
  },
  TIMEOUT,
)

test(
  "a chat starts with a conflicted profile and neither HEAD nor the model sees its markers",
  async () => {
    const office = await openOffice()
    const company = office.paths.company
    stashPopConflict(company, PROFILE)
    await firstTurn(office, folder(path.join(office.root, "project")))
    expect(git(company, "show", `HEAD:${PROFILE}`)).toBe("committed")
    expect(git(company, "ls-files", "-u")).toContain(PROFILE)
    expect(JSON.stringify(office.llm.requests())).not.toContain("<<<<<<<")
  },
  TIMEOUT,
)

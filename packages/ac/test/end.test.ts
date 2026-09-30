import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { createOfficeClient } from "@agent-corp/tui/office/client"
import { createFakeOffice } from "../../tui/script/stub"
import { endSession } from "../src/commands/end"
import { main } from "../src/main"

const home = mkdtempSync("/tmp/ace-")
const socket = path.join(home, "office", "office.sock")
const saved = process.env.AGENT_CORP_HOME
afterEach(() => {
  process.env.AGENT_CORP_HOME = saved
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** Runs `main(argv)` against the office under `home`, capturing stdout and stderr. */
async function capture(argv: string[]) {
  process.env.AGENT_CORP_HOME = home
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    return { code: await main(argv), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = log
    console.error = error
  }
}

test("with no id, ac end ends the newest live main session in the folder", async () => {
  const office = createFakeOffice()
  try {
    const [first] = office.state.sessions
    const client = createOfficeClient({ socket: office.socket })
    const ended = await endSession({ client, cwd: first.cwd })
    expect(ended.id).toBe(first.id)
    expect(office.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/sessions/${first.id}/end`])
    // An ending session is no longer live, so a second call finds none.
    await expect(endSession({ client, cwd: first.cwd })).rejects.toThrow("no live session in this folder")
    await expect(endSession({ client, cwd: "/elsewhere" })).rejects.toThrow("no live session in this folder")
  } finally {
    office.stop()
  }
})

test("ac end finds the folder's live session behind more than a page of newer sessions", async () => {
  const office = createFakeOffice()
  try {
    const [live] = office.state.sessions
    const later = new Date(Date.parse(live.updated_at) + 60_000).toISOString()
    for (let i = 0; i < 60; i++)
      office.state.sessions.push({
        ...live,
        id: office.nextId(),
        cwd: "/elsewhere",
        status: "ended",
        updated_at: later,
      })
    const client = createOfficeClient({ socket: office.socket })
    expect((await endSession({ client, cwd: live.cwd })).id).toBe(live.id)
  } finally {
    office.stop()
  }
})

test("ac end ID ends that session and says the debrief follows; the office's refusal exits 1", async () => {
  rmSync(path.dirname(socket), { recursive: true, force: true })
  const down = await capture(["end", "S1"])
  expect([down.code, down.err]).toEqual([1, `ac end: the office is not running (no socket at ${socket})`])

  mkdirSync(path.dirname(socket), { recursive: true })
  const office = createFakeOffice({ socket })
  try {
    const id = office.state.sessions[0].id
    const r = await capture(["end", id])
    expect([r.code, r.out]).toEqual([0, `Ending @minh's session ${id}; its debrief follows.`])
    // Ending an ending session is a no-op; once it is debriefing, the office refuses.
    office.state.sessions[0] = { ...office.state.sessions[0], status: "ending" }
    const ending = await capture(["end", id])
    expect([ending.code, ending.out]).toEqual([0, `Ending @minh's session ${id}; its debrief follows.`])
    expect(office.state.sessions[0].status).toBe("ending")
    office.setStatus(id, "debriefing")
    const again = await capture(["end", id])
    expect([again.code, again.err]).toEqual([1, `ac end: session ${id} has no live run`])
  } finally {
    office.stop()
  }
})

test("ac end on a side session promises no debrief", async () => {
  mkdirSync(path.dirname(socket), { recursive: true })
  const office = createFakeOffice({ socket })
  try {
    const [main] = office.state.sessions
    const side = { ...main, id: office.nextId(), kind: "side" as const }
    office.state.sessions.push(side)
    const r = await capture(["end", side.id])
    expect([r.code, r.out]).toEqual([0, `Ending @minh's side session ${side.id}.`])
  } finally {
    office.stop()
  }
})

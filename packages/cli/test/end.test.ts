import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { createOfficeClient } from "@opencorp/client"
import { createFakeOffice } from "@opencorp/tui/fake-office"
import { endSession } from "../src/commands/end"
import { main } from "../src/main"

const home = mkdtempSync("/tmp/ace-")
const socket = path.join(home, "office", "office.sock")
const saved = process.env.OPENCORP_HOME
afterEach(() => {
  process.env.OPENCORP_HOME = saved
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** Runs `main(argv)` against the office under `home`, capturing stdout and stderr. */
async function capture(argv: string[]) {
  process.env.OPENCORP_HOME = home
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

test("with no id, opencorp end ends the newest live main session in the folder", async () => {
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

test("opencorp end finds the folder's live session behind more than a page of newer sessions", async () => {
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

test("opencorp end ID ends that session; no office exits 3, its refusal 1", async () => {
  rmSync(path.dirname(socket), { recursive: true, force: true })
  const down = await capture(["end", "S1"])
  expect([down.code, down.err]).toEqual([
    3,
    "The office isn't running. Run `opencorp start` (or `opencorp doctor` if it won't start).",
  ])

  mkdirSync(path.dirname(socket), { recursive: true })
  const office = createFakeOffice({ socket })
  try {
    const id = office.state.sessions[0].id
    const r = await capture(["end", id])
    expect([r.code, r.out]).toEqual([0, `Ending @minh's session ${id}.`])
    // Ending an ending session is a no-op; once it is ended, the office refuses.
    office.state.sessions[0] = { ...office.state.sessions[0], status: "ending" }
    const ending = await capture(["end", id])
    expect([ending.code, ending.out]).toEqual([0, `Ending @minh's session ${id}.`])
    expect(office.state.sessions[0].status).toBe("ending")
    office.setStatus(id, "ended")
    const again = await capture(["end", id])
    expect([again.code, again.err]).toEqual([1, `opencorp end: session ${id} has no live run`])
  } finally {
    office.stop()
  }
})

test("opencorp end on a side session names its kind", async () => {
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

test("opencorp end ends a waiting session in the folder", async () => {
  const office = createFakeOffice()
  try {
    const [live] = office.state.sessions
    office.updateSession(live.id, { status: "waiting", waiting_on: ["ngocbh"] })
    const client = createOfficeClient({ socket: office.socket })
    expect((await endSession({ client, cwd: live.cwd })).id).toBe(live.id)
  } finally {
    office.stop()
  }
})

test("opencorp end keeps to the folder on an office that ignores the kind and cwd filters", async () => {
  const office = createFakeOffice()
  try {
    const [here] = office.state.sessions
    office.state.sessions.unshift({
      ...here,
      id: office.nextId(),
      cwd: "/tmp/elsewhere",
      updated_at: new Date().toISOString(),
    })
    const real = createOfficeClient({ socket: office.socket })
    // An office from before the filters lists every folder's sessions.
    const client = { ...real, sessions: { ...real.sessions, list: () => real.sessions.list({ limit: 500 }) } }
    expect((await endSession({ client, cwd: here.cwd })).id).toBe(here.id)
  } finally {
    office.stop()
  }
})

test("the client asks the office for one folder's main sessions", async () => {
  const office = createFakeOffice()
  try {
    const [first] = office.state.sessions
    const client = createOfficeClient({ socket: office.socket })
    const got = await client.sessions.list({ kind: "main", cwd: first.cwd, limit: 500 })
    expect(got.every((s) => s.kind === "main" && s.cwd === first.cwd)).toBe(true)
    const listed = office.requests.find((r) => r.method === "GET" && r.path.startsWith("/sessions?"))
    expect(listed?.path).toContain("kind=main")
    expect(listed?.path).toContain(`cwd=${encodeURIComponent(first.cwd)}`)
  } finally {
    office.stop()
  }
})

test("opencorp end refuses an empty id or more than one, exit 2, before asking the office", async () => {
  rmSync(path.dirname(socket), { recursive: true, force: true })
  const cases: [string[], string][] = [
    [["end", ""], "opencorp end: the session id is empty"],
    [["end", "a", "b"], "opencorp end: give at most one session id"],
  ]
  for (const [argv, err] of cases) {
    const r = await capture(argv)
    expect([r.code, r.err]).toEqual([2, err])
  }

  mkdirSync(path.dirname(socket), { recursive: true })
  const office = createFakeOffice({ socket })
  try {
    const id = office.state.sessions[0].id
    for (const argv of [["end", ""], ["end", id, "bogus"]]) {
      const r = await capture(argv)
      expect([r.code, r.out]).toEqual([2, ""])
    }
    expect(office.state.sessions[0].status).toBe("idle")
    expect(office.requests.filter((r) => r.path.startsWith("/sessions"))).toEqual([])
  } finally {
    office.stop()
  }
})

test("endSession refuses an empty id rather than ending the folder's newest session", async () => {
  const office = createFakeOffice()
  try {
    const [first] = office.state.sessions
    const client = createOfficeClient({ socket: office.socket })
    await expect(endSession({ client, cwd: first.cwd, id: "" })).rejects.toThrow("the session id is empty")
    expect(office.requests).toEqual([])
  } finally {
    office.stop()
  }
})

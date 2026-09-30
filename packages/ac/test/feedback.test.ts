import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Message } from "@agent-corp/protocol"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFakeOffice, type FakeOffice } from "../../tui/script/stub"
import { main } from "../src/main"

let home: string
let office: FakeOffice
const saved = { ...process.env }
const cwd = process.cwd()

beforeEach(() => {
  // A short path: unix socket paths are limited to about 100 bytes.
  home = mkdtempSync(path.join(os.tmpdir(), "acfb-"))
  mkdirSync(path.join(home, "office"))
  mkdirSync(path.join(home, "proj"))
  process.env.AGENT_CORP_HOME = home
  delete process.env.VISUAL
  delete process.env.EDITOR
  office = createFakeOffice({ socket: path.join(home, "office", "office.sock") })
})
afterEach(() => {
  office.stop()
  process.chdir(cwd)
  process.env = { ...saved }
  rmSync(home, { recursive: true, force: true })
})

/** Runs `ac feedback …`, capturing what it writes to stdout and stderr. */
async function feedback(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    return { code: await main(["feedback", ...argv]), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = log
    console.error = error
  }
}

const posts = () => office.requests.filter((r) => r.method === "POST" && r.path === "/feedback").map((r) => r.body)

/** A main session in `<home>/proj` (by its real path) with two turns and two runs. */
function sessionInProj() {
  const s = office.state.sessions[0]
  Object.assign(s, { cwd: realpathSync(path.join(home, "proj")), run_ids: ["run-a", "run-b"] })
  const at = new Date().toISOString()
  const msg = (id: string, role: Message["role"], text: string): Message => ({
    id,
    session_id: s.id,
    role,
    parts: [{ id: `${id}P`, type: "text", text }],
    created_at: at,
  })
  office.state.messages[s.id] = [
    msg("m1", "user", "Fix the flaky test"),
    msg("m2", "assistant", "Done."),
    msg("m3", "user", "Use a fake clock\nand keep it simple"),
  ]
  return s
}

test("-m sends feedback on the newest session in this folder, found by its real path", async () => {
  const s = sessionInProj()
  // Through a symlink: the folder is its real path, as the office stores it.
  const link = path.join(home, "link")
  symlinkSync(path.join(home, "proj"), link)
  process.chdir(link)
  const r = await feedback("-m", "Good call on the fake clock")
  expect(r).toMatchObject({ code: 0, err: "" })
  expect(posts()).toEqual([{ session_id: s.id, text: "Good call on the fake clock" }])
  expect(r.out).toMatch(/^Feedback \S+ is queued for @minh \(session \S+, run run-b\)$/)
})

test("a run ID picks its session and that run; a session ID picks the session's latest run", async () => {
  const s = sessionInProj()
  expect((await feedback("run-a", "-m", "Too many retries")).code).toBe(0)
  expect((await feedback(s.id, "--turn", "1", "-m", "Nice")).code).toBe(0)
  expect(posts()).toEqual([
    { session_id: s.id, run_id: "run-a", text: "Too many retries" },
    { session_id: s.id, text: 'About turn 1 ("Fix the flaky test"): Nice' },
  ])
})

test("without -m, $EDITOR opens on a template listing the turns; --turn pre-fills About turn N", async () => {
  const s = sessionInProj()
  const seen = path.join(home, "seen.md")
  // The editor keeps the template's first line, adds to it, and saves a copy of what it was given.
  writeFileSync(path.join(home, "ed.sh"), `cp "$1" ${seen}; printf 'mock the clock\\n' >> "$1"\n`)
  process.env.EDITOR = `sh ${path.join(home, "ed.sh")}`
  const r = await feedback(s.id, "--turn", "2")
  expect(r.code).toBe(0)
  const template = await Bun.file(seen).text()
  expect(template.split("\n")[0]).toBe('About turn 2 ("Use a fake clock"): ')
  expect(template).toContain("# Turn 1: Fix the flaky test")
  expect(template).toContain("# Turn 2: Use a fake clock")
  expect(posts()).toEqual([{ session_id: s.id, text: 'About turn 2 ("Use a fake clock"): \n\nmock the clock' }])
})

test("empty feedback isn't sent; no editor and no -m is a usage error; so is a turn that doesn't exist", async () => {
  const s = sessionInProj()
  const noEditor = await feedback(s.id)
  expect(noEditor.code).toBe(2)
  expect(noEditor.err).toContain("$EDITOR")
  writeFileSync(path.join(home, "ed.sh"), `: > "$1"\n`)
  process.env.EDITOR = `sh ${path.join(home, "ed.sh")}`
  const empty = await feedback(s.id)
  expect(empty).toMatchObject({ code: 1, err: "ac feedback: no feedback written; nothing sent" })
  const turn = await feedback(s.id, "--turn", "3", "-m", "x")
  expect(turn.code).toBe(2)
  expect(turn.err).toContain("turn 3")
  const flag = await feedback("--bogus")
  expect(flag.code).toBe(2)
  expect(flag.err).toContain("Usage: ac feedback")
  expect(posts()).toEqual([])
})

test("office errors exit 1: an unknown ID, and no session in this folder", async () => {
  const unknown = await feedback("nope", "-m", "x")
  expect(unknown.code).toBe(1)
  expect(unknown.err).toContain("nope")
  process.chdir(path.join(home, "proj"))
  const none = await feedback("-m", "x")
  expect(none.code).toBe(1)
  expect(none.err).toContain(realpathSync(path.join(home, "proj")))
})

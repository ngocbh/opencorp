/** The office's pin pruning: which pinned worktrees it frees, when, and how it fails and stops. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { CompanyGit } from "../../src/company/git.ts"
import type { Office } from "../../src/daemon/office.ts"
import { git } from "../company/helpers.ts"
import { waitFor } from "../helpers.ts"
import { session } from "../store/helpers.ts"
import { makeOffice } from "./helpers.ts"

setDefaultTimeout(60_000)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Commits `n` edits of a notes file through the office's git; returns the commits made, oldest first. */
async function commits(office: Office, n: number): Promise<string[]> {
  const made: string[] = []
  for (let i = 0; i < n; i++) {
    fs.appendFileSync(path.join(office.paths.company, "notes.md"), `${i}\n`)
    made.push(await office.git.commit(["notes.md"], `notes ${i}`))
  }
  return made
}

/** A pin of `commit` built through another `CompanyGit` on the office's clone, so no window spares it. */
function prebuilt(office: Office, commit: string): Promise<string> {
  return new CompanyGit(office.paths.company, office.paths.worktrees).pin(commit)
}

const pinned = (office: Office, sha: string) => fs.existsSync(path.join(office.paths.worktrees, sha))

/** `office.git.prune` counting its calls, each held until `release` once `hold` is set. */
function countingPrune(office: Office) {
  const real = office.git.prune.bind(office.git)
  const gate = Promise.withResolvers<void>()
  const counter = { calls: 0, hold: false, release: () => gate.resolve() }
  office.git.prune = async (...args) => {
    counter.calls++
    if (counter.hold) await gate.promise
    return real(...args)
  }
  return counter
}

test("watch pins frees the pins of ended sessions and orphans, keeping live ones and head", async () => {
  const office = makeOffice()
  const [a, b, c, d] = await commits(office, 4)
  const s1 = office.store.createSession(session({ repo_commit: a, status: "debriefing" }))
  office.store.createSession(session({ repo_commit: b, status: "ended" }))
  for (const sha of [a!, b!, c!, d!]) await prebuilt(office, sha)
  await office.start()
  office.watchPins()
  await office.prunePins()
  expect([a, b, c, d].map((sha) => pinned(office, sha!))).toEqual([true, false, false, true])
  const list = git(office.paths.company, "worktree", "list", "--porcelain")
  expect(list.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(3)

  office.store.updateSession(s1.id, { status: "ended" })
  await office.prunePins()
  expect(pinned(office, a!)).toBe(false)
  expect(pinned(office, d!)).toBe(true)
})

test("an ended sessions worker record keeps its pin until the worker is forgotten", async () => {
  const office = makeOffice()
  const [b] = await commits(office, 2)
  const s2 = office.store.createSession(session({ repo_commit: b, status: "ended" }))
  office.store.recordWorker(s2.id, { pid: 1, pgid: 1, startTime: 0 })
  office.store.recordWorker("call:x", { pid: 2, pgid: 2, startTime: 0 })
  await prebuilt(office, b!)
  await office.prunePins()
  expect(pinned(office, b!)).toBe(true)

  office.store.removeWorker(s2.id)
  await office.prunePins()
  expect(pinned(office, b!)).toBe(false)
})

test("a pin used just before the end goes once the window passes", async () => {
  const office = makeOffice({ pinGraceMs: 300 })
  const [b] = await commits(office, 2)
  const s = office.store.createSession(session({ repo_commit: b, status: "idle" }))
  await office.git.pin(b!)
  office.watchPins()
  office.store.updateSession(s.id, { status: "ended" })
  await office.prunePins()
  expect(pinned(office, b!)).toBe(true)
  await waitFor(() => !pinned(office, b!), { timeout: 5000, what: "the pin to go" })
})

test("a prune failure logs the error type only and start resolves", async () => {
  const lines: string[] = []
  const office = makeOffice({ log: (line) => lines.push(line) })
  office.git.prune = () => Promise.reject(new TypeError("/secret/path"))
  await office.start()
  office.watchPins()
  await office.prunePins()
  expect(lines).toContain("pin prune failed: TypeError")
  expect(lines.join("\n")).not.toContain("/secret")
})

test("triggers coalesce to at most one queued prune", async () => {
  const office = makeOffice()
  const counter = countingPrune(office)
  counter.hold = true
  const runs = Array.from({ length: 5 }, () => office.prunePins())
  counter.release()
  await Promise.all(runs)
  expect(counter.calls).toBe(2)
})

test("stop aborts pruning and clears the timer", async () => {
  const lines: string[] = []
  const office = makeOffice({ pinGraceMs: 200, log: (line) => lines.push(line) })
  const [b] = await commits(office, 2)
  const s = office.store.createSession(session({ repo_commit: b, status: "idle" }))
  await office.git.pin(b!)
  office.store.updateSession(s.id, { status: "ended" })
  office.watchPins()
  await office.stop()
  const counter = countingPrune(office)
  await sleep(400)
  expect(pinned(office, b!)).toBe(true)
  await office.prunePins()
  office.store.updateSession(s.id, { status: "failed" })
  expect(counter.calls).toBe(0)
  expect(lines).toEqual([])
})

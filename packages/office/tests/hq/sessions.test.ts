/** Browser sessions: hashed, 30 days, checked against the person at HEAD on every request. */
import { createHash } from "node:crypto"
import { inspect } from "node:util"
import { expect, test } from "bun:test"
import { hashPassword } from "../../src/auth/passwords.ts"
import type { CompanyGit } from "../../src/company/git.ts"
import { CompanySnapshots } from "../../src/company/snapshot.ts"
import { HttpError } from "../../src/daemon/http.ts"
import type { Office } from "../../src/daemon/office.ts"
import {
  BrowserSessions,
  Fingerprints,
  type GoneSince,
  type Humans,
  passwordFp,
  passwordFps,
  STREAMS_PER_SESSION,
  TTL,
} from "../../src/hq/sessions.ts"
import { HqSessionRecord } from "../../src/store/store.ts"
import { git } from "../company/helpers.ts"
import { addHuman, makeOffice } from "../daemon/helpers.ts"
import { handEdit } from "./helpers.ts"

const T0 = new Date("2026-10-19T10:00:00Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A clock the test moves by setting `now`. */
class Clock {
  now = T0
  call = (): Date => this.now
}

/** Sessions over `office`'s store and company, on `clock`. */
function sessionsFor(
  office: Office,
  clock = new Clock(),
  load?: (git: CompanyGit, sha: string) => Promise<Humans>,
  goneSince?: GoneSince,
): BrowserSessions {
  return new BrowserSessions(office.store, new CompanySnapshots(office.git), {
    clock: clock.call,
    passwordFps: load,
    goneSince,
  })
}

/** Deletes `handle`'s person file in `company` and commits it. */
function remove(company: string, handle: string): void {
  git(company, "rm", "-q", `people/${handle}/person.yaml`)
  git(company, "commit", "-qm", `remove ${handle}`)
}

/** `CompanyGit.goneSince`, counting its calls. */
function countingGone(): { calls: number; gone: GoneSince } {
  const counter = {
    calls: 0,
    gone: ((git, relpath, from, to) => {
      counter.calls++
      return git.goneSince(relpath, from, to)
    }) as GoneSince,
  }
  return counter
}

/** Resolves once `ready()` is true, polling. */
async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** The `HttpError` `promise` rejects with. */
async function httpError(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error("expected an HttpError")
}

const ISSUE = { issuedBy: "ngocbh", label: null }

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

test("password fp is 16 hex of the hash or empty", () => {
  expect(passwordFp(null)).toBe(sha256("").slice(0, 16))
  expect(passwordFp("$scrypt$x")).toBe(sha256("$scrypt$x").slice(0, 16))
})

test("fingerprints are loaded once per recent commit", async () => {
  const office = makeOffice()
  const loads: string[] = []
  const cache = new Fingerprints(office.git, (g: CompanyGit, sha: string) => {
    loads.push(sha)
    return passwordFps(g, sha)
  })
  const first = await office.git.readHead()
  await Promise.all([cache.at(first), cache.at(first)])
  handEdit(office.paths.company, "ngocbh", { title: "Boss" })
  const second = await office.git.readHead()
  for (const sha of [second, first, second]) await cache.at(sha)
  expect(loads).toEqual([first, second])
})

test("a failed fingerprint load is tried again", async () => {
  const office = makeOffice()
  let loads = 0
  const cache = new Fingerprints(office.git, (g: CompanyGit, sha: string) => {
    loads++
    return loads === 1 ? Promise.reject(new Error("git went away")) : passwordFps(g, sha)
  })
  const sha = await office.git.readHead()
  await expect(cache.at(sha)).rejects.toThrow("git went away")
  const humans = await cache.at(sha)
  expect(humans.fps.get("ngocbh")).toBe(passwordFp(null))
  expect(loads).toBe(2)
})

test("issue keeps only the secrets hash and check finds it", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", { issuedBy: "ngocbh", label: "Safari" })
  const [sid, secret] = cookie.split(".") as [string, string]
  const row = office.store.getHqSession(sid)!
  expect(sid).toBe(pub.id)
  expect(pub.name).toMatch(/^web-[a-z0-9]{6}$/)
  expect(row.secretSha256).toBe(sha256(secret))
  expect(inspect(row)).not.toContain(secret)
  expect(pub.expires_at).toBe(new Date(T0.getTime() + TTL).toISOString())
  const who = await s.check(cookie)
  expect([who?.id, who?.person, who?.name]).toEqual([sid, "ngocbh", pub.name])
  expect(await s.check(`${sid}.wrong`)).toBeNull()
  expect(await s.check("junk")).toBeNull()
  expect(await s.check(null)).toBeNull()
})

test("a wrong secret for a real id revokes nothing", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  expect(await s.check(`${pub.id}.forged`)).toBeNull()
  expect((await s.check(cookie))?.id).toBe(pub.id)
})

test("the cookies id must be the rows", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [, cookie] = await s.issue("ngocbh", ISSUE)
  const [other] = await s.issue("ngocbh", ISSUE)
  expect(await s.check(`${other.id}.${cookie.split(".")[1]}`)).toBeNull()
})

test("only a human at head gets a session", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  for (const handle of ["minh", "nobody"]) {
    const caught = await httpError(s.issue(handle, ISSUE))
    expect([caught.status, caught.code]).toEqual([422, "not_a_human"]) // as on the socket
    // A 422 says which field failed, never its value.
    expect(caught.message).toBe("the person isn't a human in the company at HEAD")
  }
})

test("an expired session is refused and the next issue deletes it", async () => {
  const office = makeOffice()
  const clock = new Clock()
  const s = sessionsFor(office, clock)
  const [old, cookie] = await s.issue("ngocbh", ISSUE)
  clock.now = new Date(T0.getTime() + TTL)
  expect(await s.check(cookie)).toBeNull()
  await s.issue("ngocbh", ISSUE)
  expect(office.store.getHqSession(old.id)).toBeUndefined()
})

test("a password set by any writer ends sessions issued before it", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "ngocbh", { password_hash: await hashPassword("a new password") })
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
})

test("a session issued after the password lives", async () => {
  const office = makeOffice()
  handEdit(office.paths.company, "ngocbh", { password_hash: await hashPassword("a new password") })
  const s = sessionsFor(office)
  const [, cookie] = await s.issue("ngocbh", ISSUE)
  expect(await s.check(cookie)).not.toBeNull()
})

test("a person file that doesnt validate refuses without ending the session", async () => {
  const office = makeOffice()
  const company = office.paths.company
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  handEdit(company, "ngocbh", { nickname: "typo" }) // a field Person doesn't know
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeDefined()
  await httpError(s.issue("ngocbh", ISSUE))
  handEdit(company, "ngocbh", { nickname: undefined })
  expect((await s.check(cookie))?.id).toBe(pub.id)
})

test("proven finds the session a cookie proves", async () => {
  const office = makeOffice()
  const clock = new Clock()
  const s = sessionsFor(office, clock)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  const [other] = await s.issue("ngocbh", ISSUE)
  const secret = cookie.split(".")[1]!
  expect(s.proven(cookie)).toBe(pub.id)
  for (const bad of [`${pub.id}.forged`, `${other.id}.${secret}`, pub.id, secret, "", null, undefined])
    expect(s.proven(bad)).toBeNull()
  clock.now = new Date(T0.getTime() + TTL)
  expect(s.proven(cookie)).toBeNull()
})

test("proven ignores head", async () => {
  const office = makeOffice()
  const company = office.paths.company
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  handEdit(company, "ngocbh", { nickname: "typo" })
  expect(await s.check(cookie)).toBeNull()
  expect(s.proven(cookie)).toBe(pub.id)
  handEdit(company, "ngocbh", { nickname: undefined, kind: "agent" })
  expect(s.proven(cookie)).toBe(pub.id)
  git(company, "rm", "-q", "people/ngocbh/person.yaml")
  git(company, "commit", "-qm", "offboard ngocbh")
  expect(s.proven(cookie)).toBe(pub.id)
  expect(office.store.getHqSession(pub.id)).toBeDefined()
})

test("proven reads no git", async () => {
  const office = makeOffice()
  let loads = 0
  const s = sessionsFor(office, new Clock(), (g, sha) => {
    loads++
    return passwordFps(g, sha)
  })
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  loads = 0
  let heads = 0
  const head = s.snapshots.head.bind(s.snapshots)
  s.snapshots.head = () => {
    heads++
    return head()
  }
  expect(s.proven(cookie)).toBe(pub.id)
  expect([loads, heads]).toEqual([0, 0])
})

test("knows names people at head and unreadable ones", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  expect([await s.knows("ngocbh"), await s.knows("minh"), await s.knows("nobody")]).toEqual([true, true, false])
  handEdit(office.paths.company, "ngocbh", { nickname: "typo" })
  expect(await s.knows("ngocbh")).toBe(true)
})

test("deleting the person ends the session", async () => {
  const office = makeOffice()
  const company = office.paths.company
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  git(company, "rm", "-q", "people/ngocbh/person.yaml")
  git(company, "commit", "-qm", "offboard ngocbh")
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
})

test("removing the person and adding them again, with no check between, ends the session", async () => {
  const office = makeOffice()
  const company = office.paths.company
  addHuman(company, "ann")
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ann", ISSUE)
  remove(company, "ann")
  addHuman(company, "ann") // the same handle, again a human with no password
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
})

test("reverting a removal doesnt bring the session back", async () => {
  const office = makeOffice()
  const company = office.paths.company
  addHuman(company, "ann")
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ann", ISSUE)
  remove(company, "ann")
  git(company, "revert", "--no-edit", "HEAD")
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
})

test("a removal ends the session even when the file added again doesnt validate", async () => {
  const office = makeOffice()
  const company = office.paths.company
  addHuman(company, "ann")
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ann", ISSUE)
  remove(company, "ann")
  addHuman(company, "ann")
  handEdit(company, "ann", { nickname: "typo" })
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
})

test("a reset to before the hire and a hire again ends the session; a rebase with the hire upstream keeps it", async () => {
  const office = makeOffice()
  const company = office.paths.company
  addHuman(company, "ann")
  const s = sessionsFor(office)
  const [first, firstCookie] = await s.issue("ann", ISSUE)
  git(company, "reset", "-q", "--hard", "HEAD~1")
  handEdit(company, "minh", { title: "Lead" }) // else the hire again could be the very same commit
  addHuman(company, "ann")
  expect(await s.check(firstCookie)).toBeNull()
  expect(office.store.getHqSession(first.id)).toBeUndefined()

  handEdit(company, "minh", { title: "Local" }) // a commit not pushed yet
  const [kept, keptCookie] = await s.issue("ann", ISSUE)
  git(company, "branch", "upstream", "HEAD~1")
  git(company, "checkout", "-q", "upstream")
  handEdit(company, "ngocbh", { title: "Upstream" })
  git(company, "checkout", "-q", "main")
  git(company, "rebase", "-q", "upstream")
  expect((await s.check(keptCookie))?.id).toBe(kept.id)
})

test("a session with no issue commit, one that isnt a commit id, or one the clone lacks, ends", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  for (const issuedSha of [null, "", "abc1234", "f".repeat(40)]) {
    const [pub, cookie] = await s.issue("ngocbh", ISSUE)
    const row = office.store.getHqSession(pub.id)!
    office.store.deleteHqSession(pub.id)
    office.store.addHqSession(new HqSessionRecord({ ...row, issuedSha }))
    const fresh = sessionsFor(office) // nothing in memory, as after a restart
    expect(await fresh.check(cookie)).toBeNull()
    expect(office.store.getHqSession(pub.id)).toBeUndefined()
  }
})

test("the history isnt read while HEAD is the issue commit, and once per HEAD, issue commit and person", async () => {
  const office = makeOffice()
  const counter = countingGone()
  const s = sessionsFor(office, new Clock(), undefined, counter.gone)
  const [a, cookieA] = await s.issue("ngocbh", ISSUE)
  const [, sameCommit] = await s.issue("ngocbh", ISSUE)
  await s.check(cookieA)
  await s.check(sameCommit)
  expect(counter.calls).toBe(0)
  handEdit(office.paths.company, "minh", { title: "Lead" })
  const [, cookieB] = await s.issue("ngocbh", ISSUE)
  const sha = await office.git.readHead()
  await Promise.all([s.check(cookieA), s.check(sameCommit), s.stillValid(a.id, sha), s.check(cookieB)])
  await s.check(cookieA)
  expect(counter.calls).toBe(1) // cookieB was issued at HEAD
  handEdit(office.paths.company, "minh", { title: "Head" })
  await Promise.all([s.check(cookieA), s.check(cookieB), s.check(sameCommit)])
  expect(counter.calls).toBe(3)
})

test("a failed history read refuses the check, keeps the session, logs its type and is read again", async () => {
  const office = makeOffice()
  const lines: string[] = []
  let calls = 0
  const s = new BrowserSessions(office.store, new CompanySnapshots(office.git), {
    goneSince: (git, relpath, from, to) => {
      calls++
      return calls === 1 ? Promise.reject(new Error("git went away at /secret")) : git.goneSince(relpath, from, to)
    },
    log: (line) => lines.push(line),
  })
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "minh", { title: "Lead" })
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeDefined()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain("refusing it: Error")
  expect(lines[0]).not.toContain("/secret")
  expect((await s.check(cookie))?.id).toBe(pub.id)
  expect(calls).toBe(2)
})

test("a revoke during the history read wins, in check and in still valid", async () => {
  const office = makeOffice()
  let entered = false
  let gate: Promise<void> | null = null
  const s = sessionsFor(office, new Clock(), undefined, async (git, relpath, from, to) => {
    entered = true
    if (gate !== null) await gate
    return git.goneSince(relpath, from, to)
  })
  const [checked, cookie] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "minh", { title: "Lead" })
  const [streamed] = await s.issue("ngocbh", ISSUE) // issued at another commit, so its history is read on its own
  handEdit(office.paths.company, "minh", { title: "Head" }) // a new HEAD, whose history isnt read yet
  const sha = await office.git.readHead()
  for (const [sid, run] of [
    [checked.id, () => s.check(cookie)],
    [streamed.id, () => s.stillValid(streamed.id, sha)],
  ] as const) {
    let release!: () => void
    gate = new Promise((resolve) => (release = resolve))
    entered = false
    const checking = run()
    await until(() => entered)
    await s.revoke(sid)
    release()
    expect(await checking).toBeFalsy()
  }
})

test("still valid ends the session across a removal and re-add it never saw", async () => {
  const office = makeOffice()
  const company = office.paths.company
  addHuman(company, "ann")
  const s = sessionsFor(office)
  const [pub] = await s.issue("ann", ISSUE)
  remove(company, "ann")
  addHuman(company, "ann") // as if the watcher skipped the removal's commit
  expect(await s.stillValid(pub.id, await office.git.head())).toBe(false)
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
  expect(s.alive(pub.id)).toBe(false)
})

test("issue records HEAD, and refuses a code minted before the person was removed and added again", async () => {
  const office = makeOffice()
  const company = office.paths.company
  addHuman(company, "ann")
  const since = await office.git.readHead()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ann", { ...ISSUE, since })
  expect(office.store.getHqSession(pub.id)!.issuedSha).toBe(since)
  remove(company, "ann")
  addHuman(company, "ann")
  const caught = await httpError(s.issue("ann", { ...ISSUE, since }))
  expect([caught.status, caught.code]).toEqual([422, "not_a_human"])
  expect(caught.message).toBe("the person isn't a human in the company at HEAD")
  await s.issue("ann", { ...ISSUE, since: await office.git.readHead() })
})

test("offboarding ends the session", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [, cookie] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "ngocbh", { kind: "agent" })
  expect(await s.check(cookie)).toBeNull()
})

test("last used is written at most once an hour", async () => {
  const office = makeOffice()
  const clock = new Clock()
  const s = sessionsFor(office, clock)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  await s.check(cookie)
  const first = office.store.getHqSession(pub.id)!.lastUsedAt
  expect(first).not.toBeNull()
  clock.now = new Date(T0.getTime() + 30 * MINUTE)
  await s.check(cookie)
  expect(office.store.getHqSession(pub.id)!.lastUsedAt).toBe(first)
  clock.now = new Date(T0.getTime() + 2 * HOUR)
  await s.check(cookie)
  expect(office.store.getHqSession(pub.id)!.lastUsedAt).not.toBe(first)
})

test("revoking ends the session", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  expect(await s.revoke(pub.id)).toBe(true)
  expect(await s.check(cookie)).toBeNull()
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
})

test("revoking an unknown id keeps no state", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  expect(await s.revoke("01JA1H0000000000000000000Z")).toBe(false)
  expect(s.tracked).toBe(0)
})

test("an expired session is forgotten", async () => {
  const office = makeOffice()
  const clock = new Clock()
  const s = sessionsFor(office, clock)
  const [, cookie] = await s.issue("ngocbh", ISSUE)
  clock.now = new Date(T0.getTime() + TTL)
  expect(await s.check(cookie)).toBeNull()
  expect(s.tracked).toBe(0) // neither the expired entry nor a revoked marker for it stays
})

test("a check that read the row before a revoke still refuses", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  const stale = office.store.getHqSession(pub.id)
  await s.revoke(pub.id)
  // The row as read just before the delete.
  const real = office.store.hqSessionBySecret
  office.store.hqSessionBySecret = () => stale
  try {
    expect(await s.check(cookie)).toBeNull()
  } finally {
    office.store.hqSessionBySecret = real
  }
})

test("a revoke marks the entry a check made while it read the row", async () => {
  const office = makeOffice()
  const [pub, cookie] = await sessionsFor(office).issue("ngocbh", ISSUE)
  const s = sessionsFor(office) // nothing in memory yet, as after a restart
  expect(await s.check(cookie)).not.toBeNull()
  const cut = new AbortController()
  s.open(pub.id, cut)
  expect(await s.revoke(pub.id)).toBe(true)
  // The revoke found the entry the check made and ended its stream: it never replaced or dropped it.
  expect(cut.signal.aborted).toBe(true)
  expect(s.tracked).toBe(1)
  expect(s.alive(pub.id)).toBe(false)
})

test("revoking ends open streams and alive turns false", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  const cuts = [new AbortController(), new AbortController()]
  for (const cut of cuts) s.open(pub.id, cut)
  expect(s.streams(pub.id)).toBe(2)
  expect(s.alive(pub.id)).toBe(true)
  await s.revoke(pub.id)
  expect(cuts.map((cut) => cut.signal.aborted)).toEqual([true, true])
  expect(s.alive(pub.id)).toBe(false)
})

test("a released stream outlives the revoke", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  const cut = new AbortController()
  s.open(pub.id, cut)()
  expect(s.streams(pub.id)).toBe(0)
  await s.revoke(pub.id)
  expect(cut.signal.aborted).toBe(false)
})

test("opening a stream on a session that isnt live ends it", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  await s.revoke(pub.id)
  for (const sid of [pub.id, "unknown"]) {
    const cut = new AbortController()
    s.open(sid, cut)
    expect(cut.signal.aborted).toBe(true)
    expect(s.streams(sid)).toBe(0)
    expect(s.alive(sid)).toBe(false)
  }
})

test("listing a persons sessions ends those a password change ended", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [old] = await s.issue("ngocbh", ISSUE)
  const cut = new AbortController()
  s.open(old.id, cut)
  handEdit(office.paths.company, "ngocbh", { password_hash: await hashPassword("brand new one") })
  const [kept] = await s.issue("ngocbh", ISSUE)
  const listed = await s.listLive("ngocbh")
  expect(listed.map((r) => r.id)).toEqual([kept.id])
  expect(office.store.getHqSession(old.id)).toBeUndefined()
  expect(cut.signal.aborted).toBe(true)
})

test("listing a persons sessions ends those issued before they were removed and added again", async () => {
  const office = makeOffice()
  const company = office.paths.company
  addHuman(company, "ann")
  const s = sessionsFor(office)
  const [old] = await s.issue("ann", ISSUE)
  remove(company, "ann")
  addHuman(company, "ann")
  const [kept] = await s.issue("ann", ISSUE)
  expect((await s.listLive("ann")).map((r) => r.id)).toEqual([kept.id])
  expect(office.store.getHqSession(old.id)).toBeUndefined()
})

test("listing leaves out a session revoked while it read the history", async () => {
  const office = makeOffice()
  let entered = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const s = sessionsFor(office, new Clock(), undefined, async (git, relpath, from, to) => {
    entered = true
    await gate
    return git.goneSince(relpath, from, to)
  })
  const [pub] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "minh", { title: "Lead" })
  const listing = s.listLive("ngocbh")
  await until(() => entered)
  await s.revoke(pub.id)
  release()
  expect(await listing).toEqual([])
})

test("listing a persons sessions while their file cant be read ends none", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "ngocbh", { kind: "robot" })
  const listed = await s.listLive("ngocbh")
  expect(listed.map((r) => r.id)).toEqual([pub.id])
  expect(s.alive(pub.id)).toBe(true)
})

test("a session over its stream cap ends its oldest stream", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  const cuts = Array.from({ length: STREAMS_PER_SESSION + 1 }, () => new AbortController())
  for (const cut of cuts) s.open(pub.id, cut)
  expect(cuts.map((cut) => cut.signal.aborted)).toEqual([true, ...Array(STREAMS_PER_SESSION).fill(false)])
  expect(s.streams(pub.id)).toBe(STREAMS_PER_SESSION)
})

test("releasing a stream twice frees one slot", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  const release = s.open(pub.id, new AbortController())
  s.open(pub.id, new AbortController())
  release()
  release()
  expect(s.streams(pub.id)).toBe(1)
})

test("an expired session with an open stream stays in memory", async () => {
  const office = makeOffice()
  const clock = new Clock()
  const s = sessionsFor(office, clock)
  const [held] = await s.issue("ngocbh", ISSUE)
  const [idle] = await s.issue("ngocbh", ISSUE)
  s.open(held.id, new AbortController())
  clock.now = new Date(T0.getTime() + TTL)
  await s.check("unknown.secret")
  expect(s.tracked).toBe(1)
  expect(s.streams(held.id)).toBe(1)
  expect(s.alive(idle.id)).toBe(false)
})

test("alive turns false at expiry", async () => {
  const office = makeOffice()
  const clock = new Clock()
  const s = sessionsFor(office, clock)
  const [pub] = await s.issue("ngocbh", ISSUE)
  clock.now = new Date(T0.getTime() + TTL)
  expect(s.alive(pub.id)).toBe(false)
})

test("still valid rechecks the person at a new sha", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  expect(await s.stillValid(pub.id, await office.git.head())).toBe(true)
  handEdit(office.paths.company, "ngocbh", { password_hash: await hashPassword("changed it") })
  expect(await s.stillValid(pub.id, await office.git.head())).toBe(false)
  expect(office.store.getHqSession(pub.id)).toBeUndefined()
  expect(s.alive(pub.id)).toBe(false)
})

test("still valid is false for a session that isnt live", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  expect(await s.stillValid("unknown", await office.git.head())).toBe(false)
})

test("still valid refuses without ending while the persons file cant be read", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "ngocbh", { kind: "robot" })
  expect(await s.stillValid(pub.id, await office.git.head())).toBe(false)
  expect(office.store.getHqSession(pub.id)).toBeDefined()
  expect(s.alive(pub.id)).toBe(true)
})

test("a revoke during the fingerprint load wins over a match", async () => {
  const office = makeOffice()
  let entered = false
  let gate: Promise<void> | null = null
  const s = sessionsFor(office, new Clock(), async (g, sha) => {
    entered = true
    if (gate !== null) await gate
    return passwordFps(g, sha)
  })
  const [pub] = await s.issue("ngocbh", ISSUE)
  handEdit(office.paths.company, "ngocbh", { title: "Boss" }) // a new commit, whose fingerprints aren't loaded yet
  let release!: () => void
  gate = new Promise((resolve) => (release = resolve))
  entered = false
  const sha = await office.git.readHead()
  const checking = s.stillValid(pub.id, sha)
  expect(entered).toBe(true)
  await s.revoke(pub.id)
  release()
  expect(await checking).toBe(false)
})

test("a signed in session says so and needs the password it was checked against", async () => {
  const office = makeOffice()
  const company = office.paths.company
  const hash = await hashPassword("the first password")
  handEdit(company, "ngocbh", { password_hash: hash })
  const s = sessionsFor(office)
  expect(await s.passwordHash("ngocbh")).toEqual({ hash, unreadable: false })
  expect(await s.passwordHash("minh")).toEqual({ hash: null, unreadable: false })
  expect(await s.passwordHash("nobody")).toEqual({ hash: null, unreadable: false })
  const login = { ...ISSUE, via: "login" as const, checked: passwordFp(hash) }
  const [pub] = await s.issue("ngocbh", login)
  expect(pub.via).toBe("login")
  expect(office.store.getHqSession(pub.id)!.via).toBe("login")
  handEdit(company, "ngocbh", { password_hash: await hashPassword("changed meanwhile") })
  const caught = await httpError(s.issue("ngocbh", login))
  expect([caught.status, caught.code]).toEqual([409, "password_changed"])
  handEdit(company, "ngocbh", { nickname: "typo" })
  expect(await s.passwordHash("ngocbh")).toEqual({ hash: null, unreadable: true })
})

test("its inspect and json show no secret or fingerprint", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  const secret = cookie.split(".")[1]!
  const row = office.store.getHqSession(pub.id)!
  for (const shown of [inspect(s), JSON.stringify(s)]) {
    for (const hidden of [secret, row.secretSha256, row.passwordFp, row.issuedSha!]) expect(shown).not.toContain(hidden)
  }
  expect(inspect(s)).toBe("BrowserSessions { tracked: 1 }")
  expect(JSON.parse(JSON.stringify(s))).toEqual({ tracked: 1 })
})

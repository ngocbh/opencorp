/** Browser sessions: hashed, 30 days, checked against the person at HEAD on every request. */
import { createHash } from "node:crypto"
import { inspect } from "node:util"
import { expect, test } from "bun:test"
import { hashPassword } from "../../src/auth/passwords.ts"
import type { CompanyGit } from "../../src/company/git.ts"
import { CompanySnapshots } from "../../src/company/snapshot.ts"
import { HttpError } from "../../src/daemon/http.ts"
import type { Office } from "../../src/daemon/office.ts"
import { BrowserSessions, Fingerprints, type Humans, passwordFp, passwordFps, TTL } from "../../src/hq/sessions.ts"
import { git } from "../company/helpers.ts"
import { makeOffice } from "../daemon/helpers.ts"
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
): BrowserSessions {
  return new BrowserSessions(office.store, new CompanySnapshots(office.git), { clock: clock.call, passwordFps: load })
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
  const sub = office.bus.subscribe()
  s.register(pub.id, sub)
  expect(await s.revoke(pub.id)).toBe(true)
  // The revoke found the entry the check made and ended its stream: it never replaced or dropped it.
  expect(await sub.next(1000)).toBeNull()
  expect(s.tracked).toBe(1)
  expect(s.alive(pub.id)).toBe(false)
})

test("revoking ends registered streams and alive turns false", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  const sub = office.bus.subscribe()
  s.register(pub.id, sub)
  expect(s.alive(pub.id)).toBe(true)
  await s.revoke(pub.id)
  expect(await sub.next(1000)).toBeNull()
  expect(s.alive(pub.id)).toBe(false)
})

test("an unregistered stream outlives the revoke", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  const sub = office.bus.subscribe()
  s.register(pub.id, sub)
  s.unregister(pub.id, sub)
  await s.revoke(pub.id)
  expect(office.bus.subscriberCount).toBe(1)
  sub.close()
})

test("registering on a session that isnt live ends the stream", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub] = await s.issue("ngocbh", ISSUE)
  await s.revoke(pub.id)
  for (const sid of [pub.id, "unknown"]) {
    const sub = office.bus.subscribe()
    s.register(sid, sub)
    expect(await sub.next(1000)).toBeNull()
    expect(s.alive(sid)).toBe(false)
  }
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
  expect(await s.passwordHash("ngocbh")).toBe(hash)
  expect(await s.passwordHash("minh")).toBeNull()
  expect(await s.passwordHash("nobody")).toBeNull()
  const login = { ...ISSUE, via: "login" as const, checked: passwordFp(hash) }
  const [pub] = await s.issue("ngocbh", login)
  expect(pub.via).toBe("login")
  expect(office.store.getHqSession(pub.id)!.via).toBe("login")
  handEdit(company, "ngocbh", { password_hash: await hashPassword("changed meanwhile") })
  const caught = await httpError(s.issue("ngocbh", login))
  expect([caught.status, caught.code]).toEqual([409, "password_changed"])
})

test("its inspect and json show no secret or fingerprint", async () => {
  const office = makeOffice()
  const s = sessionsFor(office)
  const [pub, cookie] = await s.issue("ngocbh", ISSUE)
  const secret = cookie.split(".")[1]!
  const row = office.store.getHqSession(pub.id)!
  for (const shown of [inspect(s), JSON.stringify(s)]) {
    for (const hidden of [secret, row.secretSha256, row.passwordFp]) expect(shown).not.toContain(hidden)
  }
  expect(inspect(s)).toBe("BrowserSessions { tracked: 1 }")
  expect(JSON.parse(JSON.stringify(s))).toEqual({ tracked: 1 })
})

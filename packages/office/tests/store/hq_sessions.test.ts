/** Browser sessions on HQ: office-local rows holding a secret's hash, never the secret. */
import { inspect } from "node:util"
import { expect, test } from "bun:test"
import { BrowserSession } from "@opencorp/protocol"
import { DuplicateKey, HqSessionRecord, StoreError, newId } from "../../src/store/store.ts"
import { openStore, recordEvents, thrown } from "./helpers.ts"

const NOW = "2026-10-19T10:00:00.000Z"
const LATER = "2026-11-18T10:00:00.000Z"

/** A session of ngocbh's, paired from Safari, created NOW and expiring LATER, overridden by `over`. */
function record(over?: Partial<ConstructorParameters<typeof HqSessionRecord>[0]>): HqSessionRecord {
  return new HqSessionRecord({
    id: newId(),
    person: "ngocbh",
    name: "web-abc123",
    label: "Safari",
    secretSha256: "a".repeat(64),
    passwordFp: "0".repeat(16),
    issuedSha: "c".repeat(40),
    issuedBy: "ngocbh",
    via: "pair",
    createdAt: NOW,
    expiresAt: LATER,
    lastUsedAt: null,
    ...over,
  })
}

test("a session round trips and is found by its secret hash", () => {
  const store = openStore()
  const r = record()
  store.addHqSession(r)
  expect(store.hqSessionBySecret("a".repeat(64), NOW)).toEqual(r)
  expect(store.getHqSession(r.id)).toEqual(r)
  expect(store.hqSessionBySecret("b".repeat(64), NOW)).toBeUndefined()
})

test("the commit a session was issued at round trips, null included", () => {
  const store = openStore()
  const issued = record({ secretSha256: "1".repeat(64) })
  const old = record({ secretSha256: "2".repeat(64), issuedSha: null })
  store.addHqSession(issued)
  store.addHqSession(old)
  expect(store.getHqSession(issued.id)?.issuedSha).toBe("c".repeat(40))
  expect(store.hqSessionBySecret("1".repeat(64), NOW)?.issuedSha).toBe("c".repeat(40))
  expect(store.getHqSession(old.id)?.issuedSha).toBeNull()
  expect(store.listHqSessions("ngocbh").map((r) => r.issuedSha).sort()).toEqual(["c".repeat(40), null])
})

test("an expired session isnt found by its secret hash", () => {
  const store = openStore()
  store.addHqSession(record())
  expect(store.hqSessionBySecret("a".repeat(64), LATER)).toBeUndefined()
})

test("its public form has no secret hash or fingerprint", () => {
  const pub = record().public()
  expect("secret_sha256" in pub || "password_fp" in pub).toBe(false)
  expect("secretSha256" in pub || "passwordFp" in pub).toBe(false)
  expect("issuedSha" in pub || "issued_sha" in pub).toBe(false)
  expect(pub.via).toBe("pair")
  expect(BrowserSession.safeParse(pub).success).toBe(true)
})

test("its repr has no secret hash or fingerprint", () => {
  const r = record({ secretSha256: "e".repeat(64), passwordFp: "f".repeat(16), issuedSha: "d".repeat(40) })
  for (const text of [inspect(r), JSON.stringify(r)]) {
    expect(text).not.toContain("e".repeat(64))
    expect(text).not.toContain("f".repeat(16))
    expect(text).not.toContain("d".repeat(40))
  }
  expect(inspect(r)).toStartWith("HqSessionRecord {")
  expect(inspect(r)).toContain(r.id)
})

test("a secret hash is unique", () => {
  const store = openStore()
  store.addHqSession(record())
  expect(thrown(() => store.addHqSession(record()))).toBeInstanceOf(DuplicateKey)
})

test("another integrity error is not a duplicate", () => {
  const store = openStore()
  const error = thrown(() => store.addHqSession(record({ person: null as unknown as string })))
  expect(error).toBeInstanceOf(StoreError)
  expect(error).not.toBeInstanceOf(DuplicateKey)
  expect((error as Error).message).toContain("NOT NULL")
})

test("adding one prunes the expired", () => {
  const store = openStore()
  const old = record({ secretSha256: "c".repeat(64), expiresAt: "2026-10-01T00:00:00.000Z" })
  store.addHqSession(old)
  store.addHqSession(record())
  expect(store.getHqSession(old.id)).toBeUndefined()
})

test("list touch delete and prune", () => {
  const store = openStore()
  const a = record({ person: "ngocbh" })
  const b = record({ person: "ann", secretSha256: "d".repeat(64) })
  store.addHqSession(a)
  store.addHqSession(b)
  expect(store.listHqSessions("ann").map((r) => r.id)).toEqual([b.id])
  expect(store.listHqSessions()).toHaveLength(2)
  store.touchHqSession(a.id, "2026-10-19T11:00:00.000Z", "2026-10-19T10:00:00.000Z")
  expect(store.getHqSession(a.id)!.lastUsedAt).toBe("2026-10-19T11:00:00.000Z")
  expect(store.deleteHqSession(a.id)).toBe(true)
  expect(store.deleteHqSession(a.id)).toBe(false)
  expect(store.pruneHqSessions("2999-01-01T00:00:00.000Z")).toBe(1)
  expect(store.listHqSessions()).toEqual([])
})

test("no event is emitted", () => {
  const store = openStore()
  const events = recordEvents(store)
  store.addHqSession(record())
  expect(events).toEqual([])
})

test("touch writes only over an older last used", () => {
  const store = openStore()
  const r = record()
  store.addHqSession(r)
  store.touchHqSession(r.id, "2026-10-19T10:00:00.000Z", "2026-10-19T09:00:00.000Z")
  store.touchHqSession(r.id, "2026-10-19T10:30:00.000Z", "2026-10-19T09:30:00.000Z")
  expect(store.getHqSession(r.id)!.lastUsedAt).toBe("2026-10-19T10:00:00.000Z")
  store.touchHqSession(r.id, "2026-10-19T11:30:00.000Z", "2026-10-19T10:30:00.000Z")
  expect(store.getHqSession(r.id)!.lastUsedAt).toBe("2026-10-19T11:30:00.000Z")
})

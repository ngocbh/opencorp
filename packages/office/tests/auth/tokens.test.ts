/** Device tokens: their format, the bearer header, and the hash table built from people at HEAD. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { Person } from "@opencorp/protocol"
import { stringify } from "yaml"
import type { z } from "zod"
import { Roster, loadRoster } from "../../src/auth/roster.ts"
import { AuthError, authenticate, newToken, tokenSha256 } from "../../src/auth/tokens.ts"
import { readYaml } from "../../src/company/flow_yaml.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { company, git } from "../company/helpers.ts"

function human(handle: string, devices: [string, string][] = [], kind = "human"): z.output<typeof Person> {
  return Person.parse({
    handle,
    name: handle,
    kind,
    title: "T",
    manager: null,
    devices: devices.map(([name, token_sha256]) => ({ name, token_sha256 })),
  })
}

function roster(people: z.output<typeof Person>[] = [], ceo = "ngocbh"): Roster {
  return Roster.of("h", ceo, people)
}

/** The AuthError `call` throws. */
function authError(call: () => unknown): AuthError {
  try {
    call()
  } catch (error) {
    if (error instanceof AuthError) return error
    throw error
  }
  throw new Error("no AuthError thrown")
}

function companyGit(root: string): CompanyGit {
  return new CompanyGit(root, path.join(path.dirname(root), "wt"))
}

test("a token is act and 32 random bytes in base64url", () => {
  const tokens = new Set(Array.from({ length: 100 }, () => newToken()))
  expect(tokens.size).toBe(100)
  for (const t of tokens) expect(t).toMatch(/^act_[A-Za-z0-9_-]{43}$/)
})

test("the hash is the hex sha256 of the whole token", () => {
  const token = newToken()
  expect(tokenSha256(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"))
  // Python's hashlib.sha256(token.encode()).hexdigest() of the same token.
  expect(tokenSha256("act_" + "A".repeat(43))).toBe("ca68123b35d5fd98fc4172f3a97e5841e66d7368ad28e433eb1c6108aa671dab")
})

test("a known token acts as its person and device", () => {
  const token = newToken()
  const r = roster([human("ngocbh", [["mac", tokenSha256(token)]])])
  expect(authenticate(`Bearer ${token}`, r)).toEqual(["ngocbh", "mac"])
  expect(authenticate(`bearer  ${token}`, r)).toEqual(["ngocbh", "mac"]) // the scheme is case-insensitive
})

test("an unknown token is a bad token", () => {
  const r = roster([human("ngocbh", [["mac", tokenSha256(newToken())]])])
  expect(authError(() => authenticate(`Bearer ${newToken()}`, r)).code).toBe("bad_token")
})

test.each([
  [""],
  ["Bearer"],
  ["Bearer "],
  ["Basic abc"],
  ["Token act_x"],
  ["Bearer act_short"],
  ["Bearer " + "x".repeat(47)],
  ["act_" + "a".repeat(43)],
])("a malformed header is a bad token [%s]", (header) => {
  expect(authError(() => authenticate(header, roster())).code).toBe("bad_token")
})

test("errors never contain the token", () => {
  const token = newToken()
  for (const header of [`Bearer ${token}`, `Bearer ${token}x`, `Basic ${token}`]) {
    const error = authError(() => authenticate(header, roster()))
    expect(error.message).not.toContain(token)
    expect(String(error)).not.toContain(token)
  }
})

test("no header is unauthenticated", () => {
  expect(authError(() => authenticate(null, roster())).code).toBe("unauthenticated")
})

test("agents devices are ignored", () => {
  const token = newToken()
  const r = roster([human("minh", [["box", tokenSha256(token)]], "agent")])
  expect(r.enforced).toBe(false)
  authError(() => authenticate(`Bearer ${token}`, r))
})

test("a hash listed by two people is left out", () => {
  const shared = newToken()
  const own = newToken()
  const r = roster([
    human("ngocbh", [["mac", tokenSha256(shared)]]),
    human("ava", [
      ["mac", tokenSha256(shared)],
      ["pc", tokenSha256(own)],
    ]),
  ])
  authError(() => authenticate(`Bearer ${shared}`, r))
  expect(authenticate(`Bearer ${own}`, r)).toEqual(["ava", "pc"])
  expect(r.enforced).toBe(true)
})

test("enforced once any human has a device", () => {
  expect(roster([human("ngocbh")]).enforced).toBe(false)
  expect(roster([human("ngocbh"), human("ava", [["pc", tokenSha256(newToken())]])]).enforced).toBe(true)
})

test("an agent ceo is no ceo", () => {
  expect(roster([human("minh", [], "agent")], "minh").ceo).toBeNull()
  expect(roster([human("ngocbh")]).ceo).toBe("ngocbh")
})

test("the roster is read at a commit", async () => {
  const root = company()
  const g = companyGit(root)
  const token = newToken()
  const file = path.join(root, "people/ngocbh/person.yaml")
  const data = readYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  data.devices = [{ name: "mac", token_sha256: tokenSha256(token) }]
  fs.writeFileSync(file, stringify(data))
  const before = await loadRoster(g, await g.readHead())
  expect([before.ceo, before.enforced]).toEqual(["ngocbh", false]) // the edit isn't committed
  git(root, "commit", "-qam", "device")
  const after = await loadRoster(g, await g.readHead())
  expect(after.head).toBe(await g.head())
  expect(after.enforced).toBe(true)
  expect(authenticate(`Bearer ${token}`, after)).toEqual(["ngocbh", "mac"])
})

test("a broken person file lets no one in through it", async () => {
  const root = company()
  const g = companyGit(root)
  fs.writeFileSync(path.join(root, "people/ngocbh/person.yaml"), "handle: [")
  git(root, "commit", "-qam", "break")
  const r = await loadRoster(g, await g.readHead())
  expect(r.ceo).toBe("ngocbh")
  expect(r.tokens.size).toBe(0)
  expect(r.unreadable).toEqual([{ path: "people/ngocbh/person.yaml", code: "repo.unreadable" }])
})

test("an empty person file counts as one that doesnt load", async () => {
  const root = company()
  const g = companyGit(root)
  fs.writeFileSync(path.join(root, "people/minh/person.yaml"), "")
  git(root, "commit", "-qam", "empty")
  const r = await loadRoster(g, await g.readHead())
  expect(r.unreadable).toEqual([{ path: "people/minh/person.yaml", code: "repo.schema" }])
  expect(r.tokens.size).toBe(0)
})

test("a schema failure is recorded by its code", async () => {
  const root = company()
  const g = companyGit(root)
  fs.appendFileSync(path.join(root, "people/minh/person.yaml"), "nickname: x\n")
  git(root, "commit", "-qam", "extra key")
  const r = await loadRoster(g, await g.readHead())
  // Only the path and the code: an issue's message never reaches the roster.
  expect(r.unreadable).toEqual([{ path: "people/minh/person.yaml", code: "repo.schema" }])
})

test("checking a token takes well under a millisecond", () => {
  const tokens = Array.from({ length: 50 }, () => newToken())
  const r = roster([human("ngocbh", tokens.map((t, i): [string, string] => [`d${i}`, tokenSha256(t)]))])
  const headers = Array.from({ length: 20 }, () => tokens.map((t) => `Bearer ${t}`)).flat()
  // Load only adds time, so the fastest round is the truest cost.
  const rounds = Array.from({ length: 5 }, () => {
    const start = performance.now()
    for (const header of headers) authenticate(header, r)
    return (performance.now() - start) / 1000 / headers.length
  })
  expect(Math.min(...rounds)).toBeLessThan(50e-6)
})

test("a person file in the wrong folder lets no one in", async () => {
  const root = company()
  const g = companyGit(root)
  const misplaced = newToken()
  const nested = newToken()
  const ava = path.join(root, "people/ava/person.yaml")
  // "x" sorts after "person.yaml", so the nested file would replace the real one were it read.
  const extra = path.join(root, "people/ngocbh/x/person.yaml")
  fs.mkdirSync(path.dirname(ava), { recursive: true })
  fs.mkdirSync(path.dirname(extra), { recursive: true })
  const device = (name: string, token: string) => [{ name, token_sha256: tokenSha256(token) }]
  const fields = { handle: "ngocbh", name: "N", kind: "human", title: "T", manager: null }
  fs.writeFileSync(ava, stringify({ ...fields, devices: device("pc", misplaced) }))
  fs.writeFileSync(extra, stringify({ ...fields, devices: device("box", nested) }))
  git(root, "add", "-A")
  git(root, "commit", "-qm", "misplaced")
  const r = await loadRoster(g, await g.readHead())
  expect(r.tokens.size).toBe(0)
  expect(r.enforced).toBe(false)
  // The nested file isn't a person file at all, so only the misplaced one is listed.
  expect(r.unreadable).toEqual([{ path: "people/ava/person.yaml", code: "person.dir_mismatch" }])
  for (const token of [misplaced, nested]) {
    expect(authError(() => authenticate(`Bearer ${token}`, r)).code).toBe("bad_token")
  }
})

/** The company at one commit, from git objects (Python's `tests/company/test_snapshot.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { CompanyGit } from "../../src/company/git.ts"
import { SECRET_KEYS } from "../../src/company/secret_keys.ts"
import { CompanySnapshots, loadCompanyAt } from "../../src/company/snapshot.ts"
import { tempDir } from "../helpers.ts"
import { company, git, makeCompany, person } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A CompanyGit for the repo at `root`, with worktrees beside it. */
function gitOf(root: string): CompanyGit {
  return new CompanyGit(root, path.join(path.dirname(root), "worktrees"))
}

test("people groups and the company come from one commit", async () => {
  const root = company()
  const g = gitOf(root)
  const sha = await g.head()
  fs.writeFileSync(path.join(root, "people/minh/person.yaml"),
    "handle: minh\nname: Changed\nkind: agent\ntitle: X\nmanager: null\n")
  const view = await loadCompanyAt(g, sha) // the uncommitted edit doesn't count
  expect(view.sha).toBe(sha)
  expect(view.company?.ceo).toBe("ngocbh")
  expect(view.people.map((p) => p.handle)).toEqual(["minh", "ngocbh"])
  expect(view.people[0]!.name).toBe("Minh")
  expect(view.groups.map((group) => group.id)).toEqual(["eng"])
  expect(view.issues).toEqual([])
})

test("people are blanked by secret keys", async () => {
  // One constant drives the snapshot and /api/company: a new secret key is blanked here too.
  const g = gitOf(company())
  const sha = await g.head()
  ;(SECRET_KEYS as Set<string>).add("skills")
  try {
    const minh = (await loadCompanyAt(g, sha)).people.find((p) => p.handle === "minh")!
    expect(minh.skills).toEqual([])
    expect(minh.title).toBe("Engineer")
  } finally {
    ;(SECRET_KEYS as Set<string>).delete("skills")
  }
})

test("people come without devices or password hashes", async () => {
  const owner = person("ngocbh", {
    devices: [{ name: "macbook", token_sha256: "a".repeat(64) }],
    password_hash: "$scrypt$ln=15,r=8,p=1$salt$hash",
  })
  const g = gitOf(makeCompany({ "people/ngocbh/person.yaml": owner }))
  const view = await loadCompanyAt(g, await g.head())
  expect(view.people.map((p) => p.handle)).toEqual(["minh", "ngocbh"])
  expect(view.issues).toEqual([])
  expect(view.people.every((p) => p.devices.length === 0 && p.password_hash === null)).toBe(true)
})

test("files that dont parse become issues without quoting them", async () => {
  const g = gitOf(makeCompany({
    "people/ann/person.yaml": "handle: ann\nkind: robot\nname: Ann\ntitle: T\nmanager: null\n",
    "people/bob/person.yaml": "handle: [unclosed\n",
    "people/cat/person.yaml": "handle: dan\nname: C\nkind: human\ntitle: T\nmanager: null\n",
    "groups/ops.yaml": "id: other\nname: Ops\n",
  }))
  const view = await loadCompanyAt(g, await g.head())
  expect(new Set(view.issues.map((i) => `${i.path} ${i.code}`))).toEqual(new Set([
    "people/ann/person.yaml repo.schema",
    "people/bob/person.yaml repo.unreadable",
    "people/cat/person.yaml person.dir_mismatch",
    "groups/ops.yaml repo.file_mismatch",
  ]))
  expect(view.issues.map((i) => i.message).join(" ")).not.toContain("robot") // never the file's own text
  expect(view.people.map((p) => p.handle)).not.toContain("ann")
})

test("a deeply nested file is an issue and the rest still loads", async () => {
  const g = gitOf(makeCompany({ "groups/deep.yaml": "[".repeat(100_000) + "]".repeat(100_000) }))
  const view = await loadCompanyAt(g, await g.head())
  expect(view.issues.map((i) => `${i.path} ${i.code}`)).toEqual(["groups/deep.yaml repo.unreadable"])
  expect(view.people.map((p) => p.handle)).toEqual(["minh", "ngocbh"])
})

test("a missing company file is null and an issue", async () => {
  const g = gitOf(makeCompany({ "company.yaml": null }))
  const view = await loadCompanyAt(g, await g.head())
  expect(view.company).toBeNull()
  expect(view.issues.map((i) => i.code)).toEqual(["repo.unreadable"])
})

test("concurrent callers for a new sha share one load", async () => {
  const g = gitOf(company())
  const real = g.readBlobs.bind(g)
  let calls = 0
  g.readBlobs = async (ids) => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 100))
    return real(ids)
  }
  const snaps = new CompanySnapshots(g)
  const views = await Promise.all(Array.from({ length: 10 }, () => snaps.head()))
  expect(calls).toBe(1)
  expect(views.every((v) => v === views[0])).toBe(true)
  expect(await snaps.head()).toBe(views[0]!) // cached
  expect(calls).toBe(1)
})

test("a new head is loaded once it moves", async () => {
  const root = company()
  const snaps = new CompanySnapshots(gitOf(root))
  const first = await snaps.head()
  git(root, "commit", "-q", "--allow-empty", "-m", "move")
  const second = await snaps.head()
  expect(second!.sha).not.toBe(first!.sha)
  expect(second!.sha).toBe(await gitOf(root).head())
})

test("a failed load is not cached", async () => {
  const g = gitOf(company())
  g.readBlobs = async () => {
    throw new Error("git went away")
  }
  const snaps = new CompanySnapshots(g)
  await expect(snaps.head()).rejects.toThrow("git went away")
  delete (g as Partial<CompanyGit>).readBlobs
  expect((await snaps.head())!.company?.ceo).toBe("ngocbh")
})

test("head is none before the first commit", async () => {
  const root = path.join(tempDir(), "company")
  fs.mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  expect(await new CompanySnapshots(gitOf(root)).head()).toBeNull()
})

/** Loading a company repo's working tree (Python's `tests/company/test_loader.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { loadFlow } from "@ngocbh/yian"
import { type CompanyRepo, loadRepo } from "../../src/company/loader.ts"
import { company, makeCompany, person } from "./helpers.ts"

setDefaultTimeout(30_000)

/** Each error's repo path and code, as `path code`. */
function codes(repo: CompanyRepo): Set<string> {
  return new Set(repo.errors.map((issue) => `${issue.path} ${issue.code}`))
}

test("loads people groups assets", () => {
  const repo = loadRepo(company())
  expect(repo.errors).toEqual([])
  expect(repo.company?.ceo).toBe("ngocbh")
  expect(new Set(repo.people.keys())).toEqual(new Set(["ngocbh", "minh"]))
  expect(repo.people.get("minh")?.handle).toBe("minh")
  expect(repo.people.get("minh")?.kind).toBe("agent")
  expect(repo.groups.get("eng")?.name).toBe("Engineering")
  expect(Object.keys(repo.assets.get("fake")!.tools)).toEqual(["echo"])
})

test("ids are plain strings", () => {
  const minh = loadRepo(company()).people.get("minh")!
  expect(typeof minh.handle).toBe("string")
  expect(typeof minh.manager).toBe("string")
  expect(typeof minh.kind).toBe("string")
})

test("chat flow fixture loads", async () => {
  const file = path.join(company(), "shared/flows/chat.yaml")
  const text = fs.readFileSync(file, "utf8")
  await loadFlow(text, { searchPaths: [path.dirname(file)], sourceLabel: file, env: () => undefined })
})

test("unknown field is a schema error", () => {
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { colour: "blue" }) })
  expect(codes(loadRepo(root))).toContain("people/minh/person.yaml repo.schema")
  expect(loadRepo(root).people.has("minh")).toBe(false)
})

test("handle must match directory", () => {
  const root = makeCompany({ "people/minh/person.yaml": person("minh", { handle: "other" }) })
  const repo = loadRepo(root)
  expect(codes(repo)).toContain("people/minh/person.yaml person.dir_mismatch")
  expect(repo.people.has("minh")).toBe(false)
  expect(repo.people.has("other")).toBe(false)
})

test("people are keyed by handle", () => {
  expect([...loadRepo(company()).people.keys()].sort()).toEqual(["minh", "ngocbh"])
})

test("group id must match file name", () => {
  const root = makeCompany({ "groups/eng.yaml": { id: "ops", name: "Ops" } })
  expect(codes(loadRepo(root))).toContain("groups/eng.yaml repo.file_mismatch")
})

test("malformed yaml is unreadable", () => {
  const root = makeCompany({ "groups/eng.yaml": "id: [eng\n" })
  expect(codes(loadRepo(root))).toContain("groups/eng.yaml repo.unreadable")
})

test("non utf8 file is unreadable", () => {
  const root = makeCompany({ "groups/eng.yaml": new Uint8Array([...Buffer.from("id: "), 0xff, 0xfe, 0x0a]) })
  expect(codes(loadRepo(root))).toContain("groups/eng.yaml repo.unreadable")
})

test("missing company yaml", () => {
  const repo = loadRepo(makeCompany({ "company.yaml": null }))
  expect(repo.company).toBeNull()
  expect(codes(repo)).toContain("company.yaml repo.unreadable")
  expect(repo.errors.find((issue) => issue.path === "company.yaml")?.message).toBe("company.yaml is missing")
})

test("a file that cant be read is unreadable without its path or text", () => {
  const root = makeCompany({
    "groups/x.yaml/keep": "",
    "people/minh/person.yaml": person("minh", { password_hash: ["$SCRYPT$leak"] }),
  })
  const repo = loadRepo(root)
  expect(codes(repo)).toContain("groups/x.yaml repo.unreadable")
  expect(codes(repo)).toContain("people/minh/person.yaml repo.schema")
  expect(repo.errors.find((issue) => issue.path === "groups/x.yaml")?.message).toBe("can't be read")
  for (const issue of repo.errors) {
    expect(issue.message).not.toContain(root)
    expect(issue.message).not.toContain("SCRYPT")
    expect(issue.message).not.toContain("leak")
  }
})

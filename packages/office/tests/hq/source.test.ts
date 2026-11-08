/** HQ's Source routes: GET /api/company/tree and /api/company/file. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { parse, stringify } from "yaml"
import { hashPassword } from "../../src/auth/passwords.ts"
import { git } from "../company/helpers.ts"
import { CEO, makeOffice } from "../daemon/helpers.ts"
import { hqClient, makeHq, signedIn, web } from "./helpers.ts"

const PROFILE = "people/minh/memory/profile.md"

type Body = Record<string, unknown>
type Tree = { commit: { id: string }; entries: unknown[] }

test("both routes need a session", async () => {
  const client = await web(await makeHq(makeOffice()))
  for (const target of ["/api/company/tree", `/api/company/file?at=${"a".repeat(40)}&path=${PROFILE}`]) {
    const r = await client.get(target)
    expect([r.status, (r.json() as Body).error, target]).toEqual([401, "sign_in_required", target])
  }
})

test("the tree and a file at its commit", async () => {
  const office = makeOffice()
  const client = await signedIn(await makeHq(office))
  const r = await client.get("/api/company/tree")
  const tree = r.json() as Tree
  expect(r.status).toBe(200)
  expect(tree.commit.id).toBe(await office.git.head())
  expect(tree.entries).toContainEqual({ path: PROFILE, type: "file", size: "# Minh, Engineer\n".length })
  const file = await client.get("/api/company/file", { query: { at: tree.commit.id, path: PROFILE } })
  expect(file.status).toBe(200)
  expect(file.json()).toEqual({
    path: PROFILE,
    commit: await office.git.head(),
    content: "text",
    text: "# Minh, Engineer\n",
    target: null,
    reason: null,
    rewritten: false,
  })
})

test.each([
  ["no at", { path: PROFILE }, 409, "stale_commit"],
  ["at HEAD by name", { at: "HEAD", path: PROFILE }, 409, "stale_commit"],
  ["no path", { at: "{head}" }, 400, "bad_path"],
  ["a dot dot path", { at: "{head}", path: "people/../company.yaml" }, 400, "bad_path"],
  ["a folder", { at: "{head}", path: "people" }, 404, "no_file"],
  ["a revision expression", { at: "{head}", path: ":company.yaml" }, 404, "no_file"],
] as const)("file errors [%s]", async (_shown, params, status, code) => {
  const office = makeOffice()
  const client = await signedIn(await makeHq(office))
  await client.get("/api/company/tree")
  const head = await office.git.head()
  const query = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.replace("{head}", head)]))
  const r = await client.get("/api/company/file", { query })
  expect([r.status, (r.json() as Body).error]).toEqual([status, code])
})

test("the tree is at the sessions commit", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await signedIn(hq)
  const old = (await hq.snapshots.head())!
  fs.writeFileSync(path.join(office.paths.company, PROFILE), "# moved on\n")
  git(office.paths.company, "commit", "-qam", "move HEAD")
  hq.snapshots.head = async () => old // the commit sessions are checked against
  const r = await client.get("/api/company/tree")
  expect((r.json() as Tree).commit.id).toBe(old.sha)
  expect(old.sha).not.toBe(await office.git.head())
})

test("the guard applies", async () => {
  const hq = await makeHq(makeOffice())
  const client = await signedIn(hq)
  const evil = await hqClient(hq, { headers: { origin: "http://evil.example" } })
  for (const [name, value] of client.cookies) evil.cookies.set(name, value)
  for (const target of ["/api/company/tree", "/api/company/file"])
    expect([(await evil.get(target)).status, target]).toEqual([403, target])
})

test("files reach the browser as stored", async () => {
  const office = makeOffice()
  const client = await signedIn(await makeHq(office))
  const company = office.paths.company
  const file = path.join(company, "people", CEO, "person.yaml")
  const data = parse(fs.readFileSync(file, "utf8")) as Body
  data.devices = [{ name: "mac", token_sha256: "e".repeat(64) }] // a device, not a password: the session lives on
  fs.writeFileSync(file, stringify(data))
  const pasted = `pasted ${await hashPassword("a secret")}\n`
  fs.writeFileSync(path.join(company, PROFILE), pasted)
  git(company, "commit", "-qam", "a device and a pasted hash")
  const at = ((await client.get("/api/company/tree")).json() as Tree).commit.id
  const person = (await client.get("/api/company/file", { query: { at, path: `people/${CEO}/person.yaml` } })).json()
  const shown = person as { content: string; text: string; rewritten: boolean }
  expect([shown.content, shown.text, shown.rewritten]).toEqual(["text", fs.readFileSync(file, "utf8"), false])
  expect(shown.text).toContain("e".repeat(64))
  const profile = (await client.get("/api/company/file", { query: { at, path: PROFILE } })).json() as Body
  expect(profile.text).toBe(pasted)
})

/** Profile routes over `office.profileStore` (a git-blob-versioned file store here). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { parse as parseYaml, stringify } from "yaml"
import { blobId } from "../../src/profile/store.ts"
import { git } from "../company/helpers.ts"
import { recordEvents } from "../store/helpers.ts"
import { blobStores, makeOffice, request, served } from "./helpers.ts"

setDefaultTimeout(30_000)

const MINH = "# Minh, Engineer\n"

type Reply = Awaited<ReturnType<typeof request>>

const blob = (text: string) => blobId(Buffer.from(text))
const errorOf = (reply: Reply) => (reply.json() as { error: string }).error

function put(sock: string, body: unknown): Promise<Reply> {
  return request(sock, "PUT", "/profiles/minh", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Sets `defaults.profile_max_chars` in the working tree's company.yaml. */
function setMaxChars(company: string, chars: number): void {
  const file = path.join(company, "company.yaml")
  const data = parseYaml(fs.readFileSync(file, "utf8")) as { defaults: Record<string, unknown> }
  data.defaults.profile_max_chars = chars
  fs.writeFileSync(file, stringify(data))
}

test("get profile", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  const r = await request(sock, "GET", "/profiles/minh")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ person: "minh", text: MINH, version: blob(MINH), over_budget: false })
})

test("over budget uses company defaults", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  expect((await request(sock, "GET", "/profiles/minh")).json()).toMatchObject({ over_budget: true })
})

test("over budget counts code points", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  setMaxChars(office.paths.company, 5)
  // Three code points, six UTF-16 units: within a budget of five, as Python's len counts.
  const r = await put(sock, { text: "😀😀😀", base_version: blob(MINH) })
  expect(r.status).toBe(200)
  expect(r.json()).toMatchObject({ over_budget: false })
})

test("unknown person is 404", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  for (const r of [
    await request(sock, "GET", "/profiles/ghost"),
    await request(sock, "PUT", "/profiles/ghost", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", base_version: "a".repeat(40) }),
    }),
  ]) {
    expect(r.status).toBe(404)
    expect(errorOf(r)).toBe("not_found")
  }
})

test("put writes emits and returns the profile", async () => {
  const office = makeOffice()
  const stores = blobStores(office)
  const { sock } = await served(office)
  const events = recordEvents(office.store)
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: blob(MINH) })
  expect(r.status).toBe(200)
  const body = r.json() as { text: string; version: string }
  expect(body.text).toBe("# Minh\nterse\n")
  expect(body.version).toBe(blob("# Minh\nterse\n"))
  expect(fs.readFileSync(path.join(office.paths.company, "people/minh/profile.md"), "utf8")).toBe("# Minh\nterse\n")
  expect(stores.get("minh")!.provenance).toEqual([{ source: "hand edit" }])
  const event = events.at(-1)!
  expect([event.type, event.subject_id, event.data]).toEqual(["profile.updated", "minh", body])
})

test("put with stale base is 409 with both versions", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  const stale = blob("old\n")
  const r = await put(sock, { text: "x", base_version: stale })
  expect(r.status).toBe(409)
  expect(r.headers["content-type"]).toStartWith("application/json")
  expect(r.json()).toEqual({ expected: stale, current: blob(MINH) })
  expect(fs.readFileSync(path.join(office.paths.company, "people/minh/profile.md"), "utf8")).toBe(MINH)
})

test("put with bad version is 422", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  const r = await put(sock, { text: "x", base_version: "sha256:abc" })
  expect(r.status).toBe(422)
  expect(errorOf(r)).toBe("invalid_body")
  expect(r.text).not.toContain("sha256:abc")
})

test("no profile store is 501", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  office.profileStore = null
  expect((await request(sock, "GET", "/profiles/minh")).status).toBe(501)
})

test("put checks the person and store before the body", async () => {
  const office = makeOffice()
  blobStores(office)
  const { sock } = await served(office)
  let r = await request(sock, "PUT", "/profiles/ghost", { body: "not json" })
  expect(r.status).toBe(404)
  expect(errorOf(r)).toBe("not_found")
  office.profileStore = null
  r = await request(sock, "PUT", "/profiles/minh", { body: "not json" })
  expect(r.status).toBe(501)
  expect(errorOf(r)).toBe("not_implemented")
})

test("the office profile store defaults to the git store", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await put(sock, { text: "# Minh\nterse\n", base_version: blob(MINH) })
  expect(r.status).toBe(200)
  expect(git(office.paths.company, "log", "-1", "--format=%s")).toBe("profile(@minh): hand edit")
  expect((await request(sock, "GET", "/profiles/minh")).json()).toMatchObject({ version: blob("# Minh\nterse\n") })
})

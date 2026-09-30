import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { createOfficeClient } from "../../src/office/client"
import { OfficeError, VersionConflictError } from "../../src/office/errors"
import { until } from "../fixture/until"

let office: FakeOffice
afterEach(() => office?.stop())
const client = () => createOfficeClient({ socket: office.socket })

test("over_budget follows the profile budget", async () => {
  office = createFakeOffice({ profileMaxChars: 10 })
  expect((await client().profiles.get("minh")).over_budget).toBe(true)
  const p = await client().profiles.get("minh")
  expect((await client().profiles.put("minh", { text: "short", base_version: p.version })).over_budget).toBe(false)
})

test("propose makes one open proposal per session, with a diff against the current version", async () => {
  office = createFakeOffice()
  const s = await client().profiles.manager("minh", { text: "Mention tests" })
  const first = office.propose(s.id, "# Minh\n\nWrites tests first.\n")
  const second = office.propose(s.id, "# Minh\n\nWrites small, tested changes first.\n")
  const list = await client().profiles.proposals("minh")
  expect(list.map((p) => [p.id, p.status])).toEqual([
    [first.id, "discarded"],
    [second.id, "open"],
  ])
  expect(second.base_version).toBe((await client().profiles.get("minh")).version)
  expect(second.diff.split("\n").slice(0, 2)).toEqual(["--- a/people/minh/profile.md", "+++ b/people/minh/profile.md"])
  expect(second.diff).toContain("+Writes small, tested changes first.")
  expect(second.diff).toContain("-Writes small, tested changes.")
})

test("apply writes the profile; a stale base is a 409 and marks the proposal stale", async () => {
  office = createFakeOffice()
  const s = await client().profiles.manager("minh", { text: "x" })
  const ok = office.propose(s.id, "v2\n")
  expect((await client().proposals.apply(ok.id)).text).toBe("v2\n")
  expect(office.state.proposals[ok.id].status).toBe("applied")
  const late = office.propose(s.id, "v3\n")
  const p = await client().profiles.get("minh")
  await client().profiles.put("minh", { text: "hand edit\n", base_version: p.version })
  const err = await client().proposals.apply(late.id).catch((e) => e)
  expect(err).toBeInstanceOf(VersionConflictError)
  expect(office.state.proposals[late.id].status).toBe("stale")
})

test("the manager route answers a starting session and its first turn runs the prompt hooks", async () => {
  office = createFakeOffice()
  const prompts: string[] = []
  office.onPrompt((id, req) => prompts.push(`${id}:${req.text}`))
  const s = await client().profiles.manager("minh", { text: "Mention tests" })
  expect([s.kind, s.status, prompts]).toEqual(["profile_manager", "starting", [`${s.id}:Mention tests`]])
})

test("apply refuses a proposal that isn't open with 409 not_open", async () => {
  office = createFakeOffice()
  const s = await client().profiles.manager("minh", { text: "x" })
  const old = office.propose(s.id, "v2\n")
  const applied = office.propose(s.id, "v3\n")
  await client().proposals.apply(applied.id)
  for (const id of [old.id, applied.id]) {
    const err = await client().proposals.apply(id).catch((e) => e)
    expect(err).toBeInstanceOf(OfficeError)
    expect([err.status, err.code]).toEqual([409, "not_open"])
  }
})

test("apply announces the applied proposal before the new profile", async () => {
  office = createFakeOffice()
  const seen: string[] = []
  const sub = client().events.subscribe((e) => {
    if (e.type === "connected") seen.push("connected")
    if (e.type === "meta") seen.push(e.event.type)
  })
  try {
    await until(() => seen.includes("connected"))
    const s = await client().profiles.manager("minh", { text: "x" })
    await client().proposals.apply(office.propose(s.id, "v2\n").id)
    await until(() => seen.includes("profile.updated"))
    expect(seen.filter((t) => t.startsWith("profile")).slice(-2)).toEqual(["profile_proposal.updated", "profile.updated"])
  } finally {
    sub.close()
  }
})

test("proposals of an unknown person are 404 not_found", async () => {
  office = createFakeOffice()
  const err = await client().profiles.proposals("nobody").catch((e) => e)
  expect([err.status, err.code]).toEqual([404, "not_found"])
})

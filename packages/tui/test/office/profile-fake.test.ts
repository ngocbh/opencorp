import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { createOfficeClient } from "../../src/office/client"
import { VersionConflictError } from "../../src/office/errors"

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

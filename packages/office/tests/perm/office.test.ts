/** Who may manage the office's model connections. */
import { expect, test } from "bun:test"
import { loadRepo } from "../../src/company/loader.ts"
import { mayManageConnections } from "../../src/perm/office.ts"
import { makeCompany } from "../company/helpers.ts"

const AVA = {
  "people/ava/person.yaml": {
    handle: "ava", name: "Ava", kind: "human", title: "Designer", manager: "ngocbh", groups: ["design"],
  },
  "groups/design.yaml": { id: "design", name: "Design", parent: null, head: null },
}

function grant(who: string, can: string[], kind = "office") {
  return {
    "assets/offices.yaml": { id: "offices", kind, tools: { connections: {} }, grants: [{ who, can }] },
  }
}

const CASES: [string, string, string | null, Record<string, unknown>, boolean][] = [
  ["owner", "ava", "ava", {}, true], // the office owner
  ["anyone else", "ava", "ngocbh", {}, false], // anyone else, by default
  ["ceo with an owner", "ngocbh", "ava", {}, false], // the CEO isn't implicit once there is an owner
  ["ceo without an owner", "ngocbh", null, {}, true], // no identity yet: the CEO
  ["not the ceo without an owner", "ava", null, {}, false], // ... and only the CEO
  ["granted", "ava", "ngocbh", grant("ava", ["connections"]), true],
  ["admin via group", "ava", "ngocbh", grant("group:design", ["admin"]), true], // via her group
  ["another group", "minh", "ngocbh", grant("group:design", ["connections"]), false], // another group's grant
  ["not an office asset", "ava", "ngocbh", grant("ava", ["connections"], "cluster"), false], // not an office asset
]

test.each(CASES)("who may manage connections [%s]", (_label, person, owner, assets, ok) => {
  const repo = loadRepo(makeCompany({ ...AVA, ...assets }))
  expect(mayManageConnections(repo, person, { owner })).toBe(ok)
})

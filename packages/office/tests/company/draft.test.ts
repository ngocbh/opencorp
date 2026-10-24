/** A proposed company and its problems. */
import { expect, test } from "bun:test"
import { type Draft, draftFromOutput, draftProblems } from "../../src/company/draft.ts"
import type { Owner } from "../../src/company_template/index.ts"

const ME: Owner = { handle: "ngocbh", name: "Hong Ngoc Bui", title: "CEO", passwordHash: null }
const GOOD: Draft = {
  company: "Acme",
  owner: ME,
  team: [
    { name: "Minh", handle: "minh", title: "Engineer", about: "Writes the backend." },
    { name: "Lan", handle: "lan", title: "QA", about: "" },
  ],
}

test("good answers have no problems", () => {
  expect(draftProblems(GOOD)).toEqual([])
  expect(draftProblems({ company: "Acme", owner: ME, team: [] })).toEqual([])
})

test("a bad owner handle is named with why", () => {
  const problems = draftProblems({ company: "Acme", owner: { handle: "Hong Ngoc", name: "Hong Ngoc Bui" }, team: [] })
  expect(problems).toHaveLength(1)
  expect(problems[0]!.startsWith("@Hong Ngoc ")).toBe(true)
  expect(problems[0]).toContain("pattern")
})

test("a teammate cant take the owners handle", () => {
  const team = [{ name: "Ngoc", handle: "ngocbh", title: "Engineer", about: "" }]
  expect(draftProblems({ company: "Acme", owner: ME, team })).toEqual(["@ngocbh is taken"])
})

test("two teammates cant share a handle", () => {
  const team = [
    { name: "Minh", handle: "minh", title: "Engineer", about: "" },
    { name: "Minh Anh", handle: "minh", title: "QA", about: "" },
  ]
  expect(draftProblems({ company: "Acme", owner: ME, team })).toEqual(["@minh is taken"])
})

const MISSING: [string, Draft][] = [
  ["blank company", { company: " ", owner: ME, team: [] }],
  ["owner without a name", { company: "Acme", owner: { handle: "ngocbh", name: "" }, team: [] }],
  [
    "teammate without a name",
    { company: "Acme", owner: ME, team: [{ name: "", handle: "minh", title: "Engineer", about: "" }] },
  ],
  [
    "teammate without a title",
    { company: "Acme", owner: ME, team: [{ name: "Minh", handle: "minh", title: "", about: "" }] },
  ],
]

test.each(MISSING)("a missing name or title is a problem [%s]", (_, answers) => {
  expect(draftProblems(answers)).toHaveLength(1)
})

test("answers come from the flows output", () => {
  const output = {
    company: "Acme",
    owner: { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" },
    teammates: [
      { name: "Minh", handle: "minh", title: "Engineer", about: "Writes the backend." },
      { name: "Lan", handle: "lan", title: "QA", about: "" },
    ],
  }
  expect(draftFromOutput(output)).toEqual(GOOD)
})

test("a draft takes the password hash from the flows output when it has one", () => {
  const out = { company: "Acme", owner: { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" }, teammates: [] }
  expect(draftFromOutput(out).owner.passwordHash).toBeNull()
  expect(draftFromOutput({ ...out, password_hash: "scrypt$x" }).owner.passwordHash).toBe("scrypt$x")
})

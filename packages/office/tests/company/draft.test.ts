/** A proposed company and its problems. */
import { expect, test } from "bun:test"
import { type Draft, draftProblems, fieldProblems } from "../../src/company/draft.ts"
import type { Owner } from "../../src/company/template.ts"

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

test("the owner and a teammate can't take a name the office speaks as", () => {
  const team = [{ name: "Yian", handle: "yian", title: "Engineer", about: "" }]
  expect(draftProblems({ company: "Acme", owner: { ...ME, handle: "office" }, team })).toEqual([
    "@office can't be a handle: is reserved for the office itself",
    "@yian can't be a handle: is reserved for the office itself",
  ])
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

test("a teammate with a blank name or title needs one", () => {
  const team = [{ name: "  ", handle: "minh", title: "", about: "" }]
  expect(fieldProblems({ company: "Acme", owner: ME, team })).toEqual([
    ["teammate.name", "the teammate @minh needs a name"],
    ["teammate.title", "the teammate @minh needs a title"],
  ])
})

test("a teammate's name and title are one line of text a hire takes", () => {
  const one = (name: string, title: string) =>
    fieldProblems({ company: "Acme", owner: ME, team: [{ name, handle: "minh", title, about: "" }] })
  const broken = "the teammate @minh's name can't hold line breaks or control characters"
  expect(one("Mi\nnh", "Engineer")).toEqual([["teammate.name", broken]])
  expect(one("\u001b[31mMinh", "Engineer")).toEqual([["teammate.name", broken]])
  expect(one("Minh", "x".repeat(201))).toEqual([
    ["teammate.title", "the teammate @minh's title is too long (at most 200 characters)"],
  ])
  expect(one("Minh", "Eng\u2028ineer")).toEqual([
    ["teammate.title", "the teammate @minh's title can't hold line breaks or control characters"],
  ])
  expect(one("  Nguyễn Minh ", "Engineer")).toEqual([])
  // An emoji joined by a zero-width joiner is one line of text, but Yian refuses the joiner in a name.
  expect(one("Nguyễn Minh 👩‍💻", "Engineer")).toEqual([
    ["teammate.name", "@minh's name holds an invisible or control character (U+200D)"],
  ])
})

test("init refuses a teammate whose name or handle reads as another person's, or that Yian refuses, naming both", () => {
  const team = [
    { name: "Kim", handle: "kim", title: "Engineer", about: "" },
    { name: "Kirn", handle: "kirn", title: "QA", about: "" },
    // The first letter is Cyrillic, so the name reads as the owner's.
    { name: "\u041dong Ngoc Bui", handle: "hong", title: "Ops", about: "" },
    { name: "Lan\u200b", handle: "lan", title: "QA", about: "" },
  ]
  expect(fieldProblems({ company: "Acme", owner: ME, team })).toEqual([
    ["teammate.name", `@kirn's name "Kirn" reads as @kim's name "Kim" by Unicode's confusables: Yian can't tell them apart`],
    ["teammate.handle", "@kirn reads as @kim by Unicode's confusables: Yian can't tell them apart"],
    [
      "teammate.name",
      `@hong's name "\u041dong Ngoc Bui" reads as @ngocbh's name "Hong Ngoc Bui" by Unicode's confusables: Yian can't tell them apart`,
    ],
    ["teammate.name", "@lan's name holds an invisible or control character (U+200B)"],
  ])
})

test("init refuses an owner name Yian refuses", () => {
  expect(fieldProblems({ company: "Acme", owner: { ...ME, name: "Office" }, team: [] })).toEqual([
    ["owner.name", "@ngocbh's name is reserved: nothing is signed yian or office"],
  ])
})

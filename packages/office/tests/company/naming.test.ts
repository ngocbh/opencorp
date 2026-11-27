/** Naming rules: person handles, and people's names and handles as Yian reads them. */
import { expect, test } from "bun:test"
import { handleProblem, labelProblems, RESERVED_HANDLES, reservedHandle } from "../../src/company/naming.ts"

test("a good handle has no problem", () => {
  expect(handleProblem("minh-anh")).toBeNull()
})

test("a bad handle says why", () => {
  const problem = handleProblem("Hong Ngoc")
  expect(problem).toContain("pattern")
  expect(problem).not.toContain("Hong Ngoc")
})

test("the names the office and Yian speak as are reserved, whatever their case", () => {
  expect([...RESERVED_HANDLES]).toEqual(["office", "opencorp", "yian"])
  for (const handle of RESERVED_HANDLES) expect(handleProblem(handle)).toBe("is reserved for the office itself")
  expect(reservedHandle("Office")).toBe(true)
  expect(reservedHandle("OPENCORP")).toBe(true)
  expect(reservedHandle("offices")).toBe(false)
  expect(handleProblem("offices")).toBeNull()
})

test("a name that reads as another person's by Unicode's confusables is a problem naming both: a Cyrillic lookalike", () => {
  // The first letter of the second name is Cyrillic.
  expect(labelProblems([{ handle: "ada", name: "Ada" }, { handle: "ada-2", name: "\u0410da" }])).toEqual([
    {
      index: 1,
      field: "name",
      kind: "clash",
      message: `@ada-2's name "\u0410da" reads as @ada's name "Ada" by Unicode's confusables: Yian can't tell them apart`,
    },
  ])
})

test("Kim and Kirn read alike, as names and as handles", () => {
  expect(labelProblems([{ handle: "kim", name: "Kim" }, { handle: "kirn", name: "Kirn" }])).toEqual([
    {
      index: 1,
      field: "name",
      kind: "clash",
      message: `@kirn's name "Kirn" reads as @kim's name "Kim" by Unicode's confusables: Yian can't tell them apart`,
    },
    {
      index: 1,
      field: "handle",
      kind: "clash",
      message: "@kirn reads as @kim by Unicode's confusables: Yian can't tell them apart",
    },
  ])
})

test("a name holding an invisible character is refused with Yian's reason, and reads as no one", () => {
  expect(labelProblems([{ handle: "ada", name: "Ada" }, { handle: "ada-2", name: "Ada\u200b" }])).toEqual([
    {
      index: 1,
      field: "name",
      kind: "refused",
      message: "@ada-2's name holds an invisible or control character (U+200B)",
    },
  ])
})

test("names Yian refuses alone are problems; a person's own name and handle may read alike", () => {
  const people = [
    { handle: "minh", name: "Minh" },
    { handle: "minh-2", name: "minh" },
    { handle: "r1", name: "Yian" },
    { handle: "lan", name: "Lan" },
    { handle: "ian", name: "Ian" },
  ]
  expect(labelProblems(people).map(({ index, field, kind, message }) => [index, field, kind, message])).toEqual([
    [1, "name", "clash", `@minh-2's name "minh" reads as @minh's name "Minh" ignoring case and width: Yian can't tell them apart`],
    [2, "name", "refused", "@r1's name is reserved: nothing is signed yian or office"],
    [2, "handle", "refused", "@r1's handle reads as a child run's (<flow> r<n>)"],
  ])
})

test("a handle that isn't one, or is reserved, or is taken twice is left to those checks", () => {
  const people = [
    { handle: "minh", name: "Minh" },
    { handle: "minh", name: "Minh Anh" },
    { handle: "office", name: "Desk" },
    { handle: "Hong Ngoc", name: "Hong" },
  ]
  expect(labelProblems(people)).toEqual([])
})

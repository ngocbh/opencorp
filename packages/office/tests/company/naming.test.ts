/** Naming rules: person handles. */
import { expect, test } from "bun:test"
import { handleProblem, RESERVED_HANDLES, reservedHandle } from "../../src/company/naming.ts"

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

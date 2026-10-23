/** Naming rules: person handles. */
import { expect, test } from "bun:test"
import { handleProblem } from "../../src/company/naming.ts"

test("a good handle has no problem", () => {
  expect(handleProblem("minh-anh")).toBeNull()
})

test("a bad handle says why", () => {
  const problem = handleProblem("Hong Ngoc")
  expect(problem).toContain("pattern")
  expect(problem).not.toContain("Hong Ngoc")
})

import { expect, test } from "bun:test"
import { costCapArgument, dollars } from "../../src/component/cost-cap"

test("costCapArgument finds the command in any case, with or without an amount", () => {
  expect(costCapArgument("/cost-cap 20")).toBe("20")
  expect(costCapArgument("  /Cost-Cap  $12.50 ")).toBe("$12.50")
  expect(costCapArgument("/cost-cap")).toBe("")
  expect(costCapArgument("/cost-capped")).toBeUndefined()
  expect(costCapArgument("raise the /cost-cap 20")).toBeUndefined()
})

test("dollars takes only positive decimal numbers", () => {
  expect(dollars("20")).toBe(20)
  expect(dollars("$12.50")).toBe(12.5)
  expect(dollars(" 0.5 ")).toBe(0.5)
  for (const bad of ["0x10", "0b11", "0o7", "1e3", "Infinity", "", "0", "-5", "abc", "1.2.3"])
    expect(dollars(bad)).toBeUndefined()
})

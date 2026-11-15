/** The checkout this code runs from. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { CHECKOUT } from "../../src/util/checkout.ts"

test("CHECKOUT is the checkout that holds the office package", () => {
  expect(fs.existsSync(path.join(CHECKOUT, "packages/office/package.json"))).toBe(true)
  expect(fs.existsSync(path.join(CHECKOUT, "packages/cli/bin/opencorp"))).toBe(true)
})

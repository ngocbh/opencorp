/** The checkout this code runs from. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { CHECKOUT, binaryCheckout } from "../../src/util/checkout.ts"

test("CHECKOUT is the checkout that holds the office package", () => {
  expect(fs.existsSync(path.join(CHECKOUT, "packages/office/package.json"))).toBe(true)
  expect(fs.existsSync(path.join(CHECKOUT, "packages/cli/bin/opencorp"))).toBe(true)
})

test("a binary built in a checkout's dist belongs to that checkout, and any other binary to none", () => {
  for (const host of ["linux-x64", "darwin-arm64"])
    expect(binaryCheckout(`/home/o/opencorp/packages/cli/dist/npm/opencorp-${host}/bin/opencorp`)).toBe(
      "/home/o/opencorp",
    )
  expect(binaryCheckout("/a b/c/packages/cli/dist/npm/opencorp-linux-arm64/bin/opencorp")).toBe("/a b/c")
  for (const other of [
    "/usr/lib/node_modules/opencorp-linux-x64/bin/opencorp",
    "/home/o/opencorp/packages/cli/dist/npm/opencorp/bin/opencorp",
    "/home/o/opencorp/packages/cli/dist/npm/opencorp-linux-x64/bin/opencorp-old",
    "/home/o/opencorp/packages/cli/dist/out/opencorp-linux-x64/bin/opencorp",
    "/home/o/opencorp/packages/cli/bin/opencorp",
    "/packages/cli/dist/npm/opencorp-linux-x64/bin/opencorp",
    "packages/cli/dist/npm/opencorp-linux-x64/bin/opencorp",
  ])
    expect(binaryCheckout(other), other).toBeNull()
})

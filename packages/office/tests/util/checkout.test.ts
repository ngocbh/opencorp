/** The checkout this code runs from. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { BUILT_FROM, CHECKOUT, binaryCheckout, newestSource, sourceRoots } from "../../src/util/checkout.ts"
import { tempDir } from "../helpers.ts"

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

test("the newest source covers the office protocol cli and yian", () => {
  const checkout = path.join(tempDir(), "checkout")
  const entry = path.join(checkout, "packages/cli/src/main.ts")
  const files: [string, number][] = [
    [entry, 100],
    [path.join(checkout, "packages/office/src/daemon/x.ts"), 200],
    [path.join(checkout, "packages/protocol/src/y.ts"), 300],
    [path.join(checkout, "packages/yian/src/deep/er/z.ts"), 400],
    [path.join(checkout, "packages/app/src/later.ts"), 900], // not code the office runs
    [path.join(checkout, "packages/cli/dist/npm/opencorp-linux-x64/bin/opencorp"), 950], // a build, not source
  ]
  for (const [file, when] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "")
    fs.utimesSync(file, when, when)
  }
  expect(newestSource(checkout)).toBe(400_000)
  fs.utimesSync(entry, 500, 500)
  expect(newestSource(checkout)).toBe(500_000)
  expect(newestSource(path.join(tempDir(), "no-checkout"))).toBe(0)
})

test("every source root exists in this checkout", () => {
  const missing = sourceRoots(CHECKOUT).filter((root) => !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
  expect(missing).toEqual([])
})

test("code run from source has no build's stamp", () => {
  // The build stamps the binary with its checkout's newest source; Bun on the source has none.
  expect(BUILT_FROM).toBeNull()
})

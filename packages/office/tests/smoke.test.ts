/** The office package imports next to yian; also covers the mode dispatch and the test helpers. */
import fs from "node:fs"
import { expect, test } from "bun:test"
import { runFlow } from "@ngocbh/yian"
import pkg from "../package.json" with { type: "json" }
import * as office from "../src/main.ts"
import { shortDir, tempDir, waitFor } from "./helpers.ts"

test("office and composer import", () => {
  expect(pkg.version).toBe("0.0.1")
  for (const mode of ["officeMain", "daemonMain", "workerMain", "fsHelperMain", "installMain"] as const)
    expect(typeof office[mode]).toBe("function")
  expect(typeof runFlow).toBe("function")
})

test("each office mode is a stub until its item lands, and an unknown mode exits 2", async () => {
  const errors: string[] = []
  const saved = console.error
  console.error = (...args: unknown[]) => void errors.push(args.join(" "))
  try {
    for (const mode of ["daemon", "__worker", "__fs-helper", "install"]) {
      errors.length = 0
      expect(await office.officeMain([mode, "x"])).toBe(1)
      expect(errors).toEqual([`opencorp ${mode}: not built yet`])
    }
    for (const argv of [["nope"], [], ["__proto__"], ["toString"]]) {
      errors.length = 0
      expect(await office.officeMain(argv)).toBe(2)
      expect(errors).toEqual(["opencorp: unknown office mode"])
    }
  } finally {
    console.error = saved
  }
})

// bun runs a file's tests in order, one at a time, so the next test sees these paths.
let helperDirs: string[] = []

test("the test helpers wait for a value and make short dirs that go away", async () => {
  expect(await waitFor(() => 7)).toBe(7)
  await expect(waitFor(() => 0, { timeout: 50, what: "zero" })).rejects.toThrow("timed out waiting for zero")
  const short = shortDir()
  expect(fs.existsSync(short)).toBe(true)
  expect(short).toMatch(/^(\/private)?\/tmp\/oc-/)
  expect(Buffer.byteLength(short)).toBeLessThan(30)
  const temp = tempDir()
  expect(fs.existsSync(temp)).toBe(true)
  expect(fs.realpathSync(temp)).toBe(temp)
  helperDirs = [short, temp]
})

test("the test helpers dirs are gone once their test ends", () => {
  expect(helperDirs).toHaveLength(2)
  for (const dir of helperDirs) expect(fs.existsSync(dir)).toBe(false)
})

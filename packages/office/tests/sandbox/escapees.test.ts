/** The macOS escapee sweep's canary directories. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { Canary } from "../../src/sandbox/escapees.ts"

// The run tests cover the sweep itself (a setsid child dies with the call).
const macOnly = test.skipIf(process.platform !== "darwin")

macOnly("canary directories exist until closed", () => {
  const canary = new Canary()
  try {
    expect(fs.statSync(canary.allowed).isDirectory() && fs.statSync(canary.denied).isDirectory()).toBe(true)
    expect(path.dirname(canary.allowed)).toBe(canary.root)
    expect(path.dirname(canary.denied)).toBe(canary.root)
  } finally {
    canary.close()
  }
  expect(fs.existsSync(canary.root)).toBe(false)
})

macOnly("canary is created outside writable paths", () => {
  // Under a writable path, `denied` would be writable too and nothing would match.
  const tmp = fs.realpathSync(os.tmpdir())
  const canary = new Canary([tmp])
  try {
    expect(canary.root === tmp || canary.root.startsWith(tmp + path.sep)).toBe(false)
  } finally {
    canary.close()
  }
})

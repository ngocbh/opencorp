import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createFakeOffice, type FakeOffice } from "@opencorp/tui/fake-office"
import { tui, TUI_USAGE } from "../src/commands/tui"

let office: FakeOffice
let home: string
const saved = process.env.OPENCORP_HOME
beforeEach(() => {
  // Short, under /tmp: macOS caps socket paths at 104 bytes.
  home = fs.mkdtempSync("/tmp/oct-")
  fs.mkdirSync(path.join(home, "office"))
  process.env.OPENCORP_HOME = home
  office = createFakeOffice({ socket: path.join(home, "office", "office.sock") })
})
afterEach(() => {
  office.stop()
  if (saved === undefined) delete process.env.OPENCORP_HOME
  else process.env.OPENCORP_HOME = saved
  fs.rmSync(home, { recursive: true, force: true })
})

/** Runs `tui(argv, deps)`, capturing what it writes to stdout and stderr. */
async function capture(argv: string[], deps: Parameters<typeof tui>[1]) {
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    return { code: await tui(argv, deps), out, err }
  } finally {
    console.log = log
    console.error = error
  }
}

test("without a terminal the TUI refuses in one line and sends nothing", async () => {
  const r = await capture(["--prompt", "hi"], { terminal: () => false, assetRoot: () => undefined })
  expect(r.code).toBe(1)
  expect(r.err).toHaveLength(1)
  expect(r.err[0]).toStartWith("opencorp: the TUI needs a terminal")
  expect(office.requests).toEqual([])
})

test("a missing assets folder is one line naming it, before the terminal or the office", async () => {
  const r = await capture([], { terminal: () => true, assetRoot: () => "/nowhere/assets" })
  expect(r.code).toBe(1)
  expect(r.err).toHaveLength(1)
  expect(r.err[0]).toContain("/nowhere/assets")
  expect(office.requests).toEqual([])
})

test("a file, or a symlink loop, where the assets folder goes is refused in one line too", async () => {
  const file = path.join(home, "assets-file")
  fs.writeFileSync(file, "")
  const loop = path.join(home, "assets-loop")
  fs.symlinkSync(loop, loop)
  for (const root of [file, loop]) {
    const r = await capture([], { terminal: () => true, assetRoot: () => root })
    expect(r.code).toBe(1)
    expect(r.err).toEqual([
      `opencorp: this binary's assets folder (${root}) is missing or unreadable; reinstall opencorp, ` +
        "or keep bin/ and assets/ together",
    ])
  }
  expect(office.requests).toEqual([])
})

test("an assets folder that is there passes on to the terminal check", async () => {
  const r = await capture([], { terminal: () => false, assetRoot: () => home })
  expect(r.code).toBe(1)
  expect(r.err[0]).toStartWith("opencorp: the TUI needs a terminal")
})

test("a usage error stays 2 and --help 0, whatever the terminal and the assets", async () => {
  const bad = await capture(["--bogus"], { terminal: () => false, assetRoot: () => "/nowhere/assets" })
  expect(bad.code).toBe(2)
  const help = await capture(["--help"], { terminal: () => false, assetRoot: () => "/nowhere/assets" })
  expect(help).toEqual({ code: 0, out: [TUI_USAGE], err: [] })
  expect(office.requests).toEqual([])
})

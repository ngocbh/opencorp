/** The compatibility key and the built app's id. */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { apiId } from "@opencorp/protocol/version"
import { BuildInfo, CHECKOUT, officeApi } from "../../src/hq/version.ts"
import { tempDir } from "../helpers.ts"

test("in a checkout the key is the version and the schema hash", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(CHECKOUT, "packages/cli/package.json"), "utf8"))
  const key = officeApi()
  expect(key).toBe(apiId())
  expect(key.startsWith(`${version}+`)).toBe(true)
  expect(key.slice(version.length + 1)).toMatch(/^[0-9a-f]{12}$/u)
  expect(officeApi()).toBe(key)
})

test("build json is parsed again only when its content changes", () => {
  const tmp = tempDir()
  const info = new BuildInfo(tmp)
  expect(info.read()).toBeNull()
  const file = path.join(tmp, "build.json")
  // Same size and, on Linux's coarse inode clock, often the same mtime: only the bytes tell b1 and b2 apart.
  fs.writeFileSync(file, JSON.stringify({ build: "b1", api: "0.0.1+abc" }))
  const first = info.read()
  expect(first?.build).toBe("b1")
  expect(info.read()).toBe(first!) // unchanged bytes: the parsed copy is kept
  fs.writeFileSync(file, JSON.stringify({ build: "b2", api: "0.0.1+abc" }))
  expect(info.read()?.build).toBe("b2")
  fs.writeFileSync(file, "{")
  expect(info.read()).toBeNull()
  fs.unlinkSync(file)
  expect(info.read()).toBeNull()
  expect(new BuildInfo(null).read()).toBeNull()
})

test("build json that is too big too deep or not a file is invalid", () => {
  const tmp = tempDir()
  const info = new BuildInfo(tmp)
  const file = path.join(tmp, "build.json")
  fs.writeFileSync(file, " ".repeat(64 * 1024) + JSON.stringify({ build: "b1", api: "x" })) // valid, but too big
  expect(info.read()).toBeNull()
  fs.writeFileSync(file, "[".repeat(30_000) + "]".repeat(30_000))
  expect(info.read()).toBeNull()
  fs.unlinkSync(file)
  fs.mkdirSync(file)
  expect(info.read()).toBeNull()
})

test("build json that is a fifo is invalid without blocking", () => {
  const tmp = tempDir()
  const file = path.join(tmp, "build.json")
  execFileSync("mkfifo", [file])
  // A read-write open of a FIFO never blocks, yet counts as a writer for a reader blocked in
  // `open`; so a regression that drops O_NONBLOCK fails the timing check instead of hanging.
  const child = spawn("sh", ["-c", 'sleep 3; : <> "$0"', file], { detached: true, stdio: "ignore" })
  onTestFinished(() => {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
  })
  const start = performance.now()
  expect(new BuildInfo(tmp).read()).toBeNull()
  // A blocked open would take about 3 s, until the bounded writer frees it.
  expect(performance.now() - start).toBeLessThan(2_000)
})

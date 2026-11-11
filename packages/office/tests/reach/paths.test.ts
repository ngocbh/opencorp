/** The saved path's folder under the home, and the limits SSH puts on the home's path. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { MAX_HOME_BYTES, makeDirs, pathProblem, ReachPaths } from "../../src/reach/paths.ts"
import { PrivateFileError } from "../../src/secrets.ts"
import { shortDir } from "../helpers.ts"

test("the hq folder holds every file the design names", () => {
  const paths = new ReachPaths("/h")
  expect(paths.home).toBe("/h")
  expect(paths.dir).toBe("/h/hq")
  expect({
    script: paths.script,
    approved: paths.approved,
    candidate: paths.candidate,
    notes: paths.notes,
    access: paths.access,
    provider: paths.provider,
    ssh: paths.ssh,
    config: paths.config,
    batchConfig: paths.batchConfig,
    bin: paths.bin,
    wrapper: paths.wrapper,
    status: paths.status(42),
    cm: paths.cm,
    node: paths.node,
    lock: paths.lock,
  }).toEqual({
    script: "/h/hq/reach.sh",
    approved: "/h/hq/reach.approved.sh",
    candidate: "/h/hq/reach.new.sh",
    notes: "/h/hq/notes.md",
    access: "/h/hq/access.json",
    provider: "/h/hq/provider.json",
    ssh: "/h/hq/ssh",
    config: "/h/hq/ssh/config",
    batchConfig: "/h/hq/ssh/config.batch",
    bin: "/h/hq/ssh/bin",
    wrapper: "/h/hq/ssh/bin/ssh",
    status: "/h/hq/ssh/status.42",
    cm: "/h/hq/cm",
    node: "/h/hq/cm/node",
    lock: "/h/hq/lock",
  })
})

test("a home of 39 bytes fits the control sockets and one of 40 doesn't", () => {
  expect(MAX_HOME_BYTES).toBe(39)
  const fits = "/tmp/" + "a".repeat(34)
  expect(Buffer.byteLength(fits)).toBe(39)
  expect(pathProblem(new ReachPaths(fits))).toBeNull()
  // The longest control socket ssh binds under it, `<cm>/<40 hex>.<16 random>`, fits macOS's 104 bytes with its NUL.
  expect(Buffer.byteLength(`${fits}/hq/cm/${"f".repeat(40)}.${"x".repeat(16)}`) + 1).toBe(104)
  const problem = pathProblem(new ReachPaths(fits + "a"))
  expect(problem).toContain("OPENCORP_HOME")
  expect(problem).toContain("40 bytes")
  expect(problem).toContain("39")
  expect(problem).toContain("104")
})

test("a home with a space or a percent sign is refused, naming OPENCORP_HOME", () => {
  for (const home of ["/tmp/a b", "/tmp/a%C", "/tmp/a:b", "relative"]) {
    const problem = pathProblem(new ReachPaths(home))
    expect([home, problem]).toEqual([home, expect.stringContaining("OPENCORP_HOME")])
    expect(problem).toContain("unquoted")
  }
})

test("makeDirs makes each folder 0700 and refuses one open to others", () => {
  const paths = new ReachPaths(path.join(shortDir(), "h"))
  makeDirs(paths)
  for (const dir of [paths.dir, paths.ssh, paths.bin, paths.cm]) expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  makeDirs(paths)
  fs.chmodSync(paths.cm, 0o755)
  expect(() => makeDirs(paths)).toThrow(PrivateFileError)
})

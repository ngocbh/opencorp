/** The env names the office's processes inherit, and finding a program on a PATH. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { INHERITED_ENV, which } from "../../src/util/env.ts"
import { tempDir } from "../helpers.ts"

test("the inherited env names are the ones a worker and the daemon share", () => {
  expect([...INHERITED_ENV]).toEqual(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"])
})

test("which finds a runnable program on the absolute path entries only", () => {
  const dir = tempDir()
  const [folder, plain, runnable, second, links] = ["folder", "plain", "runnable", "second", "links"].map((name) =>
    path.join(dir, name),
  )
  for (const entry of [folder, plain, runnable, second, links]) fs.mkdirSync(entry!)
  fs.mkdirSync(path.join(folder!, "prog"))
  fs.writeFileSync(path.join(plain!, "prog"), "#!/bin/sh\n", { mode: 0o644 })
  for (const entry of [runnable, second]) fs.writeFileSync(path.join(entry!, "prog"), "#!/bin/sh\n", { mode: 0o755 })
  fs.symlinkSync(path.join(runnable!, "prog"), path.join(links!, "prog"))

  const searchPath = [path.relative(process.cwd(), runnable!), folder, plain, runnable, second].join(":")
  expect(which("prog", searchPath)).toBe(path.join(runnable!, "prog"))
  expect(which("prog", [folder, plain].join(":"))).toBeNull()
  expect(which("prog", undefined)).toBeNull()
  expect(which("prog", links)).toBe(path.join(links!, "prog"))

  expect(which(path.join(second!, "prog"), "")).toBe(path.join(second!, "prog"))
  expect(which(path.join(plain!, "prog"), runnable)).toBeNull()
  expect(which(path.join(folder!, "prog"), runnable)).toBeNull()
  expect(which("./prog", runnable)).toBeNull()
})

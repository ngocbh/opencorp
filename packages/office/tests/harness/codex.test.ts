/** Starting and stopping one app-server: its command. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { CodexMissing, codexCommand } from "../../src/harness/codex.ts"
import { tempDir } from "../helpers.ts"

/** Writes an empty shell script at `file` with `mode`. */
function script(file: string, mode = 0o755) {
  fs.writeFileSync(file, "#!/bin/sh\n")
  fs.chmodSync(file, mode)
}

/** The error `fn` throws. */
function thrown(fn: () => unknown): Error {
  try {
    fn()
  } catch (e) {
    return e as Error
  }
  throw new Error("did not throw")
}

test("codex command finds codex on the office path", () => {
  const dir = tempDir()
  script(path.join(dir, "codex"))
  expect(codexCommand({ PATH: dir }, {})).toEqual([path.join(dir, "codex"), "app-server", "--listen", "stdio://"])
  const e = thrown(() => codexCommand({ PATH: path.join(dir, "empty") }, {}))
  expect(e).toBeInstanceOf(CodexMissing)
  expect(e.message).toContain("isn't installed")
})

test("opencorp codex bin names another codex", () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "bin"))
  const other = path.join(dir, "bin", "codex-dev")
  script(other)
  const empty = { PATH: path.join(dir, "empty") }
  expect(codexCommand(empty, { OPENCORP_CODEX_BIN: other })[0]).toBe(other)
  expect(codexCommand({ PATH: path.join(dir, "bin") }, { OPENCORP_CODEX_BIN: "codex-dev" })[0]).toBe(other)
  const e = thrown(() => codexCommand(empty, { OPENCORP_CODEX_BIN: "codex-dev" }))
  expect(e).toBeInstanceOf(CodexMissing)
  expect(e.message).toContain("OPENCORP_CODEX_BIN names codex-dev, which isn't an executable")
  expect(e.message).toContain("unset it")
  expect(e.message).not.toContain("npm")
})

test("a directory, a file that isnt executable or an empty path is not codex", () => {
  const dirs = tempDir()
  fs.mkdirSync(path.join(dirs, "codex"))
  const files = tempDir()
  script(path.join(files, "codex"), 0o644)
  for (const env of [{ PATH: dirs }, { PATH: files }, { PATH: "" }])
    expect(thrown(() => codexCommand(env, {}))).toBeInstanceOf(CodexMissing)
})

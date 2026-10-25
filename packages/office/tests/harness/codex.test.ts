/** Starting and stopping one app-server: its command and owner-load params. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { Ajv } from "ajv"
import { CodexMissing, appServerCommand, codexCommand, ownerLoad } from "../../src/harness/codex.ts"
import { tempDir } from "../helpers.ts"

const CLIENT = new Ajv({ strict: false, validateFormats: false }).compile(
  JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../fixtures/codex/schema/ClientRequest.json"), "utf8")),
)

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

test("owner load takes the persons policy", () => {
  expect(ownerLoad("/w", { sandbox: "workspace-write", network: true })).toEqual({
    cwd: "/w",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    config: { sandbox_workspace_write: { network_access: true } },
  })
  expect(ownerLoad("/w", null).sandbox).toBe("read-only")
  expect(ownerLoad("/w", null).config).toEqual({ sandbox_workspace_write: { network_access: false } })
  // Loads Codex takes.
  for (const policy of [null, { sandbox: "workspace-write" as const, network: true }]) {
    const params = ownerLoad("/w", policy)
    expect(CLIENT({ id: 1, method: "thread/start", params })).toBe(true)
    expect(CLIENT({ id: 2, method: "thread/resume", params: { threadId: "t", ...params } })).toBe(true)
  }
})

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

test("the pinned codex makes the app server command", () => {
  expect(appServerCommand("/x/codex")).toEqual(["/x/codex", "app-server", "--listen", "stdio://"])
  const missing = thrown(() => appServerCommand(undefined))
  expect(missing).toBeInstanceOf(CodexMissing)
  expect(missing.message).toContain("isn't installed")
  const override = thrown(() => appServerCommand(undefined, "codex-dev"))
  expect(override).toBeInstanceOf(CodexMissing)
  expect(override.message).toContain("OPENCORP_CODEX_BIN names codex-dev")
})

test("a relative override or path entry is not codex", () => {
  const dir = tempDir()
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  script(path.join(bin, "codex"))
  expect(thrown(() => codexCommand({ PATH: bin }, { OPENCORP_CODEX_BIN: "./codex" }))).toBeInstanceOf(CodexMissing)
  expect(thrown(() => codexCommand({ PATH: "rel" }, {}))).toBeInstanceOf(CodexMissing)
  expect(thrown(() => codexCommand({}, {}))).toBeInstanceOf(CodexMissing)
})

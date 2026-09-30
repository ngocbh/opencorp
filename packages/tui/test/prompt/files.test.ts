import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { findFiles } from "../../src/prompt/files"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-files-"))
  for (const file of ["README.md", "src/app.ts", "src/lib/apply.ts", "node_modules/app/index.js", ".git/app"]) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), "")
  }
})

afterEach(() => fs.rm(dir, { recursive: true, force: true }))

test("finds matching files under cwd, best match first, skipping .git and node_modules", async () => {
  expect(await findFiles(dir, "app")).toEqual(["src/app.ts", "src/lib/apply.ts"])
})

test("lists every file for an empty query", async () => {
  expect((await findFiles(dir, "")).sort()).toEqual(["README.md", "src/app.ts", "src/lib/apply.ts"])
})

test("stops scanning at the limit", async () => {
  expect(await findFiles(dir, "", 2)).toHaveLength(2)
})

test("a missing cwd has no files", async () => {
  expect(await findFiles(path.join(dir, "gone"), "a")).toEqual([])
})

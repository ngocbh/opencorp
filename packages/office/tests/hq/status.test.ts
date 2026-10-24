/** Who else uses this host, for the warning when TCP is on. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { otherUsers } from "../../src/hq/status.ts"
import { tempDir } from "../helpers.ts"

test("on macos other accounts under users count", async () => {
  const tmp = tempDir()
  for (const name of ["owner", "ann", "Shared", "Guest", ".localized"]) fs.mkdirSync(path.join(tmp, name))
  expect(await otherUsers("darwin", { usersDir: tmp, me: "owner" })).toEqual(["ann"])
})

test("on linux other logged in users count", async () => {
  const who = async () =>
    "owner    pts/0        2026-10-24 09:00 (10.0.0.1)\n" +
    "bob      pts/1        2026-10-24 09:05 (10.0.0.2)\n" +
    "bob      pts/2        2026-10-24 09:06 (10.0.0.2)\n"
  expect(await otherUsers("linux", { me: "owner", who })).toEqual(["bob"])
})

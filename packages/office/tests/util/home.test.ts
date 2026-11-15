/** Where the office keeps its files under an OpenCorp home. */
import path from "node:path"
import { expect, test } from "bun:test"
import { OfficePaths } from "../../src/util/home.ts"
import { tempDir } from "../helpers.ts"

test("paths layout", () => {
  const home = tempDir()
  const p = new OfficePaths(home)
  expect(p.company).toBe(path.join(home, "company"))
  expect(p.store).toBe(path.join(home, "office", "store.sqlite"))
  expect(p.socket).toBe(path.join(home, "office", "office.sock"))
  expect(p.pidfile).toBe(path.join(home, "office", "office.pid"))
  expect(p.worktrees).toBe(path.join(home, "office", "worktrees"))
  expect(p.runDir("S1")).toBe(path.join(home, "office", "runs", "S1"))
  expect([p.memory, p.secrets]).toEqual([path.join(home, "office", "memory"), path.join(home, "office", "secrets")])
})

/** The test helpers that follow a test's own processes: only this test's process tree counts, and an ended process
 *  is told by its pid and start time, never by a command line another test on the machine could share. */
import { spawn, spawnSync } from "node:child_process"
import { expect, test } from "bun:test"
import { ended, ownSleepers } from "./helpers.ts"

test("ownSleepers finds this test's own sleep, and ended sees it end", async () => {
  const child = spawn("sleep", ["7.71"], { stdio: "ignore" })
  try {
    const found = await ownSleepers("7.71")
    expect(found.map((p) => p.pid)).toEqual([child.pid!])
    expect(await ended(found, 200)).toBe(false)
  } finally {
    child.kill("SIGKILL")
  }
  const after = await ownSleepers("7.71", { waitMs: 0 })
  expect(after).toEqual([])
})

test("an identical sleep outside this test's tree never matches", async () => {
  // Orphaned at once: its shell exits, so it is no descendant of this test, as another worktree's would be.
  const pid = Number(spawnSync("sh", ["-c", "sleep 7.72 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout)
  try {
    expect(await ownSleepers("7.72", { waitMs: 300 })).toEqual([])
    const mine = spawn("sleep", ["7.72"], { stdio: "ignore" })
    const found = await ownSleepers("7.72")
    expect(found.map((p) => p.pid)).toEqual([mine.pid!])
    mine.kill("SIGKILL")
    expect(await ended(found)).toBe(true)
  } finally {
    process.kill(pid, "SIGKILL")
  }
})

test("a marker is matched as it is written: its dot is no wildcard", async () => {
  const other = spawn("sleep", ["7173"], { stdio: "ignore" })
  try {
    expect((await ownSleepers("7173")).map((p) => p.pid)).toEqual([other.pid!])
    expect(await ownSleepers("7.73", { waitMs: 300 })).toEqual([])
  } finally {
    other.kill("SIGKILL")
  }
})

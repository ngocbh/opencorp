/** The office: its paths, and start and stop. */
import path from "node:path"
import { expect, test } from "bun:test"
import { OfficePaths, type WorkerPool } from "../../src/daemon/office.ts"
import { tempDir } from "../helpers.ts"
import { makeOffice } from "./helpers.ts"

/** A WorkerPool that counts closeAll calls. */
class FakePool implements WorkerPool {
  closed = 0

  closeAll(): void {
    this.closed++
  }
}

class StopFailed extends Error {}

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

test("start and stop run callbacks and close workers", async () => {
  const office = makeOffice()
  const calls: string[] = []
  const pool = new FakePool()
  office.workers = pool
  office.onStart.push(
    () => calls.push("s1"),
    async () => {
      calls.push("s2")
    },
  )
  office.onStop.push(
    () => calls.push("t1"),
    () => calls.push("t2"),
  )
  await office.start()
  await office.stop()
  expect(calls).toEqual(["s1", "s2", "t2", "t1"])
  expect(pool.closed).toBe(1)
})

test("failed start stops the office", async () => {
  const office = makeOffice()
  const calls: string[] = []
  const pool = new FakePool()
  office.workers = pool
  office.onStart.push(
    () => calls.push("s1"),
    () => {
      throw new Error("no model key")
    },
  )
  office.onStop.push(() => calls.push("t1"))
  await expect(office.start()).rejects.toThrow("no model key")
  expect(calls).toEqual(["s1", "t1"])
  expect(pool.closed).toBe(1)
  expect(await office.bus.subscribe().next(1000)).toBeNull() // the bus is closed
})

test("a failing stop callback does not skip the rest", async () => {
  const lines: string[] = []
  const office = makeOffice({ log: (message) => lines.push(message) })
  const calls: string[] = []
  const fail = (what: string) => () => {
    calls.push(what)
    throw new StopFailed(what)
  }
  office.onStart.push(() => calls.push("a start"), fail("b start"))
  office.onStop.push(
    () => calls.push("a stop"),
    () => calls.push("b stop"),
    fail("c stop"),
  )
  await expect(office.start()).rejects.toThrow("b start")
  expect(calls).toEqual(["a start", "b start", "c stop", "b stop", "a stop"])
  // The type only: an error's message can quote a secret.
  expect(lines).toEqual(["office on_stop callback failed: StopFailed"])
})

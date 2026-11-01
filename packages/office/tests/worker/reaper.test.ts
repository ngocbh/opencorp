/** The reaper: leftover process groups are killed by pid and start time, and every record looked at is removed. */
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { killGroup, startTime } from "../../src/install/proc.ts"
import type { Store } from "../../src/store/store.ts"
import { type Readings, reap } from "../../src/worker/reaper.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { type Group, isGone, NO_GROUP, startGroup, waitFor } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"
import { base, makeJob, makeRegistry, Recorder, runWorker } from "./helpers.ts"

setDefaultTimeout(30_000)

// A process-group leader that starts a grandchild and prints its pid, as a worker running a shell tool would.
// It execs a sleep rather than waiting: a waiting sh could wake when the grandchild is killed and exit with
// status 137 before its own SIGKILL lands; after the exec nothing reaps the grandchild until the leader dies, so
// it may linger as a zombie, which isGone counts as gone.
const LEADER = "/bin/sleep 61 & echo $!; exec /bin/sleep 61"

/** Records `g` under `key` as a worker leading its own group, with its start time moved by `skew` seconds. */
function record(store: Store, key: string, g: Group, skew = 0) {
  expect(g.started).not.toBeNull()
  store.recordWorker(key, { pid: g.pid, pgid: g.pid, startTime: g.started! + skew })
}

/** Waits briefly, then expects `g` still running. */
async function expectRunning(g: Group) {
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(g.child.exitCode).toBeNull()
  expect(g.child.signalCode).toBeNull()
}

test("reap kills a leftover process group", async () => {
  const store = openStore()
  const leader = startGroup(LEADER)
  // The grandchild's pid is read first, so the group kill can't race sh's fork and leave a sleep behind.
  const grand = Number(await leader.line())
  const grandStarted = startTime(grand)
  expect(grandStarted).not.toBeNull()
  leader.track(grand, grandStarted)
  record(store, "s1", leader)
  expect(reap(store).map((r) => r.key)).toEqual(["s1"])
  expect((await leader.exited).signal).toBe("SIGKILL")
  await waitFor(() => isGone(grand, grandStarted), { timeout: 10_000, what: "the grandchild gone" })
  expect(store.listWorkers()).toEqual([])
})

test("reap leaves a reused pid alone", async () => {
  const store = openStore()
  const stranger = startGroup("exec /bin/sleep 61")
  record(store, "s1", stranger, -100)
  expect(reap(store)).toEqual([])
  await expectRunning(stranger)
  expect(store.listWorkers()).toEqual([])
})

test("reap forgets a dead worker", async () => {
  const store = openStore()
  const gone = startGroup("exit 0")
  await gone.exited
  store.recordWorker("s1", { pid: gone.pid, pgid: gone.pid, startTime: 0 })
  expect(reap(store)).toEqual([])
  expect(store.listWorkers()).toEqual([])
})

test("reap one session", async () => {
  const store = openStore()
  const first = startGroup("exec /bin/sleep 61")
  const second = startGroup("exec /bin/sleep 61")
  record(store, "s1", first)
  record(store, "s2", second)
  expect(reap(store, "s2").map((r) => r.key)).toEqual(["s2"])
  expect((await second.exited).signal).toBe("SIGKILL")
  await expectRunning(first)
  expect(store.listWorkers().map((r) => r.key)).toEqual(["s1"])
})

/** Starts a group whose leader starts a grandchild and exits, records it under `key` and waits for the leader to be
 *  reaped, so only the grandchild is left in the group: what a SIGKILLed office's Codex app-server leaves behind
 *  when it exits on stdin EOF. Returns the grandchild's pid and start time. */
async function leaderless(store: Store, key: string) {
  const leader = startGroup("/bin/sleep 61 & echo $!")
  const grand = Number(await leader.line())
  const grandStarted = startTime(grand)
  expect(grandStarted).not.toBeNull()
  // startGroup's own cleanup skips a group whose leader is gone, so the grandchild is tracked by pid.
  leader.track(grand, grandStarted)
  record(store, key, leader)
  await leader.exited
  expect(startTime(leader.pid)).toBeNull()
  return { grand, grandStarted }
}

test("reap kills what is left of a group whose leader has exited", async () => {
  const store = openStore()
  const { grand, grandStarted } = await leaderless(store, "harness:s1")
  expect(reap(store).map((r) => r.key)).toEqual(["harness:s1"])
  await waitFor(() => isGone(grand, grandStarted), { timeout: 10_000, what: "the grandchild gone" })
  expect(store.listWorkers()).toEqual([])
})

test("reap of one session kills what is left of its leaderless group", async () => {
  const store = openStore()
  const first = startGroup("exec /bin/sleep 61")
  record(store, "s1", first)
  const { grand, grandStarted } = await leaderless(store, "s2")
  expect(reap(store, "s2").map((r) => r.key)).toEqual(["s2"])
  await waitFor(() => isGone(grand, grandStarted), { timeout: 10_000, what: "the grandchild gone" })
  await expectRunning(first)
  expect(store.listWorkers().map((r) => r.key)).toEqual(["s1"])
})

test("reap signals a leaderless group only when every check passes", () => {
  // process.kill is mocked, and the rows name a group no real process can have, so nothing real is signalled.
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
  })
  onTestFinished(() => kill.mockRestore())
  const leaderGone: Readings = {
    platform: "linux",
    startTime: () => null,
    noSuchProcess: () => true,
    inOfficeGroup: () => false,
  }
  const row = { pid: NO_GROUP, pgid: NO_GROUP, startTime: 1000 }
  const store = openStore()

  store.recordWorker("s1", row)
  expect(reap(store, undefined, leaderGone)).toEqual([])
  expect(kill).toHaveBeenCalledTimes(1)
  expect(kill).toHaveBeenCalledWith(-NO_GROUP, "SIGKILL")
  expect(store.listWorkers()).toEqual([])
  kill.mockClear()

  const refused: [string, object, Readings][] = [
    ["a 0 start time", { ...row, startTime: 0 }, leaderGone],
    ["a leader that may not be signalled", row, { ...leaderGone, noSuchProcess: () => false }],
    ["another platform", row, { ...leaderGone, platform: "freebsd" }],
    ["a group the leader didn't lead", { ...row, pgid: NO_GROUP + 1 }, leaderGone],
    ["the office's own group", row, { ...leaderGone, inOfficeGroup: () => true }],
  ]
  for (const [what, refusedRow, read] of refused) {
    store.recordWorker("s1", refusedRow as typeof row)
    expect(reap(store, undefined, read), what).toEqual([])
    expect(kill, what).not.toHaveBeenCalled()
    expect(store.listWorkers(), what).toEqual([])
  }
})

test("kill group ignores a group it may not signal", () => {
  // macOS answers EPERM for a group whose only members are zombies.
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" })
  })
  onTestFinished(() => kill.mockRestore())
  expect(killGroup(NO_GROUP)).toBe(false)
  expect(kill).toHaveBeenCalledTimes(1)
  expect(kill).toHaveBeenCalledWith(-NO_GROUP, "SIGKILL")
})

test("reap kills leftover sandboxed calls and harness processes too", async () => {
  const store = openStore()
  const call = startGroup("exec /bin/sleep 61")
  const harness = startGroup("exec /bin/sleep 61")
  record(store, "call:c1", call)
  record(store, "harness:s1", harness)
  expect(reap(store).map((r) => r.key)).toEqual(["call:c1", "harness:s1"])
  expect((await call.exited).signal).toBe("SIGKILL")
  expect((await harness.exited).signal).toBe("SIGKILL")
  expect(store.listWorkers()).toEqual([])
})

test("spawn reaps a leftover worker of the session", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const stale = startGroup("exec /bin/sleep 61")
  record(store, "s1", stale)
  fake.script({ content: "fresh" })
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const rec = await runWorker(registry, makeJob(where), new Recorder(), sessionDir, { env: fake.env() })
  expect(await waitFor(() => stale.child.signalCode, { timeout: 5000, what: "the leftover killed" })).toBe("SIGKILL")
  expect(rec.outcome?.output).toBe("fresh")
})

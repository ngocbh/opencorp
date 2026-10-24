/** Process start times, the reaper's match and group kills. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { killGroup, linuxStartTime, sameProcess, startTime } from "../../src/install/proc.ts"
import { isGone, psStat, startGroup, tempDir, waitFor } from "../helpers.ts"

setDefaultTimeout(30_000)

// A group id no real process can have (Linux PID_MAX_LIMIT is 4,194,304; macOS pids stay under 100,000), so
// a call that slipped past a mocked process.kill could never signal anything.
const NO_GROUP = 2_000_000_000

/** The error process.kill throws for a group that is gone. */
function esrch(): Error {
  return Object.assign(new Error("ESRCH"), { code: "ESRCH" })
}

/** Mocks process.kill to throw `error`, recording its calls; restored when the test finishes. */
function mockKill(error: Error) {
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw error
  })
  onTestFinished(() => kill.mockRestore())
  return kill
}

test("startTime of a running process is near now and the same on every read", () => {
  const g = startGroup("exec /bin/sleep 61")
  expect(g.started).not.toBeNull()
  expect(Math.abs(g.started! - Date.now() / 1000)).toBeLessThan(5)
  expect(startTime(g.pid)).toBe(g.started)
})

test("startTime of an exited process is null", async () => {
  const g = startGroup("exit 0")
  await g.exited
  expect(startTime(g.pid)).toBeNull()
})

test("startTime reads a zombie", async () => {
  // The background sleep outlives sh's exec, and the new sleep 61 never reaps it.
  const g = startGroup("/bin/sleep 1 & echo $!; exec /bin/sleep 61")
  const z = Number(await g.line())
  await waitFor(() => psStat(z).startsWith("Z"), { timeout: 10_000, what: "a zombie" })
  const found = startTime(z)
  expect(g.started).not.toBeNull()
  expect(found).not.toBeNull()
  expect(found!).toBeGreaterThanOrEqual(g.started! - 0.01)
  expect(found!).toBeLessThan(g.started! + 10)
})

test("startTime is null for ids that are not a process id", () => {
  for (const id of [0, 1, -1, 1.5, NaN, 2 ** 31, 2 ** 53]) expect(startTime(id)).toBeNull()
})

/** Writes a proc dir with `stat` holding `system` and `<pid>/stat` holding `line` (skipped when undefined). */
function procDir(system: string, pid: number, line?: string): string {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "stat"), system)
  if (line !== undefined) {
    fs.mkdirSync(path.join(dir, String(pid)))
    fs.writeFileSync(path.join(dir, String(pid), "stat"), line)
  }
  return dir
}

const SYSTEM = "cpu  1 2 3\nbtime 1700000000\nprocesses 9\n"
const FIELDS_4_TO_21 = Array.from({ length: 18 }, (_, i) => i + 1).join(" ")

test("linuxStartTime reads the start tick and btime from a proc dir", () => {
  // Field 22, the 20th field after the comm, is 250; the comm holds a space and a paren.
  const dir = procDir(SYSTEM, 4242, `4242 (a b) c) S ${FIELDS_4_TO_21} 250 0 0`)
  expect(linuxStartTime(4242, dir)).toBe(1700000002.5)
})

test("linuxStartTime is null for a missing or malformed stat file", () => {
  expect(linuxStartTime(4242, procDir(SYSTEM, 4242))).toBeNull()
  expect(linuxStartTime(4242, procDir(SYSTEM, 4242, `4242 (a b c S ${FIELDS_4_TO_21} 250 0 0`))).toBeNull()
  expect(linuxStartTime(4242, procDir(SYSTEM, 4242, `4242 (a) S ${FIELDS_4_TO_21} x250 0 0`))).toBeNull()
  // Two spaces leave field 22 empty, which Number would read as 0.
  expect(linuxStartTime(4242, procDir(SYSTEM, 4242, `4242 (a) S ${FIELDS_4_TO_21}  0 0`))).toBeNull()
  expect(linuxStartTime(4242, procDir("cpu  1 2 3\n", 4242, `4242 (a) S ${FIELDS_4_TO_21} 250 0 0`))).toBeNull()
})

test("sameProcess matches the start time within 0.01 s only", async () => {
  const g = startGroup("exec /bin/sleep 61")
  const started = g.started!
  expect(sameProcess(g.pid, started)).toBe(true)
  expect(sameProcess(g.pid, started + 0.005)).toBe(true)
  expect(sameProcess(g.pid, started + 0.02)).toBe(false)
  expect(sameProcess(g.pid, started - 100)).toBe(false)
  const gone = startGroup("exit 0")
  await gone.exited
  // If it exited before its start time was read, any start time is a valid probe: the pid runs nothing now.
  expect(sameProcess(gone.pid, gone.started ?? started)).toBe(false)
})

test("killGroup kills the leader and its grandchild", async () => {
  const g = startGroup("/bin/sleep 61 & echo $!; wait")
  const grand = Number(await g.line())
  const grandStarted = startTime(grand)
  expect(grandStarted).not.toBeNull()
  g.track(grand, grandStarted)
  expect(killGroup(g.pid)).toBe(true)
  expect((await g.exited).signal).toBe("SIGKILL")
  await waitFor(() => isGone(grand, grandStarted), { timeout: 5000, what: "the grandchild gone" })
})

test("killGroup returns false when the group is gone", () => {
  const kill = mockKill(esrch())
  expect(killGroup(NO_GROUP)).toBe(false)
  expect(kill).toHaveBeenCalledTimes(1)
  expect(kill).toHaveBeenCalledWith(-NO_GROUP, "SIGKILL")
})

test("killGroup returns false instead of throwing on any other error", () => {
  mockKill(new TypeError("x"))
  expect(killGroup(NO_GROUP)).toBe(false)
})

test("killGroup refuses ids that are not another process group without signalling", () => {
  const kill = mockKill(esrch())
  // The precheck: a failed expect throws, so the ids below are reached only once killGroup's calls are known
  // to go through the spy.
  expect(killGroup(NO_GROUP)).toBe(false)
  expect(kill).toHaveBeenCalledTimes(1)
  expect(kill).toHaveBeenCalledWith(-NO_GROUP, "SIGKILL")
  kill.mockClear()
  for (const id of [0, 1, -1, -NO_GROUP, 1.5, NaN, 2 ** 31, process.pid]) expect(killGroup(id)).toBe(false)
  expect(kill).not.toHaveBeenCalled()
})

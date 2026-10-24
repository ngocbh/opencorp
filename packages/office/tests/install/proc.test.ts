/** Process start times, the reaper's match, group kills, `ps` args and polling stops. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { args, killGroup, linuxStartTime, sameProcess, startTime, stopProcess } from "../../src/install/proc.ts"
import { isGone, PS, psStat, startGroup, tempDir, waitFor } from "../helpers.ts"

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
  // The background loop ends only once the gate exists, which is after sh has exec'd the sleep 61; sh can't reap
  // it then, and the sleep 61 never does, so it stays a zombie.
  const gate = path.join(tempDir(), "gate")
  const g = startGroup(`(while [ ! -e '${gate}' ]; do /bin/sleep 0.05; done) & echo $!; exec /bin/sleep 61`)
  const z = Number(await g.line())
  g.track(z, startTime(z))
  await waitFor(() => args(g.pid, PS) === "/bin/sleep 61", { timeout: 10_000, what: "the exec" })
  fs.writeFileSync(gate, "")
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
  // The leader execs a sleep rather than waiting, so it can't wake when the grandchild is killed and exit 137 first.
  const g = startGroup("/bin/sleep 61 & echo $!; exec /bin/sleep 61")
  const grand = Number(await g.line())
  const grandStarted = startTime(grand)
  expect(grandStarted).not.toBeNull()
  g.track(grand, grandStarted)
  expect(killGroup(g.pid)).toBe(true)
  expect((await g.exited).signal).toBe("SIGKILL")
  await waitFor(() => isGone(grand, grandStarted), { timeout: 10_000, what: "the grandchild gone" })
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

test("args shows the command line of a process", async () => {
  // sh may not have exec'd yet, so each check waits for the expected line; on a timeout the expect shows what
  // ps printed instead.
  async function expectArgs(pid: number, expected: string) {
    try {
      await waitFor(() => args(pid, PS) === expected, { timeout: 5000, what: "ps args" })
    } catch {}
    expect(args(pid, PS)).toBe(expected)
  }
  const g = startGroup("exec /bin/sleep 61")
  await expectArgs(g.pid, "/bin/sleep 61")
  // sh stays the leader, so ps joins its argv ["/bin/sh", "-c", script] with spaces. The sleep's pid is read
  // first, so the cleanup's group kill can't race sh's fork and leave a sleep behind.
  const script = '/bin/sleep 61 & echo $!; wait; : --home "/tmp/a b/ü"'
  const h = startGroup(script)
  const sleep = Number(await h.line())
  h.track(sleep, startTime(sleep))
  await expectArgs(h.pid, `/bin/sh -c ${script}`)
})

test("args of an exited process is null", async () => {
  const g = startGroup("exit 0")
  await g.exited
  expect(args(g.pid, PS)).toBeNull()
})

test("args refuses a ps that is not an absolute path", () => {
  // Only "ps" exercises the guard (a PATH lookup would find a real ps); "./ps" is a second spelling.
  expect(args(process.pid, "ps")).toBeNull()
  expect(args(process.pid, "./ps")).toBeNull()
})

test("stopProcess ends a process with SIGTERM", async () => {
  const g = startGroup("exec /bin/sleep 61")
  expect(g.started).not.toBeNull()
  expect(await stopProcess(g.pid, g.started!)).toBe(true)
  expect((await g.exited).signal).toBe("SIGTERM")
})

test("stopProcess kills a process that ignores SIGTERM after the timeout", async () => {
  // An ignored signal stays ignored across exec, so one process ignores SIGTERM and no child is left behind.
  const g = startGroup("trap '' TERM; echo ready; exec /bin/sleep 61")
  await g.line()
  expect(g.started).not.toBeNull()
  expect(await stopProcess(g.pid, g.started!, { timeout: 300, killWait: 5000 })).toBe(true)
  expect((await g.exited).signal).toBe("SIGKILL")
})

test("stopProcess leaves a process with another start time alone", async () => {
  const g = startGroup("exec /bin/sleep 61")
  expect(g.started).not.toBeNull()
  expect(await stopProcess(g.pid, g.started! - 100)).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(g.child.exitCode).toBeNull()
  expect(g.child.signalCode).toBeNull()
})

test("stopProcess refuses ids that are not another process without signalling", async () => {
  const kill = mockKill(esrch())
  // The precheck: process.kill goes through the spy, so the ids below can't slip past it unseen.
  expect(killGroup(NO_GROUP)).toBe(false)
  expect(kill).toHaveBeenCalledTimes(1)
  expect(kill).toHaveBeenCalledWith(-NO_GROUP, "SIGKILL")
  kill.mockClear()
  for (const id of [0, 1, -1, 1.5]) expect(await stopProcess(id, 0, { timeout: 50, killWait: 50 })).toBe(false)
  // The office's own start time matches, so only the self-pid guard refuses it.
  const self = startTime(process.pid)
  expect(self).not.toBeNull()
  expect(await stopProcess(process.pid, self!, { timeout: 50, killWait: 50 })).toBe(false)
  expect(kill).not.toHaveBeenCalled()
})

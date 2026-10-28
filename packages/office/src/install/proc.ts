/** The psutil replacement: process start times, group kills, `ps` args and polling stops. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { liveGroupMembers, procStartTime } from "../platform.ts"

/** Whether `n` can be a process or group id the office may read or signal: an integer from 2 to 2^31 − 1
 *  (0 and 1 would make process.kill hit the office's own group or every process; pid_t is 32 bits). */
function isPid(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && n <= 0x7fffffff
}

/** The start time of `pid` in seconds since the epoch, or null when it can't be read (no such process, an id
 *  that isn't one, a platform other than macOS or Linux). macOS: libproc (µs); Linux: /proc (10 ms). Zombies
 *  are read too. */
export function startTime(pid: number): number | null {
  if (!isPid(pid)) return null
  if (process.platform === "darwin") return procStartTime(pid)
  if (process.platform === "linux") return linuxStartTime(pid)
  return null
}

// btime is read once per root, as psutil does: the kernel recomputes it on every read and it can shift by a
// second, which would break the 0.01 s match against a start time recorded earlier. An office restart re-reads
// it, so if it shifted meanwhile a leftover isn't matched and is left alone (fails safe, as with psutil).
const bootTimes = new Map<string, number>()

const USER_HZ = 100

/** A non-negative safe integer written in decimal digits only, else null (so "" never reads as 0). */
function parseDecimal(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/** Linux: `btime` from `<procRoot>/stat` (read once per root) plus field 22 (start ticks after boot) of
 *  `<procRoot>/<pid>/stat` over USER_HZ (100). Null when either file is missing or malformed. */
export function linuxStartTime(pid: number, procRoot = "/proc"): number | null {
  try {
    let btime = bootTimes.get(procRoot)
    if (btime === undefined) {
      const line = fs.readFileSync(path.join(procRoot, "stat"), "utf8").match(/^btime (.*)$/m)
      const read = parseDecimal(line?.[1])
      if (read === null) return null
      btime = read
      bootTimes.set(procRoot, btime)
    }
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8")
    // The comm (field 2) may hold spaces and parens, so the fields start after the last ")".
    const end = stat.lastIndexOf(")")
    if (end < 0) return null
    const rest = stat.slice(end + 2).split(" ")
    // rest[0] is field 3 (the state), so field 22 is rest[19].
    const ticks = parseDecimal(rest[19])
    return ticks === null ? null : btime + ticks / USER_HZ
  } catch {
    return null
  }
}

/** Whether `pid` is running and started within 0.01 s of `started` (a reused pid has another start time). */
export function sameProcess(pid: number, started: number): boolean {
  const found = startTime(pid)
  return found !== null && Math.abs(found - started) < 0.01
}

// At most this many repeat kills on macOS, about 1 ms apart, so a group forking faster than that can't hold the
// caller (often an exit listener) for long.
const SWEEP_ROUNDS = 50
const pause = new Int32Array(new SharedArrayBuffer(4))

/** Sends SIGKILL to process group `pgid`, and on macOS sends it again while the group has members that can still
 *  start children (at most SWEEP_ROUNDS more times, about 1 ms apart). False when the first send fails: the group
 *  is gone, may not be signalled (macOS EPERM for a group of only zombies), or `pgid` isn't a group id the office
 *  may signal or is the office's own pid (a backstop: callers pass only groups the office spawned detached, and the
 *  office leads its own group under its service). Synchronous; never throws. */
export function killGroup(pgid: number): boolean {
  if (!isPid(pgid) || pgid === process.pid) return false
  if (!sendKill(pgid)) return false
  // macOS signals only the processes in the group at that moment, and a child already being created still joins
  // it, so a child forked during the kill survives it. Re-signalling the group can't hit a recycled id: a group id
  // isn't reused while the group has members, and it is re-signalled only right after members were seen. Linux
  // aborts the creation of a child when a group signal is pending, so one send is enough there.
  if (process.platform !== "darwin") return true
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    if (liveGroupMembers(pgid).length === 0) break
    Atomics.wait(pause, 0, 0, 1)
    if (!sendKill(pgid)) break
  }
  return true
}

/** Sends SIGKILL to group `pgid`; false when the send fails. */
function sendKill(pgid: number): boolean {
  try {
    process.kill(-pgid, "SIGKILL")
    return true
  } catch {
    // Delivery races the group's exit, so any error means "not killed", never a throw.
    return false
  }
}

/** The command line of `pid` as `ps -ww -o args=` prints it (argv joined by spaces, so callers match on word
 *  pairs such as `--home <realpath>`), or null when it can't be read (no such process, `ps` failed or timed out,
 *  `ps` isn't an absolute path, or an id that isn't a pid). `ps` is resolved by the caller; it runs with only
 *  `LC_ALL=C.UTF-8`, so non-ASCII prints as UTF-8. */
export function args(pid: number, ps: string): string | null {
  if (!path.isAbsolute(ps) || !isPid(pid)) return null
  let out: string
  try {
    out = execFileSync(ps, ["-ww", "-o", "args=", "-p", String(pid)], {
      env: { LC_ALL: "C.UTF-8" },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 5000,
    })
  } catch {
    // No such process (ps exits 1) and any ps failure both read as unknown; callers treat null as not ours, so
    // nothing is signalled.
    return null
  }
  const line = out.endsWith("\n") ? out.slice(0, -1) : out
  return line === "" ? null : line
}

/** Sends `sig` to `pid`; a failed send (the process went meanwhile) is ignored. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {}
}

/** Polls every 20 ms until `pid` is no longer the process that started at `started` or `timeout` ms pass;
 *  true when it went. */
async function waitGone(pid: number, started: number, timeout: number): Promise<boolean> {
  const deadline = performance.now() + timeout
  for (;;) {
    if (!sameProcess(pid, started)) return true
    if (performance.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Stops `pid` if it is still the process that started at `started`: SIGTERM, then SIGKILL after `timeout` ms,
 *  then waits up to `killWait` ms for it to go. The start time is re-read before each signal, so a pid reused
 *  meanwhile is never signalled. True when the process was found and signalled, false when it wasn't running.
 *  Read `started` with startTime(pid) before anything else identifies the process (e.g. args), so a pid reused
 *  in between fails the re-check; never pass a time the office recorded itself. */
export async function stopProcess(
  pid: number,
  started: number,
  { timeout = 15_000, killWait = 5_000 } = {},
): Promise<boolean> {
  if (pid === process.pid || !sameProcess(pid, started)) return false
  signal(pid, "SIGTERM")
  // waitGone's last sameProcess read comes right before this SIGKILL, with nothing awaited in between.
  if (!(await waitGone(pid, started, timeout))) {
    signal(pid, "SIGKILL")
    await waitGone(pid, started, killWait)
  }
  return true
}

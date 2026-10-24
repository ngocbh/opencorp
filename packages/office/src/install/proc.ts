/** The psutil replacement: process start times, group kills, `ps` args and polling stops. */
import fs from "node:fs"
import path from "node:path"
import { procStartTime } from "../platform.ts"

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
// second, which would break the 0.01 s match against a start time recorded earlier.
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

/** Sends SIGKILL to process group `pgid`; false when the group is gone, may not be signalled (macOS EPERM for
 *  a group of only zombies), or `pgid` isn't a group id the office may signal or is the office's own pid (the
 *  office leads its own group). Never throws. */
export function killGroup(pgid: number): boolean {
  if (!isPid(pgid) || pgid === process.pid) return false
  try {
    process.kill(-pgid, "SIGKILL")
    return true
  } catch {
    // Delivery races the group's exit, so any error means "not killed", never a throw.
    return false
  }
}

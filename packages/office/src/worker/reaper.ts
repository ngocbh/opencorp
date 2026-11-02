/** Kills processes left over from an earlier office (or an earlier spawn in this one). */
import { bootTime, inOfficeGroup, killGroup, noSuchProcess, startTime } from "../install/proc.ts"
import type { Store, WorkerRecord } from "../store/store.ts"

/** What the reaper reads about processes before it signals a group; tests pass stand-ins. */
export interface Readings {
  platform: string
  bootTime(): number | null
  startTime(pid: number): number | null
  noSuchProcess(pid: number): boolean
  inOfficeGroup(pgid: number): boolean
}

const REAL: Readings = {
  get platform() {
    return process.platform
  },
  bootTime,
  startTime,
  noSuchProcess,
  inOfficeGroup,
}

/** Kills the leftover processes recorded in `store` (only the record under `key` when given). Every record looked at
 *  is removed. Returns the records whose groups were killed. The daemon calls it at start; the worker spawn calls it
 *  for the session it starts.
 *
 *  A record's group is killed when its pid still has the recorded start time, read right before the signal; a pid
 *  with another start time was reused and is left alone, and a record with a 0 start time is never signalled.
 *
 *  A group whose leader has exited is killed too, when no process holds the leader's pid (ESRCH), the record's pgid is
 *  its pid, the platform is macOS or Linux, the record is from this boot and the office isn't in that group. This
 *  reaches processes left in a recorded group after a SIGKILLed office: a sandboxed call's background children, or a
 *  harness's children that stayed in its group. Children a harness moved to a group or session of their own are not
 *  reached. This keeps the reuse guard: neither XNU nor Linux hands out a pid that is still a live group or session id,
 *  so while the group has members no other process can hold the pid. Only ESRCH counts as gone, since the start time
 *  also reads as null for a process of another user. A record from before the last boot (or with a boot time that can't
 *  be read) never takes this path: none of its processes can be alive, so any group holding its pid now is someone
 *  else's. Two windows remain, as with a worker's exit kill and the design's reaper: the group empties and its id is
 *  taken by a new group, either while the office is down within one boot (with that group's leader gone by then and its
 *  children left) or between this read and the kill. */
export function reap(store: Store, key?: string, read: Readings = REAL): WorkerRecord[] {
  const killed: WorkerRecord[] = []
  for (const record of store.listWorkers()) {
    if (key !== undefined && record.key !== key) continue
    // Unattended leftovers are often shell members; stop the group so none runs its next step mid-kill.
    if (mayKill(record, read) && killGroup(record.pgid, { stopFirst: true })) killed.push(record)
    store.removeWorker(record.key, record.pid)
  }
  return killed
}

/** Whether `record`'s group is still the one the office started: see reap. */
function mayKill(record: WorkerRecord, read: Readings): boolean {
  if (record.startTime === 0) return false
  const now = read.startTime(record.pid)
  // On Linux the start time derives from btime, which a new office run can read about a second off, so a live
  // leader may be taken for a reused pid and left alone.
  if (now !== null) return Math.abs(now - record.startTime) < 0.01
  // startTime is null everywhere but macOS and Linux, so there null doesn't mean the leader is gone.
  const booted = read.bootTime()
  return (
    record.pgid === record.pid &&
    (read.platform === "darwin" || read.platform === "linux") &&
    // Linux's btime can read a second later in a new office run; a record from the first second after boot then
    // fails safe.
    booted !== null &&
    record.startTime >= booted &&
    read.noSuchProcess(record.pid) &&
    !read.inOfficeGroup(record.pgid)
  )
}

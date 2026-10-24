/** Kills processes left over from an earlier office (or an earlier spawn in this one). */
import { killGroup, sameProcess } from "../install/proc.ts"
import type { Store, WorkerRecord } from "../store/store.ts"

/** Kills the leftover processes recorded in `store` (only the record under `key` when given): a record's
 *  group is killed only if its pid still has the recorded start time, checked right before the signal, so a
 *  reused pid is left alone. Every record looked at is removed. Returns the records whose groups were killed.
 *  The daemon calls it at start; the worker spawn calls it for the session it starts. */
export function reap(store: Store, key?: string): WorkerRecord[] {
  const killed: WorkerRecord[] = []
  for (const record of store.listWorkers()) {
    if (key !== undefined && record.key !== key) continue
    if (sameProcess(record.pid, record.startTime) && killGroup(record.pgid)) killed.push(record)
    store.removeWorker(record.key, record.pid)
  }
  return killed
}

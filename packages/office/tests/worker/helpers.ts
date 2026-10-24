/** The worker tests' helpers (Python's tests/worker/conftest.py). */
import { Job, groupSpecs, type JobInput } from "../../src/worker/job.ts"
import { BaseHandlers, type JobWorker, type WorkerHandlers } from "../../src/worker/rpc.ts"

/** A worker whose job is a fixed chat job; for `BaseHandlers`, its groups are the handlers' tools and its memory
 *  names each of their stores. `over` replaces job fields. */
export function workerFor(handlers: WorkerHandlers, over: Partial<JobInput> = {}): JobWorker {
  const granted =
    handlers instanceof BaseHandlers
      ? {
          groups: groupSpecs(handlers.tools),
          memory: Object.fromEntries(Object.keys(handlers.stores).map((name) => [name, { store: name }])),
        }
      : {}
  const job = Job.parse({
    kind: "chat",
    session_id: "s1",
    run_id: "r1",
    person: "minh",
    pin: "/pin",
    flow: "flows/echo.yaml",
    log: "/runs/r1/log.jsonl",
    ...granted,
    ...over,
  })
  return { job }
}

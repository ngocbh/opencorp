/** Store test helpers (Python's store conftest). */
import path from "node:path"
import type { z } from "zod"
import { onTestFinished } from "bun:test"
import { Event, WorkItem, now } from "@opencorp/protocol"
import { Store, newId, type StoreOptions } from "../../src/store/store.ts"
import { tempDir } from "../helpers.ts"

/** A store in a fresh temp dir (`<tmp>/office/store.sqlite`), closed when the test finishes
 *  (Python's `store` fixture). */
export function openStore(options?: StoreOptions): Store {
  const store = new Store(path.join(tempDir(), "office", "store.sqlite"), options)
  onTestFinished(() => store.close())
  return store
}

/** A WorkItem with Python's defaults (`work_item` in conftest): `WorkItem.parse` of an id, "Fix the build",
 *  task, open, requester ngocbh, now() times, overridden by `over` (so `data` equals Python's full dump). */
export function workItem(over?: Partial<WorkItem>): z.output<typeof WorkItem> {
  const t = now()
  return WorkItem.parse({
    id: newId(),
    title: "Fix the build",
    kind: "task",
    status: "open",
    requester: "ngocbh",
    created_at: t,
    updated_at: t,
    ...over,
  })
}

/** The events `store` delivers to listeners from now on, in delivery order (they arrive after each commit);
 *  the listener is removed when the test finishes (the TS form of Python's `store.events_after()`). */
export function recordEvents(store: Store): Event[] {
  const events: Event[] = []
  onTestFinished(store.addListener((event) => events.push(event)))
  return events
}

/** Runs `fn` and returns what it threw; throws "expected a throw" if it returned. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error("expected a throw")
}

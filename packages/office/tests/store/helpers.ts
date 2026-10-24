/** Store test helpers (Python's store conftest). */
import path from "node:path"
import type { z } from "zod"
import { onTestFinished } from "bun:test"
import { Comment, Event, Session, WorkItem, now } from "@opencorp/protocol"
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

/** A Comment on `workItemId` with Python's defaults (`comment` in conftest): a new id, author ngocbh, body
 *  "looks good", now(), overridden by `over`; parsed, so defaults are filled. */
export function comment(workItemId: string, over?: Partial<Comment>): z.output<typeof Comment> {
  return Comment.parse({
    id: newId(),
    work_item_id: workItemId,
    author: "ngocbh",
    body: "looks good",
    created_at: now(),
    ...over,
  })
}

/** A git commit id for fixtures. */
export const COMMIT = "a".repeat(40)

/** A Session with Python's defaults (`session` in conftest): minh, composer, office "mac", cwd "/w/app", COMMIT,
 *  idle, main, now() times, overridden by `over`; parsed, so defaults are filled. */
export function session(over?: Partial<Session>): z.output<typeof Session> {
  const t = now()
  return Session.parse({
    id: newId(),
    person: "minh",
    harness: "composer",
    office: "mac",
    cwd: "/w/app",
    repo_commit: COMMIT,
    status: "idle",
    kind: "main",
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

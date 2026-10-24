/** Work items and comments. */
import { expect, test } from "bun:test"
import { DuplicateKey, NotFound, StaleVersion, StoreError, type WorkItemRecord } from "../../src/store/store.ts"
import { comment, openStore, recordEvents, thrown, workItem } from "./helpers.ts"

const NO_ITEM = "01K6A0000000000000000000ZZ"

test("work item round trips", () => {
  const store = openStore()
  const item = workItem({ assignee: "minh", groups: ["eng"], gate: true, summary: "s", cost: 1.5 })
  const got = store.createWorkItem(item)
  expect(got).toEqual(item)
  expect(store.getWorkItem(item.id)).toEqual(item)
})

test("null fields come back as null", () => {
  const store = openStore()
  const got = store.createWorkItem(workItem())
  expect(got.assignee).toBeNull()
})

test("duplicate id", () => {
  const store = openStore()
  const item = store.createWorkItem(workItem())
  expect(thrown(() => store.createWorkItem(item))).toBeInstanceOf(DuplicateKey)
})

test("update bumps version and emits", () => {
  const store = openStore()
  const events = recordEvents(store)
  const item = store.createWorkItem(workItem())
  const got = store.updateWorkItem(item.id, { status: "done", resolved_by: "ngocbh" })
  expect([got.status, got.resolved_by, got.version]).toEqual(["done", "ngocbh", 2])
  expect(got.updated_at >= item.updated_at).toBe(true)
  expect(got.created_at).toBe(item.created_at)
  expect(events.at(-1)!.type).toBe("work_item.updated")
})

test("update with stale base version", () => {
  const store = openStore()
  const item = store.createWorkItem(workItem())
  store.updateWorkItem(item.id, { status: "in_progress" }, 1)
  const error = thrown(() => store.updateWorkItem(item.id, { status: "done" }, 1))
  expect(error).toBeInstanceOf(StaleVersion)
  expect([(error as StaleVersion).expected, (error as StaleVersion).current]).toEqual([1, 2])
})

test("update rejects bad fields", () => {
  const store = openStore()
  const item = store.createWorkItem(workItem())
  const frozen = thrown(() => store.updateWorkItem(item.id, { version: 9 }))
  expect(frozen).toBeInstanceOf(StoreError)
  expect((frozen as Error).message).toContain("cannot change")
  const status = { status: "nope" } as unknown as Partial<WorkItemRecord>
  expect(thrown(() => store.updateWorkItem(item.id, status))).toBeInstanceOf(StoreError)
  const colour = { colour: "red" } as unknown as Partial<WorkItemRecord>
  const unknown = thrown(() => store.updateWorkItem(item.id, colour))
  expect(unknown).toBeInstanceOf(StoreError)
  // An unknown key could be anything a caller passed, so the error never names it.
  expect((unknown as Error).message).not.toContain("colour")
  expect(thrown(() => store.updateWorkItem(NO_ITEM, { status: "done" }))).toBeInstanceOf(NotFound)
  expect(store.getWorkItem(item.id)).toEqual(item)
})

test("list work items", () => {
  const store = openStore()
  const a = store.createWorkItem(workItem({ assignee: "minh" }))
  const b = store.createWorkItem(workItem({ assignee: "minh", status: "done" }))
  store.createWorkItem(workItem({ assignee: "lan" }))
  expect(store.listWorkItems({ assignee: "minh" }).map((i) => i.id)).toEqual([b.id, a.id])
  expect(store.listWorkItems({ assignee: "minh", status: ["open", "in_progress"] }).map((i) => i.id)).toEqual([a.id])
})

test("comments", () => {
  const store = openStore()
  const events = recordEvents(store)
  const item = store.createWorkItem(workItem())
  const c1 = store.addComment(comment(item.id, { on_behalf_of: "ngocbh" }))
  const c2 = store.addComment(comment(item.id))
  expect(store.listComments(item.id)).toEqual([c1, c2])
  expect(events.at(-1)!.type).toBe("comment.created")
})

test("comment needs its work item", () => {
  const store = openStore()
  expect(thrown(() => store.addComment(comment(NO_ITEM)))).toBeInstanceOf(NotFound)
})

test("model field without a column needs a migration", () => {
  const store = openStore()
  const events = recordEvents(store)
  const item = { ...workItem(), new_field: null } as WorkItemRecord
  const error = thrown(() => store.createWorkItem(item))
  expect(error).toBeInstanceOf(StoreError)
  expect((error as Error).message).toMatch(/work_items has no column 'new_field'.*migration/)
  expect(store.listWorkItems()).toEqual([])
  expect(events).toEqual([])
})

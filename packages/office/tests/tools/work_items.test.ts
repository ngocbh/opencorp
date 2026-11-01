/** Read-only work item tools: what the asker can see. */
import fs from "node:fs"
import { expect, test } from "bun:test"
import { newId } from "../../src/store/store.ts"
import { workItemTools, workItemVisibility } from "../../src/tools/work_items.ts"
import { groupSpecs } from "../../src/worker/job.ts"
import { openStore, question, session, workItem } from "./helpers.ts"

test("work item tools show only what the asker can see", () => {
  const store = openStore()
  const top = store.createWorkItem(workItem({ title: "Ship v2" }))
  const chat = store.createWorkItem(workItem({ title: "Chat", parent_id: top.id }))
  const sibling = store.createWorkItem(workItem({ title: "Docs", parent_id: top.id }))
  const mine = store.createWorkItem(workItem({ title: "Mine", requester: "ngocbh", assignee: "minh" }))
  const other = store.createWorkItem(workItem({ title: "Someone else's", assignee: "lan" }))
  const asker = store.createSession(session({ work_item_id: chat.id }))
  const q = store.addQuestion(question(asker.id))
  const tools = workItemTools(store, "minh", q)
  const listed = new Set(JSON.parse(tools.list_work_items!.call({})).map((i: { title: string }) => i.title))
  expect(listed).toEqual(new Set(["Ship v2", "Chat", "Docs", "Mine"]))
  const read = JSON.parse(tools.read_work_item!.call({ work_item_id: top.id }))
  expect(read.title).toBe("Ship v2")
  expect(new Set(read.children.map((c: { title: string }) => c.title))).toEqual(new Set(["Chat", "Docs"]))
  expect(JSON.parse(tools.read_work_item!.call({ work_item_id: sibling.id })).parent_id).toBe(top.id)
  expect(JSON.parse(tools.read_work_item!.call({ work_item_id: mine.id })).title).toBe("Mine")
  for (const hidden of [other.id, newId()]) {
    expect(() => tools.read_work_item!.call({ work_item_id: hidden })).toThrow(RangeError)
    expect(() => tools.read_work_item!.call({ work_item_id: hidden })).toThrow("no work item")
  }
})

test("work item visibility follows the chain children requester and assignee", () => {
  const store = openStore()
  const top = store.createWorkItem(workItem({ title: "Ship v2" }))
  const root = store.createWorkItem(workItem({ title: "Chat", parent_id: top.id }))
  const child = store.createWorkItem(workItem({ title: "Docs", parent_id: root.id }))
  const sibling = store.createWorkItem(workItem({ title: "Sibling", parent_id: top.id }))
  const requested = store.createWorkItem(workItem({ title: "Asked", requester: "lan" }))
  const assigned = store.createWorkItem(workItem({ title: "Given", assignee: "lan" }))
  const hidden = store.createWorkItem(workItem({ title: "Hidden", assignee: "minh" }))
  const visible = workItemVisibility(store, "lan", [null, root.id, undefined])
  for (const item of [top, root, child, sibling, requested, assigned]) expect([item.title, visible(item)]).toEqual([item.title, true])
  expect(visible(hidden)).toBe(false)
  expect(workItemVisibility(store, "lan", [null, undefined])(top)).toBe(false)
})

test("a work item id that is not a string is no work item", () => {
  const store = openStore()
  const top = store.createWorkItem(workItem({ title: "Ship v2", assignee: "minh" }))
  const tools = workItemTools(store, "minh", null)
  expect(JSON.parse(tools.read_work_item!.call({ work_item_id: top.id })).title).toBe("Ship v2")
  for (const args of [{ work_item_id: {} }, { work_item_id: [top.id] }, {}]) {
    expect(() => tools.read_work_item!.call(args)).toThrow(RangeError)
    expect(() => tools.read_work_item!.call(args)).toThrow("no work item")
  }
})

test("the work item tool specs equal the saved copy", () => {
  const golden = JSON.parse(fs.readFileSync(new URL("../fixtures/tool_specs.json", import.meta.url), "utf8"))
  const specs = groupSpecs({ work_items: workItemTools(openStore(), "minh", null) }).work_items
  expect(JSON.stringify(specs, null, 2)).toBe(JSON.stringify(golden.work_items, null, 2))
})

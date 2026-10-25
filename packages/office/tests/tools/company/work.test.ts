/** Company tools bound to the caller: ask_manager, create_work_item, comment. */
import { isPending, ToolSet } from "@ngocbh/yian/tools"
import { expect, test } from "bun:test"
import { loadRepo } from "../../../src/company/loader.ts"
import { Answers, type OnQuestion } from "../../../src/questions/ask.ts"
import { NotFound, type QuestionRecord, type SessionRecord, type Store } from "../../../src/store/store.ts"
import { companyTools, tools as workTools } from "../../../src/tools/company/work.ts"
import { groupSpecs, toolSpec } from "../../../src/worker/job.ts"
import { answerRequest, BaseHandlers, modelFromSchema, remoteTool } from "../../../src/worker/rpc.ts"
import { officeEnd, workerFor } from "../../worker/helpers.ts"
import { company, openStore, session, workItem } from "../helpers.ts"

/** The yian call of an `ask_manager` call in the tools' run. */
const CALL = { callId: "run-1/reply/1/0" }

/** An `onQuestion` that stores through an `Answers` on `store` and records each question it is handed. */
class Desk {
  readonly asked: QuestionRecord[] = []
  readonly answers: Answers

  constructor(store: Store) {
    this.answers = new Answers(store)
  }

  readonly onQuestion: OnQuestion = (q, options) => {
    this.asked.push(q)
    return this.answers.ask(q, options)
  }
}

function setup() {
  const store = openStore()
  const repo = loadRepo(company())
  const item = store.createWorkItem(workItem({ requester: "minh" }))
  const s = store.createSession(session({ person: "minh", work_item_id: item.id }))
  const desk = new Desk(store)
  const tools = companyTools(store, repo, s, "run-1", desk.onQuestion)
  return { store, repo, s, item, desk, tools }
}

/** The company tools for `s`, with `desk` storing their questions. */
function toolsFor(store: Store, s: SessionRecord, desk: Desk) {
  return companyTools(store, loadRepo(company()), s, "run-1", desk.onQuestion)
}

test("the group has three tools and no ask user", async () => {
  const { tools } = setup()
  expect(new Set(Object.keys(tools))).toEqual(new Set(["ask_manager", "create_work_item", "comment"]))
  const [spec] = groupSpecs({ company: tools }).company!.filter((s) => s.name === "ask_manager")
  expect(spec!.parameters.required).toEqual(["question"])
  const rpc = await officeEnd(new BaseHandlers({ tools: { company: tools } }))
  const set = new ToolSet({
    company: Object.entries(tools).map(([name, tool]) => remoteTool(rpc, "company", toolSpec(name, tool))),
  })
  expect(set.groups).toEqual(["company"])
})

test("ask manager opens a work item and returns the formatted answer", async () => {
  const { store, s, item: parent, desk, tools } = setup()
  const options = ["Retry", "Back off", "Stop minh"]
  const ask = () => tools.ask_manager!.call({ question: "Retry or back off?", options }, CALL)
  expect(isPending(await ask())).toBe(true)
  expect(desk.asked).toHaveLength(1)
  const q = desk.asked[0]!
  expect([q.source, q.asker, q.node_id, q.session_id, q.run_id, q.call_id]).toEqual([
    "ask_manager",
    "minh",
    null,
    s.id,
    "run-1",
    CALL.callId,
  ])
  expect(q.options).toEqual(["Retry", "Back off"])
  const item = store.getWorkItem(q.work_item_id!)!
  expect([item.kind, item.requester, item.assignee, item.parent_id, item.title, item.status]).toEqual([
    "question",
    "minh",
    "ngocbh",
    parent.id,
    "Retry or back off?",
    "open",
  ])
  store.answerQuestion(q.id, "Back off", "option", "ngocbh")
  const done = store.getWorkItem(item.id)!
  expect([done.status, done.resolved_by]).toEqual(["done", "ngocbh"])
  expect(await ask()).toBe('The user chose "Back off" (option 2 of the 2 shown).')
})

test("ask manager options accept any shape", async () => {
  const { desk, tools } = setup()
  const spec = groupSpecs({ company: tools }).company!.find((s) => s.name === "ask_manager")!
  const args = modelFromSchema("ask_manager_args", spec.parameters).parse({ question: "q?", options: { bad: 1 } })
  await tools.ask_manager!.call(args, CALL)
  expect(desk.asked[0]!.options).toEqual([])
})

const KINDS = ["sent_back", "interrupted"] as const

test.each(KINDS)("ask manager closes its work item on any answer [%s]", async (kind) => {
  const store = openStore()
  const s = store.createSession(session({ person: "minh" }))
  const desk = new Desk(store)
  await toolsFor(store, s, desk).ask_manager!.call({ question: "Deploy now?" }, CALL)
  store.answerQuestion(desk.asked[0]!.id, null, kind, "ngocbh")
  expect(store.getWorkItem(desk.asked[0]!.work_item_id!)!.status).toBe("done")
})

test("ask manager leaves no work item when its question cannot be stored", async () => {
  const store = openStore()
  const unstored = session({ person: "minh" })
  const call = toolsFor(store, unstored, new Desk(store)).ask_manager!.call({ question: "Deploy now?" }, CALL)
  await expect(call).rejects.toThrow(NotFound)
  expect(store.listWorkItems()).toEqual([])
})

test("ask manager cancels its work item when its question expires", async () => {
  const store = openStore()
  const s = store.createSession(session({ person: "minh" }))
  const desk = new Desk(store)
  await toolsFor(store, s, desk).ask_manager!.call({ question: "Deploy now?" }, CALL)
  // As a card's `ended` does.
  store.setQuestionStatus(desk.asked[0]!.id, "stale")
  expect(store.getWorkItem(desk.asked[0]!.work_item_id!)!.status).toBe("cancelled")
})

test("ask manager with no manager is an error", async () => {
  const store = openStore()
  const s = store.createSession(session({ person: "ngocbh" }))
  const call = toolsFor(store, s, new Desk(store)).ask_manager!.call({ question: "anyone?" }, CALL)
  await expect(call).rejects.toThrow(RangeError)
  await expect(call).rejects.toThrow("no manager")
})

test("create work item and comment", async () => {
  const { store, item: parent, tools } = setup()
  const out = String(
    await tools.create_work_item!.call({
      title: "Fix the flaky test",
      summary: "retry() flakes",
      assignee: "minh",
    }),
  )
  const itemId = out.replace(/^created work item /, "")
  const item = store.getWorkItem(itemId)!
  expect([item.kind, item.status, item.requester, item.assignee, item.parent_id, item.summary]).toEqual([
    "task",
    "open",
    "minh",
    "minh",
    parent.id,
    "retry() flakes",
  ])
  expect(await tools.comment!.call({ work_item_id: itemId, body: "on it" })).toBe(`commented on ${itemId}`)
  const comments = store.listComments(itemId)
  expect(comments.map((c) => [c.author, c.body])).toEqual([["minh", "on it"]])
})

test("bad arguments are errors for the model", () => {
  const { tools } = setup()
  expect(() => tools.create_work_item!.call({ title: "x", assignee: "ghost" })).toThrow(RangeError)
  expect(() => tools.create_work_item!.call({ title: "x", assignee: "ghost" })).toThrow("no person 'ghost'")
  expect(() => tools.comment!.call({ work_item_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", body: "hi" })).toThrow(RangeError)
  expect(() => tools.comment!.call({ work_item_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", body: "hi" })).toThrow("no work item")
})

test("company tool arguments of the wrong type store nothing", async () => {
  const { store, s, item, tools } = setup()
  const V = 4242424242
  /** Asserts `fn` throws a TypeError naming `field` without quoting `V`. */
  const typeError = (fn: () => unknown, field: string) => {
    let error: unknown
    try {
      fn()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toContain(field)
    expect((error as Error).message).not.toContain(String(V))
  }
  for (const id of [{}, [item.id]]) {
    expect(() => tools.comment!.call({ work_item_id: id, body: "hi" })).toThrow(RangeError)
    expect(() => tools.comment!.call({ work_item_id: id, body: "hi" })).toThrow("no work item")
  }
  typeError(() => tools.comment!.call({ work_item_id: item.id, body: V }), "body")
  expect(() => tools.create_work_item!.call({ title: "x", assignee: V })).toThrow(RangeError)
  expect(() => tools.create_work_item!.call({ title: "x", assignee: V })).toThrow("no person")
  typeError(() => tools.create_work_item!.call({ title: V }), "title")
  typeError(() => tools.create_work_item!.call({ title: "x", summary: V }), "summary")
  await expect(tools.ask_manager!.call({ question: V }, CALL)).rejects.toThrow(TypeError)
  expect(store.listWorkItems().map((i) => i.id)).toEqual([item.id])
  expect(store.listComments(item.id)).toEqual([])
  expect(store.listQuestions({ sessionId: s.id })).toEqual([])
})

test("ask manager titles its work item with the question on one line", async () => {
  const { store, desk, tools } = setup()
  let calls = 0
  const titleOf = async (question: string) => {
    await tools.ask_manager!.call({ question }, { callId: `run-1/reply/${++calls}/0` })
    return store.getWorkItem(desk.asked.at(-1)!.work_item_id!)!.title
  }
  expect(await titleOf("  Retry\n\tor  back off?  ")).toBe("Retry or back off?")
  const long = "a".repeat(40) + "😀" + "b".repeat(59)
  expect([...long]).toHaveLength(100)
  const title = await titleOf(long)
  expect([...title]).toHaveLength(80)
  expect(title).toBe("a".repeat(40) + "😀" + "b".repeat(39))
  expect(await titleOf(" \n\t ")).toBe("Question")
})

test("ask manager without an on question callback stores nothing", async () => {
  const { store, repo, s, item } = setup()
  const tools = workTools({ store, repo, session: s, runId: "run-1" })
  await expect(tools.ask_manager!.call({ question: "Deploy now?" }, CALL)).rejects.toThrow("nobody is here to answer")
  expect(store.listWorkItems().map((i) => i.id)).toEqual([item.id])
  expect(store.listQuestions()).toEqual([])
})

test("ask manager called twice with one call id stores one question and one work item", async () => {
  const { store, s, item, tools } = setup()
  expect(isPending(await tools.ask_manager!.call({ question: "Deploy now?" }, CALL))).toBe(true)
  expect(isPending(await tools.ask_manager!.call({ question: "Deploy now?" }, CALL))).toBe(true)
  const questions = store.listQuestions({ sessionId: s.id })
  expect(questions.map((q) => q.call_id)).toEqual([CALL.callId])
  expect(store.listWorkItems().map((i) => i.id).sort()).toEqual([item.id, questions[0]!.work_item_id!].sort())
})

test("ask manager without a call id stores nothing", async () => {
  const { store, item, tools } = setup()
  await expect(tools.ask_manager!.call({ question: "Deploy now?" })).rejects.toThrow(TypeError)
  await expect(tools.ask_manager!.call({ question: "Deploy now?" })).rejects.toThrow("call id")
  expect(store.listQuestions()).toEqual([])
  expect(store.listWorkItems().map((i) => i.id)).toEqual([item.id])
})

test("an office stop leaves an ask manager item open", async () => {
  const { store, desk, tools } = setup()
  // Nothing waits on the answer: with no answer and no expiry stored, the item stays as it was stored.
  expect(isPending(await tools.ask_manager!.call({ question: "Deploy now?" }, CALL))).toBe(true)
  expect(store.getQuestion(desk.asked[0]!.id)!.status).toBe("open")
  expect(store.getWorkItem(desk.asked[0]!.work_item_id!)!.status).toBe("open")
})

test("ask manager replies pending through the office handlers", async () => {
  const { store, s, tools } = setup()
  const handlers = new BaseHandlers({ tools: { company: tools } })
  const frame = {
    type: "tool_call",
    id: 1,
    group: "company",
    name: "ask_manager",
    args: { question: "Deploy now?" },
    call_id: CALL.callId,
  }
  const got = await answerRequest(frame, handlers, workerFor(handlers, { run_id: "run-1" }))
  expect(got).toEqual({ type: "tool_result", id: 1, pending: true })
  expect(store.listQuestions({ sessionId: s.id }).map((q) => q.call_id)).toEqual([CALL.callId])
})

/** Company tools bound to the caller: ask_manager, create_work_item, comment. */
import { ToolSet } from "@ngocbh/yian/tools"
import { expect, test } from "bun:test"
import { loadRepo } from "../../../src/company/loader.ts"
import { Answers, type OnQuestion, QuestionExpired } from "../../../src/questions/ask.ts"
import { NotFound, type QuestionRecord, type SessionRecord, type Store } from "../../../src/store/store.ts"
import { companyTools, tools as workTools } from "../../../src/tools/company/work.ts"
import { groupSpecs, toolSpec } from "../../../src/worker/job.ts"
import { BaseHandlers, modelFromSchema, remoteTool } from "../../../src/worker/rpc.ts"
import { officeEnd } from "../../worker/helpers.ts"
import { company, openStore, session, workItem } from "../helpers.ts"

/** The manager never answers (Python's `...`); `null` is a real answer. */
const NEVER = Symbol("never")

type AnswerKind = NonNullable<QuestionRecord["answer_kind"]>

/** An `onQuestion` that stores through `Answers`; the manager answers each question as it is stored. */
class Desk {
  readonly asked: QuestionRecord[] = []
  readonly answers: Answers

  constructor(store: Store, answer: unknown, kind: AnswerKind = "option") {
    this.answers = new Answers(store)
    store.addListener((event) => {
      if (event.type === "question.created" && answer !== NEVER) {
        store.answerQuestion(event.subject_id, answer, kind, "ngocbh")
      }
    })
  }

  readonly onQuestion: OnQuestion = (q, options) => {
    this.asked.push(q)
    return this.answers.ask(q, { workItem: options?.workItem })
  }
}

function setup() {
  const store = openStore()
  const repo = loadRepo(company())
  const item = store.createWorkItem(workItem({ requester: "minh" }))
  const s = store.createSession(session({ person: "minh", work_item_id: item.id }))
  const desk = new Desk(store, "Back off")
  const tools = companyTools(store, repo, s, "run-1", desk.onQuestion)
  return { store, repo, s, item, desk, tools }
}

/** The company tools for `s`, with `desk` answering. */
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
  const got = await tools.ask_manager!.call({ question: "Retry or back off?", options })
  expect(got).toBe('The user chose "Back off" (option 2 of the 2 shown).')
  expect(desk.asked).toHaveLength(1)
  const q = desk.asked[0]!
  expect([q.source, q.asker, q.node_id, q.session_id, q.run_id]).toEqual(["ask_manager", "minh", null, s.id, "run-1"])
  expect(q.options).toEqual(["Retry", "Back off"])
  const item = store.getWorkItem(q.work_item_id!)!
  expect([item.kind, item.requester, item.assignee, item.parent_id, item.title]).toEqual([
    "question",
    "minh",
    "ngocbh",
    parent.id,
    "Retry or back off?",
  ])
  expect([item.status, item.resolved_by]).toEqual(["done", "ngocbh"])
})

test("ask manager options accept any shape", async () => {
  const { desk, tools } = setup()
  const spec = groupSpecs({ company: tools }).company!.find((s) => s.name === "ask_manager")!
  const args = modelFromSchema("ask_manager_args", spec.parameters).parse({ question: "q?", options: { bad: 1 } })
  await tools.ask_manager!.call(args)
  expect(desk.asked[0]!.options).toEqual([])
})

const KINDS = ["sent_back", "interrupted"] as const

test.each(KINDS)("ask manager closes its work item on any answer [%s]", async (kind) => {
  const store = openStore()
  const s = store.createSession(session({ person: "minh" }))
  const desk = new Desk(store, null, kind)
  await toolsFor(store, s, desk).ask_manager!.call({ question: "Deploy now?" })
  expect(store.getWorkItem(desk.asked[0]!.work_item_id!)!.status).toBe("done")
})

test("ask manager leaves no work item when its question cannot be stored", async () => {
  const store = openStore()
  const unstored = session({ person: "minh" })
  const call = toolsFor(store, unstored, new Desk(store, "x")).ask_manager!.call({ question: "Deploy now?" })
  await expect(call).rejects.toThrow(NotFound)
  expect(store.listWorkItems()).toEqual([])
})

test("ask manager cancels its work item when its question expires", async () => {
  const store = openStore()
  const s = store.createSession(session({ person: "minh" }))
  const desk = new Desk(store, NEVER)
  store.addListener((e) => {
    if (e.type === "question.created") store.setQuestionStatus(e.subject_id, "stale")
  })
  await expect(toolsFor(store, s, desk).ask_manager!.call({ question: "Deploy now?" })).rejects.toThrow(QuestionExpired)
  expect(store.getWorkItem(desk.asked[0]!.work_item_id!)!.status).toBe("cancelled")
})

test("ask manager with no manager is an error", async () => {
  const store = openStore()
  const s = store.createSession(session({ person: "ngocbh" }))
  const call = toolsFor(store, s, new Desk(store, "x")).ask_manager!.call({ question: "anyone?" })
  await expect(call).rejects.toThrow(RangeError)
  await expect(call).rejects.toThrow("no manager")
})

test("create work item and comment", async () => {
  const { store, item: parent, tools } = setup()
  const out = await tools.create_work_item!.call({
    title: "Fix the flaky test",
    summary: "retry() flakes",
    assignee: "minh",
  })
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
  await expect(tools.ask_manager!.call({ question: V })).rejects.toThrow(TypeError)
  expect(store.listWorkItems().map((i) => i.id)).toEqual([item.id])
  expect(store.listComments(item.id)).toEqual([])
  expect(store.listQuestions({ sessionId: s.id })).toEqual([])
})

test("ask manager titles its work item with the question on one line", async () => {
  const { store, desk, tools } = setup()
  const titleOf = async (question: string) => {
    await tools.ask_manager!.call({ question })
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
  await expect(tools.ask_manager!.call({ question: "Deploy now?" })).rejects.toThrow("nobody is here to answer")
  expect(store.listWorkItems().map((i) => i.id)).toEqual([item.id])
  expect(store.listQuestions()).toEqual([])
})

/** The office side of a run's ask_user: the handler, and storing each call's question once until it is answered. */
import { inspectRun, type PendingCall, pendingCalls } from "@ngocbh/yian/run"
import { expect, setDefaultTimeout, test } from "bun:test"
import { isPending, pending, ToolSet } from "@ngocbh/yian/tools"
import { Question } from "@opencorp/protocol"
import { loadRepo } from "../../src/company/loader.ts"
import { Answers, ASK_MANAGER_CALL, makeAskUser, type OnQuestion } from "../../src/questions/ask.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import { DuplicateKey, NotFound, StoreError, newId, type QuestionRecord } from "../../src/store/store.ts"
import { companyTools } from "../../src/tools/company/work.ts"
import { EXIT_OK } from "../../src/worker/main.ts"
import { ASK_KEYS, AskRefused, type AskRequest, askUserStub, BaseHandlers } from "../../src/worker/rpc.ts"
import { openStore, question, session, workItem } from "../store/helpers.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { company } from "../tools/helpers.ts"
import {
  agentFlow,
  base,
  inProcessWorker,
  makeJob,
  officeEnd,
  Pending,
  Recorder,
  waitsOf,
  writeFiles,
} from "../worker/helpers.ts"

setDefaultTimeout(30_000)

const PAGES = [
  { question: "Which db?", header: "DB", options: [{ label: "sqlite", description: "local" }], multi_select: false },
]
const SCHEMA = [{ name: "DB", type: "str", required: true }]
const CALL = "run-1/reply/1/0"
const NODE_CALL = "run-1/sop#0/ask"

function modelCall(over?: Partial<AskRequest>): AskRequest {
  return {
    question: "Retry or back off?",
    questions: null,
    answer_schema: null,
    title: null,
    node_id: null,
    options: ["Retry", "Back off", "Chat about this"],
    ...over,
  }
}

function askNodeCall(over?: Partial<AskRequest>): AskRequest {
  return {
    question: "",
    questions: PAGES,
    answer_schema: SCHEMA,
    title: "Setup",
    node_id: "sop#0/ask",
    options: null,
    ...over,
  }
}

/** An `OnQuestion` that records the question and returns it answered at once. */
class Desk {
  asked: QuestionRecord[] = []
  answer: unknown
  kind: QuestionRecord["answer_kind"]

  constructor(answer: unknown, kind: QuestionRecord["answer_kind"] = "option") {
    this.answer = answer
    this.kind = kind
  }

  call: OnQuestion = (q) => {
    this.asked.push(q)
    return { ...q, status: "answered", answer: this.answer, answer_kind: this.kind }
  }
}

test("the handler passes composers check and takes its calls", async () => {
  const desk = new Desk("B")
  const handler = makeAskUser(session(), "run-1", desk.call)
  // Yian's ask slot hands the request with camelCase fields, adapted to an AskRequest as askUserStub does.
  const tools = new ToolSet({
    ask: (r) =>
      handler(
        {
          question: r.question ?? null,
          questions: r.questions ?? null,
          answer_schema: r.answerSchema ?? null,
          title: r.title ?? null,
          node_id: r.nodeId ?? null,
          options: r.options ?? null,
        },
        r.callId,
      ),
  })
  expect(await tools.invoke("ask_user", { question: "A or B?", options: '["A","B"]' }, { callId: CALL })).toBe(
    'The user chose "B" (option 2 of the 2 shown).',
  )
  desk.answer = { DB: "sqlite" }
  const call = askNodeCall()
  expect(
    await tools.invokeTrusted(
      "ask",
      {
        prompt: call.question,
        questions: call.questions,
        answerSchema: call.answer_schema,
        title: call.title,
        nodeId: call.node_id,
      },
      { callId: NODE_CALL },
    ),
  ).toEqual({ DB: "sqlite" })
  expect(desk.asked.map((q) => [q.source, q.call_id])).toEqual([
    ["ask_user", CALL],
    ["ask", NODE_CALL],
  ])
  expect(new Set<string>(ASK_KEYS)).toEqual(new Set(Object.keys(modelCall())))
})

test("the handler answers through the workers stub", async () => {
  const store = openStore()
  const s = store.createSession(session())
  const answers = new Answers(store)
  const handler = makeAskUser(s, "r1", (q, o) => answers.ask(q, o))
  const rpc = await officeEnd(
    new (class extends BaseHandlers {
      override askUser(_w: unknown, r: AskRequest, callId: string) {
        return handler(r, callId)
      }
    })(),
    { concurrent: true },
  )
  const tools = new ToolSet({ ask: askUserStub(rpc) })
  const ask = () => tools.invoke("ask_user", { question: "A or B?", options: ["A", "B"] }, { callId: "r1/reply/1/0" })
  expect(isPending(await ask())).toBe(true)
  const stored = store.listQuestions({ sessionId: s.id })
  expect(stored.map((q) => [q.status, q.call_id, q.options])).toEqual([["open", "r1/reply/1/0", ["A", "B"]]])
  store.answerQuestion(stored[0]!.id, "B", "option")
  const chosen = 'The user chose "B" (option 2 of the 2 shown).'
  expect(await ask()).toBe(chosen)
  expect(store.getQuestion(stored[0]!.id)!.status).toBe("consumed")
  // A call whose reply was lost is invoked again and still gets the answer.
  expect(await ask()).toBe(chosen)
  expect(store.listQuestions({ sessionId: s.id })).toHaveLength(1)
})

test("a model call stores a flat question and returns the formatted answer", async () => {
  const s = session({ work_item_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ" })
  const desk = new Desk("Back off")
  const got = await makeAskUser(s, "run-1", desk.call, { names: ["minh"] })(modelCall(), CALL)
  expect(got).toBe('The user chose "Back off" (option 2 of the 2 shown).')
  expect(desk.asked.length).toBe(1)
  const q = desk.asked[0]!
  expect([q.source, q.node_id, q.asker, q.session_id, q.run_id, q.work_item_id, q.call_id]).toEqual([
    "ask_user",
    null,
    "minh",
    s.id,
    "run-1",
    s.work_item_id,
    CALL,
  ])
  expect(q.options).toEqual(["Retry", "Back off"])
  expect(q.questions).toBeNull()
  expect(q.answer_schema).toEqual([])
  expect(q.status).toBe("open")
  expect(Question.parse(q)).toEqual(q)

  const { store, sid, answers } = setup()
  const stored = store.getSession(sid)!
  const open = await makeAskUser(stored, "run-1", (question, o) => answers.ask(question, o))(modelCall(), CALL)
  expect(isPending(open)).toBe(true)
  expect(store.listQuestions({ sessionId: sid }).map((x) => x.status)).toEqual(["open"])
})

test("a model call with bad options still asks", async () => {
  const desk = new Desk("fine", "text")
  expect(await makeAskUser(session(), "run-1", desk.call)(modelCall({ options: { x: 1 } }), CALL)).toBe(
    "The user answered: fine",
  )
  expect(desk.asked[0]!.options).toEqual([])
})

test("a model call with a blank question is refused and stores nothing", async () => {
  const { store, sid, answers } = setup()
  const handler = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  for (const question of ["", "   ", null]) {
    const error = await handler(modelCall({ question }), CALL).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AskRefused)
    expect((error as Error).message).toBe("ask_user question is blank: write the question to ask the user")
  }
  expect(store.listQuestions({ sessionId: sid })).toEqual([])
})

test("a model call with text that is not valid is refused without it", async () => {
  const { store, sid, answers } = setup()
  const handler = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  for (const over of [{ question: "Which \ud800?" }, { options: ["A", "B\ud800"] }]) {
    const error = await handler(modelCall(over), CALL).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AskRefused)
    expect((error as Error).message).toBe("ask_user question and options must be valid text")
  }
  expect(store.listQuestions({ sessionId: sid })).toEqual([])
})

test("an ask node call with an empty question still asks", async () => {
  const { store, sid, answers } = setup()
  const handler = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  expect(isPending(await handler(askNodeCall({ question: "" }), NODE_CALL))).toBe(true)
  expect(store.listQuestions({ sessionId: sid }).map((q) => [q.source, q.question])).toEqual([["ask", ""]])
})

test("an ask node call keeps its node pages and schema", async () => {
  const desk = new Desk({ DB: "sqlite" })
  const got = await makeAskUser(session(), "run-1", desk.call)(askNodeCall(), NODE_CALL)
  expect(got).toEqual({ DB: "sqlite" })
  expect(desk.asked.length).toBe(1)
  const q = desk.asked[0]!
  expect([q.source, q.node_id, q.title, q.question, q.call_id]).toEqual(["ask", "sop#0/ask", "Setup", "", NODE_CALL])
  expect(q.questions![0]!.options[0]!.description).toBe("local")
  expect(q.answer_schema[0]!.name).toBe("DB")
  expect(q.options).toEqual([])
})

const PAGED =
  "id: paged\nname: paged\nnodes:\n  asked:\n    kind: tool\n    tool_id: ask\n    input:\n" +
  '      prompt: "Setup"\n      questions:\n        - question: "Which db?"\n          header: DB\n' +
  "          options:\n            - label: sqlite\n          multi_select: true\n" +
  '        - question: "Why?"\n          header: Why\noutput: ${asked.output}\n'

test("an ask node from a real flow stores its pages", async () => {
  const store = openStore()
  const s = store.createSession(session())
  const answers = new Answers(store)
  const b = base()
  writeFiles(b.pin, { "flows/paged.yaml": PAGED })
  const job = makeJob(b, "flows/paged.yaml", { inputs: {} })
  const ask = makeAskUser(s, job.run_id, (q, o) => answers.ask(q, o))
  const handlers = new (class extends Recorder {
    override askUser(_w: unknown, request: AskRequest, callId?: string): unknown {
      this.asked.push(request)
      expect(callId).toBeDefined()
      return ask(request, callId!)
    }
  })()
  const worker = await inProcessWorker(job, handlers)
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(handlers.outcome?.status, String(handlers.outcome?.message)).toBe("waiting")
  const stored = store.listQuestions({ sessionId: s.id })
  expect(stored.map((q) => [q.source, q.call_id, q.status])).toEqual([["ask", `${job.run_id}/asked`, "open"]])
  expect(stored[0]!.questions).toEqual([
    {
      question: "Which db?",
      header: "DB",
      options: [{ label: "sqlite", description: "" }],
      multi_select: true,
      secret: false,
    },
    { question: "Why?", header: "Why", options: [], multi_select: false, secret: false },
  ])
})

test("a carried discussion reaches the answer", async () => {
  const handler = makeAskUser(session(), "run-1", new Desk("x", "text").call, {
    carried: () => [{ role: "user", text: "before" }],
  })
  expect(await handler(modelCall(), CALL)).toEndWith(
    '[{"role":"note","text":"from an earlier, expired question"},{"role":"user","text":"before"}]',
  )
})

test("a malformed request is refused without its values", async () => {
  const desk = new Desk("x")
  const request = askNodeCall({
    questions: [{ question: "sk-SECRET", header: 7, options: [] }],
    title: { sk: "nested" },
  })
  const error = await makeAskUser(session(), "run-1", desk.call)(request, NODE_CALL).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(TypeError)
  expect((error as Error).name).toBe("TypeError")
  expect((error as Error).message).not.toContain("sk-SECRET")
  expect((error as Error).message).not.toContain("nested")
  expect(desk.asked).toEqual([])
})

/** A store with one session, and `Answers` on it whose log lines go to `lines`. */
function setup() {
  const store = openStore()
  const sid = store.createSession(session()).id
  const lines: string[] = []
  const answers = new Answers(store, { log: (line) => lines.push(line) })
  return { store, sid, answers, lines }
}

/** An `ask_manager` question of session `sid` and its work item. */
function managerQuestion(sid: string, callId = CALL) {
  const item = workItem({ kind: "question" })
  const q = question(sid, { source: "ask_manager", work_item_id: item.id, call_id: callId })
  return { item, q }
}

test("ask stores then blocks until answered and marks consumed", () => {
  const { store, sid, answers } = setup()
  const q = question(sid, { call_id: CALL })
  const first = answers.ask(q)
  expect([first.id, first.status]).toEqual([q.id, "open"])
  expect(store.listQuestions({ sessionId: sid, status: "open" }).map((s) => s.id)).toEqual([q.id])
  store.answerQuestion(q.id, "pg", "text", "ngocbh")
  const got = answers.ask(question(sid, { call_id: CALL }))
  expect([got.id, got.answer, got.status]).toEqual([q.id, "pg", "consumed"])
  expect(store.getQuestion(q.id)!.status).toBe("consumed")
})

test("a question that goes stale raises", async () => {
  const { store, sid, answers } = setup()
  const ask = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  expect(isPending(await ask(modelCall(), CALL))).toBe(true)
  const q = store.getQuestionByCall(CALL)!
  answers.closedCall("run-1", CALL, "cancelled")
  expect(store.getQuestion(q.id)!.status).toBe("stale")
  const error = await ask(modelCall(), CALL).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(`question ${q.id} expired before it was answered`)
})

test("an ask node asked again finds its stored question", () => {
  const { store, sid, answers } = setup()
  const first = store.addQuestion(question(sid, { source: "ask", node_id: "sop#0/ask", call_id: NODE_CALL }))
  store.answerQuestion(first.id, "kept", "text")
  const got = answers.ask(question(sid, { source: "ask", node_id: "sop#0/ask", call_id: NODE_CALL }))
  expect(got.id).toBe(first.id)
  expect(got.answer).toBe("kept")
  expect(store.listQuestions({ sessionId: sid }).length).toBe(1)
})

test("a work item is stored with its question", () => {
  const { store, sid, answers } = setup()
  const { item, q } = managerQuestion(sid)
  answers.ask(q, { workItem: item })
  const stored = store.listQuestions({ sessionId: sid, status: "open" })
  expect(stored.map((s) => s.work_item_id)).toEqual([item.id])
  expect(store.getWorkItem(item.id)!.status).toBe("open")
})

test("a question that cannot be stored leaves no work item", () => {
  const { store, answers } = setup()
  const { item, q } = managerQuestion("01J9ZZZZZZZZZZZZZZZZZZZZZZ")
  expect(() => answers.ask(q, { workItem: item })).toThrow(NotFound)
  expect(store.getWorkItem(item.id)).toBeUndefined()
})

test("a question that goes stale cancels its work item", () => {
  const { store, sid, answers, lines } = setup()
  const { item, q } = managerQuestion(sid)
  answers.ask(q, { workItem: item })
  answers.closedCall("run-1", CALL, "timed_out")
  expect(store.getQuestion(q.id)!.status).toBe("stale")
  expect(store.getWorkItem(item.id)!.status).toBe("cancelled")
  expect(lines).toEqual([])
})

test("a store error after the answer does not cancel the work item", () => {
  const { store, sid, answers } = setup()
  const { item, q } = managerQuestion(sid)
  answers.ask(q, { workItem: item })
  store.answerQuestion(q.id, "pg", "text", "ngocbh")
  expect(store.getWorkItem(item.id)!.status).toBe("done")
  const setQuestionStatus = store.setQuestionStatus.bind(store)
  store.setQuestionStatus = () => {
    throw new StoreError("disk full")
  }
  try {
    expect(() => answers.ask(managerQuestion(sid).q)).toThrow(StoreError)
  } finally {
    store.setQuestionStatus = setQuestionStatus
  }
  expect(store.getWorkItem(item.id)!.status).toBe("done")
})

test("a work item that cannot be cancelled is logged by its error name", () => {
  const { store, sid, answers, lines } = setup()
  const { item, q } = managerQuestion(sid)
  answers.ask(q, { workItem: item })
  const updateWorkItem = store.updateWorkItem.bind(store)
  store.updateWorkItem = () => {
    throw new StoreError("secret /path")
  }
  try {
    store.setQuestionStatus(q.id, "stale")
  } finally {
    store.updateWorkItem = updateWorkItem
  }
  expect(lines).toEqual([`could not settle the work item of question ${q.id}: StoreError`])
  expect(lines.some((line) => line.includes("secret"))).toBe(false)
  expect(store.getWorkItem(item.id)!.status).toBe("open")
})

test("a repeated question id is refused", () => {
  const { store, sid, answers } = setup()
  const q = question(sid, { call_id: CALL })
  answers.ask(q)
  const again = question(sid, { id: q.id, question: "Which cache?", call_id: "run-1/reply/2/0" })
  expect(() => answers.ask(again)).toThrow(DuplicateKey)
  expect(store.listQuestions({ sessionId: sid }).map((s) => [s.question, s.call_id])).toEqual([["Which db?", CALL]])
})

test("carried returns the expired questions discussion or nothing", () => {
  const { store, sid, answers } = setup()
  const earlier = store.addQuestion(question(sid, { discussion: [{ role: "user", text: "before" }] }))
  store.setQuestionStatus(earlier.id, "stale")
  expect(answers.carried(question(sid, { carried_from: earlier.id }))).toEqual([{ role: "user", text: "before" }])
  expect(answers.carried(question(sid, { carried_from: newId() }))).toEqual([])
  expect(answers.carried(question(sid))).toEqual([])
})

test("a handler called twice with one call id stores one question", async () => {
  const { store, sid, answers } = setup()
  const ask = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  expect(isPending(await ask(modelCall(), CALL))).toBe(true)
  expect(isPending(await ask(modelCall(), CALL))).toBe(true)
  expect(store.listQuestions({ sessionId: sid }).map((q) => q.call_id)).toEqual([CALL])
})

test("a call id from another run is refused", () => {
  const { store, sid, answers } = setup()
  for (const callId of ["run-2/reply/1/0", "run-1", null]) {
    expect(() => answers.ask(question(sid, { call_id: callId }))).toThrow(TypeError)
  }
  expect(store.listQuestions({ sessionId: sid })).toEqual([])
  const other = store.addQuestion(question(sid, { run_id: "run-2", call_id: "run-1/reply/9/0" }))
  expect(() => answers.ask(question(sid, { call_id: "run-1/reply/9/0" }))).toThrow(TypeError)
  expect(store.listQuestions({ sessionId: sid })).toEqual([other])
})

test.each(["interrupted", "timed_out", "cancelled", "crashed", "failed"])(
  "a closed call answers interrupted or goes stale [%s]",
  (reason) => {
    const { store, sid, answers } = setup()
    const q = answers.ask(question(sid, { call_id: CALL }))
    const got = answers.closedCall("run-1", CALL, reason)!
    expect(got.id).toBe(q.id)
    const stored = store.getQuestion(q.id)!
    if (reason === "interrupted") {
      expect([stored.answer, stored.answer_kind, stored.answered_by, stored.status]).toEqual([
        INTERRUPTED,
        "interrupted",
        null,
        "consumed",
      ])
    } else {
      expect([stored.status, stored.answer_kind]).toEqual(["stale", null])
    }
    expect(got).toEqual(stored)
  },
)

test("a closed call on a flow question goes stale", () => {
  const { store, sid, answers } = setup()
  const q = answers.ask(question(sid, { source: "ask", node_id: "sop#0/ask", call_id: NODE_CALL }))
  answers.closedCall("run-1", NODE_CALL, "interrupted")
  expect([store.getQuestion(q.id)!.status, store.getQuestion(q.id)!.answer_kind]).toEqual(["stale", null])
})

test("a closed call interrupts an ask manager question and closes its item", () => {
  const { store, sid, answers, lines } = setup()
  const { item, q } = managerQuestion(sid)
  answers.ask(q, { workItem: item })
  answers.closedCall("run-1", CALL, "interrupted")
  const stored = store.getQuestion(q.id)!
  expect([stored.status, stored.answer, stored.answer_kind, stored.answered_by]).toEqual([
    "consumed",
    INTERRUPTED,
    "interrupted",
    null,
  ])
  const closed = store.getWorkItem(item.id)!
  expect([closed.status, closed.resolved_by]).toEqual(["done", null])
  expect(lines).toEqual([])
})

test("a closed call of another run or an answered question changes nothing", () => {
  const { store, sid, answers } = setup()
  const open = answers.ask(question(sid, { call_id: CALL }))
  const other = store.addQuestion(question(sid, { run_id: "run-2", call_id: "run-2/reply/1/0" }))
  expect(answers.closedCall("run-2", CALL, "cancelled")).toBeUndefined()
  expect(answers.closedCall("run-1", "run-2/reply/1/0", "cancelled")).toBeUndefined()
  const misnamed = store.addQuestion(question(sid, { run_id: "run-2", call_id: "run-1/reply/9/0" }))
  expect(answers.closedCall("run-1", "run-1/reply/9/0", "cancelled")).toBeUndefined()
  expect(store.getQuestion(open.id)!.status).toBe("open")
  expect(store.getQuestion(other.id)!.status).toBe("open")
  expect(store.getQuestion(misnamed.id)!.status).toBe("open")
  store.answerQuestion(open.id, "pg", "text")
  expect(answers.closedCall("run-1", CALL, "interrupted")!.status).toBe("answered")
  expect([store.getQuestion(open.id)!.status, store.getQuestion(open.id)!.answer]).toEqual(["answered", "pg"])
})

/** An open host call of run-1 as `pendingCalls` lists it. */
function pendingCall(over: Partial<PendingCall>): PendingCall {
  return {
    callId: CALL,
    node: "reply",
    tool: "ask_user",
    arguments: null,
    pendingSeq: 1,
    deadline: null,
    ...over,
  }
}

test("reconcile marks an unlisted question stale and stores an unstored call", async () => {
  const { store, sid, answers, lines } = setup()
  const s = store.getSession(sid)!
  const unlisted = answers.ask(question(sid, { call_id: "run-1/reply/1/0" }))
  const kept = answers.ask(question(sid, { call_id: "run-1/reply/4/0" }))
  const other = store.addQuestion(question(sid, { run_id: "run-2", call_id: "run-2/reply/1/0" }))
  const answered = answers.ask(question(sid, { call_id: "run-1/reply/5/0" }))
  store.answerQuestion(answered.id, "pg", "text")
  const calls = [
    pendingCall({ callId: "run-1/reply/2/0", arguments: { question: "Which city?", options: ["Paris", "Rome"] } }),
    pendingCall({ callId: "run-1/reply/4/0", arguments: { question: "Which db?" } }),
    pendingCall({ callId: "run-1/reply/6/0", tool: ASK_MANAGER_CALL, arguments: { question: "Deploy now?" } }),
  ]
  const askUser = makeAskUser(s, "run-1", (q, o) => answers.ask(q, o))
  const tools = companyTools(store, loadRepo(company()), s, "run-1", (q, o) => answers.ask(q, o))
  const askManager = (args: Record<string, unknown>, callId: string) => tools.ask_manager!.call(args, { callId })
  await answers.reconcile("run-1", calls, { askUser, askManager })
  expect(store.getQuestion(unlisted.id)!.status).toBe("stale")
  expect(store.getQuestion(kept.id)).toEqual(kept)
  expect(store.getQuestion(other.id)!.status).toBe("open")
  expect([store.getQuestion(answered.id)!.status, store.getQuestion(answered.id)!.answer]).toEqual(["answered", "pg"])
  const stored = store.listQuestions({ runId: "run-1", status: "open" })
  expect(stored.map((q) => [q.call_id, q.source, q.question, q.options])).toEqual([
    ["run-1/reply/4/0", "ask_user", "Which db?", []],
    ["run-1/reply/2/0", "ask_user", "Which city?", ["Paris", "Rome"]],
    ["run-1/reply/6/0", "ask_manager", "Deploy now?", []],
  ])
  const item = store.getWorkItem(stored[2]!.work_item_id!)!
  expect([item.status, item.assignee]).toEqual(["open", "ngocbh"])
  expect(store.listQuestions({ sessionId: sid })).toHaveLength(6)
  expect(lines).toEqual([])
})

test("reconcile logs a recorded blank model question and stores nothing", async () => {
  const { store, sid, answers, lines } = setup()
  const askUser = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  await answers.reconcile("run-1", [pendingCall({ arguments: { question: " " } })], { askUser })
  expect(lines).toEqual([`could not store the question of call ${CALL}: AskRefused`])
  expect(store.listQuestions({ sessionId: sid })).toEqual([])
})

test("reconcile rebuilds an ask node call from its recorded inputs", async () => {
  const fake = await fakeLlm()
  const job = makeJob(base(), "flows/turn.yaml", { inputs: {} })
  const handlers = new Pending()
  const worker = await inProcessWorker(job, handlers, { env: fake.env() })
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(handlers.outcome?.status, String(handlers.outcome?.message)).toBe("waiting")
  const calls = pendingCalls(job.log)
  expect(calls.map((call) => [call.node, call.tool, call.callId])).toEqual([["asked", "ask", `${job.run_id}/asked`]])

  const { store, sid, answers, lines } = setup()
  const askUser = makeAskUser(store.getSession(sid)!, job.run_id, (q, o) => answers.ask(q, o))
  await answers.reconcile(job.run_id, calls, { askUser })
  const stored = store.listQuestions({ sessionId: sid })
  expect(stored.map((q) => [q.source, q.node_id, q.question, q.call_id, q.status, q.title, q.answer_schema])).toEqual([
    ["ask", "asked", "Where to?", `${job.run_id}/asked`, "open", null, []],
  ])

  const byHand = pendingCall({
    callId: "run-1/sop#0/ask",
    node: "sop#0/ask",
    tool: "ask",
    arguments: { prompt: "Setup", questions: [{ question: "Why?", header: "Why" }] },
  })
  const askRun1 = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  await answers.reconcile("run-1", [byHand], { askUser: askRun1 })
  const page = store.getQuestionByCall("run-1/sop#0/ask")!
  expect([page.source, page.node_id, page.question]).toEqual(["ask", "sop#0/ask", "Setup"])
  expect(page.questions).toEqual([{ question: "Why?", header: "Why", options: [], multi_select: false, secret: false }])
  expect(lines).toEqual([])
})

test("reconcile rebuilds an ask_manager call as yian records it", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "company_ask_manager", arguments: { question: "Deploy now?" } }] })
  const b = base()
  writeFiles(b.pin, { "flows/managed.yaml": agentFlow("managed", { node: "    tools: [company]\n" }) })
  const parameters = { type: "object", properties: { question: { type: "string" } }, required: ["question"] }
  const parked = { description: "Ask.", parameters, call: () => pending() }
  const handlers = new Pending({ tools: { company: { ask_manager: parked } } })
  const job = makeJob(b, "flows/managed.yaml", {}, handlers)
  const worker = await inProcessWorker(job, handlers, { env: fake.env() })
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(handlers.outcome?.status, String(handlers.outcome?.message)).toBe("waiting")
  // The session actor tells a model question's wait by its tool, from the result and from the log.
  expect(waitsOf(handlers).map((wait) => wait.tool)).toEqual([ASK_MANAGER_CALL])
  expect(inspectRun(job.log).waits.map((wait) => wait.tool)).toEqual([ASK_MANAGER_CALL])
  const calls = pendingCalls(job.log)

  const { store, sid, answers, lines } = setup()
  const s = store.getSession(sid)!
  const tools = companyTools(store, loadRepo(company()), s, job.run_id, (q, o) => answers.ask(q, o))
  await answers.reconcile(job.run_id, calls, {
    askUser: makeAskUser(s, job.run_id, (q, o) => answers.ask(q, o)),
    askManager: (args, callId) => tools.ask_manager!.call(args, { callId }),
  })
  const stored = store.listQuestions({ sessionId: sid })
  expect(stored.map((q) => [q.source, q.question, q.call_id, q.status])).toEqual([
    ["ask_manager", "Deploy now?", calls[0]!.callId, "open"],
  ])
  expect(lines).toEqual([])
})

test("reconcile skips calls of another run and logs a call it cannot store by its error name", async () => {
  const { store, sid, answers, lines } = setup()
  const real = makeAskUser(store.getSession(sid)!, "run-1", (q, o) => answers.ask(q, o))
  const seen: string[] = []
  const askUser = (request: AskRequest, callId: string) => {
    seen.push(callId)
    if (callId === "run-1/reply/3/0") return Promise.reject(new StoreError("secret"))
    return real(request, callId)
  }
  const managed: string[] = []
  const calls = [
    pendingCall({ callId: "run-2/reply/1/0", arguments: { question: "Elsewhere?" } }),
    pendingCall({ callId: "run-1/reply/2/0", tool: "shout", arguments: { text: "hi" } }),
    pendingCall({ callId: "run-1/reply/3/0", arguments: { question: "secret question" } }),
    pendingCall({ callId: "run-1/reply/4/0", arguments: { question: "Which city?" } }),
  ]
  await answers.reconcile("run-1", calls, {
    askUser,
    askManager: (_args, callId) => managed.push(callId),
  })
  expect(seen).toEqual(["run-1/reply/3/0", "run-1/reply/4/0"])
  expect(managed).toEqual([])
  expect(lines).toEqual(["could not store the question of call run-1/reply/3/0: StoreError"])
  expect(lines.some((line) => line.includes("secret"))).toBe(false)
  expect(store.listQuestions({ sessionId: sid }).map((q) => [q.call_id, q.question])).toEqual([
    ["run-1/reply/4/0", "Which city?"],
  ])
})

/** The office side of a run's ask_user: the handler, and storing then waiting for answers. */
import { expect, onTestFinished, test } from "bun:test"
import { Question } from "@opencorp/protocol"
import { Answers, AnswersClosed, QuestionExpired, makeAskUser, type OnQuestion } from "../../src/questions/ask.ts"
import {
  DuplicateKey,
  NotFound,
  Store,
  StoreError,
  newId,
  type QuestionRecord,
  type WorkItemRecord,
} from "../../src/store/store.ts"
import type { AskRequest } from "../../src/worker/rpc.ts"
import { openStore, question, session, workItem } from "../store/helpers.ts"

const PAGES = [
  { question: "Which db?", header: "DB", options: [{ label: "sqlite", description: "local" }], multi_select: false },
]
const SCHEMA = [{ name: "DB", type: "str", required: true }]

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

function humanInputCall(over?: Partial<AskRequest>): AskRequest {
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

/** An `OnQuestion` that records the question and answers it at once. */
class Desk {
  asked: QuestionRecord[] = []
  answer: unknown
  kind: QuestionRecord["answer_kind"]

  constructor(answer: unknown, kind: QuestionRecord["answer_kind"] = "option") {
    this.answer = answer
    this.kind = kind
  }

  call: OnQuestion = async (q) => {
    this.asked.push(q)
    return { ...q, status: "answered", answer: this.answer, answer_kind: this.kind }
  }
}

test("a model call stores a flat question and returns the formatted answer", async () => {
  const s = session({ work_item_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ" })
  const desk = new Desk("Back off")
  const got = await makeAskUser(s, "run-1", desk.call, { names: ["minh"] })(modelCall())
  expect(got).toBe('The user chose "Back off" (option 2 of the 2 shown).')
  expect(desk.asked.length).toBe(1)
  const q = desk.asked[0]!
  expect([q.source, q.node_id, q.asker, q.session_id, q.run_id, q.work_item_id]).toEqual([
    "ask_user",
    null,
    "minh",
    s.id,
    "run-1",
    s.work_item_id,
  ])
  expect(q.options).toEqual(["Retry", "Back off"])
  expect(q.questions).toBeNull()
  expect(q.answer_schema).toEqual([])
  expect(q.status).toBe("open")
  expect(Question.parse(q)).toEqual(q)
})

test("a model call with bad options still asks", async () => {
  const desk = new Desk("fine", "text")
  expect(await makeAskUser(session(), "run-1", desk.call)(modelCall({ options: { x: 1 } }))).toBe(
    "The user answered: fine",
  )
  expect(desk.asked[0]!.options).toEqual([])
})

test("a human input call keeps its node pages and schema", async () => {
  const desk = new Desk({ DB: "sqlite" })
  const got = await makeAskUser(session(), "run-1", desk.call)(humanInputCall())
  expect(got).toEqual({ DB: "sqlite" })
  expect(desk.asked.length).toBe(1)
  const q = desk.asked[0]!
  expect([q.source, q.node_id, q.title, q.question]).toEqual(["human_input", "sop#0/ask", "Setup", ""])
  expect(q.questions![0]!.options[0]!.description).toBe("local")
  expect(q.answer_schema[0]!.name).toBe("DB")
  expect(q.options).toEqual([])
})

test("a carried discussion reaches the answer", async () => {
  const handler = makeAskUser(session(), "run-1", new Desk("x", "text").call, {
    carried: () => [{ role: "user", text: "before" }],
  })
  expect(await handler(modelCall())).toEndWith(
    '[{"role":"note","text":"from an earlier, expired question"},{"role":"user","text":"before"}]',
  )
})

test("a malformed request is refused without its values", async () => {
  const desk = new Desk("x")
  const request = humanInputCall({
    questions: [{ question: "sk-SECRET", header: 7, options: [] }],
    title: { sk: "nested" },
  })
  const error = await makeAskUser(session(), "run-1", desk.call)(request).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(TypeError)
  expect((error as Error).name).toBe("TypeError")
  expect((error as Error).message).not.toContain("sk-SECRET")
  expect((error as Error).message).not.toContain("nested")
  expect(desk.asked).toEqual([])
})

/** A store with one session, and `Answers` on it whose log lines go to `lines`; closed when the test finishes. */
function setup() {
  const store = openStore()
  const sid = store.createSession(session()).id
  const lines: string[] = []
  const answers = new Answers(store, { log: (line) => lines.push(line) })
  onTestFinished(() => answers.close())
  return { store, sid, answers, lines }
}

/** Call `answers.ask(q, options)`; `out` gets its result or its error, and `done` (which never rejects) settles
 *  once it has one. */
function asking(answers: Answers, q: QuestionRecord, options?: { workItem?: WorkItemRecord; signal?: AbortSignal }) {
  const out: { result?: QuestionRecord; error?: unknown } = {}
  const done = answers.ask(q, options).then(
    (result) => {
      out.result = result
    },
    (error: unknown) => {
      out.error = error
    },
  )
  return { done, out }
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

test("ask stores then blocks until answered and marks consumed", async () => {
  const { store, sid, answers } = setup()
  const q = question(sid)
  const { done, out } = asking(answers, q)
  expect(store.listQuestions({ sessionId: sid, status: "open" }).map((s) => s.id)).toEqual([q.id])
  await tick()
  expect(out).toEqual({})
  store.answerQuestion(q.id, "pg", "text", "ngocbh")
  await done
  expect(out.result!.answer).toBe("pg")
  expect(out.result!.status).toBe("consumed")
  expect(store.getQuestion(q.id)!.status).toBe("consumed")
  expect(answers.waiting).toBe(0)
})

test("a question that goes stale raises", async () => {
  const { store, sid, answers } = setup()
  const q = question(sid)
  const { done, out } = asking(answers, q)
  store.setQuestionStatus(q.id, "stale")
  await done
  expect(out.error).toBeInstanceOf(QuestionExpired)
  expect((out.error as Error).message).toBe(`question ${q.id} expired before it was answered`)
  expect(answers.waiting).toBe(0)
})

test("a re asked human input finds its stored question", async () => {
  const { store, sid, answers } = setup()
  const first = store.addQuestion(question(sid, { source: "human_input", node_id: "sop#0/ask" }))
  store.answerQuestion(first.id, "kept", "text")
  const again = question(sid, { source: "human_input", node_id: "sop#0/ask" })
  const got = await answers.ask(again)
  expect(got.id).toBe(first.id)
  expect(got.answer).toBe("kept")
  expect(store.listQuestions({ sessionId: sid }).length).toBe(1)
})

test("a work item is stored with its question", async () => {
  const { store, sid, answers } = setup()
  const item = workItem({ kind: "question" })
  const q = question(sid, { work_item_id: item.id })
  const { done, out } = asking(answers, q, { workItem: item })
  const stored = store.listQuestions({ sessionId: sid, status: "open" })
  expect(stored.map((s) => s.work_item_id)).toEqual([item.id])
  expect(store.getWorkItem(item.id)!.status).toBe("open")
  store.answerQuestion(q.id, "pg", "text")
  await done
  expect(out.result!.status).toBe("consumed")
})

test("a question that cannot be stored leaves no work item", async () => {
  const { store, answers } = setup()
  const item = workItem({ kind: "question" })
  const q = question("01J9ZZZZZZZZZZZZZZZZZZZZZZ", { work_item_id: item.id })
  await expect(answers.ask(q, { workItem: item })).rejects.toBeInstanceOf(NotFound)
  expect(store.getWorkItem(item.id)).toBeUndefined()
})

test("a question that goes stale cancels its work item", async () => {
  const { store, sid, answers, lines } = setup()
  const item = workItem({ kind: "question" })
  const q = question(sid, { work_item_id: item.id })
  const { done, out } = asking(answers, q, { workItem: item })
  store.setQuestionStatus(q.id, "stale")
  await done
  expect(out.error).toBeInstanceOf(QuestionExpired)
  expect(store.getWorkItem(item.id)!.status).toBe("cancelled")
  expect(lines).toEqual([])
})

test("an answer that lands between the check and the wait still wakes ask", async () => {
  const { store, sid, answers } = setup()
  const q = question(sid)
  const getQuestion = store.getQuestion.bind(store)
  store.getQuestion = (qid) => {
    // ask sees the question open, then the answer lands before ask starts waiting.
    const seen = getQuestion(qid)
    if (seen?.status === "open") {
      store.getQuestion = getQuestion
      store.answerQuestion(qid, "pg", "text")
    }
    return seen
  }
  const { done, out } = asking(answers, q)
  await done
  expect(out.result!.answer).toBe("pg")
  expect(answers.waiting).toBe(0)
})

test("close wakes every waiting ask", async () => {
  const { sid, answers } = setup()
  const waiting = [asking(answers, question(sid)), asking(answers, question(sid))]
  await tick()
  answers.close()
  await Promise.all(waiting.map((w) => w.done))
  for (const { out } of waiting) expect(out.error).toBeInstanceOf(AnswersClosed)
  expect(answers.waiting).toBe(0)
})

test("ask after close raises and stores nothing", async () => {
  const { store, sid, answers } = setup()
  answers.close()
  await expect(answers.ask(question(sid))).rejects.toBeInstanceOf(AnswersClosed)
  expect(store.listQuestions({ sessionId: sid })).toEqual([])
})

test("close leaves the open question and its work item as they are", async () => {
  const { store, sid, answers } = setup()
  const item = workItem({ kind: "question" })
  const q = question(sid, { work_item_id: item.id })
  const { done, out } = asking(answers, q, { workItem: item })
  await tick()
  answers.close()
  await done
  // Stopping the office is not the question expiring: the run resumes after a restart.
  expect(out.error).toBeInstanceOf(AnswersClosed)
  expect(store.getQuestion(q.id)!.status).toBe("open")
  expect(store.getWorkItem(item.id)!.status).toBe("open")
})

test("an answer committed just before close is returned", async () => {
  const { store, sid, answers } = setup()
  const item = workItem({ kind: "question" })
  const q = question(sid, { work_item_id: item.id })
  const { done, out } = asking(answers, q, { workItem: item })
  await tick()
  // Answered through another connection, so no event wakes the waiter before close does.
  const other = new Store(store.path)
  try {
    other.answerQuestion(q.id, "pg", "text")
  } finally {
    other.close()
  }
  await tick()
  expect(out).toEqual({})
  answers.close()
  await done
  expect(out.result!.answer).toBe("pg")
  expect(out.result!.status).toBe("consumed")
  expect(store.getWorkItem(item.id)!.status).toBe("open")
})

test("a store error after the answer does not cancel the work item", async () => {
  const { store, sid, answers } = setup()
  const item = workItem({ kind: "question" })
  const q = question(sid, { work_item_id: item.id })
  const setQuestionStatus = store.setQuestionStatus.bind(store)
  store.setQuestionStatus = () => {
    throw new StoreError("disk full")
  }
  try {
    const { done, out } = asking(answers, q, { workItem: item })
    store.answerQuestion(q.id, "pg", "text")
    await done
    expect(out.error).toBeInstanceOf(StoreError)
    expect(store.getWorkItem(item.id)!.status).toBe("open")
  } finally {
    store.setQuestionStatus = setQuestionStatus
  }
})

test("a work item that cannot be cancelled is logged by its error name", async () => {
  const { store, sid, answers, lines } = setup()
  const item = workItem({ kind: "question" })
  const q = question(sid, { work_item_id: item.id })
  const updateWorkItem = store.updateWorkItem.bind(store)
  store.updateWorkItem = () => {
    throw new StoreError("secret /path")
  }
  try {
    const { done, out } = asking(answers, q, { workItem: item })
    store.setQuestionStatus(q.id, "stale")
    await done
    expect(out.error).toBeInstanceOf(QuestionExpired)
  } finally {
    store.updateWorkItem = updateWorkItem
  }
  expect(lines).toEqual([`could not cancel the work item of expired question ${q.id}: StoreError`])
  expect(lines.some((line) => line.includes("secret"))).toBe(false)
  expect(store.getWorkItem(item.id)!.status).toBe("open")
})

test("a repeated question id is refused", async () => {
  const { store, sid, answers } = setup()
  const q = question(sid)
  const first = asking(answers, q)
  const again = asking(answers, question(sid, { id: q.id, node_id: null, question: "Which cache?" }))
  await again.done
  expect(again.out.error).toBeInstanceOf(DuplicateKey)
  expect(store.listQuestions({ sessionId: sid }).map((s) => s.question)).toEqual(["Which db?"])
  store.answerQuestion(q.id, "pg", "text")
  await first.done
  expect(first.out.result!.answer).toBe("pg")
})

test("carried returns the expired questions discussion or nothing", () => {
  const { store, sid, answers } = setup()
  const earlier = store.addQuestion(question(sid, { discussion: [{ role: "user", text: "before" }] }))
  store.setQuestionStatus(earlier.id, "stale")
  expect(answers.carried(question(sid, { carried_from: earlier.id }))).toEqual([{ role: "user", text: "before" }])
  expect(answers.carried(question(sid, { carried_from: newId() }))).toEqual([])
  expect(answers.carried(question(sid))).toEqual([])
})

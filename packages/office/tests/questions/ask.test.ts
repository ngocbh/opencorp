/** The office side of a run's ask_user: the handler, and storing then waiting for answers. */
import { expect, test } from "bun:test"
import { Question } from "@opencorp/protocol"
import { makeAskUser, type OnQuestion } from "../../src/questions/ask.ts"
import type { QuestionRecord } from "../../src/store/store.ts"
import type { AskRequest } from "../../src/worker/rpc.ts"
import { session } from "../store/helpers.ts"

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

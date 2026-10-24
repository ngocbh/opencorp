/** Questions: round-trips, the human_input key, status moves, first answer wins. */
import { expect, test } from "bun:test"
import { DuplicateKey, InvalidTransition, StoreError, type Store } from "../../src/store/store.ts"
import { openStore, question, recordEvents, session, thrown } from "./helpers.ts"

const PAGES = [
  { question: "Which db?", header: "DB", options: [{ label: "sqlite", description: "local" }, { label: "pg" }] },
  { question: "Which tests?", header: "Tests", options: [{ label: "unit" }, { label: "e2e" }], multi_select: true },
]
const SCHEMA = [
  { name: "db", type: "str" as const, required: true, enum: ["sqlite", "pg"] },
  { name: "tests", type: "list[str]" as const, required: true },
]

/** A store with one session, and the session's id (Python's `sid` fixture). */
function withSession(): { store: Store; sid: string } {
  const store = openStore()
  return { store, sid: store.createSession(session()).id }
}

/** The raw `answer` column of a question: null for SQL NULL, else its text. */
function rawAnswer(store: Store, questionId: string): unknown {
  return store.db.prepare("SELECT answer FROM questions WHERE id = ?").get(questionId)!.answer
}

test("two page question round trips", () => {
  const { store, sid } = withSession()
  const events = recordEvents(store)
  const q = question(sid, {
    title: "Setup",
    questions: PAGES,
    answer_schema: SCHEMA,
    options: ["a", "b"],
    gate: true,
    discussion: [{ role: "user", text: "why?" }],
  })
  const got = store.addQuestion(q)
  expect(got).toEqual(q)
  expect(store.getQuestion(q.id)).toEqual(q)
  expect(got.questions!.length).toBe(2)
  expect(got.questions![1]!.multi_select).toBe(true)
  expect(events.at(-1)!.type).toBe("question.created")
})

test("human input key is unique", () => {
  const { store, sid } = withSession()
  store.addQuestion(question(sid, { node_id: "chat#0/ask", source: "human_input" }))
  const again = thrown(() => store.addQuestion(question(sid, { node_id: "chat#0/ask", source: "human_input" })))
  expect(again).toBeInstanceOf(DuplicateKey)
  store.addQuestion(question(sid, { node_id: "chat#0/ask", source: "human_input", run_id: "run-2" }))
  expect(store.getQuestionByNode("run-1", "chat#0/ask")!.node_id).toBe("chat#0/ask")
  expect(store.getQuestionByNode("run-1", "other")).toBeUndefined()
})

test("many null node questions", () => {
  const { store, sid } = withSession()
  for (let i = 0; i < 3; i++) store.addQuestion(question(sid))
  expect(store.listQuestions({ runId: "run-1" })).toHaveLength(3)
})

test("answer is null until answered", () => {
  const { store, sid } = withSession()
  const events = recordEvents(store)
  const q = store.addQuestion(question(sid))
  expect(q.answer).toBeNull()
  expect(rawAnswer(store, q.id)).toBeNull()
  const answered = store.answerQuestion(q.id, null, "text", "ngocbh")
  expect(answered.status).toBe("answered")
  expect(answered.answer).toBeNull()
  expect(rawAnswer(store, q.id)).toBe("null")
  const other = store.answerQuestion(store.addQuestion(question(sid)).id, { db: "pg" }, "option")
  expect(other.answer).toEqual({ db: "pg" })
  expect(other.answer_kind).toBe("option")
  expect(events.at(-1)!.type).toBe("question.updated")
})

test.each([
  ["path0-consumed", [], "consumed"],
  ["path1-consumed", ["stale"], "consumed"],
  ["path2-stale", ["answer"], "stale"],
  ["path3-stale", ["answer", "consumed"], "stale"],
  ["path4-consumed", ["answer", "consumed"], "consumed"],
  ["path5-stale", ["stale"], "stale"],
])("status moves only forward [%s]", (_, path, bad) => {
  const { store, sid } = withSession()
  const q = store.addQuestion(question(sid))
  for (const step of path as string[]) {
    if (step === "answer") store.answerQuestion(q.id, "x", "text")
    else store.setQuestionStatus(q.id, step)
  }
  expect(thrown(() => store.setQuestionStatus(q.id, bad as string))).toBeInstanceOf(InvalidTransition)
})

test("status happy paths", () => {
  const { store, sid } = withSession()
  const a = store.addQuestion(question(sid))
  store.answerQuestion(a.id, "x", "text")
  expect(store.setQuestionStatus(a.id, "consumed").answer).toBe("x")
  const b = store.addQuestion(question(sid))
  expect(store.setQuestionStatus(b.id, "stale").status).toBe("stale")
  expect(thrown(() => store.answerQuestion(b.id, "late", "text"))).toBeInstanceOf(InvalidTransition)
  expect(thrown(() => store.setQuestionStatus(b.id, "answered"))).toBeInstanceOf(InvalidTransition)
})

test("lose answer moves an answered question to stale and drops the answer", () => {
  const { store, sid } = withSession()
  const events = recordEvents(store)
  const q = store.addQuestion(question(sid))
  store.answerQuestion(q.id, "Approve", "option", "ngocbh")
  const lost = store.loseAnswer(q.id)
  expect(lost.status).toBe("stale")
  expect([lost.answer, lost.answer_kind, lost.answered_by]).toEqual([null, null, null])
  expect(rawAnswer(store, q.id)).toBeNull()
  expect(events.at(-1)!.type).toBe("question.updated")
})

test.each([
  ["path0", []],
  ["path1", ["stale"]],
  ["path2", ["answer", "consumed"]],
])("lose answer takes only an answered question [%s]", (_, path) => {
  const { store, sid } = withSession()
  const q = store.addQuestion(question(sid))
  for (const step of path as string[]) {
    if (step === "answer") store.answerQuestion(q.id, "x", "text")
    else store.setQuestionStatus(q.id, step)
  }
  expect(thrown(() => store.loseAnswer(q.id))).toBeInstanceOf(InvalidTransition)
})

test("first answer wins", () => {
  const { store, sid } = withSession()
  const q = store.addQuestion(question(sid))
  store.answerQuestion(q.id, "first", "text")
  expect(thrown(() => store.answerQuestion(q.id, "second", "text"))).toBeInstanceOf(InvalidTransition)
  expect(store.getQuestion(q.id)!.answer).toBe("first")
})

test("update question fields", () => {
  const { store, sid } = withSession()
  const q = store.addQuestion(question(sid))
  const side = store.createSession(session())
  const got = store.updateQuestion(q.id, { side_session_id: side.id, discussion: [{ role: "assistant", text: "hi" }] })
  expect(got.side_session_id).toBe(side.id)
  expect(got.discussion[0]!.text).toBe("hi")
  expect(thrown(() => store.updateQuestion(q.id, { status: "answered" }))).toBeInstanceOf(StoreError)
})

test("list questions filters", () => {
  const { store, sid } = withSession()
  const a = store.addQuestion(question(sid))
  const b = store.addQuestion(question(sid, { source: "human_input", node_id: "n" }))
  store.answerQuestion(b.id, "x", "text")
  const open = store.listQuestions({ sessionId: sid, status: "open", source: "ask_user" })
  expect(open.map((q) => q.id)).toEqual([a.id])
  const answered = store.listQuestions({ sessionId: sid, status: ["answered", "consumed"] })
  expect(answered.map((q) => q.id)).toEqual([b.id])
})

test("answer is stored as its json dump", () => {
  const { store, sid } = withSession()
  const q = store.addQuestion(question(sid))
  const got = store.answerQuestion(q.id, { when: new Date("2026-09-30T00:00:00.000Z"), picks: ["a", "b"] }, "text")
  const dumped = { when: "2026-09-30T00:00:00.000Z", picks: ["a", "b"] }
  expect(got.answer).toEqual(dumped)
  expect(store.getQuestion(q.id)!.answer).toEqual(dumped)
})

test.each([["open"], ["stale"]])("unanswered question keeps no answer fields [%s]", (status) => {
  const { store, sid } = withSession()
  const q = question(sid, {
    status: status as "open" | "stale",
    answer: { x: 1 },
    answer_kind: "text",
    answered_by: "minh",
  })
  const got = store.addQuestion(q)
  expect([got.answer, got.answer_kind, got.answered_by]).toEqual([null, null, null])
  expect(store.getQuestion(q.id)).toEqual(got)
})

test("answered question keeps its answer fields", () => {
  const { store, sid } = withSession()
  const q = question(sid, { status: "consumed", answer: "x", answer_kind: "text", answered_by: "minh" })
  const got = store.addQuestion(q)
  expect([got.answer, got.answer_kind, got.answered_by]).toEqual(["x", "text", "minh"])
})

test("a harness question keeps its secret page", () => {
  const store = openStore()
  const sid = store.createSession(session({ harness: "codex" })).id
  const page = { question: "Paste the API key", header: "Key", options: [], secret: true }
  const q = store.addQuestion(question(sid, { source: "harness", run_id: "turn-1", node_id: "7", questions: [page] }))
  store.addQuestion(question(sid))
  expect(store.getQuestion(q.id)).toEqual(q)
  expect(q.questions![0]!.secret).toBe(true)
  expect(store.listQuestions({ source: "harness" }).map((x) => x.id)).toEqual([q.id])
})

test("questions are read by a long run id list in one statement", () => {
  // A plain `IN (?, …)` list of this size throws on Bun's SQLite.
  const { store, sid } = withSession()
  const base = Date.parse("2026-10-01T00:00:00.000Z")
  const made = ["run-1", "run-2", "run-1", "run-2"].map((runId, i) => {
    const at = new Date(base + i * 1000).toISOString()
    return store.addQuestion(question(sid, { run_id: runId, created_at: at, updated_at: at }))
  })
  const ids = Array.from({ length: 300_000 }, (_, i) => `unknown-${i}`)
  ids.push("run-2", "run-1")
  expect(store.listQuestions({ runId: ids }).map((q) => q.id)).toEqual(made.map((q) => q.id))
})

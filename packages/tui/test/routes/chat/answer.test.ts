import type { AnswerField, Question } from "@agent-corp/protocol"
import { expect, test } from "bun:test"
import { buildAnswer, cardModel } from "../../../src/routes/chat/answer"

function q(fields: Partial<Question>): Question {
  return {
    id: "q1",
    session_id: "s1",
    run_id: "r1",
    node_id: null,
    source: "ask_user",
    asker: "minh",
    question: "Proceed?",
    status: "open",
    created_at: "2026-09-30T00:00:00Z",
    updated_at: "2026-09-30T00:00:00Z",
    ...fields,
  }
}
const field = (f: Partial<AnswerField>): AnswerField => ({ name: "answer", type: "str", required: true, ...f })

test("an ask_user question is one page: its options, then a typed answer; the answer is the plain value", () => {
  const m = cardModel(q({ question: "Retry?", options: ["yes", "no"] }))!
  expect(m.record).toBe(false)
  expect(m.pages).toEqual([
    {
      header: "Question",
      question: "Retry?",
      options: [
        { label: "yes", value: "yes" },
        { label: "no", value: "no" },
      ],
      multi: false,
      typed: true,
    },
  ])
  expect(buildAnswer(m, [{ picked: [1], text: "" }])).toEqual({ answer: "no", answer_kind: "option" })
  expect(buildAnswer(m, [{ picked: [], text: "later" }])).toEqual({ answer: "later", answer_kind: "text" })
  expect(buildAnswer(m, [{ picked: [], text: "" }])).toBeUndefined()
})

test("a questions gate is one page per question and answers with a record keyed by header", () => {
  const m = cardModel(
    q({
      source: "human_input",
      node_id: "setup",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [{ label: "Postgres", description: "the default" }, { label: "SQLite" }, { label: "Oracle" }],
        },
        {
          question: "Which features?",
          header: "Features",
          multi_select: true,
          options: [{ label: "auth" }, { label: "billing" }],
        },
      ],
      // An enum entry named after a page's header limits it to those values, with no typed answer.
      answer_schema: [field({ name: "Database", enum: ["Postgres", "SQLite"] })],
    }),
  )!
  expect(m.record).toBe(true)
  expect(m.pages.map((p) => [p.header, p.options.map((o) => o.label), p.multi, p.typed])).toEqual([
    ["Database", ["Postgres", "SQLite"], false, false],
    ["Features", ["auth", "billing"], true, true],
  ])
  expect(m.pages[0].options[0].description).toBe("the default")
  expect(
    buildAnswer(m, [
      { picked: [0], text: "" },
      { picked: [0], text: "" },
    ]),
  ).toEqual({ answer: { Database: "Postgres", Features: ["auth"] }, answer_kind: "option" })
  // A multi-select page can add one typed item; any typed text makes the answer text.
  expect(
    buildAnswer(m, [
      { picked: [1], text: "" },
      { picked: [1], text: "audit log" },
    ]),
  ).toEqual({ answer: { Database: "SQLite", Features: ["billing", "audit log"] }, answer_kind: "text" })
  expect(
    buildAnswer(m, [
      { picked: [], text: "" },
      { picked: [0], text: "" },
    ]),
  ).toBeUndefined()
})

test("a one-question gate still answers with a record", () => {
  const m = cardModel(
    q({
      source: "human_input",
      node_id: "go",
      questions: [{ question: "Ship?", header: "Ship", options: [{ label: "now" }] }],
    }),
  )!
  expect(buildAnswer(m, [{ picked: [0], text: "" }])).toEqual({ answer: { Ship: "now" }, answer_kind: "option" })
})

test("a prompt gate's single answer entry picks its control", () => {
  const gate = (f: Partial<AnswerField>) =>
    cardModel(q({ source: "human_input", node_id: "ok", question: "Approve?", answer_schema: [field(f)] }))!
  const yesNo = gate({ type: "bool" })
  expect(yesNo.pages[0].options).toEqual([
    { label: "Yes", value: true },
    { label: "No", value: false },
  ])
  expect(yesNo.pages[0].typed).toBe(false)
  expect(buildAnswer(yesNo, [{ picked: [1], text: "" }])).toEqual({ answer: false, answer_kind: "option" })

  const pick = gate({ type: "str", enum: ["high", "low"] })
  expect([pick.pages[0].options.map((o) => o.value), pick.pages[0].multi, pick.pages[0].typed]).toEqual([
    ["high", "low"],
    false,
    false,
  ])
  const many = gate({ type: "list[str]", enum: ["a", "b"] })
  expect([many.pages[0].multi, many.pages[0].typed]).toEqual([true, false])
  expect(buildAnswer(many, [{ picked: [0, 1], text: "" }])).toEqual({ answer: ["a", "b"], answer_kind: "option" })

  // Typed values go as text; the office converts them to the entry's type and refuses what doesn't fit.
  for (const type of ["str", "int", "float", "date", "datetime"] as const) {
    const typed = gate({ type })
    expect([typed.pages[0].options, typed.pages[0].typed]).toEqual([[], true])
  }
  expect(buildAnswer(gate({ type: "int" }), [{ picked: [], text: "12" }])).toEqual({
    answer: "12",
    answer_kind: "text",
  })
  expect(cardModel(q({ source: "human_input", node_id: "ok", question: "Why?" }))!.pages[0].typed).toBe(true)
})

test("a prompt gate with a record output or an object entry is read-only here", () => {
  const gate = (answer_schema: AnswerField[]) =>
    cardModel(q({ source: "human_input", node_id: "ok", question: "Fill in", answer_schema }))
  expect(gate([field({ name: "title" }), field({ name: "count", type: "int" })])).toBeUndefined()
  expect(gate([field({ type: "object", fields: [field({ name: "x" })] })])).toBeUndefined()
  expect(gate([field({ type: "list[int]" })])).toBeUndefined()
})

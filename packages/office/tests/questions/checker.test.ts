/** Answers checked against their questions, and typed text converted to the value a gate takes. */
import { expect, test } from "bun:test"
import { Question, type AnswerField } from "@opencorp/protocol"
import { InvalidAnswer, checkAnswer } from "../../src/questions/checker.ts"
import type { QuestionRecord } from "../../src/store/store.ts"
import { thrown } from "../store/helpers.ts"

const T = "2026-09-30T00:00:00.000Z"

function q(source: Question["source"] = "human_input", fields: Partial<Question> = {}): QuestionRecord {
  return Question.parse({
    id: "01J0000000000000000000000Q",
    session_id: "01J0000000000000000000000S",
    run_id: "r1",
    node_id: source !== "human_input" ? null : "gate",
    source,
    asker: "minh",
    question: "Which?",
    status: "open",
    created_at: T,
    updated_at: T,
    ...fields,
  })
}

const PAGES: Question["questions"] = [
  { question: "Which database?", header: "db", options: [{ label: "Postgres" }, { label: "SQLite" }] },
  {
    question: "Which features?",
    header: "features",
    multi_select: true,
    options: [{ label: "auth" }, { label: "search" }],
  },
]

type Entry = [name: string, type: AnswerField["type"], required: boolean, extra?: Partial<AnswerField>]

function fields(...entries: Entry[]): AnswerField[] {
  return entries.map(([name, type, required, extra]) => ({ name, type, required, ...extra }))
}

/** The `InvalidAnswer` `fn` throws; with `pattern`, its message must match it (a regex search). */
function refused(fn: () => unknown, pattern?: RegExp): InvalidAnswer {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(InvalidAnswer)
  if (pattern !== undefined) expect((error as InvalidAnswer).message).toMatch(pattern)
  return error as InvalidAnswer
}

test("a model question takes text and checks options", () => {
  const ask = q("ask_user", { options: ["A", "B"] })
  expect(checkAnswer(ask, "B", "option")).toBe("B")
  expect(checkAnswer(ask, "Neither, C", "text")).toBe("Neither, C")
  for (const [answer, kind] of [["C", "option"], ["", "text"], [{ a: 1 }, "text"]] as const) {
    refused(() => checkAnswer(ask, answer, kind))
  }
})

test("office answers pass unchanged", () => {
  expect(checkAnswer(q("ask_manager"), null, "sent_back")).toBeNull()
  expect(checkAnswer(q("human_input", { questions: PAGES }), "[interrupted by the user]", "interrupted")).toBe(
    "[interrupted by the user]",
  )
})

test("pages take a record keyed by header", () => {
  const gate = q("human_input", { questions: PAGES })
  const answer = { db: "Postgres", features: ["auth", "graphs, typed"] }
  expect(checkAnswer(gate, answer, "text")).toEqual(answer)
  expect(checkAnswer(gate, { db: "MySQL, typed", features: [] }, "text")).toEqual({
    db: "MySQL, typed",
    features: [],
  })
})

const SHAPES: [unknown, RegExp][] = [
  ["Postgres", /a record/],
  [{ db: "Postgres" }, /'features' has no answer/],
  [{ db: "Postgres", features: "auth" }, /'features' takes a list of labels/],
  [{ db: ["Postgres"], features: [] }, /'db' takes one label/],
  [{ db: " ", features: [] }, /'db' takes one label/],
  [{ db: "Postgres", features: [], extra: "x" }, /no question has the header 'extra'/],
]

test.each(SHAPES)("pages refuse other shapes [%s]", (answer, message) => {
  refused(() => checkAnswer(q("human_input", { questions: PAGES }), answer, "option"), message)
})

test("an enum in the schema hides free text on its page", () => {
  const gate = q("human_input", {
    questions: PAGES,
    answer_schema: fields(["db", "str", true, { enum: ["Postgres", "SQLite"] }], ["features", "list[str]", true]),
  })
  expect(checkAnswer(gate, { db: "SQLite", features: ["x"] }, "option")).toEqual({ db: "SQLite", features: ["x"] })
  refused(() => checkAnswer(gate, { db: "MySQL", features: [] }, "text"), /'db' must be one of/)
})

test("a schema entry types its page", () => {
  const gate = q("human_input", { questions: PAGES, answer_schema: fields(["db", "str", true], ["features", "str", true]) })
  refused(() => checkAnswer(gate, { db: "SQLite", features: ["auth"] }, "option"), /'features' must be text/)
  const counted = q("human_input", {
    questions: [{ question: "How many?", header: "n", options: [{ label: "3" }] }],
    answer_schema: fields(["n", "int", true]),
  })
  expect(checkAnswer(counted, { n: "3" }, "option")).toEqual({ n: 3 })
})

test("a prompt gate without a schema takes text", () => {
  expect(checkAnswer(q(), "go ahead", "text")).toBe("go ahead")
  refused(() => checkAnswer(q(), 3, "text"))
})

test("a record gate converts each field and omits blank optional ones", () => {
  const gate = q("human_input", {
    answer_schema: fields(
      ["days", "int", true],
      ["note", "str", false],
      ["who", "object", true, { fields: fields(["name", "str", true]) }],
    ),
  })
  expect(checkAnswer(gate, { days: "3", note: "", who: { name: "Ava" } }, "text")).toEqual({
    days: 3,
    who: { name: "Ava" },
  })
  expect(checkAnswer(gate, '{"days": 4, "who": {"name": "Bo"}}', "text")).toEqual({ days: 4, who: { name: "Bo" } })
  const bad: [unknown, RegExp][] = [
    [{ note: "x", who: { name: "A" } }, /answer.days is required/],
    [{ days: 1, who: { name: "A" }, zzz: 1 }, /no field 'zzz'/],
    [{ days: 1, who: {} }, /answer.who.name is required/],
    [{ days: 1, who: { name: "  " } }, /answer.who.name is required/],
  ]
  for (const [answer, message] of bad) refused(() => checkAnswer(gate, answer, "text"), message)
})

test("a required none field in a record takes blank", () => {
  const gate = q("human_input", { answer_schema: fields(["done", "None", true], ["note", "str", false]) })
  expect(checkAnswer(gate, { done: null }, "text")).toEqual({ done: null })
  expect(checkAnswer(gate, { done: "" }, "text")).toEqual({ done: null })
  refused(() => checkAnswer(gate, { done: "x" }, "text"), /answer.done must be empty/)
})

test("a harness approval takes one of its options only", () => {
  const card = q("harness", { options: ["Approve", "Deny and stop"] })
  expect(checkAnswer(card, "Approve", "option")).toBe("Approve")
  // The office's own answers never reach Codex either: it waits on the reply an answer makes.
  const bad = [
    ["Approve", "text"],
    ["yes please", "text"],
    ["Maybe", "option"],
    ["Approve", "interrupted"],
    ["", "sent_back"],
  ] as const
  for (const [answer, kind] of bad) refused(() => checkAnswer(card, answer, kind))
})

test("a harness card with pages takes a record with typed numbers", () => {
  const pages: Question["questions"] = [
    { question: "Token?", header: "Token", options: [], secret: true },
    { question: "Env?", header: "Env", options: [{ label: "prod" }, { label: "dev" }] },
    { question: "Points?", header: "points", options: [] },
  ]
  const card = q("harness", {
    questions: pages,
    answer_schema: fields(["Env", "str", true, { enum: ["prod", "dev"] }], ["points", "int", true]),
  })
  expect(checkAnswer(card, { Token: "s3cret", Env: "dev", points: "3" }, "text")).toEqual({
    Token: "s3cret",
    Env: "dev",
    points: 3,
  })
  for (const bad of [
    { Token: "s3cret", Env: "staging", points: "3" },
    { Token: "s3cret", Env: "dev", points: "x" },
  ]) {
    expect(refused(() => checkAnswer(card, bad, "text")).message).not.toContain("s3cret")
  }
  const stopped = refused(() => checkAnswer(card, { Token: "s3cret", Env: "dev", points: "3" }, "interrupted"))
  expect(stopped.message).not.toContain("s3cret")
})

test("answer keys on the prototype are not answers", () => {
  const gate = q("human_input", {
    questions: [{ question: "Which?", header: "constructor", options: [{ label: "a" }] }],
  })
  refused(() => checkAnswer(gate, {}, "option"), /'constructor' has no answer/)
  const proto = q("human_input", { answer_schema: fields(["__proto__", "str", true]) })
  const result = checkAnswer(proto, JSON.parse('{"__proto__": "x"}'), "text") as Record<string, unknown>
  expect(Object.hasOwn(result, "__proto__")).toBe(true)
  expect(result["__proto__"]).toBe("x")
})

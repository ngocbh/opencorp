/** Answers checked against their questions, and typed text converted to the value a gate takes. */
import { expect, test } from "bun:test"
import { Question, type AnswerField } from "@opencorp/protocol"
import { InvalidAnswer, checkAnswer } from "../../src/questions/checker.ts"
import type { QuestionRecord } from "../../src/store/store.ts"
import { thrown } from "../store/helpers.ts"

const T = "2026-09-30T00:00:00.000Z"

function q(source: Question["source"] = "ask", fields: Partial<Question> = {}): QuestionRecord {
  return Question.parse({
    id: "01J0000000000000000000000Q",
    session_id: "01J0000000000000000000000S",
    run_id: "r1",
    node_id: source !== "ask" ? null : "gate",
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
  expect(checkAnswer(q("ask", { questions: PAGES }), "[interrupted by the user]", "interrupted")).toBe(
    "[interrupted by the user]",
  )
})

test("pages take a record keyed by header", () => {
  const gate = q("ask", { questions: PAGES })
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
  refused(() => checkAnswer(q("ask", { questions: PAGES }), answer, "option"), message)
})

test("an enum in the schema hides free text on its page", () => {
  const gate = q("ask", {
    questions: PAGES,
    answer_schema: fields(["db", "str", true, { enum: ["Postgres", "SQLite"] }], ["features", "list[str]", true]),
  })
  expect(checkAnswer(gate, { db: "SQLite", features: ["x"] }, "option")).toEqual({ db: "SQLite", features: ["x"] })
  refused(() => checkAnswer(gate, { db: "MySQL", features: [] }, "text"), /'db' must be one of/)
})

test("a schema entry types its page", () => {
  const gate = q("ask", {
    questions: PAGES,
    answer_schema: fields(["db", "str", true], ["features", "str", true]),
  })
  refused(() => checkAnswer(gate, { db: "SQLite", features: ["auth"] }, "option"), /'features' must be text/)
  const counted = q("ask", {
    questions: [{ question: "How many?", header: "n", options: [{ label: "3" }] }],
    answer_schema: fields(["n", "int", true]),
  })
  expect(checkAnswer(counted, { n: "3" }, "option")).toEqual({ n: 3 })
})

type PageEntry = Omit<AnswerField, "name" | "required">

/** A one-page gate whose `p` page has the schema entry `entry`. */
function page(multi: boolean, entry: PageEntry): QuestionRecord {
  return q("ask", {
    questions: [{ question: "Which?", header: "p", multi_select: multi, options: [{ label: "3" }, { label: "yes" }] }],
    answer_schema: [{ name: "p", required: true, ...entry }],
  })
}

const TYPED: [boolean, PageEntry, unknown, unknown][] = [
  [false, { type: "int" }, "3", 3],
  [false, { type: "float" }, "3", 3],
  [false, { type: "bool" }, "yes", true],
  [false, { type: "date" }, "2026-09-30", "2026-09-30"],
  [false, { type: "str", enum: ["fast", "safe"] }, "safe", "safe"],
  [false, { type: "list[str]" }, "a", ["a"]],
  [true, { type: "list[str]", enum: ["x", "y"] }, ["y", "x"], ["y", "x"]],
  [true, { type: "list[int]" }, ["3", "5"], [3, 5]],
  [false, { type: "None" }, "", null],
]

test.each(TYPED)("a typed page answer converts to itself [%s]", (multi, entry, label, value) => {
  const gate = page(multi, entry)
  expect(checkAnswer(gate, { p: label }, "option")).toEqual({ p: value })
  expect(checkAnswer(gate, { p: value }, "option")).toEqual({ p: value }) // the harness checks the stored value again
})

const TYPED_REFUSED: [boolean, PageEntry, unknown, RegExp][] = [
  [false, { type: "int" }, " ", /'p' has no answer/],
  [false, { type: "int" }, "three", /'p' must be a whole number/],
  [false, { type: "str", enum: ["fast", "safe"] }, ["safe"], /'p' must be one of/],
  [true, { type: "list[str]", enum: ["x", "y"] }, ["z"], /'p'\[0\] must be one of/],
]

test.each(TYPED_REFUSED)("a typed page refuses what its entry refuses [%s]", (multi, entry, answer, message) => {
  refused(() => checkAnswer(page(multi, entry), { p: answer }, "option"), message)
})

test("a prompt gate without a schema takes text", () => {
  expect(checkAnswer(q(), "go ahead", "text")).toBe("go ahead")
  refused(() => checkAnswer(q(), 3, "text"))
})

const CONVERTED: [Entry, unknown, unknown][] = [
  [["answer", "bool", true], "Yes", true],
  [["answer", "bool", true], false, false],
  [["answer", "str", true, { enum: ["high", "low"] }], "low", "low"],
  [["answer", "list[str]", true, { enum: ["a", "b"] }], ["b"], ["b"]],
  [["answer", "str", true], "  spaced  ", "  spaced  "],
  [["answer", "int", true], " 12 ", 12],
  [["answer", "float", true], "2.5", 2.5],
  [["answer", "float", true], 3, 3],
  [["answer", "date", true], "2026-09-30", "2026-09-30"],
  [["answer", "datetime", true], "2026-09-30T10:00:00+07:00", "2026-09-30T10:00:00+07:00"],
  [["answer", "list[int]", true], "1\n\n2\n", [1, 2]],
  [["answer", "list[str]", true], ["x", "y"], ["x", "y"]],
  [["answer", "int", false], "", null],
  [["answer", "str", false], "  ", null],
  [["answer", "str", false], null, null],
  [["answer", "object", true], '{"k": 1}', { k: 1 }],
]

test.each(CONVERTED)("a single answer is converted to its type [%s]", (entry, answer, value) => {
  const gate = q("ask", { answer_schema: fields(entry) })
  expect(checkAnswer(gate, answer, "text")).toEqual(value)
  expect(checkAnswer(gate, value, "text")).toEqual(value) // a converted value converts to itself
})

const MISFITS: [Entry, unknown, RegExp][] = [
  [["answer", "bool", true], "maybe", /yes or no/],
  [["answer", "str", true, { enum: ["high", "low"] }], "medium", /must be one of/],
  [["answer", "int", true], "1.5", /a whole number/],
  [["answer", "int", true], true, /a whole number/],
  [["answer", "float", true], "nan", /a number/],
  [["answer", "date", true], "30/09/2026", /ISO-8601 date/],
  [["answer", "int", true], "", /is required/],
  [["answer", "str", true], "", /is required/],
  [["answer", "str", true], " \n ", /is required/],
  [["answer", "list[int]", true], "1\ntwo", /answer\[1\] must be a whole number/],
  [["answer", "file", true], "x", /can't answer|cannot answer/],
]

test.each(MISFITS)("a single answer that does not fit is refused [%s]", (entry, answer, message) => {
  refused(() => checkAnswer(q("ask", { answer_schema: fields(entry) }), answer, "text"), message)
})

test("a whole float is a whole number", () => {
  // JSON numbers don't tell 2.0 from 2, so only a fraction is refused.
  const intGate = q("ask", { answer_schema: fields(["answer", "int", true]) })
  expect(checkAnswer(intGate, 2.0, "text")).toBe(2)
  refused(() => checkAnswer(intGate, 2.5, "text"), /a whole number/)
})

test("a record gate converts each field and omits blank optional ones", () => {
  const gate = q("ask", {
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
  const gate = q("ask", { answer_schema: fields(["done", "None", true], ["note", "str", false]) })
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

/** A one-page gate whose secret `Token` page takes a record with a `key` field. */
const SECRET = q("ask", {
  questions: [{ question: "Token?", header: "Token", options: [], secret: true }],
  answer_schema: fields(["Token", "object", true, { fields: fields(["key", "str", true], ["n", "int", false]) }]),
})

const SECRET_REFUSED: unknown[] = [
  { key: "k", "sk-stray": "v" },
  JSON.stringify({ key: "k", "sk-stray": "v" }),
  { key: ["sk-typed"] },
  { key: "k", n: "sk-typed" },
  "sk-typed",
]

test.each(SECRET_REFUSED)("a secret page's refusal names only the page [%s]", (answer) => {
  expect(checkAnswer(SECRET, { Token: { key: "k" } }, "text")).toEqual({ Token: { key: "k" } })
  const error = refused(() => checkAnswer(SECRET, { Token: answer }, "text"))
  expect(error.message).toBe("'Token' isn't a valid answer")
})

test("answer keys on the prototype are not answers", () => {
  const gate = q("ask", {
    questions: [{ question: "Which?", header: "constructor", options: [{ label: "a" }] }],
  })
  refused(() => checkAnswer(gate, {}, "option"), /'constructor' has no answer/)
  const proto = q("ask", { answer_schema: fields(["__proto__", "str", true]) })
  const result = checkAnswer(proto, JSON.parse('{"__proto__": "x"}'), "text") as Record<string, unknown>
  expect(Object.hasOwn(result, "__proto__")).toBe(true)
  expect(result["__proto__"]).toBe("x")
})

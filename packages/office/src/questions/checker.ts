/** Check an answer against its question, and convert typed text to the value a `human_input` node takes. */
import { casefold, repr, splitLines, strip } from "../perm/redact.ts"
import type { QuestionRecord } from "../store/store.ts"

type Field = QuestionRecord["answer_schema"][number]

const TRUE = new Set(["true", "yes", "y"])
const FALSE = new Set(["false", "no", "n"])

/** The answer doesn't fit the question; the message says why, for the person answering. */
export class InvalidAnswer extends Error {
  override name = "InvalidAnswer"
}

/**
 * Return the value to store for `answer` to `question`, or throw `InvalidAnswer`.
 *
 * A harness card takes one of its options, or a record for its pages, and never the office's own answers.
 * Otherwise `sent_back` and `interrupted` answers are the office's own and pass unchanged. A model question
 * (`ask_user`, `ask_manager`) takes text, and an `option` answer must be one of its options. A `human_input`
 * question with pages takes a record keyed by each page's `header`. A page with an `answer_schema` entry takes
 * what that entry takes, and one without takes a label, or a list of labels for a multi-select page. One without
 * pages takes what its `answer_schema` says; text is converted to the field's type (numbers, ISO dates, yes/no,
 * one list item per line). Blank text is no answer: a required field refuses it unless its type is `None`, and an
 * optional one is null (omitted in a record). Nothing looser than the engine's own check is returned, and a
 * converted value converts to itself.
 */
export function checkAnswer(
  question: QuestionRecord,
  answer: unknown,
  kind: "option" | "text" | "sent_back" | "interrupted",
): unknown {
  if (question.source === "harness") return harness(question, answer, kind)
  if (kind === "sent_back" || kind === "interrupted") return answer
  if (question.source !== "human_input") {
    if (typeof answer !== "string" || strip(answer) === "") throw new InvalidAnswer("the answer must be text")
    if (kind === "option" && !question.options.includes(answer)) {
      throw new InvalidAnswer(`${repr(answer)} is not one of the options`)
    }
    return answer
  }
  if (question.questions !== null) return pages(question, answer)
  const schema = question.answer_schema
  if (schema.length === 0) {
    if (typeof answer !== "string") throw new InvalidAnswer("the answer must be text")
    return answer
  }
  if (schema.length === 1 && schema[0]!.name === "answer") return field(schema[0]!, answer, "answer")
  return record(schema, answer, "answer")
}

function harness(question: QuestionRecord, answer: unknown, kind: string): unknown {
  // Codex waits on the reply an answer makes, so the office's own answers (send back, stop) never reach it.
  if (kind === "sent_back" || kind === "interrupted") throw new InvalidAnswer("a Codex card takes only an answer")
  if (question.questions !== null) return pages(question, answer)
  if (kind !== "option" || typeof answer !== "string" || !question.options.includes(answer)) {
    throw new InvalidAnswer("pick one of the options")
  }
  return answer
}

function pages(question: QuestionRecord, answer: unknown): Record<string, unknown> {
  if (!isRecord(answer)) throw new InvalidAnswer("the answer must be a record with one entry per question header")
  const list = question.questions ?? []
  const headers = new Set(list.map((page) => page.header))
  const extra = Object.keys(answer).filter((key) => !headers.has(key)).sort(byCodePoint)
  if (extra.length > 0) throw new InvalidAnswer(`no question has the header ${repr(extra[0]!)}`)
  const entries = new Map(question.answer_schema.map((f) => [f.name, f]))
  const out: [string, unknown][] = []
  for (const page of list) {
    if (!Object.hasOwn(answer, page.header)) throw new InvalidAnswer(`${repr(page.header)} has no answer`)
    const value = answer[page.header]
    const entry = entries.get(page.header)
    if (entry === undefined) {
      const values = page.multi_select ? value : [value]
      if (!Array.isArray(values) || !values.every((v) => typeof v === "string" && strip(v) !== "")) {
        const shape = page.multi_select ? "a list of labels" : "one label"
        throw new InvalidAnswer(`${repr(page.header)} takes ${shape}`)
      }
      out.push([page.header, value])
      continue
    }
    // The engine checks the record against the schema, so the entry alone decides the page's
    // type and enum; the stored value is already typed when the harness checks it again.
    if (blank(value) && entry.type !== "None") throw new InvalidAnswer(`${repr(page.header)} has no answer`)
    out.push([page.header, field(entry, value, repr(page.header))])
  }
  return Object.fromEntries(out)
}

function record(fields: Field[], value: unknown, where: string): Record<string, unknown> {
  if (typeof value === "string") value = json(value)
  if (!isRecord(value)) throw new InvalidAnswer(`${where} must be a record`)
  const names = new Set(fields.map((f) => f.name))
  const extra = Object.keys(value).filter((key) => !names.has(key)).sort(byCodePoint)
  if (extra.length > 0) throw new InvalidAnswer(`${where} has no field ${repr(extra[0]!)}`)
  const out: [string, unknown][] = []
  for (const f of fields) {
    const item = Object.hasOwn(value, f.name) ? value[f.name] : null
    if (blank(item)) {
      if (f.required && f.type !== "None") throw new InvalidAnswer(`${where}.${f.name} is required`)
      if (f.required) out.push([f.name, null]) // the one answer a required None field has
      continue // an optional field left blank is omitted
    }
    out.push([f.name, field(f, item, `${where}.${f.name}`)])
  }
  return Object.fromEntries(out)
}

function blank(value: unknown): boolean {
  return value === null || (typeof value === "string" && strip(value) === "")
}

function field(f: Field, value: unknown, where: string): unknown {
  if (blank(value)) {
    // As in a record: required refuses it, optional gives null.
    if (f.required && f.type !== "None") throw new InvalidAnswer(`${where} is required`)
    return null
  }
  if (f.type === "None") throw new InvalidAnswer(`${where} must be empty`)
  if (f.type === "object" && f.fields !== null && f.fields.length > 0) return record(f.fields, value, where)
  if (f.type.startsWith("list[")) {
    // Typed text is one item per line; blank lines are skipped.
    const items = typeof value === "string" ? splitLines(value).filter((line) => strip(line) !== "") : value
    if (!Array.isArray(items)) throw new InvalidAnswer(`${where} must be a list`)
    return items.map((item, n) => scalar(f.type.slice(5, -1), f.enum, item, `${where}[${n}]`))
  }
  return scalar(f.type, f.enum, value, where)
}

function scalar(kind: string, enumValues: string[] | null, value: unknown, where: string): unknown {
  if (enumValues !== null) {
    if (typeof value !== "string" || !enumValues.includes(value)) {
      throw new InvalidAnswer(`${where} must be one of [${enumValues.map(repr).join(", ")}]`)
    }
    return value
  }
  if (kind === "str" || kind === "Any") {
    if (kind === "str" && typeof value !== "string") throw new InvalidAnswer(`${where} must be text`)
    return value
  }
  if (kind === "object") {
    if (typeof value === "string") value = json(value)
    if (!isRecord(value)) throw new InvalidAnswer(`${where} must be a record`)
    return value
  }
  if (typeof value === "boolean") {
    if (kind === "bool") return value
  } else if (typeof value === "number") {
    // JSON numbers don't tell 2.0 from 2, so a whole float is a whole number.
    if ((kind === "int" && Number.isSafeInteger(value)) || (kind === "float" && Number.isFinite(value))) return value
  } else if (typeof value === "string") {
    const parsed = parse(kind, strip(value))
    if (parsed !== null) return parsed
  }
  throw new InvalidAnswer(`${where} must be ${EXPECTED[kind] ?? `a ${kind}, which a card cannot answer`}`)
}

const EXPECTED: Record<string, string> = {
  bool: "yes or no",
  int: "a whole number",
  float: "a number",
  date: "an ISO-8601 date",
  datetime: "an ISO-8601 datetime",
}

/** Python's `int` text, underscores between digits allowed. */
const INT = /^[+-]?[0-9]+(?:_[0-9]+)*$/
/** Python's decimal `float` text, underscores between digits allowed; `nan` and `inf` are never finite. */
const FLOAT = /^[+-]?(?:[0-9]+(?:_[0-9]+)*(?:\.(?:[0-9]+(?:_[0-9]+)*)?)?|\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?$/
// Yian's one date grammar, restated since its `typesys/temporal.ts` doesn't export it: the office never takes a
// date the engine refuses.
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/
const DATETIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,6}))?)?(Z|[+-][0-9]{2}:[0-9]{2})?$/

/** `text` as a `kind` value, or null if it isn't one. */
function parse(kind: string, text: string): unknown {
  if (kind === "bool") {
    const folded = casefold(text)
    return TRUE.has(folded) ? true : FALSE.has(folded) ? false : null
  }
  if (kind === "int") {
    if (!INT.test(text)) return null
    const number = Number(text.replaceAll("_", ""))
    // Python's int has no -0.
    return Number.isSafeInteger(number) ? (number === 0 ? 0 : number) : null
  }
  if (kind === "float") {
    if (!FLOAT.test(text)) return null
    const number = Number(text.replaceAll("_", ""))
    return Number.isFinite(number) ? number : null
  }
  if (kind === "date") {
    const m = DATE.exec(text)
    return m !== null && isDate(m[1]!, m[2]!, m[3]!) ? text : null
  }
  if (kind === "datetime") {
    // A date alone is midnight, as Python's `datetime.fromisoformat` reads it.
    if (parse("date", text) !== null) return `${text}T00:00:00`
    const m = DATETIME.exec(text)
    if (m === null || !isDate(m[1]!, m[2]!, m[3]!)) return null
    const [, year, month, day, hour, minute, second = "00", fraction = "", offset] = m
    if (Number(hour) >= 24 || Number(minute) >= 60 || Number(second) >= 60) return null
    if (offset !== undefined && offset !== "Z" && (Number(offset.slice(1, 3)) >= 24 || Number(offset.slice(4)) >= 60)) {
      return null
    }
    // Python's `isoformat()`: microseconds only when non-zero, and UTC as `+00:00`.
    const micro = fraction.padEnd(6, "0")
    const zone = offset === undefined ? "" : offset === "Z" || offset === "-00:00" ? "+00:00" : offset
    return `${year}-${month}-${day}T${hour}:${minute}:${second}${Number(micro) === 0 ? "" : `.${micro}`}${zone}`
  }
  return null
}

/** Whether the digits name a real day: year 1 or later, a month, and a day that month has. */
function isDate(year: string, month: string, day: string): boolean {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  return y >= 1 && days !== undefined && d >= 1 && d <= days
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Python's `isinstance(value, dict)` for a JSON value: an object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Order strings by code point, as Python sorts them; JS's default sort compares UTF-16 units. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (diff !== 0) return diff
  }
  return x.length - y.length
}

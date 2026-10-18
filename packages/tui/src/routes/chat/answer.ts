import type { AnswerField, AnswerRequest, Question } from "@opencorp/protocol"

/** One pickable row on a card page; `value` is what the answer carries when it is picked. */
export interface CardOption {
  label: string
  description?: string
  value: unknown
}

/**
 * One page of a card: options to pick (several when `multi`), whether a typed answer is allowed, and whether that
 * answer is a secret to mask.
 */
export interface CardPage {
  header: string
  question: string
  options: CardOption[]
  multi: boolean
  typed: boolean
  secret?: boolean
}

/** What a card asks: its pages, and whether the answer is a record keyed by page header. */
export interface CardModel {
  pages: CardPage[]
  record: boolean
}

/** A page's answer so far: the picked option indexes and the typed text. */
export interface PageAnswer {
  picked: number[]
  text: string
}

// Types a typed field sends as text; the office converts the text to the type.
const TYPED = new Set<AnswerField["type"]>(["str", "int", "float", "date", "datetime"])

const label = (value: string): CardOption => ({ label: value, value })

/** The page for a prompt gate's single `answer` entry, or undefined when the card can't show it. */
function fieldPage(q: Question, f: AnswerField): CardPage | undefined {
  const page = { header: q.title ?? "Question", question: q.question, options: [], multi: false, typed: false }
  if (f.type === "bool")
    return {
      ...page,
      options: [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ],
    }
  if (f.type === "str" && f.enum) return { ...page, options: f.enum.map(label) }
  if (f.type === "list[str]" && f.enum) return { ...page, options: f.enum.map(label), multi: true }
  if (TYPED.has(f.type) && !f.enum) return { ...page, typed: true }
  return undefined
}

/** How the card shows `q`, or undefined when the TUI can't answer it (a record prompt gate). */
export function cardModel(q: Question): CardModel | undefined {
  const schema = q.answer_schema ?? []
  if (q.questions?.length)
    return {
      record: true,
      pages: q.questions.map((p) => {
        const only = schema.find((f) => f.name === p.header && f.enum)?.enum
        return {
          header: p.header,
          question: p.question,
          options: p.options
            .filter((o) => !only || only.includes(o.label))
            .map((o) => ({ ...o, value: o.label })),
          multi: p.multi_select === true,
          typed: !only,
          secret: p.secret === true,
        }
      }),
    }
  if (q.source === "human_input" && schema.length) {
    const page = schema.length === 1 && schema[0].name === "answer" ? fieldPage(q, schema[0]) : undefined
    return page && { record: false, pages: [page] }
  }
  // A Codex approval: its decisions are its options, and the office refuses typed text.
  if (q.source === "harness")
    return {
      record: false,
      pages: [
        {
          header: q.title ?? "Codex asks",
          question: q.question,
          options: (q.options ?? []).map(label),
          multi: false,
          typed: false,
        },
      ],
    }
  return {
    record: false,
    pages: [
      {
        header: q.title ?? "Question",
        question: q.question,
        options: (q.options ?? []).map(label),
        multi: false,
        typed: true,
      },
    ],
  }
}

/** The answer request for `answers`, one per page, or undefined while a single-pick page has none. */
export function buildAnswer(model: CardModel, answers: PageAnswer[]): AnswerRequest | undefined {
  const values: unknown[] = []
  let typed = false
  for (const [i, page] of model.pages.entries()) {
    const a = answers[i] ?? { picked: [], text: "" }
    const text = page.typed ? a.text.trim() : ""
    if (text) typed = true
    if (page.multi) {
      values.push([...a.picked.map((n) => page.options[n].value), ...(text ? [text] : [])])
      continue
    }
    if (!text && a.picked.length === 0) return undefined
    values.push(text || page.options[a.picked[0]].value)
  }
  const answer = model.record ? Object.fromEntries(model.pages.map((p, i) => [p.header, values[i]])) : values[0]
  return { answer, answer_kind: typed ? "text" : "option" }
}

// The office's tool result for an answered question (opencorp.questions.format): a choice
// line, then any side-chat discussion behind this marker, written for the model.
const DISCUSSION_MARK = "\n\nBefore answering, the user discussed your question with you in a side chat."
const CHOSE = /^The user chose "([\s\S]*)" \(option \d+ of the \d+ shown\)\.$/
const ANSWERED = /^The user answered: ([\s\S]*)$/

/** What an answered question card shows for the asker's tool result: the answer, not the model-facing text. */
export function answerShown(output: string): string {
  const cut = output.indexOf(DISCUSSION_MARK)
  const choice = cut < 0 ? output : output.slice(0, cut)
  const answer = choice.match(CHOSE)?.[1] ?? choice.match(ANSWERED)?.[1]
  if (answer === undefined) return choice
  return cut < 0 ? answer : `${answer} (discussed in a side chat)`
}

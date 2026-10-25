/** Card actions on the questions extension, through a stand-in for the session actor. */
import { expect, test } from "bun:test"
import { inspect } from "node:util"
import type { Question } from "@opencorp/protocol"
import { Hooks } from "../../src/chat/hooks.ts"
import { HarnessError } from "../../src/chat/state.ts"
import type { Office } from "../../src/daemon/office.ts"
import { register } from "../../src/extensions/questions.ts"
import type { AnswerKind, CardActor, Cards } from "../../src/questions/cards.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import { InvalidTransition, type QuestionRecord, type Store } from "../../src/store/store.ts"
import { makeOffice } from "../daemon/helpers.ts"
import { question, session } from "../store/helpers.ts"

class StandIn implements CardActor {
  readonly hooks: Hooks
  readonly answered: [string, unknown, AnswerKind, string | null][] = []
  readonly interrupted: string[] = []
  interruptFails = false
  /** While set, `answer` waits on it after recording the call (a real actor answers across awaits). */
  answerGate: Promise<void> | undefined

  constructor(
    readonly store: Store,
    log: (line: string) => void = () => {},
  ) {
    this.hooks = new Hooks({ log })
  }

  async answer(id: string, value: unknown, kind: AnswerKind, { by = null }: { by?: string | null } = {}) {
    const q = this.store.getQuestion(id)
    if (q === undefined) throw new HarnessError(404, "not_found", `no question ${id}`)
    if (q.status !== "open") throw new HarnessError(409, "not_open", `question ${id} is ${q.status}`)
    for (const refusal of this.hooks.fire("answerCheck", q, value, kind))
      if (refusal) throw new HarnessError(422, "invalid_answer", refusal)
    this.answered.push([id, value, kind, by])
    await (this.answerGate ?? Promise.resolve())
    try {
      return this.store.answerQuestion(id, value, kind, by)
    } catch (error) {
      if (error instanceof InvalidTransition) throw new HarnessError(409, "not_open", error.message)
      throw error
    }
  }

  async interrupt(sessionId: string) {
    if (this.interruptFails) throw new HarnessError(409, "not_live", `session ${sessionId} has no live run`)
    this.interrupted.push(sessionId)
    for (const q of this.store.listQuestions({ sessionId, status: "open" })) {
      if (q.source !== "ask_user" && q.source !== "ask_manager") continue
      try {
        this.store.answerQuestion(q.id, INTERRUPTED, "interrupted")
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error
      }
    }
  }
}

/** The office with the stand-in as its harness and the questions extension registered (Python's `wire`). */
function wire(office: Office, log?: (line: string) => void): { cards: Cards; actor: StandIn } {
  const actor = new StandIn(office.store, log)
  office.harness = actor
  register(office)
  return { cards: office.cards!, actor }
}

/** A stored question in a new stored session. */
function card(office: Office, over?: Partial<Question>): QuestionRecord {
  const s = office.store.createSession(session())
  return office.store.addQuestion(question(s.id, over))
}

/** The `HarnessError` that `action` rejected with; fails the test if it resolved or threw something else. */
async function refusal(action: () => Promise<unknown>): Promise<HarnessError> {
  try {
    await action()
  } catch (error) {
    if (error instanceof HarnessError) return error
    throw error
  }
  throw new Error("expected a HarnessError")
}

test("an ask nodes card cant be sent back or stopped and takes a record keyed by header", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const q = card(office, {
    source: "ask",
    node_id: "setup",
    questions: [
      { question: "Which database?", header: "db", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      {
        question: "Which features?",
        header: "features",
        multi_select: true,
        options: [{ label: "auth" }, { label: "search" }],
      },
    ],
  })
  const refused = [() => cards.answer(q.id, { db: "SQLite" }, "option"), () => actor.answer(q.id, "SQLite", "text")]
  for (const action of refused) expect((await refusal(action)).code).toBe("invalid_answer")
  expect(actor.answered).toEqual([])
  const answer = { db: "SQLite", features: ["auth", "search"] }
  expect((await cards.answer(q.id, answer, "option")).answer).toEqual(answer)
  expect(actor.answered).toEqual([[q.id, answer, "option", null]])
})

test("a typed card gives the actor the converted values", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const q = card(office, {
    source: "ask",
    node_id: "setup",
    questions: [
      { question: "How many replicas?", header: "count", options: [{ label: "3" }, { label: "5" }] },
      { question: "Ship it?", header: "ship", options: [{ label: "yes" }, { label: "no" }] },
    ],
    answer_schema: [
      { name: "count", type: "int", required: true },
      { name: "ship", type: "bool", required: true },
    ],
  })
  const typed = { count: 3, ship: true }
  expect((await cards.answer(q.id, { count: "3", ship: "yes" }, "option")).answer).toEqual(typed)
  expect(actor.answered).toEqual([[q.id, typed, "option", null]])
  expect(office.store.getQuestion(q.id)!.answer).toEqual(typed)
})

test("a turn question is no card", async () => {
  const office = makeOffice()
  const { cards } = wire(office)
  const turn = card(office, { source: "ask", node_id: "chat#1/ask" })
  expect(cards.check(turn, 42, "text")).toBeNull()
  const node = card(office, { source: "ask", node_id: "setup" })
  expect(cards.check(node, 42, "text")).toBe("the answer must be text")
  const error = await refusal(() => cards.openSide(turn.id, "why?"))
  expect([error.status, error.code]).toEqual([422, "not_a_card"])
})

test("an invalid answer is refused before the actor sees it", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const q = card(office, { options: ["Retry", "Back off"] })
  const error = await refusal(() => cards.answer(q.id, "Maybe", "option"))
  const expected = [422, "invalid_answer", "'Maybe' is not one of the options"]
  expect([error.status, error.code, error.message]).toEqual(expected)
  expect(actor.answered).toEqual([])
})

test("chat about this answers 501 until side chats land", async () => {
  const office = makeOffice()
  const { cards } = wire(office)
  const q = card(office)
  const error = await refusal(() => cards.openSide(q.id, "why?"))
  expect([error.status, error.code]).toEqual([501, "not_implemented"])
})

test("no harness means no cards", () => {
  const bare = makeOffice()
  register(bare)
  expect(bare.cards).toBeUndefined()
  expect([bare.onStart.length, bare.onStop.length]).toEqual([0, 0])

  const office = makeOffice()
  const { cards, actor } = wire(office)
  expect(office.cards).toBe(cards)
  expect(actor.hooks.answerCheck).toHaveLength(1)
})

test("a secret pages answer is never in a refusal or a log line", async () => {
  const SECRET = "sk-PLANTED-0123456789"
  const lines: string[] = []
  const office = makeOffice({ log: (line) => lines.push(line) })
  const { cards, actor } = wire(office, (line) => lines.push(line))
  const key = card(office, {
    source: "ask",
    node_id: "k",
    questions: [{ question: "API key?", header: "key", options: [{ label: "keep" }], secret: true }],
  })
  const pin = card(office, {
    source: "ask",
    node_id: "p",
    questions: [{ question: "PIN?", header: "pin", options: [], secret: true }],
    answer_schema: [{ name: "pin", type: "int", required: true }],
  })
  const cases: [QuestionRecord, unknown, string][] = [
    [key, { key: [SECRET] }, "'key' takes one label"],
    [pin, { pin: SECRET }, "'pin' must be a whole number"],
  ]
  for (const [q, answer, message] of cases) {
    for (const action of [() => cards.answer(q.id, answer, "option"), () => actor.answer(q.id, answer, "option")]) {
      const error = await refusal(action)
      expect([error.status, error.code, error.message]).toEqual([422, "invalid_answer", message])
      expect(error.cause).toBeUndefined()
      expect(String(error)).not.toContain(SECRET)
      expect(inspect(error)).not.toContain(SECRET)
    }
  }
  expect(lines.filter((line) => line.includes(SECRET))).toEqual([])
})

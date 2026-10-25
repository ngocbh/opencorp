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
  expect((await refusal(() => cards.sendBack(q.id, "x"))).code).toBe("cannot_send_back")
  expect((await refusal(() => cards.stop(q.id))).code).toBe("cannot_stop")
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
  expect(office.onStop).toHaveLength(1)
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

test("a harness card takes only an answer", async () => {
  const office = makeOffice()
  const { cards } = wire(office)
  const s = office.store.createSession(session({ harness: "codex" }))
  const q = office.store.addQuestion(
    question(s.id, {
      run_id: "turn_1",
      node_id: "1",
      source: "harness",
      question: "$ touch a",
      options: ["Approve", "Deny and stop"],
    }),
  )
  for (const action of [() => cards.openSide(q.id, "why?"), () => cards.sendBack(q.id, ""), () => cards.stop(q.id)]) {
    const error = await refusal(action)
    expect([error.status, error.code]).toEqual([422, "harness_card"])
  }
  expect(office.store.getQuestion(q.id)!.status).toBe("open")
})

test("stop on a live main chats model question is esc on that chat", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const q = card(office)
  const stopped = await cards.stop(q.id, { by: "lan" })
  expect(actor.interrupted).toEqual([q.session_id])
  expect(actor.answered).toEqual([])
  expect([stopped.answer, stopped.answer_kind, stopped.answered_by]).toEqual([INTERRUPTED, "interrupted", null])
})

test("stop answers the question when the asking chat has no run to interrupt", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  actor.interruptFails = true
  const q = card(office)
  const stopped = await cards.stop(q.id, { by: "lan" })
  expect([stopped.answer, stopped.answer_kind, stopped.answered_by]).toEqual([INTERRUPTED, "interrupted", "lan"])

  actor.interruptFails = false
  const ended = office.store.createSession(session({ status: "ended" }))
  const q2 = office.store.addQuestion(question(ended.id))
  const answered = await cards.stop(q2.id, { by: "lan" })
  expect([answered.answer, answered.answer_kind, answered.answered_by]).toEqual([INTERRUPTED, "interrupted", "lan"])
  expect(actor.interrupted).toEqual([])
})

test("a manager question is stopped by answering it as who clicked", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const q = card(office, { source: "ask_manager" })
  const stopped = await cards.stop(q.id, { by: "ngocbh" })
  expect(actor.answered).toEqual([[q.id, INTERRUPTED, "interrupted", "ngocbh"]])
  expect(stopped.answered_by).toBe("ngocbh")
  expect(actor.interrupted).toEqual([])
})

test("send back needs a discussion or a carried one", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const q = card(office)
  const error = await refusal(() => cards.sendBack(q.id, ""))
  expect([error.status, error.code]).toEqual([422, "no_discussion"])
  expect(actor.answered).toEqual([])

  const stale = card(office)
  office.store.setQuestionStatus(stale.id, "stale")
  const carried = card(office, { carried_from: stale.id })
  expect((await cards.sendBack(carried.id, "")).answer_kind).toBe("sent_back")
})

test("send back adds a non blank note and answers undecided as who acted", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const discussion = [
    { role: "user" as const, text: "why?" },
    { role: "assistant" as const, text: "quota" },
  ]
  const q = card(office, { discussion })
  const sent = await cards.sendBack(q.id, " list them ", { by: "lan" })
  expect(sent.discussion).toEqual([...discussion, { role: "user", text: " list them " }])
  expect(actor.answered).toEqual([[q.id, null, "sent_back", "lan"]])

  const q2 = card(office, { discussion })
  expect((await cards.sendBack(q2.id, "  ")).discussion).toEqual(discussion)
})

test("two send backs at once leave one note", async () => {
  const office = makeOffice()
  const { cards } = wire(office)
  const q = card(office, { discussion: [{ role: "user", text: "why?" }] })
  const results = await Promise.allSettled([cards.sendBack(q.id, "a"), cards.sendBack(q.id, "b")])
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
  const failed = results.find((result) => result.status === "rejected")!
  expect(failed.reason).toBeInstanceOf(HarnessError)
  const error = failed.reason as HarnessError
  expect([error.status, error.code]).toEqual([409, "not_open"])
  expect(office.store.getQuestion(q.id)!.discussion).toHaveLength(2)
})

test("a dismissed carry over is cleared", () => {
  const office = makeOffice()
  const { cards } = wire(office)
  const stale = card(office)
  office.store.setQuestionStatus(stale.id, "stale")
  const q = card(office, { carried_from: stale.id })
  const dismissed = cards.dismissCarried(q.id)
  expect(dismissed.carried_from).toBeNull()
  expect(office.store.getQuestion(q.id)).toEqual(dismissed)
})

test("card actions on a closed question are 409 not open", async () => {
  const office = makeOffice()
  const { cards } = wire(office)
  const q = card(office, { options: ["Retry", "Back off"] })
  await cards.answer(q.id, "Retry", "option")
  const actions = (id: string) => [
    () => cards.answer(id, "Retry", "option"),
    () => cards.sendBack(id, "x"),
    () => cards.stop(id),
    async () => cards.dismissCarried(id),
    () => cards.openSide(id, "why?"),
  ]
  for (const action of actions(q.id)) {
    const error = await refusal(action)
    expect([error.status, error.code]).toEqual([409, "not_open"])
  }
  for (const action of actions("01MISSINGQUESTION000000000")) {
    const error = await refusal(action)
    expect([error.status, error.code]).toEqual([404, "not_found"])
  }
})

test("close waits for queued send backs", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  let release = () => {}
  actor.answerGate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const q = card(office, { discussion: [{ role: "user", text: "why?" }] })
    const sent = cards.sendBack(q.id, "")
    let closed = false
    const closing = cards.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(false)
    release()
    expect((await sent).answer_kind).toBe("sent_back")
    await closing
    expect(closed).toBe(true)
  } finally {
    release()
  }
})

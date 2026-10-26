/** Card actions on the questions extension: through a stand-in for the session actor, and the chat's rows on the real
 *  chat harness (Python's `tests/questions/test_cards.py`). */
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { iterRunRecords } from "@ngocbh/yian/run"
import type { Scheduler } from "@ngocbh/yian/platform"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { type Question, stamp } from "@opencorp/protocol"
import { Hooks } from "../../src/chat/hooks.ts"
import { HarnessError, notWaiting } from "../../src/chat/state.ts"
import type { Office } from "../../src/daemon/office.ts"
import { register } from "../../src/extensions/questions.ts"
import type { AnswerKind, CardActor, Cards } from "../../src/questions/cards.ts"
import { CARRIED_NOTE, INTERRUPTED, SENT_BACK } from "../../src/questions/format.ts"
import { FRAMING, firstMessage } from "../../src/questions/seed.ts"
import { BACK_HINT, SEED_FILE } from "../../src/questions/side.ts"
import { CARD_CLOSED } from "../../src/runs/outcomes.ts"
import { InvalidTransition, type QuestionRecord, type Store } from "../../src/store/store.ts"
import type { FakeLLM, ScriptedReply } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import {
  ASK_MANAGER,
  card as chatCard,
  fakeLlm,
  GATE,
  GATE_ANSWER,
  GATE_FILES,
  LAN,
  makeHarness,
  noWorkersLeft,
  ROOT,
  status,
  texts,
} from "../chat/helpers.ts"
import { CEO, makeOffice, standInHarness } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import { question, recordEvents, session } from "../store/helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

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
  office.harness = standInHarness({
    hooks: actor.hooks,
    answer: actor.answer.bind(actor),
    interrupt: actor.interrupt.bind(actor),
  })
  register(office)
  return { cards: office.cards!, actor }
}

/** A stored question in a new stored session. */
function card(office: Office, over?: Partial<Question>): QuestionRecord {
  const s = office.store.createSession(session())
  return office.store.addQuestion(question(s.id, over))
}

/** A fixed timestamp `n` seconds after 2026-01-01, so cards made in one test have a known order. */
function at(n: number): string {
  return stamp(new Date(Date.UTC(2026, 0, 1, 0, 0, n)))
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

test("an invalid answer is refused before the actor sees it", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const q = card(office, { options: ["Retry", "Back off"] })
  const error = await refusal(() => cards.answer(q.id, "Maybe", "option"))
  const expected = [422, "invalid_answer", "'Maybe' is not one of the options"]
  expect([error.status, error.code, error.message]).toEqual(expected)
  expect(actor.answered).toEqual([])
})

test("chat about this answers 501 without a side chat harness", async () => {
  const office = makeOffice()
  const { cards } = wire(office)
  const q = card(office)
  const error = await refusal(() => cards.openSide(q.id, "why?"))
  expect([error.status, error.code]).toEqual([501, "not_implemented"])
  expect(office.store.getQuestion(q.id)!.side_session_id).toBeNull()
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
  expect([actor.hooks.questionStored.length, actor.hooks.sessionEnded.length]).toEqual([1, 1])
  expect([office.onStart.length, office.onStop.length]).toEqual([1, 1])
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

test("an expired questions discussion is carried into the next card", async () => {
  const office = makeOffice()
  const { cards, actor } = wire(office)
  const said = [{ role: "user" as const, text: "why?" }]
  /** A stale card made at `n` in session `sid`. */
  const expired = (sid: string, n: number, discussion: Question["discussion"]) => {
    const q = office.store.addQuestion(question(sid, { discussion, created_at: at(n) }))
    return office.store.setQuestionStatus(q.id, "stale")
  }
  const carried = (id: string) => office.store.getQuestion(id)!.carried_from

  const s1 = office.store.createSession(session())
  const old1 = expired(s1.id, 1, said)
  const next1 = office.store.addQuestion(question(s1.id, { created_at: at(2) }))
  cards.stored(next1)
  expect(carried(next1.id)).toBe(old1.id)

  const s2 = office.store.createSession(session())
  expired(s2.id, 1, [])
  const next2 = office.store.addQuestion(question(s2.id, { created_at: at(2) }))
  cards.stored(next2)
  expect(carried(next2.id)).toBeNull()

  const s4 = office.store.createSession(session())
  const old4 = expired(s4.id, 1, said)
  const next4 = office.store.addQuestion(question(s4.id, { created_at: at(2) }))
  await actor.hooks.notify("questionStored", next4)
  expect(carried(next4.id)).toBe(old4.id)

  const s5 = office.store.createSession(session())
  expired(s5.id, 1, said)
  office.store.addQuestion(question(s5.id, { created_at: at(2) }))
  const next5 = office.store.addQuestion(question(s5.id, { created_at: at(3) }))
  cards.stored(next5)
  expect(carried(next5.id)).toBeNull()

  const s6 = office.store.createSession(session())
  const next6 = office.store.addQuestion(question(s6.id, { created_at: at(3) }))
  expired(s6.id, 4, said)
  cards.stored(next6)
  expect(carried(next6.id)).toBeNull()
})

test("a session that ends expires its open cards", async () => {
  const office = makeOffice()
  const { actor } = wire(office)
  const s = office.store.createSession(session({ status: "failed" }))
  const open = [office.store.addQuestion(question(s.id)), office.store.addQuestion(question(s.id))]
  const done = office.store.addQuestion(question(s.id))
  const answered = office.store.answerQuestion(done.id, "Postgres", "text", "lan")
  const other = card(office)
  await actor.hooks.notify("sessionEnded", s)
  for (const q of open) expect(office.store.getQuestion(q.id)!.status).toBe("stale")
  expect(office.store.getQuestion(done.id)).toEqual(answered)
  expect(office.store.getQuestion(other.id)!.status).toBe("open")
})

test("the start sweep expires cards of sessions with no live run", async () => {
  const office = makeOffice()
  wire(office)
  const opened = (["failed", "ended", "idle"] as const).map((status) =>
    office.store.addQuestion(question(office.store.createSession(session({ status })).id)),
  )
  await office.start()
  expect(opened.map((q) => office.store.getQuestion(q.id)!.status)).toEqual(["stale", "stale", "open"])
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

// --- on the real chat harness -----------------------------------------------------------------

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** Starts minh's chat in `h.folder` (`options` as `startSession`'s) and waits for its first turn; returns its id. */
async function started(h: Harness, options: Parameters<Harness["harness"]["startSession"]>[2] = {}): Promise<string> {
  const { id } = await h.harness.startSession("minh", h.folder, options)
  await waitFor(() => status(h, id) === "idle", { what: "the first turn" })
  return id
}

/** The result each of `h`'s runs finished with, in order. */
function outcomes(h: Harness): (Frame | null)[] {
  const seen: (Frame | null)[] = []
  h.hooks.runFinished.push((_s, _runId, result) => void seen.push(result))
  return seen
}

/** A harness over `fake` whose minh runs `gate` as his main flow, with the side chat flow and the questions
 *  extension, and minh's session waiting at its card; with `asleep`, the harness is closed and a new one (not
 *  restored) has the session. */
async function atTheGate(gate = GATE, { asleep = false, fake }: { asleep?: boolean; fake?: FakeLLM } = {}) {
  const files = { ...SIDE_FILES, ...GATE_FILES, "people/minh/gate.yaml": gate }
  const h = await makeHarness(fake ?? (await fakeLlm()), { files, questions: true })
  const { id } = await h.harness.startSession("minh", h.folder)
  const q = await chatCard(h, id, "ask")
  await waitFor(() => status(h, id) === "waiting", { what: "the session to wait at its card" })
  if (asleep) await h.reopen()
  return { h, q }
}

/** The gate with typed pages: its answer is `{count: int, ship: bool}`. */
const TYPED_GATE = GATE.replace(
  /  setup:[\s\S]*?(?=output: )/,
  `  setup:
    kind: tool
    tool_id: ask
    input:
      questions:
        - question: How many replicas?
          header: count
          options: [{label: "3"}, {label: "5"}]
        - question: Ship it?
          header: ship
          options: [{label: "yes"}, {label: "no"}]
    output: {count: int, ship: bool}
`,
)

test("a manager question is stopped by answering it", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_MANAGER, { content: "Carrying on." })
  const h = await makeHarness(fake, { questions: true })
  const id = await started(h)
  await h.harness.prompt(id, "plan it")
  const q = await chatCard(h, id, "ask_manager")
  await h.office.cards!.stop(q.id)
  expect(JSON.stringify((await fake.waitForRequests(2))[1]!.messages)).toContain(INTERRUPTED)
  await waitFor(() => texts(h, id).at(-1) === "Carrying on.", { what: "the asker to carry on" })
})

test("stopping a manager question is credited to who clicked", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_MANAGER, { content: "Carrying on." })
  const h = await makeHarness(fake, { files: LAN, questions: true })
  const id = await started(h, { openedBy: "lan" })
  await h.harness.prompt(id, "plan it", { by: "lan" })
  const q = await chatCard(h, id, "ask_manager")
  // Minh's manager clicks Stop on a chat Lan opened: the manager is credited, not the opener.
  expect((await h.office.cards!.stop(q.id, { by: "ngocbh" })).answered_by).toBe("ngocbh")
  await waitFor(() => h.store.getWorkItem(q.work_item_id!)!.resolved_by === "ngocbh", { what: "the item to close" })
})

test("a gate takes a record keyed by header and offers no send back or stop", async () => {
  const { h, q } = await atTheGate()
  const cards = h.office.cards!
  const ended = outcomes(h)
  expect([q.source, q.node_id, q.questions?.map((p) => p.header)]).toEqual(["ask", "setup", ["db", "features"]])
  const refused: [() => Promise<unknown>, string][] = [
    [() => cards.sendBack(q.id, "x"), "cannot_send_back"],
    [() => cards.stop(q.id), "cannot_stop"],
    [() => cards.answer(q.id, { db: "SQLite" }, "option"), "invalid_answer"],
    [() => h.harness.answer(q.id, "SQLite", "text"), "invalid_answer"],
  ]
  for (const [action, code] of refused) expect((await refusal(action)).code).toBe(code)
  const answer = { db: "SQLite", features: ["auth", "search"] }
  expect((await cards.answer(q.id, answer, "option")).answer).toEqual(answer)
  await waitFor(() => status(h, q.session_id) === "ended", { what: "the flow to finish" })
  // The run took the answer (by complete) and succeeded with the record as its output.
  expect(h.store.getQuestion(q.id)!.status).toBe("consumed")
  await waitFor(() => ended.length === 1, { what: "the run's end" })
  expect(ended[0]).toMatchObject({ status: "succeeded", output: answer })
})

test("a typed gate takes labels and the harness accepts their converted values", async () => {
  const { h, q } = await atTheGate(TYPED_GATE)
  const ended = outcomes(h)
  expect(q.answer_schema.map((f) => [f.name, f.type])).toEqual([
    ["count", "int"],
    ["ship", "bool"],
  ])
  const typed = { count: 3, ship: true }
  expect((await h.office.cards!.answer(q.id, { count: "3", ship: "yes" }, "option")).answer).toEqual(typed)
  await waitFor(() => status(h, q.session_id) === "ended", { what: "the flow to finish" })
  await waitFor(() => ended.length === 1, { what: "the run's end" })
  // A yian int is a bigint.
  expect(ended[0]).toMatchObject({ status: "succeeded", output: { count: 3n, ship: true } })
})

test("an answer to a sleeping sessions question node is stored then wakes it", async () => {
  const { h, q } = await atTheGate(GATE, { asleep: true })
  const ended = outcomes(h)
  expect(h.registry.get(q.session_id)).toBeUndefined()
  const before = h.kinds.length
  const got = await h.office.cards!.answer(q.id, GATE_ANSWER, "option")
  expect(got.status).toBe("answered")
  // A new actor takes it to the run by complete, on one advance.
  expect(h.kinds.slice(before)).toEqual(["advance"])
  expect(h.jobs.at(-1)!.deliver).toMatchObject([{ op: "complete", call_id: q.call_id, result: { output: GATE_ANSWER } }])
  await waitFor(() => status(h, q.session_id) === "ended", { what: "the gate flow's end" })
  await waitFor(() => ended.length === 1, { what: "the run's end" })
  expect(ended[0]).toMatchObject({ status: "succeeded", output: GATE_ANSWER })
})

test("an answer whose wake fails still stands", async () => {
  const { h, q } = await atTheGate(GATE, { asleep: true })
  const sid = q.session_id
  const file = path.join(h.office.connections.dir, "office.json")
  fs.chmodSync(file, 0o644) // not private: the office's connection can't be read
  const got = await h.office.cards!.answer(q.id, GATE_ANSWER, "option")
  expect(got.status).toBe("answered")
  expect(h.store.getQuestion(q.id)!.status).toBe("answered")
  expect(status(h, sid)).toBe("idle")
  expect(h.registry.get(sid)).toBeUndefined()
  // The next wake carries the stored answer by complete; the gate reads no inbox, so the message is refused.
  fs.chmodSync(file, 0o600)
  const before = h.kinds.length
  expect((await refusal(() => h.harness.prompt(sid, "go on"))).code).toBe("refused")
  expect(h.kinds.slice(before)).toEqual(["advance"])
  const complete = { op: "complete", call_id: q.call_id, result: { output: GATE_ANSWER } }
  expect(h.jobs.at(-1)!.deliver).toMatchObject([complete, { op: "send" }])
  await waitFor(() => status(h, sid) === "ended", { what: "the gate flow's end" })
})

// --- side chats on the real chat harness --------------------------------------------------------

const SIDE_FLOW = "shared/flows/side_chat.yaml"

/** The template's side chat flow, by repo path. */
const SIDE_FILES = {
  [SIDE_FLOW]: fs.readFileSync(path.join(ROOT, SIDE_FLOW), "utf8"),
}

const ASK: ScriptedReply = {
  tool_calls: [{ name: "ask_user", arguments: { question: "Retry or back off?", options: ["Retry", "Back off"] } }],
}

/** A harness over `fake` whose company has the side chat flow (and `files`), with the questions extension. */
function sideHarness(fake: FakeLLM, options: Parameters<typeof makeHarness>[1] = {}) {
  return makeHarness(fake, { ...options, files: { ...SIDE_FILES, ...options.files }, questions: true })
}

/** Starts minh's chat (`options` as `startSession`'s) and has its reply ask the scripted question; returns the
 *  session id and the question. */
async function ask(h: Harness, options: Parameters<Harness["harness"]["startSession"]>[2] = {}) {
  const sid = await started(h, options)
  await h.harness.prompt(sid, "fix the build")
  return { sid, q: await chatCard(h, sid, "ask_user") }
}

/** Sends `text` from `by` in the question's side chat and waits for its reply number `replies`. */
async function chat(h: Harness, q: QuestionRecord, text: string, replies: number, by: string | null = null) {
  const side = await h.office.cards!.openSide(q.id, text, { by })
  await waitFor(() => texts(h, side.id).length === replies && status(h, side.id) === "idle", {
    what: "the side reply",
  })
  return side
}

/** A request message's text: its content, or its text parts joined with "\n". */
function contentText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part: { text?: unknown }) => (typeof part.text === "string" ? part.text : "")).join("\n")
}

/** Every string in `value`, nested or not, joined with "\n": text to search, where JSON would escape quotes. */
function contentOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(contentOf).join("\n")
  if (value !== null && typeof value === "object") return Object.values(value).map(contentOf).join("\n")
  return ""
}

/** The messages of request `n` (from 1). */
async function messagesOf(fake: FakeLLM, n: number): Promise<Record<string, unknown>[]> {
  return (await fake.waitForRequests(n))[n - 1]!.messages as Record<string, unknown>[]
}

/** The text of request `n`'s last user message, inside its author wrapper. */
async function lastUser(fake: FakeLLM, n: number): Promise<string> {
  const text = contentText((await messagesOf(fake, n)).filter((m) => m.role === "user").at(-1)!)
  return text.replace(/^<authored_message author="[^"]*">\n([\s\S]*)\n<\/authored_message>$/, "$1")
}

/** How many times request `n`'s messages carry the side chat's framing. */
async function framings(fake: FakeLLM, n: number): Promise<number> {
  return (await messagesOf(fake, n)).reduce((sum, m) => sum + contentText(m).split(FRAMING).length - 1, 0)
}

/** The authors of session `sid`'s user messages whose text is `text` (any text when null). */
function authors(h: Harness, sid: string, text: string | null = null): (string | null | undefined)[] {
  return h.harness
    .messages(sid)
    .filter((m) => m.role === "user" && (text === null || m.parts.some((p) => p.type === "text" && p.text === text)))
    .map((m) => m.author)
}

test("chat about this opens a seeded side session and the answer carries it", async () => {
  const fake = await fakeLlm()
  fake.script(
    ASK,
    { content: "The sandbox is rate-limited." },
    { content: "Each retry costs a call." },
    { content: "Backing off." },
  )
  const h = await sideHarness(fake)
  const events = recordEvents(h.store)
  const cards = h.office.cards!
  const { sid, q } = await ask(h)

  const side = await chat(h, q, "why not fail fast?", 1)
  expect([side.kind, side.question_id, side.person, side.cwd, side.cost_cap_usd]).toEqual([
    "side",
    q.id,
    "minh",
    fs.realpathSync(h.folder),
    1,
  ])
  const seedFile = path.join(h.office.paths.sessionDir(side.id), SEED_FILE)
  const seed = fs.readFileSync(seedFile, "utf8")
  expect(seed).toStartWith(FRAMING)
  expect(seed).toContain("Retry or back off?")
  expect(fs.statSync(seedFile).mode & 0o777).toBe(0o600)
  expect(h.store.getQuestion(q.id)!.side_session_id).toBe(side.id)
  // The seed and the message go as two text parts, inside the author's wrapper; joined, they read as Python's.
  const sent = (await messagesOf(fake, 2)).filter((m) => m.role === "user").at(-1)!.content as { text: string }[]
  expect(sent).toHaveLength(2)
  expect(sent[0]!.text).toMatch(/^<authored_message author="[^"]*">\n/)
  expect(sent[0]!.text).toEndWith(`\n${seed}\n\n# Their first message to you\n`)
  expect(sent[1]!.text).toBe("why not fail fast?\n</authored_message>")
  const first = await lastUser(fake, 2)
  expect(first).toStartWith(FRAMING)
  expect(first).toEndWith("why not fail fast?")
  expect(first).toBe(firstMessage(seed, "why not fail fast?"))
  expect(JSON.stringify((await fake.waitForRequests(2))[1]!.tools ?? [])).not.toContain("ask_user")

  await chat(h, q, "and retries?", 2)
  expect(await lastUser(fake, 3)).toBe("and retries?")
  expect(await framings(fake, 3)).toBe(1) // the seed, once, from the side session's history
  expect(texts(h, side.id, "user")).toEqual(["why not fail fast?", "and retries?"])
  const said = () => h.store.getQuestion(q.id)!.discussion.map((e) => [e.role, e.text])
  const discussed = [
    ["user", "why not fail fast?"],
    ["assistant", "The sandbox is rate-limited."],
    ["user", "and retries?"],
    ["assistant", "Each retry costs a call."],
  ]
  await waitFor(() => JSON.stringify(said()) === JSON.stringify(discussed), { what: "the discussion" })

  for (const say of [() => cards.openSide(q.id, "/exit"), () => h.harness.prompt(side.id, " /Quit ")]) {
    const error = await refusal(say)
    expect([error.status, error.code, error.message]).toEqual([422, "refused", BACK_HINT])
  }

  // The seed stays out of the session, so its updates don't carry it to every client, and out of the log lines.
  const updates = events.filter((e) => e.type === "session.updated" && e.subject_id === side.id).map((e) => e.data)
  expect(updates.length).toBeGreaterThan(2)
  expect(updates.filter((d) => contentOf(d).includes(FRAMING))).toEqual([])
  expect(h.logs.filter((line) => line.includes(FRAMING) || line.includes("Retry or back off?"))).toEqual([])

  await cards.answer(q.id, "Back off", "option")
  const result = contentOf(await messagesOf(fake, 4))
  expect(result).toContain('The user chose "Back off" (option 2 of the 2 shown).')
  expect(result).toContain("why not fail fast?")
  expect(result).toContain("Each retry costs a call.")
  await waitFor(() => status(h, side.id) === "ended", { what: "the side session to end" })
  await waitFor(() => texts(h, sid).at(-1) === "Backing off.", { what: "the asker's reply" })
})

test("send back needs a discussion and returns it undecided", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "It depends on the quota." }, { content: "I'll ask better." })
  const h = await sideHarness(fake)
  const cards = h.office.cards!
  const { q } = await ask(h)
  const error = await refusal(() => cards.sendBack(q.id, ""))
  expect([error.status, error.code]).toEqual([422, "no_discussion"])

  const side = await chat(h, q, "what quota?", 1)
  const answered = await cards.sendBack(q.id, "list the quotas as options")
  expect([answered.answer_kind, answered.discussion.at(-1)!.text]).toEqual(["sent_back", "list the quotas as options"])
  await waitFor(() => status(h, side.id) === "ended", { what: "the side session to end" })
  const result = contentOf(await messagesOf(fake, 3))
  expect(result).toContain(SENT_BACK)
  expect(result).toContain("It depends on the quota.")
  expect(result).toContain("list the quotas as options")
  const again = await refusal(() => cards.sendBack(q.id, ""))
  expect([again.status, again.code]).toEqual([409, "not_open"])
})

test("a side worker exit during send back keeps the note", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "It depends on the quota." }, { content: "I'll ask better." })
  const h = await sideHarness(fake)
  const cards = h.office.cards!
  const { q } = await ask(h)
  const side = await chat(h, q, "what quota?", 1)
  const answer = h.harness.answer.bind(h.harness)
  let late: Promise<void> | undefined
  h.harness.answer = async (questionId, value, kind, options) => {
    // The side worker exits after the note is added and before the answer lands.
    late = h.hooks.notify("workerExited", h.store.getSession(side.id)!, 0)
    await Bun.sleep(300)
    return answer(questionId, value, kind, options)
  }
  await cards.sendBack(q.id, "list the quotas as options")
  await late
  expect(h.store.getQuestion(q.id)!.discussion.map((e) => e.text)).toEqual([
    "what quota?",
    "It depends on the quota.",
    "list the quotas as options",
  ])
})

test("stop is esc on the asking chat", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Because of the quota." })
  const h = await sideHarness(fake)
  const { sid, q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  const stopped = await h.office.cards!.stop(q.id)
  expect([stopped.answer, stopped.answer_kind]).toEqual([INTERRUPTED, "interrupted"])
  expect(stopped.discussion.map((e) => e.text)).toEqual(["why?", "Because of the quota."])
  await waitFor(() => status(h, sid) === "idle", { what: "the asker to wait for the next message" })
  await waitFor(() => status(h, side.id) === "ended", { what: "the side session to end" })
})

const DECIDE: [string, (cards: Cards, q: QuestionRecord) => Promise<QuestionRecord>][] = [
  ["answer", (cards, q) => cards.answer(q.id, "Back off", "option", { by: "lan" })],
  ["send_back", (cards, q) => cards.sendBack(q.id, "", { by: "lan" })],
]

test.each(DECIDE)("a side chat and the decision are credited to who acted [%s]", async (_name, decide) => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Rate limits." }, { content: "OK." })
  const h = await sideHarness(fake, { files: LAN })
  const cards = h.office.cards!
  const { q } = await ask(h)
  const side = await cards.openSide(q.id, "why?", { by: "lan" })
  expect(side.opened_by).toBe("lan")
  await waitFor(() => texts(h, side.id).join() === "Rate limits." && status(h, side.id) === "idle", {
    what: "the side reply",
  })
  expect(contentText((await messagesOf(fake, 2))[0]!)).toContain("You're talking with Lan (@lan), your peer.")
  expect(authors(h, side.id)).toEqual(["lan"])
  expect(h.store.getRun(h.store.getSession(side.id)!.run_ids[0]!)!.driver).toBe("lan")
  expect((await decide(cards, q)).answered_by).toBe("lan")
})

test("a side chat reopened by someone else is theirs", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." }, { content: "Per hour." })
  const h = await sideHarness(fake, { files: LAN })
  const cards = h.office.cards!
  const { q } = await ask(h)
  const side = await cards.openSide(q.id, "why?", { by: "ngocbh" })
  await waitFor(() => texts(h, side.id).join() === "Quota." && status(h, side.id) === "idle", {
    what: "the side reply",
  })
  await h.harness.end(side.id)
  await waitFor(() => status(h, side.id) === "ended", { what: "the side session to end" })
  const again = await cards.openSide(q.id, "how often?", { by: "lan" })
  expect([again.id, again.opened_by]).toEqual([side.id, "lan"])
  await waitFor(() => texts(h, side.id).at(-1) === "Per hour." && status(h, side.id) === "idle", {
    what: "the reply",
  })
  expect(contentText((await messagesOf(fake, 3))[0]!)).toContain("You're talking with Lan (@lan), your peer.")
  expect(authors(h, side.id, "how often?")).toEqual(["lan"])
})

test("a refused reopen stores nothing", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." })
  const h = await sideHarness(fake, { files: LAN })
  const cards = h.office.cards!
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1, "ngocbh")
  await h.harness.end(side.id)
  await waitFor(() => status(h, side.id) === "ended", { what: "the side session to end" })
  const before = h.store.getSession(side.id)!
  fs.rmSync(h.folder, { recursive: true })
  const error = await refusal(() => cards.openSide(q.id, "how often?", { by: "lan" }))
  expect(error.status).toBe(422)
  const after = h.store.getSession(side.id)!
  expect([after.status, after.opened_by, after.run_ids]).toEqual(["ended", "ngocbh", before.run_ids])
  expect(after.updated_at).toBe(before.updated_at)
})

test("the seed goes once when no ceo answers for the human", async () => {
  // An unreadable company.yaml leaves no CEO to answer for the human: "first" rests on the session's turns.
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." }, { content: "Per hour." })
  const h = await sideHarness(fake, { files: { "company.yaml": "ceo: [unclosed\n" } })
  const { q } = await ask(h)
  await chat(h, q, "why?", 1)
  expect(await lastUser(fake, 2)).toStartWith(FRAMING)
  await chat(h, q, "how often?", 2)
  expect(await lastUser(fake, 3)).toBe("how often?")
})

test("an ended side chat restarts on its memory without the seed again", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." }, { content: "Per hour." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  await h.harness.end(side.id)
  await waitFor(() => status(h, side.id) === "ended", { what: "the side session to end" })
  expect(h.store.getQuestion(q.id)!.status).toBe("open")

  const again = await chat(h, q, "how often?", 2)
  expect(again.id).toBe(side.id)
  expect(h.store.getSession(side.id)!.run_ids).toHaveLength(2)
  expect(await lastUser(fake, 3)).toBe("how often?")
  expect(await framings(fake, 3)).toBe(1) // from the first run's history
})

test("a first reply that dies leaves the seed for the next turn", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { error: 500 }, { content: "Quota." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await h.office.cards!.openSide(q.id, "why?")
  expect(await lastUser(fake, 2)).toStartWith(FRAMING)
  // The failed reply finished no turn, so the session's turns stay 0: a fresh run waits on the next message.
  await waitFor(() => h.store.getSession(side.id)!.run_ids.length === 2 && status(h, side.id) === "idle", {
    what: "the side session's next run",
  })
  await chat(h, q, "why, again?", 1)
  const first = await lastUser(fake, 3)
  expect(first).toStartWith(FRAMING)
  expect(first).toEndWith("why, again?")
})

test("a failed side chat restarts on the next message", async () => {
  const fake = await fakeLlm()
  const held = { content: "Thinking.", hold: true }
  fake.script(ASK, { content: "Quota." }, held, held, { content: "Per hour." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  await h.harness.prompt(side.id, "and then?")
  // Two worker deaths in a row during the held reply fail the side session.
  for (const n of [3, 4]) {
    await fake.waitForRequests(n)
    await waitFor(() => h.registry.get(side.id), { what: `worker ${n - 2}` })
    process.kill(-h.registry.get(side.id)!.pgid, "SIGKILL")
  }
  await waitFor(() => status(h, side.id) === "failed", { what: "the side session to fail" })

  // Reopened at once: the new run's worker waits for the failed run's hard stop, which runs under the session's id.
  const again = await chat(h, q, "how often?", 2)
  expect(again.id).toBe(side.id)
  const runs = h.store.getSession(side.id)!.run_ids
  expect(runs).toHaveLength(2)
  expect(await lastUser(fake, 5)).toBe("how often?")
  const cancels = h.jobs.filter((job) => job.run_id === runs[0] && !job.advance)
  expect(cancels.map((job) => job.deliver.map((d) => d.op))).toEqual([["cancel"]])
})

test("a side chat uses its askers model", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "On five." })
  const h = await sideHarness(fake, { connections: { second: "stub-2" } })
  const { q } = await ask(h, { connection: "second", model: "stub-5" })
  const side = await chat(h, q, "why?", 1)
  expect([side.connection, side.model]).toEqual(["second", "stub-5"])
  expect((await fake.waitForRequests(2))[1]!.model).toBe("stub-5")
})

test("each side chat run nests under the cards run with its opener as driver", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." }, { content: "Per hour." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  const ended = outcomes(h)
  await h.harness.end(side.id)
  await waitFor(() => status(h, side.id) === "ended" && ended.length === 1, { what: "the side session to end" })
  await chat(h, q, "how often?", 2) // a reopen is a new run of the same side session
  const runs = h.store.runsOfSession(side.id)
  expect(runs.map((r) => [r.flow, r.flowPath, r.driver])).toEqual([
    ["side_chat", SIDE_FLOW, CEO],
    ["side_chat", SIDE_FLOW, CEO],
  ])
  const logs = h.jobs.filter((job) => job.kind === "chat" && job.session_id === side.id).map((job) => job.log)
  expect(logs).toHaveLength(2)
  for (const log of logs) {
    const [started] = iterRunRecords(log, { payloads: true })
    expect(started!.kind).toBe("run_started")
    const record = started!.envelope.record as unknown as { parent: unknown }
    expect(record.parent).toEqual({ runId: q.run_id, node: q.node_id })
  }
  // The first run finished at its end; the reopened one runs on.
  expect(ended.map((result) => [result?.run_id, result?.status])).toEqual([[runs[0]!.runId, "succeeded"]])
})

// --- side chats closing with their cards ----------------------------------------------------------

/** The question `ASK` asks, waiting at most a second for its answer. */
const ASK_TIMED: ScriptedReply = {
  tool_calls: [
    {
      name: "ask_user",
      arguments: { question: "Retry or back off?", options: ["Retry", "Back off"], timeout: "1s" },
    },
  ],
}

/** A scheduler on the real clock whose sleeps wait for the next `release()`, then sleep for real: a wake-at timer
 *  fires only once the test lets it. */
function heldTimers(): { scheduler: Scheduler; release: () => void } {
  const held: (() => void)[] = []
  const scheduler: Scheduler = {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        let timer: ReturnType<typeof setTimeout> | undefined
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            reject(signal.reason)
          },
          { once: true },
        )
        // A margin past the sleep, so the timer's next read of the clock finds its deadline passed.
        held.push(() => {
          if (!signal?.aborted) timer = setTimeout(resolve, ms + 20)
        })
      }),
  }
  return { scheduler, release: () => held.splice(0).forEach((go) => go()) }
}

/** The kinds of run `runId`'s log records. */
function recordKinds(h: Harness, runId: string): string[] {
  const log = path.join(h.office.paths.runs, runId, "log.jsonl")
  return fs.existsSync(log) ? [...iterRunRecords(log)].map((entry) => entry.kind) : []
}

/** The texts of question `id`'s discussion. */
function discussed(h: Harness, id: string): string[] {
  return h.store.getQuestion(id)!.discussion.map((e) => e.text)
}

/** End answering 409 `not_live`, as it does for a session stored live with no run to end. */
function noLiveRun(h: Harness, before: (sid: string) => void = () => {}) {
  return spyOn(h.harness, "end").mockImplementation(async (sid: string) => {
    before(sid)
    throw new HarnessError(409, "not_live", `session ${sid} has no live run`)
  })
}

test("a question answered while its side chat starts ends it", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "OK." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const startRun = h.harness.startRun.bind(h.harness)
  h.harness.startRun = async (sessionId) => {
    const runId = await startRun(sessionId)
    h.store.answerQuestion(q.id, "Retry", "option", null) // another client answered meanwhile
    return runId
  }
  const error = await refusal(() => h.office.cards!.openSide(q.id, "why?"))
  expect([error.status, error.code]).toEqual([409, "not_open"])
  const sideId = h.store.getQuestion(q.id)!.side_session_id!
  await waitFor(() => status(h, sideId) === "ended", { what: "the side session to end" })
  expect(texts(h, sideId, "user")).toEqual([])
})

test("a card answered after its side runs row commits ends the side chat once", async () => {
  const fake = await fakeLlm()
  fake.script(ASK)
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const ends: string[] = []
  h.hooks.sessionEnded.push((session) => void ends.push(session.id))
  const end = spyOn(h.harness, "end")
  // The side's start holds at its worker's spawn: its run's row committed, inside its actor's queue.
  const held = h.hold()
  const opening = refusal(() => h.office.cards!.openSide(q.id, "why?"))
  await held.entered
  const sideId = h.store.getQuestion(q.id)!.side_session_id!
  expect(h.store.runsOfSession(sideId)).toHaveLength(1)
  h.store.answerQuestion(q.id, "Retry", "option", null) // another client answered meanwhile
  await Bun.sleep(100)
  // The close left the starting side chat to its open.
  expect(end).not.toHaveBeenCalled()
  held.release()
  const error = await opening
  expect([error.status, error.code]).toEqual([409, "not_open"])
  await waitFor(() => status(h, sideId) === "ended" && h.registry.get(sideId) === undefined, {
    what: "the side chat's end",
  })
  const rows = h.store.runsOfSession(sideId)
  expect(rows.map((row) => row.runId)).toEqual(h.store.getSession(sideId)!.run_ids)
  expect(rows.map((row) => row.endReason)).toEqual([null])
  expect(end).toHaveBeenCalledTimes(1)
  await Bun.sleep(100)
  expect(ends.filter((id) => id === sideId)).toEqual([sideId])
})

test("an expired question hands its discussion to the next card", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_TIMED, { content: "Retries hide flakes." }, ASK, { content: "OK." })
  const timers = heldTimers()
  const h = await sideHarness(fake, { scheduler: timers.scheduler })
  const cards = h.office.cards!
  const { sid, q } = await ask(h)
  const side = await chat(h, q, "why ask?", 1)
  timers.release() // its call times out, and the agent asks again
  await waitFor(() => h.store.getQuestion(q.id)!.status === "stale", { what: "the old question to expire" })
  const q2 = await waitFor(() => h.store.listQuestions({ sessionId: sid, status: "open", source: "ask_user" })[0], {
    what: "the new question",
  })
  await waitFor(() => h.store.getQuestion(q2.id)!.carried_from === q.id, { what: "the carry-over" })
  await waitFor(() => status(h, side.id) === "ended", { what: "the old side session to end" })
  expect(discussed(h, q.id)).toEqual(["why ask?", "Retries hide flakes."])

  await cards.answer(q2.id, "Retry", "option")
  const result = contentOf(await messagesOf(fake, 4))
  expect(result).toContain(CARRIED_NOTE)
  expect(result).toContain("Retries hide flakes.")
})

test("a dismissed carry over stays out of the answer", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_TIMED, { content: "Retries hide flakes." }, ASK, { content: "OK." })
  const timers = heldTimers()
  const h = await sideHarness(fake, { scheduler: timers.scheduler })
  const cards = h.office.cards!
  const { sid, q } = await ask(h)
  await chat(h, q, "why ask?", 1)
  timers.release()
  const carried = () =>
    h.store.listQuestions({ sessionId: sid, status: "open", source: "ask_user" }).find((c) => c.carried_from)
  const q2 = await waitFor(carried, { what: "the carried card" })
  expect(cards.dismissCarried(q2.id).carried_from).toBeNull()
  await cards.answer(q2.id, "Retry", "option")
  expect(contentOf(await messagesOf(fake, 4))).not.toContain(CARRIED_NOTE)
})

test("a session that fails for good leaves a stale card with its discussion", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_TIMED, { content: "Because." }, ASK_TIMED)
  const timers = heldTimers()
  const h = await sideHarness(fake, { scheduler: timers.scheduler })
  const { sid, q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  timers.release()
  const q2 = await waitFor(() => h.store.listQuestions({ sessionId: sid, status: "open", source: "ask_user" })[0], {
    what: "q2",
  })
  await waitFor(
    () => status(h, side.id) === "ended" && status(h, sid) === "waiting" && h.registry.get(sid) === undefined,
    { what: "the asker to wait at q2" },
  )
  // The wake at q2's deadline and its retry both die: the session fails for good.
  const kill = (worker: { pgid: number }) => process.kill(-worker.pgid, "SIGKILL")
  h.afterSpawn(kill)
  h.afterSpawn(kill)
  timers.release()
  await waitFor(() => status(h, sid) === "failed", { what: "the failure" })
  await waitFor(() => h.store.getQuestion(q2.id)!.status === "stale", { what: "the open card to expire" })
  expect(discussed(h, q.id)).toEqual(["why?", "Because."])
  expect(status(h, side.id)).toBe("ended")
})

test("the start sweep expires cards of dead sessions and ends their side chats", async () => {
  const h = await sideHarness(await fakeLlm())
  const dead = h.store.createSession(session({ status: "failed", cwd: h.folder }))
  const q = h.store.addQuestion(question(dead.id))
  const orphan = h.store.createSession(session({ kind: "side", status: "idle", question_id: q.id, cwd: h.folder }))
  h.store.updateQuestion(q.id, { side_session_id: orphan.id })
  h.office.cards!.sweep()
  expect(h.store.getQuestion(q.id)!.status).toBe("stale")
  await waitFor(() => status(h, orphan.id) === "ended", { what: "the orphaned side session to end" })
  expect(h.store.getQuestion(q.id)!.status).toBe("stale")
  // It has no run, so End can't reach it.
  expect(h.logs).toContain(`side session ${orphan.id} has no live run to end`)
})

test("a side chat stored starting at the sweep ends at once", async () => {
  const h = await sideHarness(await fakeLlm())
  const asker = h.store.createSession(session({ cwd: h.folder }))
  const q = h.store.addQuestion(question(asker.id))
  const side = h.store.createSession(session({ kind: "side", status: "starting", question_id: q.id, cwd: h.folder }))
  h.store.updateQuestion(q.id, { side_session_id: side.id })
  const end = spyOn(h.harness, "end")
  h.office.cards!.sweep()
  expect(status(h, side.id)).toBe("ended")
  expect(end).not.toHaveBeenCalled()
  expect(h.store.getQuestion(q.id)!.status).toBe("open")
})

test("a side chat resumes after an office restart", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Postgres scales." }, { content: "SQLite is simpler." })
  const { h, q } = await atTheGate(GATE, { fake })
  const side = await chat(h, q, "why Postgres?", 1)
  await h.reopen()
  expect(status(h, side.id)).toBe("idle") // left for the next office

  await h.harness.restore() // the harness's own start, then the extension's sweep
  h.office.cards!.sweep()
  // Asleep: the next message wakes it.
  expect([status(h, side.id), h.registry.get(side.id)]).toEqual(["idle", undefined])
  expect(h.store.getQuestion(q.id)!.status).toBe("open")
  await chat(h, q, "and SQLite?", 2)
  expect(await lastUser(fake, 2)).toBe("and SQLite?")
  expect(await framings(fake, 2)).toBe(1)
  const all = ["why Postgres?", "Postgres scales.", "and SQLite?", "SQLite is simpler."]
  await waitFor(() => JSON.stringify(discussed(h, q.id)) === JSON.stringify(all), { what: "the discussion" })
})

test("a restored or woken side chat keeps the cards run as its parent", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Postgres scales." }, { content: "SQLite is simpler." }, { content: "Either." })
  const { h, q } = await atTheGate(GATE, { fake })
  const side = await chat(h, q, "why Postgres?", 1)
  await h.reopen()
  await chat(h, q, "and SQLite?", 2) // woken: an advance of its recorded run
  await h.harness.end(side.id)
  await waitFor(() => status(h, side.id) === "ended", { what: "the side session to end" })
  await chat(h, q, "which then?", 3) // reopened: a fresh run
  const parent = { run_id: q.run_id, node: q.node_id }
  const jobs = h.jobs.filter((job) => job.session_id === side.id && job.advance !== false)
  const chats = jobs.filter((job) => job.kind === "chat")
  expect(chats.map((job) => job.parent)).toEqual([parent, parent])
  const runs = h.store.getSession(side.id)!.run_ids
  expect(chats.map((job) => job.run_id)).toEqual(runs)
  // The woken advance resumes the first run's log, which records its parent.
  const woken = jobs.filter((job) => job.kind === "advance" && job.run_id === runs[0])
  expect(woken.length).toBeGreaterThan(0)
  for (const job of woken) expect(job.log).toBe(chats[0]!.log)
  for (const job of chats) {
    const [started] = iterRunRecords(job.log, { payloads: true })
    expect(started!.kind).toBe("run_started")
    const record = started!.envelope.record as unknown as { parent: unknown }
    expect(record.parent).toEqual({ runId: q.run_id, node: q.node_id })
  }
})

test("a side session whose wake for its end fails stays failed", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Postgres scales." })
  const { h, q } = await atTheGate(GATE, { fake })
  const side = await chat(h, q, "why Postgres?", 1)
  await h.reopen() // not restored: the side session sleeps
  // Not private: its wake can't read the office's connection.
  fs.chmodSync(path.join(h.office.connections.dir, "office.json"), 0o644)
  await h.office.cards!.answer(q.id, GATE_ANSWER, "option")
  await waitFor(() => status(h, side.id) === "failed", { what: "the failed end" })
  await Bun.sleep(300)
  expect(status(h, side.id)).toBe("failed") // not relabelled ended
})

test("a card that closes while its side chat isnt running interrupts the side run", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  noLiveRun(h)
  h.store.answerQuestion(q.id, "Retry", "option", null)
  await waitFor(() => status(h, side.id) === "ended", { what: "the side chat's end" })
  const [row, ...rest] = h.store.runsOfSession(side.id)
  expect(rest).toEqual([])
  expect(row!.endReason).toBe(CARD_CLOSED)
  expect(CARD_CLOSED).toBe("its card closed while it wasn't running")
  await waitFor(() => recordKinds(h, row!.runId).includes("run_cancelled"), { what: "the side run's cancel" })
  expect(h.logs).toContain(`side session ${side.id} has no live run to end`)
})

test("a card that closes as its side chat registers leaves the side run alone", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  // Its 409 came just before a start stored the session starting again.
  const end = noLiveRun(h, (sid) => void h.store.updateSession(sid, notWaiting("starting")))
  const abandon = spyOn(h.harness, "abandon")
  h.store.answerQuestion(q.id, "Retry", "option", null)
  await h.office.cards!.close()
  expect(end).toHaveBeenCalledTimes(1)
  expect(abandon).not.toHaveBeenCalled()
  const [row] = h.store.runsOfSession(side.id)
  expect([status(h, side.id), row!.endReason]).toEqual(["starting", null])
  expect(h.logs.filter((line) => line.includes("no live run to end"))).toEqual([])
})

test("a closed cards side chat and its runs outcome commit together", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  noLiveRun(h)
  const endRun = h.store.endRun.bind(h.store)
  spyOn(h.store, "endRun").mockImplementation((runId: string, reason: string, at?: string) => {
    endRun(runId, reason, at)
    throw new Error("disk full")
  })
  h.store.answerQuestion(q.id, "Retry", "option", null)
  await h.office.cards!.close()
  const [row] = h.store.runsOfSession(side.id)
  expect([status(h, side.id), row!.endReason]).toEqual(["idle", null])
  expect(h.logs).toContain(`session ${side.id}: can't store the end (Error)`)
  expect(h.logs.filter((line) => line.includes("disk full"))).toEqual([])
})

test("a card that closes while its side chat finishes leaves the run finished", async () => {
  const fake = await fakeLlm()
  fake.script(ASK, { content: "Quota." })
  const h = await sideHarness(fake)
  const { q } = await ask(h)
  const side = await chat(h, q, "why?", 1)
  const ended = outcomes(h)
  // Inside the side run's own finish, before its end is stored, the card closes.
  h.hooks.endStatus.push((session) => {
    if (session.id === side.id) h.store.answerQuestion(q.id, "Retry", "option", null)
    return null
  })
  const abandon = spyOn(h.harness, "abandon")
  await h.harness.end(side.id) // the exit: the side run finishes on its own
  await waitFor(() => status(h, side.id) === "ended", { what: "the side chat's end" })
  await h.office.cards!.close()
  expect(abandon).not.toHaveBeenCalled()
  const [row] = h.store.runsOfSession(side.id)
  expect(row!.endReason).toBeNull()
  await waitFor(() => ended.length === 1, { what: "the run's end" })
  expect(ended[0]).toMatchObject({ status: "succeeded" })
})

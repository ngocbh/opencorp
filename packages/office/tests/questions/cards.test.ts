/** Card actions on the questions extension: through a stand-in for the session actor, and the chat's rows on the real
 *  chat harness (Python's `tests/questions/test_cards.py`). */
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { type Question, stamp } from "@opencorp/protocol"
import { Hooks } from "../../src/chat/hooks.ts"
import { HarnessError } from "../../src/chat/state.ts"
import type { Office } from "../../src/daemon/office.ts"
import { register } from "../../src/extensions/questions.ts"
import type { AnswerKind, CardActor, Cards } from "../../src/questions/cards.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import { InvalidTransition, type QuestionRecord, type Store } from "../../src/store/store.ts"
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
  status,
  texts,
} from "../chat/helpers.ts"
import { makeOffice, standInHarness } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import { question, session } from "../store/helpers.ts"

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

/** A harness whose minh runs `gate` as his main flow, with the questions extension, and minh's session waiting at its
 *  card; with `asleep`, the harness is closed and a new one (not restored) has the session. */
async function atTheGate(gate = GATE, { asleep = false } = {}) {
  const h = await makeHarness(await fakeLlm(), { files: { ...GATE_FILES, "people/minh/gate.yaml": gate }, questions: true })
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

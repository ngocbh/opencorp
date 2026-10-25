/** Question routes. */
import { expect, test } from "bun:test"
import type { Question } from "@opencorp/protocol"
import { newToken } from "../../src/auth/tokens.ts"
import { Hooks } from "../../src/chat/hooks.ts"
import { HarnessError } from "../../src/chat/state.ts"
import type { Office } from "../../src/daemon/office.ts"
import { register } from "../../src/extensions/questions.ts"
import { CodexSessions } from "../../src/harness/sessions.ts"
import type { AnswerKind, CardActor, Cards } from "../../src/questions/cards.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import { InvalidTransition, type QuestionRecord, type Store } from "../../src/store/store.ts"
import { question, recordEvents, session } from "../store/helpers.ts"
import { CEO, type Reply, addHuman, bearer, giveDevice, makeOffice, request, served, standInHarness, ULID } from "./helpers.ts"

// The same stand-in for the session harness as tests/questions/cards.test.ts, less the knobs these tests leave unused;
// no test here interrupts a session.
class StandIn implements CardActor {
  readonly hooks: Hooks
  readonly answered: [string, unknown, AnswerKind, string | null][] = []

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
    try {
      return this.store.answerQuestion(id, value, kind, by)
    } catch (error) {
      if (error instanceof InvalidTransition) throw new HarnessError(409, "not_open", error.message)
      throw error
    }
  }

  async interrupt(_sessionId: string): Promise<void> {
    throw new Error("interrupt is not used by these tests")
  }
}

/** The office with the stand-in as its harness and the questions extension registered (Python's `cards`). */
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
function openQuestion(office: Office, over?: Partial<Question>): QuestionRecord {
  const s = office.store.createSession(session())
  return office.store.addQuestion(question(s.id, over))
}

/** Bearer headers for a new device of a new human, ava. */
function avaHeaders(office: Office): Record<string, string> {
  addHuman(office.paths.company, "ava")
  const token = newToken()
  giveDevice(office.paths.company, "ava", "pc", token)
  return bearer(token)
}

/** POSTs `body` as JSON, or nothing when it is null. */
function post(sock: string, target: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  if (body === null) return request(sock, "POST", target, { headers })
  return request(sock, "POST", target, {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

function errorOf(r: Reply): string {
  return (r.json() as { error: string }).error
}

function ids(r: Reply): string[] {
  expect(r.status).toBe(200)
  return (r.json() as { id: string }[]).map((q) => q.id)
}

const CARD_ACTIONS: [string, string, unknown][] = [
  ["side", `/questions/${ULID}/side`, { text: "why?" }],
  ["send-back", `/questions/${ULID}/send-back`, { note: "more" }],
  ["stop", `/questions/${ULID}/stop`, null],
  ["carried/dismiss", `/questions/${ULID}/carried/dismiss`, null],
]

test.each(CARD_ACTIONS)("card actions need the cards extension [%s]", async (_case, target, body) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await post(sock, target, body)
  expect([r.status, errorOf(r)]).toEqual([501, "not_implemented"])
})

test.each(CARD_ACTIONS)("card actions on a missing question are 404 [%s]", async (_case, target, body) => {
  const office = makeOffice()
  wire(office)
  const { sock } = await served(office)
  const r = await post(sock, target, body)
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
})

test.each([
  ["side empty text", `/questions/${ULID}/side`, { text: "" }],
  ["side no text", `/questions/${ULID}/side`, {}],
  ["send-back no note", `/questions/${ULID}/send-back`, {}],
  ["send-back extra field", `/questions/${ULID}/send-back`, { note: "x", extra: 1 }],
])("bad card action bodies are 422 [%s]", async (_case, target, body) => {
  const office = makeOffice()
  wire(office)
  const { sock } = await served(office)
  const r = await post(sock, target, body)
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
})

test("dismiss a carried discussion", async () => {
  const office = makeOffice()
  wire(office)
  const { sock } = await served(office)
  const s = office.store.createSession(session())
  const old = office.store.addQuestion(question(s.id))
  const q = office.store.addQuestion(question(s.id))
  office.store.updateQuestion(q.id, { carried_from: old.id })
  const r = await post(sock, `/questions/${q.id}/carried/dismiss`, null)
  expect(r.status).toBe(200)
  expect((r.json() as { carried_from: string | null }).carried_from).toBeNull()
})

test("list questions by session and status", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const s1 = office.store.createSession(session())
  const s2 = office.store.createSession(session())
  const a = office.store.addQuestion(question(s1.id))
  const b = office.store.addQuestion(question(s1.id))
  const c = office.store.addQuestion(question(s2.id))
  office.store.answerQuestion(b.id, "yes", "text")
  const get = async (query: string) => ids(await request(sock, "GET", `/questions${query}`))
  expect(await get("")).toEqual([a.id, b.id, c.id])
  expect(await get(`?session=${s1.id}`)).toEqual([a.id, b.id])
  expect(await get(`?session=${s1.id}&status=open`)).toEqual([a.id])
  expect(await get("?status=open")).toEqual([a.id, c.id])
  const both = [a.id, b.id, c.id]
  expect(await get("?status=open%2Canswered")).toEqual(both)
  expect(await get("?status=open&status=answered")).toEqual(both)
})

test("list questions strips statuses and ignores an empty session", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const a = openQuestion(office)
  const b = openQuestion(office)
  office.store.answerQuestion(b.id, "yes", "text")
  expect(ids(await request(sock, "GET", "/questions?status=+open+%2C+answered+"))).toEqual([a.id, b.id])
  expect(ids(await request(sock, "GET", "/questions?session=&status=open"))).toEqual([a.id])
})

test("list questions with an unknown status or session is empty", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  openQuestion(office)
  expect(ids(await request(sock, "GET", "/questions?status=pondering"))).toEqual([])
  expect(ids(await request(sock, "GET", `/questions?session=${ULID}`))).toEqual([])
})

test("get question", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const q = openQuestion(office)
  const r = await request(sock, "GET", `/questions/${q.id}`)
  expect(r.status).toBe(200)
  expect((r.json() as { status: string }).status).toBe("open")
})

test("missing question is 404", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  expect((await request(sock, "GET", `/questions/${ULID}`)).status).toBe(404)
  const r = await post(sock, `/questions/${ULID}/answer`, { answer: 1, answer_kind: "text" })
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
})

test("a plain answer is credited to the verified person", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const ava = avaHeaders(office)
  const q = openQuestion(office)
  const r = await post(sock, `/questions/${q.id}/answer`, { answer: "a", answer_kind: "text" }, ava)
  expect(r.status).toBe(200)
  expect((r.json() as { answered_by: string }).answered_by).toBe("ava")
})

test("answer then second answer is 409", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const q = openQuestion(office)
  const events = recordEvents(office.store)
  const r = await post(sock, `/questions/${q.id}/answer`, { answer: null, answer_kind: "text" })
  expect(r.status).toBe(200)
  expect(r.json()).toMatchObject({ status: "answered", answer: null })
  expect(events.at(-1)!.type).toBe("question.updated")
  const again = await post(sock, `/questions/${q.id}/answer`, { answer: "b", answer_kind: "option" })
  expect([again.status, errorOf(again)]).toEqual([409, "not_open"])
})

test.each([
  ["sent_back kind", JSON.stringify({ answer: 1, answer_kind: "sent_back" })],
  ["no answer", JSON.stringify({ answer_kind: "text" })],
  ["not json", "not json"],
])("bad answer body is 422 [%s]", async (_case, body) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const q = openQuestion(office)
  const r = await request(sock, "POST", `/questions/${q.id}/answer`, {
    headers: { "content-type": "application/json" },
    body,
  })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
})

test("an answer goes through the cards and is credited to the verified person", async () => {
  const office = makeOffice()
  const { actor } = wire(office)
  const { sock } = await served(office, { tokens: true })
  const ava = avaHeaders(office)
  const q = openQuestion(office, { options: ["Retry", "Back off"] })
  let r = await post(sock, `/questions/${q.id}/answer`, { answer: "Maybe", answer_kind: "option" }, ava)
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_answer"])
  r = await post(sock, `/questions/${q.id}/answer`, { answer: "Back off", answer_kind: "option" }, ava)
  expect(r.status).toBe(200)
  expect((r.json() as { answered_by: string }).answered_by).toBe("ava")
  expect(actor.answered).toEqual([[q.id, "Back off", "option", "ava"]])
})

test("an answer goes to the harness when there are no cards", async () => {
  const office = makeOffice()
  const actor = new StandIn(office.store)
  office.harness = standInHarness({
    hooks: actor.hooks,
    answer: actor.answer.bind(actor),
    interrupt: actor.interrupt.bind(actor),
  })
  const { sock } = await served(office)
  const q = openQuestion(office)
  const r = await post(sock, `/questions/${q.id}/answer`, { answer: "Postgres", answer_kind: "text" })
  expect(r.status).toBe(200)
  expect(actor.answered).toEqual([[q.id, "Postgres", "text", CEO]])
})

test("an answer to a codex card codex no longer waits on is 200 and stale", async () => {
  const office = makeOffice()
  office.harness = new CodexSessions(office, new Hooks({ log: () => {} }), {
    command: () => {
      throw new Error("no app-server in this test")
    },
  })
  register(office)
  const s = office.store.createSession(session({ harness: "codex", status: "idle", opened_by: CEO }))
  const q = office.store.addQuestion(question(s.id, { source: "harness", options: ["Approve", "Deny"] }))
  const { sock } = await served(office)
  const r = await post(sock, `/questions/${q.id}/answer`, { answer: "Approve", answer_kind: "option" })
  expect(r.status).toBe(200)
  expect(r.json()).toMatchObject({ status: "stale", answer: null })
})

test("stop is credited to the verified person", async () => {
  const office = makeOffice()
  const { actor } = wire(office)
  const { sock } = await served(office, { tokens: true })
  const ava = avaHeaders(office)
  const q = openQuestion(office, { source: "ask_manager" })
  const r = await post(sock, `/questions/${q.id}/stop`, null, ava)
  expect(r.status).toBe(200)
  expect(r.json()).toMatchObject({ answer_kind: "interrupted", answered_by: "ava" })
  expect(actor.answered).toEqual([[q.id, INTERRUPTED, "interrupted", "ava"]])
})

test("a secret pages refused answer is not echoed", async () => {
  const SECRET = "sk-PLANTED-0123456789"
  const lines: string[] = []
  const office = makeOffice({ log: (line) => lines.push(line) })
  wire(office, (line) => lines.push(line))
  const { sock } = await served(office, { log: (line) => lines.push(line) })
  const q = openQuestion(office, {
    source: "ask",
    node_id: "p",
    questions: [{ question: "PIN?", header: "pin", options: [], secret: true }],
    answer_schema: [{ name: "pin", type: "int", required: true }],
  })
  const r = await post(sock, `/questions/${q.id}/answer`, { answer: { pin: SECRET }, answer_kind: "option" })
  expect([r.status, r.json()]).toEqual([422, { error: "invalid_answer", message: "'pin' must be a whole number" }])
  expect(r.text).not.toContain(SECRET)
  expect(lines.filter((line) => line.includes(SECRET))).toEqual([])
})

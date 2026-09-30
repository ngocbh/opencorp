import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../../script/stub"
import { createOfficeClient } from "../../../src/office/client"
import { until } from "../../fixture/until"

let office: FakeOffice
afterEach(() => office?.stop())
const client = () => createOfficeClient({ socket: office.socket })
/** The error `p` rejects with; fails the test if it resolves. */
const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )
const status = async (id: string) => (await client().sessions.get(id)).status

test("the seeded idle session has an open turn; a prompt answers it; while busy it steers", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  const turns: string[] = []
  office.onPrompt((_, req) => turns.push(req.text))
  const [turn] = await client().questions.list({ session: id, status: ["open"] })
  expect([turn.source, turn.node_id]).toEqual(["human_input", "chat#1/ask"])
  await client().sessions.prompt(id, { text: "fix it" })
  expect(office.state.questions[turn.id]).toMatchObject({ status: "answered", answer: "fix it", answer_kind: "text" })
  expect(await status(id)).toBe("busy")
  await client().sessions.prompt(id, { text: "use a fake clock" })
  expect(turns).toEqual(["fix it"])
  expect(office.state.messages[id].map((m) => m.parts[0])).toMatchObject([
    { text: "fix it" },
    { text: "use a fake clock" },
  ])
})

test("a new session is starting; it goes idle when its first turn opens", async () => {
  office = createFakeOffice()
  const s = await client().sessions.create({ person: "minh", cwd: "/tmp/proj" })
  expect(s.status).toBe("starting")
  await until(() => office.state.sessions.find((x) => x.id === s.id)?.status === "idle")
  const turns = await client().questions.list({ session: s.id, status: ["open"] })
  expect(turns.map((q) => [q.source, q.node_id])).toEqual([["human_input", "chat#1/ask"]])
})

test("interrupt answers the open ask_user questions; the session stays busy until its next turn opens", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  const interrupts: string[] = []
  office.onInterrupt((sid) => interrupts.push(sid))
  await client().sessions.prompt(id, { text: "go" })
  const asked = office.addQuestion({ session_id: id, source: "ask_user" })
  await client().sessions.interrupt(id)
  expect(await status(id)).toBe("busy")
  expect(interrupts).toEqual([id])
  expect(office.state.questions[asked.id]).toMatchObject({ status: "answered", answer_kind: "interrupted" })
  expect(office.openTurn(id).node_id).toBe("chat#2/ask")
  expect(await status(id)).toBe("idle")
})

test("a prompt with no open turn and no reply running is queued; the next turn takes the queue", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  const turns: string[] = []
  office.onPrompt((_, req) => turns.push(req.text))
  await client().sessions.prompt(id, { text: "go" })
  // The reply ended; the next turn has not opened yet.
  office.setStatus(id, "idle")
  await client().sessions.prompt(id, { text: "one" })
  await client().sessions.prompt(id, { text: "two" })
  expect(await status(id)).toBe("idle")
  expect(turns).toEqual(["go"])
  const texts = office.state.messages[id].map((m) => m.parts[0])
  expect(texts).toMatchObject([{ text: "go" }, { text: "one" }, { text: "two" }])
  const next = office.openTurn(id)
  expect(office.state.questions[next.id]).toMatchObject({ status: "answered", answer: "one\n\ntwo" })
  expect(await status(id)).toBe("busy")
  expect(turns).toEqual(["go", "one\n\ntwo"])
})

test("an answer the question doesn't take is 422 invalid_answer", async () => {
  office = createFakeOffice()
  const invalid = async (id: string, req: any) => {
    const e = await failure(client().questions.answer(id, req))
    return [e.status, e.code]
  }
  const asked = office.addQuestion({ options: ["yes", "no"] })
  expect(await invalid(asked.id, { answer: "maybe", answer_kind: "option" })).toEqual([422, "invalid_answer"])
  expect(await invalid(asked.id, { answer: " ", answer_kind: "text" })).toEqual([422, "invalid_answer"])
  expect(await invalid(asked.id, { answer: { a: 1 }, answer_kind: "text" })).toEqual([422, "invalid_answer"])
  const pages = office.addQuestion({
    source: "human_input",
    node_id: "release",
    questions: [
      { question: "Which channel?", header: "Channel", options: [{ label: "beta" }, { label: "stable" }] },
      { question: "Targets?", header: "Targets", multi_select: true, options: [{ label: "linux" }, { label: "mac" }] },
    ],
  })
  for (const answer of [
    "beta",
    { Channel: "beta" },
    { Channel: "beta", Targets: "linux" },
    { Channel: ["beta"], Targets: [] },
    { Channel: "beta", Targets: [], Other: "x" },
  ])
    expect(await invalid(pages.id, { answer, answer_kind: "option" })).toEqual([422, "invalid_answer"])
  expect(office.state.questions[pages.id].status).toBe("open")
  const record = { Channel: "beta", Targets: [] }
  expect((await client().questions.answer(pages.id, { answer: record, answer_kind: "option" })).status).toBe("answered")
  expect((await client().questions.answer(asked.id, { answer: "yes", answer_kind: "option" })).status).toBe("answered")
})

test("end goes ending, then debriefing; prompts are refused from the start", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  await client().sessions.end(id)
  expect(await status(id)).toBe("ending")
  const ending = await failure(client().sessions.prompt(id, { text: "hi" }))
  expect([ending.status, ending.code]).toEqual([409, "ending"])
  await client().sessions.end(id)
  await until(() => office.state.sessions[0].status === "debriefing")
  const over = await failure(client().sessions.prompt(id, { text: "hi" }))
  expect([over.status, over.code]).toEqual([409, "not_live"])
  const again = await failure(client().sessions.end(id))
  expect([again.status, again.code]).toEqual([409, "not_live"])
})

test("one side session per question: it records the discussion, refuses exit words, and ends with it", async () => {
  office = createFakeOffice()
  const q = office.addQuestion({ question: "Retry?", options: ["yes", "no"] })
  const side = await client().questions.side(q.id, { text: "why retry?" })
  expect([side.kind, side.question_id, side.person, side.status]).toEqual(["side", q.id, "minh", "busy"])
  expect(office.state.questions[q.id].side_session_id).toBe(side.id)
  await client().sessions.interrupt(side.id)
  await client().sessions.prompt(side.id, { text: "and backoff?" })
  office.setStatus(side.id, "ended")
  expect((await client().questions.side(q.id, { text: "still there?" })).id).toBe(side.id)
  expect(await status(side.id)).toBe("busy")
  expect(office.state.questions[q.id].discussion).toEqual([
    { role: "user", text: "why retry?" },
    { role: "user", text: "and backoff?" },
    { role: "user", text: "still there?" },
  ])
  for (const call of ["/end", "/EXIT", " /quit "].flatMap((text) => [
    client().sessions.prompt(side.id, { text }),
    client().questions.side(q.id, { text }),
  ])) {
    const e = await failure(call)
    expect([e.status, e.code, e.message]).toEqual([422, "refused", "use /back to return to the question"])
  }
  await client().questions.answer(q.id, { answer: "yes", answer_kind: "option" })
  expect(await status(side.id)).toBe("ended")
})

test("send back needs a discussion; neither send back nor stop is offered on human_input", async () => {
  office = createFakeOffice()
  const plain = office.addQuestion({ question: "Retry?" })
  const none = await failure(client().questions.sendBack(plain.id, { note: "" }))
  expect([none.status, none.code]).toEqual([422, "no_discussion"])
  office.state.questions[plain.id].discussion = [{ role: "user", text: "why?" }]
  expect(await client().questions.sendBack(plain.id, { note: "try the fake clock" })).toMatchObject({
    status: "answered",
    answer: null,
    answer_kind: "sent_back",
    discussion: [
      { role: "user", text: "why?" },
      { role: "user", text: "try the fake clock" },
    ],
  })
  const carried = office.addQuestion({ carried_from: plain.id })
  expect((await client().questions.sendBack(carried.id, { note: "" })).answer_kind).toBe("sent_back")
  const gate = office.addQuestion({
    source: "human_input",
    node_id: "review",
    discussion: [{ role: "user", text: "?" }],
  })
  const noSendBack = await failure(client().questions.sendBack(gate.id, { note: "" }))
  expect([noSendBack.status, noSendBack.code]).toEqual([422, "cannot_send_back"])
  const noStop = await failure(client().questions.stop(gate.id))
  expect([noStop.status, noStop.code]).toEqual([422, "cannot_stop"])
})

test("stopping a busy chat's ask_user is Esc on that chat: every open ask_user in its run is interrupted", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  const interrupts: string[] = []
  office.onInterrupt((sid) => interrupts.push(sid))
  await client().sessions.prompt(id, { text: "go" })
  const asked = office.addQuestion({ session_id: id, source: "ask_user" })
  const also = office.addQuestion({ session_id: id, source: "ask_user" })
  const otherRun = office.addQuestion({ session_id: id, source: "ask_user", run_id: "run-0" })
  expect(await client().questions.stop(asked.id)).toMatchObject({
    answer: "[interrupted by the user]",
    answer_kind: "interrupted",
  })
  expect(office.state.questions[also.id]).toMatchObject({ status: "answered", answer_kind: "interrupted" })
  expect(office.state.questions[otherRun.id].status).toBe("open")
  expect(interrupts).toEqual([id])
  // As with Esc, the chat stays busy until its next turn opens.
  expect(await status(id)).toBe("busy")
  const again = await failure(client().questions.stop(asked.id))
  expect([again.status, again.code]).toEqual([409, "not_open"])
})

test("dismissing a carried discussion clears carried_from on an open question", async () => {
  office = createFakeOffice()
  const earlier = office.addQuestion({ status: "stale", discussion: [{ role: "user", text: "why?" }] })
  const q = office.addQuestion({ carried_from: earlier.id })
  expect((await client().questions.dismissCarried(q.id)).carried_from).toBeNull()
  expect(office.state.questions[q.id].carried_from).toBeNull()
  const closed = await failure(client().questions.dismissCarried(earlier.id))
  expect([closed.status, closed.code]).toEqual([409, "not_open"])
  const missing = await failure(client().questions.dismissCarried("nope"))
  expect(missing.status).toBe(404)
})

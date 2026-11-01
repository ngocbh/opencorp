/** The run state the session actor writes: waiting (and on whom), busy, idle (Python's
 *  `tests/chat/test_waiting.py`). */
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { now, Question } from "@opencorp/protocol"
import { SessionActor } from "../../src/chat/session_actor.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import { newId, type QuestionRecord } from "../../src/store/store.ts"
import { CEO } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  ASK_MANAGER,
  ASK_USER,
  ASKED,
  asleep,
  capItem,
  capGate,
  card,
  type ChatOffice,
  chatOffice,
  fakeLlm,
  GATE_ANSWER,
  GATE_FILES,
  free,
  KAI,
  LAN,
  makeActor,
  makeHarness,
  newSession,
  noWorkersLeft,
  PRICES,
  PRICEY,
  reopen,
  say,
  type ScriptedWorker,
  scriptedWorker,
  session,
  startActor,
  state,
  status,
  texts,
  unreadAtRestart,
  waitingResult,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Session `sid`'s status and who it waits on. */
function waits(o: ChatOffice, sid: string): [string, string[]] {
  const { status, waiting_on } = state(o, sid)
  return [status, waiting_on]
}

/** Records each status session `sid` is written with from now on, a repeat of the one before left out. */
function statusesOf(o: ChatOffice, sid: string): string[] {
  const seen: string[] = []
  onTestFinished(
    o.office.store.addListener((event) => {
      const data = event.data as { id?: string; status?: string }
      if (event.type === "session.updated" && data.id === sid && data.status !== seen.at(-1)) seen.push(data.status!)
    }),
  )
  return seen
}

/** Tells the actor over scripted worker `w` of node `nodeId`'s event `name`, with `data` on top. */
function frame(w: ScriptedWorker, name: string, nodeId: string, data: Record<string, unknown> = {}): void {
  w.handlers.event(w.worker, { type: "event", name, data: { node_id: nodeId, ...data } })
}

/** Turn `i`'s first frames as the chat flow sends them: its take waits at once, while its context (compact_history's
 *  call containers, its case, its fold skipped under budget) runs beside it. */
function nextTurn(w: ScriptedWorker, i: number): void {
  frame(w, "NodeStarted", `chat#${i}/context`)
  frame(w, "NodeStarted", `chat#${i}/heard`)
  frame(w, "NodeWaiting", `chat#${i}/heard`, { call_ids: [`c${i}`] })
  frame(w, "NodeExpanded", `chat#${i}/context`)
  frame(w, "NodeStarted", `chat#${i}/context/compacted`)
  frame(w, "NodeExpanded", `chat#${i}/context/compacted`)
  frame(w, "NodeStarted", `chat#${i}/context/compacted/over`)
  frame(w, "NodeRouted", `chat#${i}/context/compacted/over`)
  frame(w, "NodeSkipped", `chat#${i}/context/compacted/folded`)
}

/** Stores an open question at node `gate` of session `sid`'s run, as a flow's question beside the turn. */
function besideTheTurn(o: ChatOffice, sid: string): void {
  const t = now()
  o.office.store.addQuestion(
    Question.parse({
      id: newId(),
      session_id: sid,
      run_id: session(o, sid).run_ids.at(-1)!,
      node_id: "gate",
      source: "ask",
      asker: "minh",
      question: "Which db?",
      status: "open",
      created_at: t,
      updated_at: t,
    }),
  )
}

/** Starts minh's gate flow; returns its actor, the session id and its open card once it waits there. */
async function atTheGate(o: ChatOffice): Promise<{ actor: SessionActor; sid: string; q: QuestionRecord }> {
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const q = await card(o, sid, "ask")
  // Starting moves straight to waiting.
  await waitFor(() => JSON.stringify(waits(o, sid)) === JSON.stringify(["waiting", [CEO]]), {
    what: "waiting at the node",
  })
  return { actor, sid, q }
}

test("settle gives idle at the turn and busy while a live run has no turn", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  // A starting session stays starting until its run shows its turn.
  expect(status(o, sid)).toBe("starting")
  const { worker, handlers } = workers[0]!
  const waitsAtTurn = { type: "event", name: "NodeWaiting", data: { node_id: "chat#0/heard", call_ids: ["c1"] } }
  handlers.event(worker, waitsAtTurn)
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  actor.settle()
  expect(state(o, sid)).toEqual({ status: "idle", waiting_on: [], capped: false })
  // The take has a message: the live run is no longer at its turn.
  handlers.event(worker, { type: "event", name: "NodeWoken", data: { node_id: "chat#0/heard" } })
  await waitFor(() => status(o, sid) === "busy", { what: "busy once the turn is taken" })
  actor.settle()
  expect(state(o, sid)).toEqual({ status: "busy", waiting_on: [], capped: false })
  handlers.event(worker, { type: "event", name: "NodeSucceeded", data: { node_id: "chat#0/heard" } })
  handlers.event(worker, { ...waitsAtTurn, data: { node_id: "chat#1/heard", call_ids: ["c2"] } })
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the next turn" })
})

test("the turn alone is idle and a running reply is busy", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "slow", hold: true })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  expect(status(o, sid)).toBe("busy")
  // Held only once it arrives.
  await fake.waitForRequests(1, 30_000)
  fake.release()
  await waitFor(() => {
    const now = state(o, sid)
    return now.status === "idle" && now.waiting_on.length === 0
  }, { what: "idle again" })
})

test("history compaction beside the waiting take leaves the session idle", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  const seen = statusesOf(o, sid)
  await actor.start()
  const w = workers[0]!
  nextTurn(w, 0)
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  frame(w, "NodeWoken", "chat#0/heard")
  frame(w, "NodeSucceeded", "chat#0/heard")
  frame(w, "NodeStarted", "chat#0/reply")
  frame(w, "NodeSucceeded", "chat#0/reply")
  nextTurn(w, 1)
  await waitFor(() => session(o, sid).turns === 1 && status(o, sid) === "idle", { what: "idle at the next turn" })
  // One idle per turn: the compaction nodes starting and finishing beside the take don't flip it.
  expect(seen).toEqual(["starting", "idle", "busy", "idle"])
})

test("a chat writes busy once and idle once per turn, its history compaction included", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const sid = await newSession(o)
  const seen = statusesOf(o, sid)
  const actor = makeActor(o, sid)
  await actor.start()
  // The worker parks on the run's waiting result, which comes after every frame of the turn's compaction. Each
  // message waits for it: one sent as the run suspends is carried to the next job, a blip this row doesn't pin.
  const parked = () => waitFor(() => status(o, sid) === "idle" && !actor.hasWorker, { what: "the worker to park" })
  await parked()
  expect(await say(o, actor, sid, "a")).toBe("one")
  await parked()
  expect(await say(o, actor, sid, "b")).toBe("two")
  await parked()
  expect(seen).toEqual(["starting", "idle", "busy", "idle", "busy", "idle"])
})

test("an answered question goes from waiting straight to busy", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting" && !actor.hasWorker, { what: "asleep on the question" })
  const seen = statusesOf(o, sid)
  await actor.answer(q.id, "A", "option")
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the reply",
  })
  expect(seen).toEqual(["busy", "idle"])
})

test("an answer held until the worker that asked exits reads busy", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const callId = `${runId}/c1`
  const { worker, handlers } = workers[0]!
  await handlers.askUser(worker, { ...ASKED, options: ["A", "B"] }, callId)
  const asked = { node: "chat#0/reply", call_id: callId, tool: "ask_user", inbox: null, deadline: null, settled: false }
  handlers.result(worker, waitingResult(runId, [asked]))
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting", { what: "waiting on the question" })
  await actor.answer(q.id, "A", "option")
  // Its worker hasn't exited yet: the answer waits for the job after it, which is sure to come.
  expect(status(o, sid)).toBe("busy")
  handlers.exited(worker, 0)
  await waitFor(() => workers.length === 2, { what: "the job that delivers it" })
  expect(workers[1]!.job.deliver).toMatchObject([{ op: "complete", call_id: callId }])
})

test("a first message taken at the start reads busy through its reply and an interrupt", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "slow", hold: true })
  const o = await chatOffice(fake)
  const sid = await newSession(o)
  const seen = statusesOf(o, sid)
  const actor = makeActor(o, sid)
  // Not awaited in between: the message is queued as the session starts, as the TUI's home sends it.
  const started = actor.start()
  const sent = actor.prompt("hi")
  await started
  expect(await sent).toBe("queued")
  await fake.waitForRequests(1, 30_000)
  // The model can get the request before the actor handles the reply's start.
  await waitFor(() => status(o, sid) === "busy", { what: "busy in the first reply" })
  await actor.interrupt()
  // The held model call is still to end, and the reply with it.
  expect(status(o, sid)).toBe("busy")
  fake.release()
  await waitFor(() => status(o, sid) === "idle" && !actor.hasWorker, { what: "idle at the next turn" })
  expect(seen).toEqual(["starting", "busy", "idle"])
})

test("a first turn's reply moves a starting session to busy", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const w = workers[0]!
  frame(w, "NodeStarted", "chat#0/heard")
  frame(w, "NodeSucceeded", "chat#0/heard")
  // Taken straight away, the turn never showed: the session still reads starting.
  actor.settle()
  expect(status(o, sid)).toBe("starting")
  frame(w, "NodeStarted", "chat#0/reply")
  await waitFor(() => status(o, sid) === "busy", { what: "busy once the reply runs" })
})

test("ask user waits on the opener else the pinned ceo", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake, { files: LAN })
  const a = await startActor(o, { openedBy: "lan" })
  await a.actor.prompt("hi")
  await card(o, a.sid, "ask_user")
  await waitFor(() => JSON.stringify(waits(o, a.sid)) === JSON.stringify(["waiting", ["lan"]]), {
    what: "waiting on lan",
  })
  const b = await startActor(o)
  await b.actor.prompt("hi")
  await card(o, b.sid, "ask_user")
  await waitFor(() => JSON.stringify(waits(o, b.sid)) === JSON.stringify(["waiting", [CEO]]), {
    what: "waiting on the CEO",
  })
  // The answer.
  expect(await a.actor.prompt("A")).toBe("answer")
  await waitFor(() => status(o, a.sid) !== "waiting" && state(o, a.sid).waiting_on.length === 0, {
    what: "no longer waiting",
  })
})

test("ask manager waits on its items assignee even an agent", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_MANAGER)
  const o = await chatOffice(fake, { files: KAI })
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  await card(o, sid, "ask_manager")
  await waitFor(() => JSON.stringify(waits(o, sid)) === JSON.stringify(["waiting", ["kai"]]), {
    what: "waiting on kai",
  })
})

test("settle waits on the ceo for a question beside the turn", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  besideTheTurn(o, sid)
  actor.settle()
  // No opener: the pinned CEO.
  expect(waits(o, sid)).toEqual(["waiting", [CEO]])
})

test("a question beside the open turn is waiting", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const { worker, handlers } = workers[0]!
  handlers.event(worker, { type: "event", name: "NodeWaiting", data: { node_id: "chat#0/heard", call_ids: ["c1"] } })
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  // The run asks beside the open turn: stored through the actor, which settles.
  await handlers.askUser(worker, { ...ASKED, question: "Which db?" }, `${actor.runId}/c2`)
  await waitFor(() => JSON.stringify(waits(o, sid)) === JSON.stringify(["waiting", [CEO]]), { what: "waiting" })
})

test("a gate flow waits at its node from starting", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { files: GATE_FILES })
  const { q } = await atTheGate(o)
  expect([q.source, q.node_id]).toEqual(["ask", "setup"])
})

test("a session waiting at a question node sleeps and an answer wakes it to the node", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { files: GATE_FILES })
  const first = await atTheGate(o)
  const actor = await reopen(o, first.actor)
  const { sid, q } = first
  expect(o.office.store.getQuestion(q.id)!.status).toBe("open")
  expect(waits(o, sid)).toEqual(["waiting", [CEO]])
  const before = o.kinds.length
  const answered = await actor.answer(q.id, GATE_ANSWER, "option", { by: CEO })
  expect([answered.status, answered.answer]).toEqual(["answered", GATE_ANSWER])
  // The answer goes back by complete on a new advance, which runs the flow past its node.
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === "consumed", { what: "the answer taken" })
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  const complete = { op: "complete", call_id: q.call_id, result: { output: GATE_ANSWER } }
  expect(o.jobs.at(-1)!.deliver).toMatchObject([complete])
  // Past its node the gate flow is done.
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
})

test("esc answers an ask manager card interrupted and closes its item", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_MANAGER, { content: "spare" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_manager")
  await waitFor(() => JSON.stringify(waits(o, sid)) === JSON.stringify(["waiting", [CEO]]), {
    what: "waiting on the manager",
  })
  await actor.interrupt()
  // Answered by the closed call before Esc returns.
  const got = o.office.store.getQuestion(q.id)!
  expect([got.status, got.answer, got.answer_kind]).toEqual(["consumed", INTERRUPTED, "interrupted"])
  // Answered, not stale, so the cards carry none of its discussion into a later card.
  await waitFor(() => o.office.store.getWorkItem(q.work_item_id!)!.status === "done", { what: "the item closed" })
  await waitFor(() => status(o, sid) !== "waiting", { what: "no longer waiting" })
})

test("ending a waiting session clears waiting on", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "spare" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting", { what: "waiting" })
  await actor.end()
  await waitFor(() => JSON.stringify(waits(o, sid)) === JSON.stringify(["ended", []]), { what: "the end" })
})

test("a failed waiting session waits on no one", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const sid = await newSession(o)
  o.office.store.updateSession(sid, { status: "waiting", waiting_on: [CEO], capped: true })
  await makeActor(o, sid).fail()
  expect(state(o, sid)).toEqual({ status: "failed", waiting_on: [], capped: false })
})

test("settle leaves a session whose finish is in flight", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const { worker, handlers } = workers[0]!
  const succeeded = { type: "result", status: "succeeded", run_id: actor.runId, output: null, failure: null, waits: [] }
  handlers.result(worker, succeeded)
  handlers.exited(worker, 0)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  // The finish stored the end; a settle after it leaves it.
  actor.settle()
  expect(state(o, sid)).toEqual({ status: "ended", waiting_on: [], capped: false })
})

test("settle holds a session over its cap on its manager", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  // Over the company's $5.
  o.office.store.updateSession(sid, { cost: 6 })
  actor.settle()
  expect(state(o, sid)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
})

test("the cost hold waits on the cap item then the manager and raising the cap frees it", async () => {
  const fake = await fakeLlm()
  fake.script(PRICEY, free("done"), free("spare"))
  const gate = capGate()
  const o = await chatOffice(fake, { prices: PRICES, files: LAN, groups: gate.groups })
  const { actor, sid } = await startActor(o)
  gate.watch(o)
  await actor.prompt("hi")
  // Held from the charge on: the reply's worker is stopped, not interrupted, and its run waits for a raise.
  const held = JSON.stringify(["waiting", [CEO]])
  await waitFor(() => capItem(o) !== undefined && !actor.hasWorker && JSON.stringify(waits(o, sid)) === held, {
    what: "the hold",
  })
  expect(gate.stops()).toBe(1)
  expect(session(o, sid)).toMatchObject({ capped: true, turns: 0 })
  o.office.store.updateWorkItem(capItem(o)!.id, { assignee: "lan" })
  actor.settle()
  expect(waits(o, sid)).toEqual(["waiting", ["lan"]])
  // Closed some other way: the cost is still over the cap.
  o.office.store.updateWorkItem(capItem(o)!.id, { status: "done" })
  actor.settle()
  // The manager at the pinned commit.
  expect(waits(o, sid)).toEqual(["waiting", [CEO]])
  await actor.setCostCap(20)
  // The raise advances the stopped reply, which then finishes once.
  await waitFor(() => status(o, sid) === "idle" && !actor.hasWorker, { what: "idle after the raise" })
  expect(session(o, sid)).toMatchObject({ capped: false, turns: 1 })
})

test("raising the cap of a sleeping session frees it without a worker", async () => {
  const fake = await fakeLlm()
  fake.script(PRICEY, free("done"), free("spare"))
  const gate = capGate()
  const o = await chatOffice(fake, { prices: PRICES, groups: gate.groups })
  const first = await startActor(o)
  gate.watch(o)
  await first.actor.prompt("hi")
  const { sid } = first
  await waitFor(() => status(o, sid) === "waiting" && capItem(o) !== undefined, { what: "the hold" })
  const actor = await reopen(o, first.actor)
  const before = o.kinds.length
  await actor.setCostCap(20)
  // One advance resumes the stopped reply.
  await waitFor(() => status(o, sid) === "idle" && !actor.hasWorker, { what: "idle after the raise" })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(state(o, sid)).toEqual({ status: "idle", waiting_on: [], capped: false })
})

test("a cap raise whose settle fails still stands", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor } = await startActor(o)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  spyOn(actor, "settle").mockImplementation(() => {
    throw new Error("the pin can't be read")
  })
  // Logged, not a route error.
  expect((await actor.setCostCap(20)).cost_cap_usd).toBe(20)
  expect(o.logs.some((line) => line.includes("no state after its cap was raised (Error)"))).toBe(true)
})

test("a late cap check after the cap was raised does nothing", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  // Under the cap: posted before a raise, run after it.
  await actor.checkCap()
  expect(capItem(o)).toBeUndefined()
  expect(waits(o, sid)).toEqual(["idle", []])
})

test("a failed wake whose settle fails still answers cant wake", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  o.failNextSpawn()
  spyOn(actor, "settle").mockImplementation(() => {
    throw new Error("the pin can't be read")
  })
  await expect(actor.prompt("hi")).rejects.toMatchObject({ status: 503, code: "cant_wake" })
  expect(actor.hasWorker).toBe(false)
  expect(status(o, sid)).toBe("idle")
})

test("a model question asked before a restart is answered after it", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake)
  const first = await startActor(o)
  const { sid } = first
  await first.actor.prompt("hi")
  const old = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting" && !first.actor.hasWorker, { what: "asleep on the question" })
  const actor = await reopen(o, first.actor)
  const before = o.kinds.length
  const asked = fake.requests().length
  await actor.restore()
  // Asleep, its question still open: not asked again.
  expect(o.kinds.length).toBe(before)
  expect(actor.hasWorker).toBe(false)
  expect(waits(o, sid)).toEqual(["waiting", [CEO]])
  const open = o.office.store.listQuestions({ sessionId: sid, status: "open", source: "ask_user" })
  expect(open.map((q) => q.id)).toEqual([old.id])
  expect(await actor.prompt("A")).toBe("answer")
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
  // One request for the answer; none for the call the run recorded.
  expect(fake.requests()).toHaveLength(asked + 1)
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("The user answered: A")
  expect(o.office.store.getQuestion(old.id)!.status).toBe("consumed")
})

test("end on a session asleep at a question node stays ending across a restart", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { files: GATE_FILES })
  const first = await atTheGate(o)
  const { sid, q } = first
  const second = await reopen(o, first.actor)
  await second.restore()
  expect(second.hasWorker).toBe(false)
  // The node comes before the exit: the close waits in the run.
  await second.end()
  expect(waits(o, sid)).toEqual(["ending", []])
  expect(o.office.store.getQuestion(q.id)!.status).toBe("open")
  const third = await reopen(o, second)
  const before = o.kinds.length
  await third.restore()
  // An ending session is closed again at every start.
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(o.jobs.at(-1)!.deliver.map((d) => d.op)).toEqual(["close"])
  expect(status(o, sid)).toBe("ending")
  await waitFor(() => !third.hasWorker, { what: "the worker to exit" })
  expect(o.office.store.getQuestion(q.id)!.status).toBe("open")
  await third.answer(q.id, GATE_ANSWER, "option", { by: CEO })
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
})

test("restore settles a sleeping session held at its cap", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const first = await startActor(o)
  const { sid } = first
  const actor = await reopen(o, first.actor)
  // Over the $5 cap, but stored idle, as an older office left it.
  o.office.store.updateSession(sid, { cost: 6 })
  await actor.restore()
  expect(actor.hasWorker).toBe(false)
  expect(state(o, sid)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
})

test("a settle that fails after a resume at restore stops no other session", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "read it" }, { content: "read it" })
  const h = await makeHarness(fake)
  const sids: string[] = []
  for (let i = 0; i < 2; i++) {
    const s = await h.harness.startSession("minh", h.folder)
    await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
    sids.push(s.id)
  }
  const [a, b] = sids as [string, string]
  // Resumed at start, not left asleep.
  await unreadAtRestart(h, a, b)
  const settle = SessionActor.prototype.settle
  let broken = true
  const spy = spyOn(SessionActor.prototype, "settle").mockImplementation(function (this: SessionActor) {
    if (broken && this.sessionId === a) throw new Error("the pin can't be read")
    settle.call(this)
  })
  onTestFinished(() => spy.mockRestore())
  const before = h.kinds.length
  // Logged, not raised.
  await h.harness.restore()
  broken = false
  expect(h.kinds.slice(before)).toEqual(["advance", "advance"])
  expect(h.logs).toContain(`session ${a}: no state at restore (Error)`)
  await waitFor(() => sids.every((sid) => texts(h, sid).includes("read it")), { what: "both resumed replies" })
})

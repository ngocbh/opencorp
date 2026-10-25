/** The run state the session actor writes: waiting (and on whom), busy, idle (Python's
 *  `tests/chat/test_waiting.py`). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { now, Question } from "@opencorp/protocol"
import type { SessionActor } from "../../src/chat/session_actor.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import { newId, type QuestionRecord } from "../../src/store/store.ts"
import { CEO } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  ASK_MANAGER,
  ASK_USER,
  ASKED,
  card,
  type ChatOffice,
  chatOffice,
  fakeLlm,
  GATE_ANSWER,
  GATE_FILES,
  KAI,
  LAN,
  makeActor,
  newSession,
  noWorkersLeft,
  reopen,
  scriptedWorker,
  session,
  startActor,
  state,
  status,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Session `sid`'s status and who it waits on. */
function waits(o: ChatOffice, sid: string): [string, string[]] {
  const { status, waiting_on } = state(o, sid)
  return [status, waiting_on]
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

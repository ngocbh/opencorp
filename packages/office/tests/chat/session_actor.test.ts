/** The session actor's host loop rules that have no Python test of their own. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import type { LiveEvent } from "@opencorp/protocol"
import { INTERRUPTED_CALL, SessionActor } from "../../src/chat/session_actor.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import { CEO } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  ASK_USER,
  asleep,
  card,
  chatOffice,
  EMPTY,
  fakeLlm,
  makeActor,
  newSession,
  noWorkersLeft,
  reopen,
  say,
  scriptedWorker,
  session,
  startActor,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** A model question's request, as the worker sends it. */
const ASKED = { question: "Which?", questions: null, answer_schema: null, title: null, node_id: null, options: null }

test("turns count finished replies once", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  expect(session(o, sid).turns).toBe(0)
  await say(o, actor, sid, "a")
  await say(o, actor, sid, "b")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  expect(session(o, sid).turns).toBe(2)
})

test("the status is busy as soon as a message is accepted", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "held", hold: true })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  expect(status(o, sid)).toBe("idle")
  await actor.prompt("hi")
  expect(status(o, sid)).toBe("busy")
  await fake.waitForRequests(1, 30_000)
  fake.release()
  await waitFor(() => status(o, sid) === "idle" && texts(o, sid).includes("held"), { what: "the reply" })
})

test("the status is busy when a message is accepted after the result", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const { worker, handlers, deliveries } = workers[0]!
  handlers.event(worker, { type: "event", name: "NodeWaiting", data: { node_id: "chat#0/heard", call_ids: ["c1"] } })
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  const sent = actor.prompt("hi")
  await waitFor(() => deliveries.length === 1, { what: "the send" })
  const take = { node: "chat#0/heard", call_id: "c1", tool: "take", inbox: "messages", deadline: null, settled: false }
  handlers.result(worker, { type: "result", status: "waiting", run_id: runId, output: null, failure: null, waits: [take] })
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[0]!.id, seq: 7 })
  expect(await sent).toBe("turn")
  // The worker's exit spawns the advance that reads it.
  expect(status(o, sid)).toBe("busy")
})

test("a prompt whose send comes back unsent after close is refused as stopping", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const scripted = workers[0]!
  let unsent!: (sent: boolean) => void
  scripted.accept = () => new Promise((resolve) => (unsent = resolve))
  const sent = actor.prompt("hi")
  await waitFor(() => scripted.deliveries.length === 1, { what: "the send" })
  actor.close()
  unsent(false)
  await expect(sent).rejects.toMatchObject({ status: 503, code: "stopping" })
  expect(o.kinds).toEqual(["chat"])
})

test("a start after the registry closed is refused as stopping", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await o.registry.closeAll()
  await expect(actor.start()).rejects.toMatchObject({ status: 503, code: "stopping" })
  expect(status(o, sid)).toBe("starting")
  for (const runId of session(o, sid).run_ids) expect(o.office.store.getRun(runId)?.endReason).toBeNull()
})

test("the user message is published live under its send id", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "hello" })
  const o = await chatOffice(fake)
  const live: LiveEvent[] = []
  o.hooks.turnContext.push(() => "[context]")
  const sid = await newSession(o)
  const actor = new SessionActor({ ...o.ctx, bus: { publishLive: (event) => void live.push(event) } }, sid)
  o.actors.push(actor)
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  await actor.prompt("hi")
  // Published before the caller hears back.
  const published = live.filter((event) => event.type === "message.updated")
  expect(published).toHaveLength(1)
  await waitFor(() => texts(o, sid).includes("hello") && status(o, sid) === "idle", { what: "the reply" })
  const message = o.transcript.messages(sid, session(o, sid).run_ids).find((m) => m.role === "user")!
  const { created_at: _, ...shown } = message
  const { created_at: __, ...sent } = published[0]!.data as typeof message
  expect(sent).toEqual(shown)
  expect(sent).toMatchObject({ role: "user", author: CEO, parts: [{ type: "text", text: "hi" }] })
  expect(published[0]!.session_id).toBe(sid)
})

test("live calls is empty while a worker runs the run and null otherwise", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  expect(actor.calls("r1")).toBeNull()
  await actor.start()
  const runId = actor.runId!
  expect(actor.calls(runId)).toEqual([])
  expect(actor.calls("another-run")).toBeNull()
  const { worker, handlers } = workers[0]!
  const take = { node: "chat#0/heard", call_id: "c1", tool: "take", inbox: "messages", deadline: null, settled: false }
  handlers.result(worker, { type: "result", status: "waiting", run_id: runId, output: null, failure: null, waits: [take] })
  handlers.exited(worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  expect(actor.calls(runId)).toBeNull()
  expect(o.kinds).toEqual(["chat"])
})

test("turn context goes before the message and not in the transcript", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const seen: [string, string, boolean][] = []
  o.hooks.turnContext.push((s, text, { first }) => {
    seen.push([s.id, text, first])
    return seen.length === 1 ? "[context]" : null
  })
  const { actor, sid } = await startActor(o)
  expect(await say(o, actor, sid, "hi")).toBe("one")
  expect(await say(o, actor, sid, "again")).toBe("two")
  const [firstAsk, secondAsk] = fake.requests()
  expect(JSON.stringify(firstAsk!.messages)).toContain("[context]")
  expect(JSON.stringify(firstAsk!.messages)).toContain("hi")
  expect(JSON.stringify((secondAsk!.messages as unknown[]).at(-1))).not.toContain("[context]")
  expect(texts(o, sid, "user")).toEqual(["hi", "again"])
  expect(seen).toEqual([
    [sid, "hi", true],
    [sid, "again", false],
  ])
})

test("esc on a session asleep while its agent waits on a call spawns one advance that cuts it", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "spare" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await first.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting", { what: "waiting on the question" })
  const actor = await reopen(o, first)
  const before = o.kinds.length
  await actor.interrupt()
  // The closed call answered the question before Esc returned.
  const got = o.office.store.getQuestion(q.id)!
  expect([got.status, got.answer, got.answer_kind]).toEqual(["consumed", INTERRUPTED, "interrupted"])
  expect(o.jobs.at(-1)!.deliver.map((d) => d.op)).toEqual(["interrupt"])
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the run at its next turn" })
  expect(o.kinds.slice(before)).toEqual(["advance"])
})

test("a message while ask user is open answers it by complete", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting", { what: "waiting on the question" })
  expect(await actor.prompt("A")).toBe("answer")
  const got = o.office.store.getQuestion(q.id)!
  expect([got.status, got.answer, got.answer_kind, got.answered_by]).toEqual(["consumed", "A", "text", CEO])
  expect(o.jobs.at(-1)!.deliver).toMatchObject([{ op: "complete", call_id: q.call_id }])
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("The user answered: A")
  // The answer isn't a message of the transcript.
  expect(texts(o, sid, "user")).toEqual(["hi"])
})

test("a message whose question a card settled first is sent as a message", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const callId = `${actor.runId}/c1`
  const { worker, handlers, deliveries } = workers[0]!
  await handlers.askUser(worker, { ...ASKED, options: ["A", "B"] }, callId)
  const sent = actor.prompt("A")
  await waitFor(() => deliveries.length === 1, { what: "the answer" })
  expect(deliveries[0]).toMatchObject({ op: "complete", call_id: callId })
  // A card's complete settled the call first.
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[0]!.id, refused: "call_settled" })
  await waitFor(() => deliveries.length === 2, { what: "the message" })
  expect(deliveries[1]).toMatchObject({ op: "send", event: { parts: [{ type: "text", text: "A" }] } })
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[1]!.id, seq: 3 })
  expect(await sent).toBe("queued")
})

test("a card answer is completed and consumed", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "B it is." })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting", { what: "waiting on the question" })
  const before = o.kinds.length
  const stored = await actor.answer(q.id, "B", "option", { by: CEO })
  expect([stored.status, stored.answer, stored.answered_by]).toEqual(["answered", "B", CEO])
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === "consumed", { what: "the answer taken" })
  await waitFor(() => texts(o, sid).includes("B it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(o.jobs.at(-1)!.deliver).toMatchObject([
    { op: "complete", call_id: q.call_id, result: { output: expect.stringContaining('The user chose "B"') } },
  ])
})

test("esc answers an office call in flight interrupted", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "slow", arguments: {} }] }, { content: "spare" }, { content: "spare too" })
  let entered!: () => void
  const called = new Promise<void>((resolve) => (entered = resolve))
  const slow: OfficeTool = {
    description: "Waits until the test ends.",
    parameters: EMPTY,
    call: () => {
      entered()
      return new Promise(() => {})
    },
  }
  const o = await chatOffice(fake, { groups: { toolbox: { slow } } })
  // What the actor's handlers answer each tool call with.
  const replies: Promise<unknown>[] = []
  const spawn = o.registry.spawn
  o.registry.spawn = async (job, sessionDir, handlers, options) => {
    const toolCall = handlers.toolCall.bind(handlers)
    handlers.toolCall = (w, group, name, args, callId) => {
      const reply = toolCall(w, group, name, args, callId)
      replies.push(Promise.resolve(reply))
      return reply
    }
    return spawn(job, sessionDir, handlers, options)
  }
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  await called
  const interrupts = o.workspace.interrupts
  await actor.interrupt()
  expect(await replies[0]).toBe(INTERRUPTED_CALL)
  expect(o.workspace.interrupts).toBeGreaterThan(interrupts)
  // The run goes on to its next turn.
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the run at its next turn" })
})

test("a stored question fires question stored once", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake)
  const stored: string[] = []
  o.hooks.questionStored.push((q) => void stored.push(q.id))
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting", { what: "waiting on the question" })
  expect(stored).toEqual([q.id])
  await actor.prompt("A")
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(stored).toEqual([q.id])
})

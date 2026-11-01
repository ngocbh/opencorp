/** The session actor's host loop rules that have no Python test of their own. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type Scheduler, SLEEP_CHUNK_MS } from "@ngocbh/yian/platform"
import type { LiveEvent, Message } from "@opencorp/protocol"
import {
  type ActorContext,
  CHECK_MS,
  INDEX_WAIT_MS,
  INTERRUPTED_CALL,
  type SessionActor,
  type Wait,
} from "../../src/chat/session_actor.ts"
import { PING } from "../../src/daemon/bus.ts"
import { INTERRUPTED, MAX_ANSWER_BYTES } from "../../src/questions/format.ts"
import {
  CARD_CLOSED,
  COULDNT_RESUME,
  COULDNT_START,
  ENDED_OVER_CAP,
  NEW_MODEL,
  WORKER_STOPPED,
} from "../../src/runs/outcomes.ts"
import { writePrivate } from "../../src/secrets.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { type Delivery, STOP_REASON } from "../../src/worker/job.ts"
import { type Worker, WorkerExists } from "../../src/worker/spawn.ts"
import type { Frame } from "../../src/worker/channel.ts"
import type { OfficeTool, WorkerHandlers } from "../../src/worker/rpc.ts"
import { CEO } from "../daemon/helpers.ts"
import { fold } from "../harness/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import {
  ASK_USER,
  ASKED,
  asleep,
  capGate,
  capItem,
  card,
  type ChatOffice,
  chatOffice,
  EMPTY,
  errors,
  fakeLlm,
  free,
  livingWorkers,
  makeActor,
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
  TAKE,
  texts,
  waitingChat,
  waitingResult,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** What a command settled with: its value, or the status and code of the error it was refused with. */
function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(String, (error) => `${error.status} ${error.code}`)
}

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
  const waiting = { type: "result", status: "waiting", run_id: runId, output: null, failure: null, waits: [take] }
  handlers.result(worker, waiting)
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[0]!.id, seq: 7 })
  expect(await sent).toBe("turn")
  // The worker's exit spawns the advance that reads it.
  expect(status(o, sid)).toBe("busy")
})

test("a message sent while the next turn's history is compacted is a turn and makes the session busy", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const { worker, handlers, deliveries } = workers[0]!
  const frame = (name: string, node_id: string, data: Record<string, unknown> = {}) =>
    handlers.event(worker, { type: "event", name, data: { node_id, ...data } })
  // The turn's context runs beside its take, which already waits.
  frame("NodeStarted", "chat#0/context")
  frame("NodeStarted", "chat#0/heard")
  frame("NodeWaiting", "chat#0/heard", { call_ids: ["c1"] })
  frame("NodeExpanded", "chat#0/context")
  frame("NodeStarted", "chat#0/context/compacted")
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  const sent = actor.prompt("hi")
  await waitFor(() => deliveries.length === 1, { what: "the send" })
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[0]!.id, seq: 7 })
  expect(await sent).toBe("turn")
  // The take is still to wake, but it has the message: no longer at the turn.
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

test("a send the worker answered is not sent again when its frame reports the channel closed", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const scripted = workers[0]!
  let unsent!: (sent: boolean) => void
  scripted.accept = () => new Promise((resolve) => (unsent = resolve))
  const sent = actor.prompt("hi")
  await waitFor(() => scripted.deliveries.length === 1, { what: "the send" })
  // The worker took it and answered, then the channel closed before the frame's write reported back.
  scripted.handlers.deliverReply(scripted.worker, { type: "deliver_reply", id: scripted.deliveries[0]!.id, seq: 4 })
  scripted.handlers.result(scripted.worker, waitingResult(runId))
  unsent(false)
  scripted.handlers.exited(scripted.worker, 0)
  expect(await sent).toBe("queued")
  // Queued after the exit: the exit job has run when it answers.
  await expect(actor.answer("no-such-question", "x", "text")).rejects.toMatchObject({ status: 404 })
  expect(o.kinds).toEqual(["chat"])
})

test("a reply reason or error type that does not read as one never reaches a log or an error", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const scripted = workers[0]!
  const junk = `Not a reason: ${"x".repeat(1000)}`
  const refused = actor.prompt("hi")
  await waitFor(() => scripted.deliveries.length === 1, { what: "the send" })
  const refusedId = scripted.deliveries[0]!.id
  scripted.handlers.deliverReply(scripted.worker, { type: "deliver_reply", id: refusedId, refused: junk })
  const refusal = await refused.catch((error: Error) => error)
  expect(refusal).toMatchObject({ status: 422, code: "refused" })
  // The run started a node, so a failed delivery is answered at once.
  scripted.handlers.event(scripted.worker, { type: "event", name: "NodeStarted", data: { node_id: "chat#0/reply" } })
  const failed = actor.prompt("again")
  await waitFor(() => scripted.deliveries.length === 2, { what: "the second send" })
  const failedId = scripted.deliveries[1]!.id
  scripted.handlers.deliverReply(scripted.worker, { type: "deliver_reply", id: failedId, failed: junk })
  const failure = await failed.catch((error: Error) => error)
  expect(failure).toMatchObject({ status: 503, code: "cant_wake" })
  for (const text of [String((refusal as Error).message), String((failure as Error).message), ...o.logs]) {
    expect(text).not.toContain("Not a reason")
  }
  expect(o.logs.some((line) => line.includes("was refused (refused)"))).toBe(true)
  expect(o.logs.some((line) => line.includes("failed (Error)"))).toBe(true)
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
  const actor = makeActor(o, sid, { bus: { publishLive: (event) => void live.push(event) } })
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
  const waiting = { type: "result", status: "waiting", run_id: runId, output: null, failure: null, waits: [take] }
  handlers.result(worker, waiting)
  handlers.exited(worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  expect(actor.calls(runId)).toBeNull()
  expect(o.kinds).toEqual(["chat"])
})

test("a chat turn streams its reply live as the transcript shows it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one two three four five", hold: true })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  const sub = o.office.bus.subscribe(sid)
  onTestFinished(() => sub.close())
  await actor.prompt("hi")
  const runId = actor.runId!
  await fake.waitForRequests(1, 30_000)
  await waitFor(() => o.live.calls(runId)?.length === 1, { what: "the reply call live" })
  expect(actor.calls(runId)).toEqual(o.live.calls(runId)!)
  expect(actor.calls(runId)).toMatchObject([{ text: "" }])
  fake.release()
  await waitFor(() => texts(o, sid).includes("one two three four five"), { what: "the reply" })
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  const events: LiveEvent[] = []
  while (sub.queued > 0) {
    const item = await sub.next(0)
    if (item !== null && item !== PING && item[0] === "live") events.push(item[1])
  }
  expect(events.some((event) => event.type === "part.delta")).toBe(true)
  // The actor publishes the user message with its send time; the transcript has the log's.
  const timeless = (messages: Message[]) => messages.map(({ created_at: _, ...message }) => message)
  const shown = o.transcript.messages(sid, session(o, sid).run_ids, actor)
  expect(shown.map((message) => message.role)).toEqual(["user", "assistant"])
  expect(timeless(fold(events))).toEqual(timeless(shown))
})

/** The office's live relay, recording each `detach` and `forget` in `seen`. */
function spyLive(o: ChatOffice, seen: string[]): ActorContext["live"] {
  return {
    frame: (worker, frame) => o.live.frame(worker, frame),
    calls: (runId) => o.live.calls(runId),
    detach: (worker) => {
      seen.push("detach")
      o.live.detach(worker)
    },
    forget: (runIds) => {
      seen.push(`forget ${[...runIds].join(" ")}`)
      o.live.forget(runIds)
    },
  }
}

test("a finished session forgets its live runs only after its worker exits", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const seen: string[] = []
  const live = spyLive(o, seen)
  const transcript = { forget: (runIds: Iterable<string>) => void seen.push(`transcript ${[...runIds].join(" ")}`) }
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { live, transcript })
  await actor.start()
  await actor.fail()
  expect(status(o, sid)).toBe("failed")
  expect(seen).toEqual([])
  const { worker, handlers } = workers[0]!
  handlers.exited(worker, 0)
  const runs = session(o, sid).run_ids.join(" ")
  expect(seen).toEqual(["detach", `transcript ${runs}`, `forget ${runs}`])
  // A finish queued before the exit job: it runs after the exit handler, so it forgets.
  seen.length = 0
  const sid2 = await newSession(o)
  const second = makeActor(o, sid2, { live, transcript })
  await second.start()
  const runId = second.runId!
  expect(second.calls(runId)).toEqual([])
  // The first run's cancel got no reply, so its hard stop spawned a cancel job too.
  const next = workers.find((w) => w.job.session_id === sid2)!
  const failing = second.fail()
  next.handlers.exited(next.worker, 0)
  // The worker is gone before the exit job runs: no call of it is live.
  expect(second.calls(runId)).toBeNull()
  await failing
  const runs2 = session(o, sid2).run_ids.join(" ")
  expect(seen).toEqual(["detach", `transcript ${runs2}`, `forget ${runs2}`])
})

test("a finished actors lingering worker forgets only the runs it finished at its exit", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const seen: string[] = []
  const live = spyLive(o, seen)
  const transcript = { forget: (runIds: Iterable<string>) => void seen.push(`transcript ${[...runIds].join(" ")}`) }
  const sid = await newSession(o)
  const old = makeActor(o, sid, { live, transcript })
  await old.start()
  const first = old.runId!
  await old.fail()
  // Reopened while the failed run's worker still lingers: a new actor starts a new run.
  o.office.store.updateSession(sid, { status: "starting" })
  const fresh = makeActor(o, sid, { live, transcript })
  await fresh.start()
  expect(session(o, sid).run_ids).toEqual([first, fresh.runId!])
  const { worker, handlers } = workers[0]!
  handlers.exited(worker, 0)
  expect(seen).toEqual(["detach", `transcript ${first}`, `forget ${first}`])
})

test("turn text changes what the turn gets but not the transcript", async () => {
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

test("a message answers the models open question", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  // The worker exits after its waiting result, so the answer goes to the next job.
  await waitFor(() => status(o, sid) === "waiting" && !actor.hasWorker, { what: "asleep on the question" })
  expect(await actor.prompt("A")).toBe("answer")
  const got = o.office.store.getQuestion(q.id)!
  expect([got.status, got.answer, got.answer_kind, got.answered_by]).toEqual(["consumed", "A", "text", CEO])
  expect(o.jobs.at(-1)!.deliver).toMatchObject([{ op: "complete", call_id: q.call_id }])
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("The user answered: A")
  // The answer isn't a message of the transcript.
  expect(texts(o, sid, "user")).toEqual(["hi"])
})

test("a blank model question is a tool error the model reads, and the reply goes on", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "ask_user", arguments: { question: "  ", options: [] } }] }, { content: "Asked." })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  expect(await say(o, actor, sid, "hi")).toBe("Asked.")
  expect(o.office.store.listQuestions({ sessionId: sid })).toEqual([])
  const messages = fake.requests().at(-1)!.messages as { role: string }[]
  const tool = messages.find((message) => message.role === "tool")
  expect(JSON.stringify(tool)).toContain("ask_user question is blank: write the question to ask the user")
})

test("a message with text that is not valid is refused before anything sees it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const { worker, handlers, deliveries } = workers[0]!
  const hooked: string[] = []
  o.hooks.promptCheck.push(() => void hooked.push("promptCheck"))
  o.hooks.turnContext.push(() => void hooked.push("turnContext"))
  // With no question open, and with one the message would answer.
  await expect(actor.prompt("x\ud800y")).rejects.toMatchObject({ status: 422, code: "refused" })
  const callId = `${actor.runId}/c1`
  await handlers.askUser(worker, ASKED, callId)
  const refusal = await actor.prompt("x\ud800y").catch((error: Error) => error)
  expect(refusal).toMatchObject({ status: 422, code: "refused" })
  expect((refusal as Error).message.isWellFormed()).toBe(true)
  expect(o.office.store.getQuestionByCall(callId)!.status).toBe("open")
  expect(deliveries).toEqual([])
  expect(hooked).toEqual([])
})

test("a message that loses the question to a card answer is the next message", async () => {
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
  // The answer never reached the call.
  expect(o.office.store.getQuestionByCall(callId)!.status).toBe("stale")
})

/** A started actor on scripted workers whose first worker's run asked `ASKED` on call `c1`. */
async function askedOnce(o: ChatOffice) {
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const callId = `${runId}/c1`
  const first = workers[0]!
  await first.handlers.askUser(first.worker, ASKED, callId)
  const q = o.office.store.getQuestionByCall(callId)!
  return { workers, sid, actor, runId, callId, q, first }
}

/** The run's unsettled wait on the model's `ask_user` call `callId`. */
function askWait(callId: string): Wait {
  return { ...TAKE, node: "chat#0/reply", call_id: callId, tool: "ask_user", inbox: null }
}

/** `scripted`'s reply to `delivery`. */
function replyTo(scripted: ScriptedWorker, delivery: Delivery, fields: Record<string, unknown>): void {
  scripted.handlers.deliverReply(scripted.worker, { type: "deliver_reply", id: delivery.id, ...fields })
}

/** Resolves once every command queued on `actor` before it has run: a command refused at once. */
async function drained(actor: SessionActor): Promise<void> {
  await actor.answer("no-such-question", "x", "text").catch(() => {})
}

test.each(["call_settled", "ended"])("a card answer whose complete is refused %s goes stale", async (reason) => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first } = await askedOnce(o)
  expect((await actor.answer(q.id, "A", "text")).status).toBe("answered")
  expect(first.deliveries).toMatchObject([{ op: "complete", call_id: q.call_id }])
  replyTo(first, first.deliveries[0]!, { refused: reason })
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === "stale", { what: "the answer lost" })
  await drained(actor)
  expect(first.deliveries).toHaveLength(1)
})

test.each(["invalid_value", "too_large"])(
  "a card answer whose complete is refused %s goes stale and its call gets an error",
  async (reason) => {
    const o = await chatOffice(await fakeLlm())
    const { actor, q, first, callId } = await askedOnce(o)
    await actor.answer(q.id, "Secret-answer", "text")
    replyTo(first, first.deliveries[0]!, { refused: reason })
    await waitFor(() => first.deliveries.length === 2, { what: "the error complete" })
    expect(o.office.store.getQuestion(q.id)!.status).toBe("stale")
    expect(first.deliveries[1]).toEqual({
      id: expect.any(String),
      op: "complete",
      call_id: callId,
      result: { error: `the answer couldn't be delivered (${reason})` },
    })
    // Refused in turn (the call settled meanwhile): nothing more goes out.
    replyTo(first, first.deliveries[1]!, { refused: "call_settled" })
    await drained(actor)
    expect(first.deliveries).toHaveLength(2)
    expect(o.office.store.getQuestion(q.id)!.status).toBe("stale")
    expect(JSON.stringify([first.deliveries[1], o.logs])).not.toContain("Secret-answer")
  },
)

test("a refusal of an answer the run already took changes nothing", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first } = await askedOnce(o)
  await actor.answer(q.id, "A", "text")
  o.office.store.setQuestionStatus(q.id, "consumed")
  replyTo(first, first.deliveries[0]!, { refused: "invalid_value" })
  await drained(actor)
  expect(o.office.store.getQuestion(q.id)!.status).toBe("consumed")
  expect(first.deliveries).toHaveLength(1)
})

test.each([
  [{ seq: null }, "consumed"],
  [{ refused: "unknown_call" }, "stale"],
])("a card answer a running worker refused as an unknown call goes with the next advance [%o]", async (again, end) => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, workers, runId, callId } = await askedOnce(o)
  await actor.answer(q.id, "A", "text")
  // The call may not be pending yet: the answer stands.
  replyTo(first, first.deliveries[0]!, { refused: "unknown_call" })
  await drained(actor)
  expect(o.office.store.getQuestion(q.id)!.status).toBe("answered")
  first.handlers.result(first.worker, waitingResult(runId, [askWait(callId)]))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => workers.length === 2, { what: "the advance" })
  const second = workers[1]!
  expect(second.job.deliver).toMatchObject([{ op: "complete", call_id: callId }])
  replyTo(second, second.job.deliver[0]!, again)
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === end, { what: `the answer ${end}` })
})

test("a card answer a new worker's job refuses as an unknown call goes stale at once", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, workers, runId, callId } = await askedOnce(o)
  first.handlers.result(first.worker, waitingResult(runId, [askWait(callId)]))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await actor.answer(q.id, "A", "text")
  await waitFor(() => workers.length === 2, { what: "the advance" })
  const second = workers[1]!
  expect(second.job.deliver).toMatchObject([{ op: "complete", call_id: callId }])
  replyTo(second, second.job.deliver[0]!, { refused: "unknown_call" })
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === "stale", { what: "the answer lost" })
  second.handlers.result(second.worker, waitingResult(runId))
  second.handlers.exited(second.worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await drained(actor)
  expect(o.kinds).toEqual(["chat", "advance"])
})

test("an answer whose re-send failed waits for the next spawn", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, workers, runId, callId } = await askedOnce(o)
  await actor.answer(q.id, "A", "text")
  replyTo(first, first.deliveries[0]!, { refused: "unknown_call" })
  first.handlers.result(first.worker, waitingResult(runId, [askWait(callId)]))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => workers.length === 2, { what: "the re-send" })
  const second = workers[1]!
  replyTo(second, second.job.deliver[0]!, { failed: "OSError" })
  second.handlers.result(second.worker, waitingResult(runId, [askWait(callId)]))
  second.handlers.exited(second.worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await drained(actor)
  // No spin: the answer goes with whatever spawns next.
  expect(workers).toHaveLength(2)
  expect(o.office.store.getQuestion(q.id)!.status).toBe("answered")
})

test.each([
  [{ seq: null }, "consumed"],
  [{ refused: "unknown_call" }, "stale"],
])("an answered question whose call no wait lists is sent once with the next advance [%o]", async (again, end) => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, workers, runId, callId } = await askedOnce(o)
  // Its answer's reply never reached the actor (the office died, or the reply was lost).
  o.office.store.answerQuestion(q.id, "A", "text", null)
  first.handlers.result(first.worker, waitingResult(runId))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => workers.length === 2, { what: "the advance" })
  const second = workers[1]!
  expect(second.job.deliver).toMatchObject([{ op: "complete", call_id: callId }])
  replyTo(second, second.job.deliver[0]!, again)
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === end, { what: `the answer ${end}` })
  second.handlers.result(second.worker, waitingResult(runId))
  second.handlers.exited(second.worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await drained(actor)
  expect(workers).toHaveLength(2)
})

test("a message whose answer the running worker refused as an unknown call is also its next message", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first } = await askedOnce(o)
  const sent = actor.prompt("A")
  await waitFor(() => first.deliveries.length === 1, { what: "the answer" })
  replyTo(first, first.deliveries[0]!, { refused: "unknown_call" })
  await waitFor(() => first.deliveries.length === 2, { what: "the message" })
  expect(first.deliveries[1]).toMatchObject({ op: "send", event: { parts: [{ type: "text", text: "A" }] } })
  replyTo(first, first.deliveries[1]!, { seq: 3 })
  expect(await sent).toBe("queued")
  // A re-send decides whether the call took it.
  expect(o.office.store.getQuestion(q.id)!.status).toBe("answered")
})

test("an answer too large for the run's log is refused before it is stored", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first } = await askedOnce(o)
  const big = "x".repeat(MAX_ANSWER_BYTES)
  await expect(actor.answer(q.id, big, "text")).rejects.toMatchObject({ status: 422, code: "too_large" })
  await expect(actor.prompt(big)).rejects.toMatchObject({ status: 422, code: "too_large" })
  expect(o.office.store.getQuestion(q.id)!.status).toBe("open")
  expect(first.deliveries).toEqual([])
})

test("an answer to the model's question during end is refused as ending", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first } = await askedOnce(o)
  await actor.end()
  await expect(actor.answer(q.id, "A", "text")).rejects.toMatchObject({ status: 409, code: "ending" })
  expect(first.deliveries.map((d) => d.op)).toEqual(["interrupt", "close"])
  expect(o.office.store.getQuestion(q.id)!.status).toBe("open")
})

test("an answer while esc is under way is refused, and the question ends interrupted", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, callId } = await askedOnce(o)
  const cut = actor.interrupt()
  await waitFor(() => first.deliveries.length === 1, { what: "the interrupt" })
  const refusal = await actor.answer(q.id, "A", "text").catch((error: Error) => error)
  expect(refusal).toMatchObject({ status: 409, code: "not_open", message: `question ${q.id} is being interrupted` })
  // A message in the window is a message, not the answer.
  const sent = actor.prompt("x")
  await waitFor(() => first.deliveries.length === 2, { what: "the message" })
  expect(first.deliveries.map((d) => d.op)).toEqual(["interrupt", "send"])
  replyTo(first, first.deliveries[0]!, { seq: null, closed: [callId] })
  await cut
  const got = o.office.store.getQuestion(q.id)!
  expect([got.status, got.answer, got.answer_kind, got.answered_by]).toEqual([
    "consumed",
    INTERRUPTED,
    "interrupted",
    null,
  ])
  replyTo(first, first.deliveries[1]!, { seq: 4 })
  expect(await sent).toBe("queued")
})

test("an answer after an esc the worker never answered is taken, and lost if the call settled", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, workers, runId, callId } = await askedOnce(o)
  const cut = actor.interrupt()
  await waitFor(() => first.deliveries.length === 1, { what: "the interrupt" })
  first.handlers.result(first.worker, waitingResult(runId, [askWait(callId)]))
  first.handlers.exited(first.worker, 0)
  await cut
  expect((await actor.answer(q.id, "A", "text")).status).toBe("answered")
  await waitFor(() => workers.length === 2, { what: "the advance" })
  const second = workers[1]!
  replyTo(second, second.job.deliver[0]!, { refused: "call_settled" })
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === "stale", { what: "the answer lost" })
})

test("a card's stop interrupts only while its question is open and no esc is under way", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, runId, callId } = await askedOnce(o)
  const cut = actor.interrupt()
  await waitFor(() => first.deliveries.length === 1, { what: "the interrupt" })
  await expect(actor.interrupt({ question: q.id })).rejects.toMatchObject({ status: 409, code: "not_open" })
  replyTo(first, first.deliveries[0]!, { seq: null, closed: [callId] })
  await cut
  await expect(actor.interrupt({ question: q.id })).rejects.toMatchObject({ status: 409, code: "not_open" })
  expect(first.deliveries).toHaveLength(1)
  await first.handlers.askUser(first.worker, ASKED, `${runId}/c2`)
  const q2 = o.office.store.getQuestionByCall(`${runId}/c2`)!
  await actor.end()
  await expect(actor.interrupt({ question: q2.id })).rejects.toMatchObject({ status: 409, code: "ending" })
})

test("a message queued before a card's stop answers the question, and the stop is refused", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first } = await askedOnce(o)
  const sent = actor.prompt("A")
  await expect(actor.interrupt({ question: q.id })).rejects.toMatchObject({ status: 409, code: "not_open" })
  expect(first.deliveries.map((d) => d.op)).toEqual(["complete"])
  replyTo(first, first.deliveries[0]!, { seq: 2 })
  expect(await sent).toBe("answer")
  expect(o.office.store.getQuestion(q.id)!.status).toBe("consumed")
})

test("end interrupts a model call whose question is answered but not taken", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, q, first, workers, runId, callId } = await askedOnce(o)
  first.handlers.result(first.worker, waitingResult(runId, [askWait(callId)]))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  o.office.store.answerQuestion(q.id, "A", "text", null)
  await actor.end()
  await waitFor(() => workers.length === 2, { what: "the end's advance" })
  expect(workers[1]!.job.deliver.map((d) => d.op).slice(-2)).toEqual(["interrupt", "close"])
})

test("a card answer is completed and consumed", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "B it is." })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  // The worker exits after its waiting result, so the answer goes to the next job.
  await waitFor(() => status(o, sid) === "waiting" && !actor.hasWorker, { what: "asleep on the question" })
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

test("a message whose answer is unanswered at close is refused as stopping", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const { worker, handlers, deliveries } = workers[0]!
  await handlers.askUser(worker, { ...ASKED, options: ["A", "B"] }, `${actor.runId}/c1`)
  const sent = actor.prompt("A")
  await waitFor(() => deliveries.length === 1, { what: "the answer" })
  expect(deliveries[0]).toMatchObject({ op: "complete" })
  actor.close()
  await expect(sent).rejects.toMatchObject({ status: 503, code: "stopping" })
})

test("an answer whose spawn failed goes with the next advance and is consumed", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "B it is." }, { content: "spare" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting" && !actor.hasWorker, { what: "asleep on the question" })
  o.failNextSpawn()
  await actor.answer(q.id, "B", "option", { by: CEO })
  expect(actor.hasWorker).toBe(false)
  expect(o.office.store.getQuestion(q.id)!.status).toBe("answered")
  await actor.prompt("next")
  expect(o.jobs.at(-1)!.deliver).toMatchObject([
    { op: "complete", call_id: q.call_id, result: { output: expect.stringContaining('The user chose "B"') } },
    { op: "send", event: { parts: [{ type: "text", text: "next" }] } },
  ])
  await waitFor(() => o.office.store.getQuestion(q.id)!.status === "consumed", { what: "the answer taken" })
  await waitFor(() => texts(o, sid).includes("B it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(texts(o, sid, "user")).toEqual(["hi", "next"])
})

/** An office whose `slow` tool call never returns, recording what the actor's handlers answer each tool call with:
 *  `called` resolves once the call starts. */
async function slowCallOffice(fake: Awaited<ReturnType<typeof fakeLlm>>) {
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
  const replies: Promise<unknown>[] = []
  const recorded = (handlers: WorkerHandlers<Worker>) => {
    const toolCall = handlers.toolCall.bind(handlers)
    handlers.toolCall = (w, group, name, args, callId) => {
      const reply = toolCall(w, group, name, args, callId)
      replies.push(Promise.resolve(reply))
      return reply
    }
    return handlers
  }
  const { spawn, next } = o.registry
  o.registry.spawn = (job, sessionDir, handlers, options) => spawn(job, sessionDir, recorded(handlers), options)
  o.registry.next = (worker, job, handlers) => next(worker, job, recorded(handlers))
  return { o, called, replies }
}

test("esc answers an office call in flight", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "slow", arguments: {} }] }, { content: "spare" }, { content: "spare too" })
  const { o, called, replies } = await slowCallOffice(fake)
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

test("end answers an office call in flight and interrupts the workspace", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [{ name: "slow", arguments: {} }] }, { content: "spare" }, { content: "spare too" })
  const { o, called, replies } = await slowCallOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  await called
  const interrupts = o.workspace.interrupts
  await actor.end()
  expect(o.workspace.interrupts).toBeGreaterThan(interrupts)
  // Answered by End itself, while the worker still waits on it, not at the worker's exit.
  const answered = replies[0]!.then((reply) => [reply, actor.hasWorker])
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve("unanswered"), 5_000)))
  expect(await Promise.race([answered, late])).toEqual([INTERRUPTED_CALL, true])
  clearTimeout(timer)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
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

test("exit typed ends the session", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const ended: string[] = []
  o.hooks.sessionEnded.push((s) => void ended.push(s.status))
  const { actor, sid } = await startActor(o)
  expect(await actor.prompt("/exit")).toBe("turn")
  await waitFor(() => status(o, sid) === "ended" && ended.length > 0, { what: "the end" })
  expect(ended).toEqual(["ended"])
  expect(fake.requests()).toEqual([])
  expect(texts(o, sid, "user")).toEqual([])
})

test("the actor brings the run index up to date before it reports a runs end", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { scheduler } = steppedScheduler(Date.now())
  let calls = 0
  let updated!: (ok: boolean) => void
  const runIndex = {
    update: () => {
      calls += 1
      return new Promise<boolean>((resolve) => (updated = resolve))
    },
  }
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { runIndex, scheduler })
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  expect(await actor.prompt("/exit")).toBe("turn")
  // The registry drops the worker at its exit; the actor's own exit job waits behind the update. The first turn's
  // waiting result asked for one update already.
  await waitFor(() => calls > 1 && o.registry.get(sid) === undefined, { what: "the update and the worker's exit" })
  expect(status(o, sid)).not.toBe("ended")
  updated(true)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(calls).toBe(2)
})

test("a stuck run index update does not stall a runs end", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { scheduler, sleeps } = steppedScheduler(Date.now())
  let calls = 0
  const runIndex = {
    update: () => {
      calls += 1
      return new Promise<boolean>(() => {})
    },
  }
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { runIndex, scheduler })
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  expect(await actor.prompt("/exit")).toBe("turn")
  await waitFor(() => sleeps.some(({ ms }) => ms === INDEX_WAIT_MS), { what: "the bounded wait" })
  expect(status(o, sid)).not.toBe("ended")
  sleeps.find(({ ms }) => ms === INDEX_WAIT_MS)!.wake()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(calls).toBe(2)
})

/** Resolves once `calls` stayed the same length for 100 ms: the node events' run.updated calls are over. */
async function quiet(calls: unknown[]): Promise<void> {
  for (let n = -1; n !== calls.length; ) {
    n = calls.length
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test("a turn's waiting result brings the run index up to date without holding the turn", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  let calls = 0
  const updates: ((ok: boolean) => void)[] = []
  const runIndex = {
    update: () => {
      calls += 1
      return new Promise<boolean>((resolve) => updates.push(resolve))
    },
  }
  const changed: string[] = []
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { runIndex, runChanged: (runId) => void changed.push(runId) })
  await actor.start()
  // Idle can come before the waiting result (history compaction may run beside the take), so wait for both.
  await waitFor(() => status(o, sid) === "idle" && calls === 1, { what: "the first turn" })
  // Still idle while the update is pending: the turn wasn't held for it.
  expect(status(o, sid)).toBe("idle")
  const runId = session(o, sid).run_ids.at(-1)!
  await quiet(changed)
  const before = changed.length
  updates[0]!(true)
  await waitFor(() => changed.length > before, { what: "the run's run.updated" })
  expect(changed.slice(before)).toEqual([runId])
})

test("a turn's index update that fails sends no run.updated", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const updates: ((ok: boolean) => void)[] = []
  const runIndex = { update: () => new Promise<boolean>((resolve) => updates.push(resolve)) }
  const changed: string[] = []
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { runIndex, runChanged: (runId) => void changed.push(runId) })
  await actor.start()
  await waitFor(() => status(o, sid) === "idle" && updates.length === 1, { what: "the first turn" })
  await quiet(changed)
  const before = changed.length
  updates[0]!(false)
  await quiet(changed)
  expect(changed.length).toBe(before)
})

test("an ending update that outlasts the wait still sends the run's run.updated", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { scheduler, sleeps } = steppedScheduler(Date.now())
  const updates: ((ok: boolean) => void)[] = []
  const runIndex = { update: () => new Promise<boolean>((resolve) => updates.push(resolve)) }
  const changed: string[] = []
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { runIndex, scheduler, runChanged: (runId) => void changed.push(runId) })
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  const runId = session(o, sid).run_ids.at(-1)!
  expect(await actor.prompt("/exit")).toBe("turn")
  await waitFor(() => sleeps.some(({ ms }) => ms === INDEX_WAIT_MS), { what: "the bounded wait" })
  sleeps.find(({ ms }) => ms === INDEX_WAIT_MS)!.wake()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  await quiet(changed)
  const before = changed.length
  updates.at(-1)!(true)
  await waitFor(() => changed.length > before, { what: "the late run.updated" })
  expect(changed.slice(before)).toEqual([runId])
})

test("a message after end is refused as ending", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const { worker, handlers, deliveries } = workers[0]!
  handlers.event(worker, { type: "event", name: "NodeWaiting", data: { node_id: "chat#0/heard", call_ids: ["c1"] } })
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  await actor.end()
  expect(status(o, sid)).toBe("ending")
  await expect(actor.prompt("late")).rejects.toMatchObject({ status: 409, code: "ending" })
  await expect(actor.steer("late")).rejects.toMatchObject({ status: 409, code: "ending" })
  // A second end does nothing more.
  await actor.end()
  expect(deliveries.map((d) => d.op)).toEqual(["close"])
})

test("the provider key never reaches a reason a hook a log or the store", async () => {
  const key = "sk-sentinel-5d1f0e7a93"
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: key } })
  const workers = scriptedWorker(o)
  const live: LiveEvent[] = []
  const seen: unknown[] = []
  o.hooks.runFinished.push((...args) => void seen.push(args))
  o.hooks.sessionEnded.push((...args) => void seen.push(args))
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { bus: { publishLive: (event) => void live.push(event) } })
  await actor.start()
  const runId = actor.runId!
  const { worker, handlers } = workers[0]!
  // The worker's start frame is the one place the key travels.
  expect(worker.job.llm_config).toMatchObject({ api_key: key })
  // Not the reply: a failed reply starts a fresh run, and this run's failure fails the session.
  const failure = {
    node_id: "chat",
    cause_type: "AuthError",
    message: `bad key ${key} ${"x".repeat(900)}`,
    details: [{ input: { api_key: key } }, key],
  }
  const failed = { type: "result", status: "failed", run_id: runId, output: null, failure, waits: [] }
  handlers.result(worker, failed)
  handlers.exited(worker, 1)
  await waitFor(() => status(o, sid) === "failed" && seen.length === 2, { what: "the failure" })
  const [[, finishedRun, frame]] = seen as [[unknown, string, { failure: typeof failure }]]
  expect(finishedRun).toBe(runId)
  expect(frame.failure.message).toStartWith("bad key [redacted] xxx")
  expect(frame.failure.details).toEqual([{ input: { api_key: "[redacted]" } }, "[redacted]"])
  const stored = JSON.stringify([session(o, sid), o.office.store.getRun(runId)])
  for (const text of [JSON.stringify(seen), o.logs.join("\n"), JSON.stringify(live), stored]) {
    expect(text).not.toContain(key)
  }
})

/** Records the order `runFinished` and `sessionEnded` fire in. */
function hookOrder(o: ChatOffice): string[] {
  const fired: string[] = []
  o.hooks.runFinished.push(() => void fired.push("runFinished"))
  o.hooks.sessionEnded.push(() => void fired.push("sessionEnded"))
  return fired
}

test("a second worker death fails the session", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const fired = hookOrder(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  workers[0]!.handlers.exited(workers[0]!.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  expect(o.jobs[1]).toMatchObject({ kind: "advance", advance: true, deliver: [] })
  workers[1]!.handlers.exited(workers[1]!.worker, 1)
  await waitFor(() => workers.length === 3 && fired.length === 2, { what: "the hard stop" })
  expect(status(o, sid)).toBe("failed")
  expect(o.office.store.getRun(runId)?.endReason).toBe(WORKER_STOPPED)
  expect(o.kinds).toEqual(["chat", "advance", "advance"])
  expect(o.jobs[2]).toMatchObject({ advance: false, deliver: [{ op: "cancel" }] })
  expect(fired).toEqual(["runFinished", "sessionEnded"])
})

test("a run that stops on every advance fails after one retry", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const frames: unknown[] = []
  o.hooks.runFinished.push((_s, _runId, frame) => void frames.push(frame))
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const stopped = { type: "result", status: "stopped", run_id: runId, output: null, failure: null, waits: [] }
  workers[0]!.handlers.result(workers[0]!.worker, stopped)
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  workers[1]!.handlers.result(workers[1]!.worker, stopped)
  workers[1]!.handlers.exited(workers[1]!.worker, 0)
  await waitFor(() => workers.length === 3 && frames.length === 1, { what: "the hard stop" })
  expect(status(o, sid)).toBe("failed")
  expect(o.office.store.getRun(runId)?.endReason).toBe(WORKER_STOPPED)
  expect(o.kinds).toEqual(["chat", "advance", "advance"])
  expect(o.jobs[2]).toMatchObject({ advance: false, deliver: [{ op: "cancel" }] })
  // A stopped run isn't how the run ended: the office stops it.
  expect(frames).toEqual([null])
})

test("fail with a live worker cancels through it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  await actor.fail()
  expect(status(o, sid)).toBe("failed")
  await waitFor(() => workers[0]!.deliveries.length === 1, { what: "the cancel" })
  expect(workers[0]!.deliveries.map((d) => d.op)).toEqual(["cancel"])
  expect(o.kinds).toEqual(["chat"])
})

test("fail leaves a session whose stored status is no longer live", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid } = await startActor(o)
  const runId = actor.runId!
  // Ended in the store before this actor finished it.
  o.office.store.updateSession(sid, { status: "ended" })
  await actor.fail()
  expect(status(o, sid)).toBe("ended")
  expect(o.office.store.getRun(runId)!.endReason).toBeNull()
})

test("a cancel the live worker doesnt take is sent again by a hard stop at its exit", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  for (const took of [false, true]) {
    const sid = await newSession(o)
    const actor = makeActor(o, sid)
    await actor.start()
    const runId = actor.runId!
    const scripted = workers.at(-1)!
    await actor.abandon(CARD_CLOSED)
    await waitFor(() => scripted.deliveries.length === 1, { what: "the cancel" })
    const [cancel] = scripted.deliveries
    expect(cancel!.op).toBe("cancel")
    const before = o.kinds.length
    // A run that never resumed refuses it; a run that took it gives its seq.
    const reply = took ? { seq: 3, closed: [] } : { refused: "not_started" }
    scripted.handlers.deliverReply(scripted.worker, { type: "deliver_reply", id: cancel!.id, ...reply })
    scripted.handlers.exited(scripted.worker, 1)
    if (took) {
      // Time for a hard stop's cancel job to have spawned.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(o.kinds.length).toBe(before)
    } else {
      await waitFor(() => o.kinds.length === before + 1, { what: "the cancel job" })
      const job = o.jobs.at(-1)
      expect(job).toMatchObject({ kind: "advance", run_id: runId, advance: false, deliver: [{ op: "cancel" }] })
    }
  }
})

test("fail with a lingering waiting worker reports no run frame", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const frames: unknown[] = []
  o.hooks.runFinished.push((_s, _runId, frame) => void frames.push(frame))
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const { worker, handlers } = workers[0]!
  handlers.result(worker, waitingResult(runId))
  await actor.fail()
  await waitFor(() => frames.length === 1, { what: "run finished" })
  // A waiting result isn't how the run ended: the office stops it.
  expect(frames).toEqual([null])
  expect(o.office.store.getRun(runId)?.endReason).toBe(COULDNT_RESUME)
})

test("a hard stop waits for the lingering worker and skips a run with no log", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  // The stop job reads the run's connection right after its log check, inside the exit's job.
  const { connections } = o.ctx
  const resolve = connections.resolve.bind(connections)
  let resolves = 0
  connections.resolve = (...args) => {
    resolves += 1
    return resolve(...args)
  }
  // One session whose run has a log, then one whose run has none.
  for (const logged of [true, false]) {
    const sid = await newSession(o)
    const actor = makeActor(o, sid)
    await actor.start()
    const before = o.kinds.length
    // A run whose worker never started it has no log.
    if (!logged) fs.rmSync(path.join(o.office.paths.runs, actor.runId!, "log.jsonl"))
    const scripted = workers.at(-1)!
    // The worker read its last frame: the cancel isn't sent.
    scripted.accept = () => false
    await actor.fail()
    await waitFor(() => scripted.deliveries.length === 1, { what: "the cancel" })
    expect(o.kinds.length).toBe(before)
    const read = resolves
    scripted.handlers.exited(scripted.worker, 0)
    // Queued after the exit: the exit job has run when it answers.
    await expect(actor.end()).rejects.toMatchObject({ status: 409, code: "not_live" })
    if (logged) {
      expect(resolves).toBe(read + 1)
      await waitFor(() => o.kinds.length === before + 1, { what: "the cancel job" })
      expect(o.jobs.at(-1)).toMatchObject({ kind: "advance", advance: false, deliver: [{ op: "cancel" }] })
    } else {
      expect(resolves).toBe(read)
      expect(o.kinds.length).toBe(before)
    }
  }
})

test("a start after a replaced actors hard stop waits for it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  // As the registry does: one worker per session at a time.
  const gone = new Set<unknown>()
  const spawn = o.registry.spawn.bind(o.registry)
  o.registry.spawn = async (job, ...rest) => {
    const last = workers.at(-1)
    if (last !== undefined && !gone.has(last.worker)) throw new WorkerExists(job.session_id)
    return spawn(job, ...rest)
  }
  const exit = (n: number, code: number) => {
    gone.add(workers[n]!.worker)
    workers[n]!.handlers.exited(workers[n]!.worker, code)
  }
  const sid = await newSession(o)
  const old = makeActor(o, sid)
  await old.start()
  exit(0, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  exit(1, 1)
  await waitFor(() => status(o, sid) === "failed", { what: "the session to fail" })
  // Reopened at once: the failed run's cancel job spawns under the session's id first.
  o.office.store.updateSession(sid, { status: "starting" })
  let waiting = false
  // Not a native promise, so both `await` and `Promise.race` call its `then` once the start waits on it.
  const after: PromiseLike<void> = {
    then: (ok, no) => {
      waiting = true
      return old.stopped.then(ok, no)
    },
  }
  const fresh = makeActor(o, sid)
  const starting = fresh.start({ after })
  await waitFor(() => workers.length === 3 && waiting, { what: "the cancel job and the start waiting for it" })
  expect(o.jobs[2]).toMatchObject({ kind: "advance", advance: false, deliver: [{ op: "cancel" }] })
  exit(2, 0)
  await starting
  await old.stopped
  expect(o.kinds).toEqual(["chat", "advance", "advance", "chat"])
  expect(session(o, sid).run_ids).toHaveLength(2)
  expect(o.logs.filter((line) => line.includes("WorkerExists"))).toEqual([])
})

test("a delivery acked after result is advanced", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const { worker, handlers, deliveries } = workers[0]!
  const sent = actor.prompt("hi")
  await waitFor(() => deliveries.length === 1, { what: "the send" })
  handlers.result(worker, waitingResult(runId))
  // The run took the send after its result: nobody would move it now.
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[0]!.id, seq: 4 })
  await sent
  handlers.exited(worker, 0)
  await waitFor(() => workers.length === 2, { what: "the re-advance" })
  expect(o.jobs[1]).toMatchObject({ kind: "advance", advance: true, deliver: [] })
  expect(status(o, sid)).toBe("busy")
})

test("a lost ack is resent and a lost interrupt is dropped", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const first = workers[0]!
  const sent = actor.prompt("hi")
  await waitFor(() => first.deliveries.length === 1, { what: "the send" })
  const cut = actor.interrupt()
  await waitFor(() => first.deliveries.length === 2, { what: "the interrupt" })
  expect(first.deliveries.map((d) => d.op)).toEqual(["send", "interrupt"])
  // The worker ends without answering either.
  first.handlers.result(first.worker, waitingResult(runId))
  first.handlers.exited(first.worker, 0)
  await cut
  await waitFor(() => workers.length === 2, { what: "the next worker" })
  const second = workers[1]!
  // The send goes again, under its own id; the interrupt would cut the next reply, so it doesn't.
  expect(second.job.deliver).toEqual([first.deliveries[0]!])
  second.handlers.deliverReply(second.worker, { type: "deliver_reply", id: first.deliveries[0]!.id, seq: 5 })
  expect(await sent).toBe("queued")
})

test("an esc its worker never answered is resent when the worker dies", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const first = workers[0]!
  const sent = actor.prompt("hi")
  await waitFor(() => first.deliveries.length === 1, { what: "the send" })
  first.handlers.deliverReply(first.worker, { type: "deliver_reply", id: first.deliveries[0]!.id, seq: 4 })
  expect(await sent).toBe("queued")
  let answered = false
  const cut = actor.interrupt().then(() => void (answered = true))
  await waitFor(() => first.deliveries.length === 2, { what: "the interrupt" })
  // The worker dies before it answers the interrupt, with no outcome.
  first.handlers.exited(first.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the next worker" })
  const second = workers[1]!
  // Its advance resumes the reply the interrupt was meant to cut, so the interrupt goes again.
  expect(second.job).toMatchObject({ kind: "advance", advance: true })
  expect(second.job.deliver).toEqual([first.deliveries[1]!])
  expect(answered).toBe(false)
  second.handlers.deliverReply(second.worker, { type: "deliver_reply", id: first.deliveries[1]!.id, seq: 6 })
  await cut
  expect(answered).toBe(true)
})

test("an end its worker never answered resends its interrupt and close when the worker dies", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const first = workers[0]!
  first.handlers.event(first.worker, { type: "event", name: "NodeStarted", data: { node_id: "chat#0/reply" } })
  await actor.end()
  expect(first.deliveries.map((d) => d.op)).toEqual(["interrupt", "close"])
  first.handlers.exited(first.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the next worker" })
  const second = workers[1]!
  // In order: the resumed reply is cut before its turn reads the inbox closed.
  expect(second.job.deliver).toEqual(first.deliveries)
  for (const [seq, d] of second.job.deliver.entries()) {
    second.handlers.deliverReply(second.worker, { type: "deliver_reply", id: d.id, seq: 6 + seq })
  }
  const succeeded = { type: "result", status: "succeeded", run_id: runId, output: null, failure: null, waits: [] }
  second.handlers.result(second.worker, succeeded)
  second.handlers.exited(second.worker, 0)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.kinds).toEqual(["chat", "advance"])
})

test("a settled wait is re-advanced once without progress", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const asked = { node: "chat#0/reply", call_id: "q1", tool: "ask_user", inbox: null, deadline: null, settled: true }
  const later = { ...asked, call_id: "q2" }
  /** Ends worker `n` waiting on `waits`. */
  const waitOn = (n: number, waits: Wait[]) => {
    const { worker, handlers } = workers[n]!
    handlers.result(worker, waitingResult(runId, waits))
    handlers.exited(worker, 0)
  }
  waitOn(0, [asked])
  await waitFor(() => workers.length === 2, { what: "the re-advance" })
  // It moved on to another settled wait: that's progress, so once more.
  waitOn(1, [later])
  await waitFor(() => workers.length === 3, { what: "the second re-advance" })
  waitOn(2, [later])
  await waitFor(() => o.logs.some((line) => line.includes("WARNING")), { what: "the warning" })
  expect(o.kinds).toEqual(["chat", "advance", "advance"])
  expect(o.jobs.slice(1).map((job) => job.deliver)).toEqual([[], []])
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  // The next command moves it again.
  const sent = actor.prompt("hi")
  await waitFor(() => workers.length === 4, { what: "the message's advance" })
  expect(workers[3]!.job.deliver.map((d) => d.op)).toEqual(["send"])
  const { worker, handlers, job } = workers[3]!
  handlers.deliverReply(worker, { type: "deliver_reply", id: job.deliver[0]!.id, seq: 6 })
  await sent
})

test("a busy run is retried once then answered run busy", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const start = Date.parse("2026-10-25T00:00:00.000Z")
  const { scheduler, sleeps } = steppedScheduler(start)
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { scheduler })
  await actor.start()
  const runId = actor.runId!
  const take = { ...TAKE, deadline: new Date(start + 86_400_000).toISOString() }
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(runId, [take]))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "asleep at the turn" })
  expect(sleeps).toHaveLength(1)
  const a = outcome(actor.prompt("a"))
  await waitFor(() => workers.length === 2, { what: "the advance" })
  const b = outcome(actor.prompt("b"))
  await waitFor(() => workers[1]!.deliveries.length === 1, { what: "the second send" })
  const cut = actor.interrupt()
  await waitFor(() => workers[1]!.deliveries.length === 2, { what: "the interrupt" })
  /** Worker `n` finds the run held by another process: each send fails, then its advance; `between` runs after
   *  its error, before its exit. */
  const busy = (n: number, between = () => {}) => {
    const { worker, handlers, job, deliveries } = workers[n]!
    for (const d of [...job.deliver, ...deliveries]) {
      if (d.op === "send") handlers.deliverReply(worker, { type: "deliver_reply", id: d.id, failed: "RunBusyError" })
    }
    handlers.error(worker, { type: "error", message: `RunBusyError: run ${runId} is running`, traceback: "" })
    between()
    handlers.exited(worker, 1)
  }
  busy(1)
  await cut
  await waitFor(() => workers.length === 3, { what: "the retry" })
  const sends = workers[1]!.given().filter((d) => d.op === "send")
  expect(o.jobs[2]).toMatchObject({ kind: "advance", deliver: sends })
  // A message after the second error waits in the next job, which never comes.
  let c!: Promise<string>
  busy(2, () => (c = outcome(actor.prompt("c"))))
  expect(await a).toBe("503 run_busy")
  expect(await b).toBe("503 run_busy")
  expect(await c).toBe("503 run_busy")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  // The session stays as it was, its timer armed again.
  expect(o.kinds).toEqual(["chat", "advance", "advance"])
  expect(status(o, sid)).toBe("idle")
  await waitFor(() => sleeps.length === 2, { what: "the timer" })
})

test("the wake at timer advances a timed out question once", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [{ name: "ask_user", arguments: { question: "Which?", timeout: "1s" } }] },
    { content: "No answer, so A." },
    { content: "spare" },
  )
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  // A worker still at the first turn could take the message after its result, and its exit would spawn the
  // message's advance after the prompt returns.
  await waitFor(() => !actor.hasWorker, { what: "the first turn's worker to exit" })
  await actor.prompt("hi")
  // The message's advance has its worker once the prompt returns.
  expect(o.jobs.at(-1)!.deliver.map((d) => d.op)).toEqual(["send"])
  const before = o.kinds.length
  await waitFor(() => texts(o, sid).includes("No answer, so A.") && status(o, sid) === "idle", {
    what: "the reply after the timeout",
  })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  const asked = o.office.store.listQuestions({ sessionId: sid, source: "ask_user" })
  expect(asked.map((q) => q.status)).toEqual(["stale"])
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("timed out: no answer")
  await new Promise((resolve) => setTimeout(resolve, 3000))
  expect(o.kinds.slice(before)).toEqual(["advance"])
})

/** A scheduler whose clock the test sets and whose sleeps the test ends, one at a time. */
function steppedScheduler(start: number) {
  const sleeps: { ms: number; wake: () => void }[] = []
  const clock = { now: start }
  const scheduler: Scheduler = {
    now: () => clock.now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        sleeps.push({ ms, wake: resolve })
      }),
  }
  return { scheduler, sleeps, clock }
}

test("the wake at timer is armed in chunks and never advances early", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const start = Date.parse("2026-10-25T00:00:00.000Z")
  const { scheduler, sleeps, clock } = steppedScheduler(start)
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { scheduler })
  await actor.start()
  const deadline = new Date(start + 30 * 86_400_000).toISOString()
  const asked = { node: "chat#0/reply", call_id: "q1", tool: "ask_user", inbox: null, deadline, settled: false }
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(actor.runId!, [asked]))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => sleeps.length === 1, { what: "the timer" })
  // An early wake (a chunk ended, or the laptop slept less than the deadline) sleeps again.
  for (const step of [SLEEP_CHUNK_MS, 7 * 86_400_000]) {
    clock.now += step
    const n = sleeps.length
    sleeps.at(-1)!.wake()
    await waitFor(() => sleeps.length === n + 1, { what: "the next chunk" })
  }
  expect(sleeps.every(({ ms }) => ms > 0 && ms <= SLEEP_CHUNK_MS)).toBe(true)
  expect(o.kinds).toEqual(["chat"])
  clock.now = Date.parse(deadline)
  sleeps.at(-1)!.wake()
  await waitFor(() => workers.length === 2, { what: "the advance at the deadline" })
  expect(o.jobs[1]).toMatchObject({ kind: "advance", advance: true, deliver: [] })
  expect(status(o, sid)).toBe("busy")
})

test("a changed endpoint before a message starts a fresh run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  expect(await say(o, actor, sid, "a")).toBe("one")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  const old = actor.runId!
  // The office connection now points at another endpoint.
  const moved = await fakeLlm()
  moved.script({ content: "two" })
  const file = path.join(o.office.paths.office, "connections", "office.json")
  await writePrivate(file, JSON.stringify({ llm_config: LLM_CONFIG, env: moved.env(), prices: {} }))
  const before = o.kinds.length
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(o.kinds.slice(before)).toEqual(["chat"])
  const runIds = session(o, sid).run_ids
  expect(runIds).toEqual([old, actor.runId!])
  expect(o.office.store.getRun(old)?.endReason).toBe(NEW_MODEL)
  expect(o.office.store.getRun(actor.runId!)?.replacesRunId).toBe(old)
  // The fresh run carried the conversation to the new endpoint; the old one got nothing more.
  expect(JSON.stringify(moved.requests().at(-1)!.messages)).toContain("one")
  expect(fake.requests()).toHaveLength(1)
})

test("a profile edited between two messages does not stop the next advance", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  expect(await say(o, actor, sid, "a")).toBe("one")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  const { git } = o.office
  fs.writeFileSync(path.join(git.root, "people/minh/profile.md"), "# Minh, Engineer\n\nLikes tests.\n")
  await git.commit(["people/minh/profile.md"], "Edit minh's profile")
  const before = o.kinds.length
  expect(await say(o, actor, sid, "b")).toBe("two")
  // The run's recorded profile is still served: the advance resumes it, with no fresh run.
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(session(o, sid).run_ids).toHaveLength(1)
})

test("a run log with a bad line answers the next message from a fresh run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  expect(await say(o, actor, sid, "a")).toBe("one")
  const old = actor.runId!
  fs.appendFileSync(path.join(o.office.paths.runs, old, "log.jsonl"), "garbage\n")
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(o.kinds.at(-1)).toBe("chat")
  expect(actor.runId).not.toBe(old)
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
  expect(status(o, sid)).toBe("idle")
  expect(texts(o, sid, "user")).toEqual(["a", "b"])
  expect(texts(o, sid)).toEqual(["one", "two"])
  expect(o.logs).toContainEqual(expect.stringContaining("its run's log can't be read (RangeError); a fresh run replaces it"))
  expect(o.logs.filter((line) => line.includes("has no recorded outcome") || line.includes("garbage"))).toEqual([])
})

/** An `error` frame as a worker sends it for a throw it didn't expect. */
const ERROR_FRAME = { type: "error", message: "Error: x", traceback: "" }

const LOG_LOST = "The reply failed (its run log is gone or can't be read). Send your message again."

/** Session `sid` on `o`'s scripted workers, its first worker started and its run's `RunStarted` told. */
async function startedScripted(o: ChatOffice): Promise<{ actor: SessionActor; sid: string; workers: ScriptedWorker[] }> {
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const first = workers[0]!
  first.handlers.event(first.worker, { type: "event", name: "RunStarted", data: { run_id: actor.runId } })
  return { actor, sid, workers }
}

/** Removes run `runId`'s folder, then has `scripted` send `frame` and exit 1. */
function loseLogThenFail(o: ChatOffice, scripted: ScriptedWorker, runId: string, frame: Frame = ERROR_FRAME): void {
  fs.rmSync(path.join(o.office.paths.runs, runId), { recursive: true, force: true })
  scripted.handlers.error(scripted.worker, frame)
  scripted.handlers.exited(scripted.worker, 1)
}

test("an error after a run started whose log is gone sleeps; the next message starts a fresh run", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid, workers } = await startedScripted(o)
  const old = actor.runId!
  const first = workers[0]!
  await first.handlers.askUser(first.worker, ASKED, `${old}/c1`)
  loseLogThenFail(o, first, old)
  await waitFor(() => !actor.hasWorker && errors(o, sid).length > 0, { what: "the notice" })
  expect(status(o, sid)).toBe("idle")
  expect(errors(o, sid)).toEqual([LOG_LOST])
  expect(o.office.store.listQuestions({ runId: old, status: "open" })).toEqual([])
  expect(o.kinds).toEqual(["chat"])
  expect(o.office.store.getRun(old)?.endReason).toBeNull()
  void outcome(actor.prompt("again"))
  await waitFor(() => workers.length === 2, { what: "the fresh run" })
  expect(workers[1]!.job).toMatchObject({ kind: "chat", seed: null })
  expect(workers[1]!.given().map((d) => d.op)).toEqual(["send"])
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
  expect(o.logs).toContainEqual(expect.stringContaining("its run's log is gone or can't be read"))
})

test("an error after a run started whose log is gone carries an unapplied message to a fresh run at once", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, workers } = await startedScripted(o)
  const old = actor.runId!
  const reply = outcome(actor.prompt("b"))
  await waitFor(() => workers[0]!.deliveries.length === 1, { what: "the message" })
  loseLogThenFail(o, workers[0]!, old)
  await waitFor(() => workers.length === 2, { what: "the fresh run" })
  const fresh = workers[1]!
  expect(fresh.job.kind).toBe("chat")
  expect(fresh.given().map((d) => d.op)).toEqual(["send"])
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
  const send = fresh.given()[0]!
  fresh.handlers.deliverReply(fresh.worker, { type: "deliver_reply", id: send.id, seq: 1 })
  expect(await reply).toBe("queued")
})

test("an error before the run started fails it couldn't start; after it started with a readable log, worker stopped", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const never = await newSession(o)
  const unstarted = makeActor(o, never)
  await unstarted.start()
  loseLogThenFail(o, workers[0]!, unstarted.runId!)
  await waitFor(() => status(o, never) === "failed", { what: "the failure" })
  expect(o.office.store.getRun(unstarted.runId!)?.endReason).toBe(COULDNT_START)

  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const scripted = workers.at(-1)!
  // A log yian can read, in place of the scripted worker's empty one.
  const real = await waitingChat(fake, "chat", {}, { runs: tempDir(), runId })
  fs.copyFileSync(real.log, path.join(o.office.paths.runs, runId, "log.jsonl"))
  scripted.handlers.event(scripted.worker, { type: "event", name: "RunStarted", data: { run_id: runId } })
  scripted.handlers.error(scripted.worker, ERROR_FRAME)
  scripted.handlers.exited(scripted.worker, 1)
  await waitFor(() => status(o, sid) === "failed", { what: "the failure" })
  expect(o.office.store.getRun(runId)?.endReason).toBe(WORKER_STOPPED)
  expect(errors(o, sid).filter((text) => text === LOG_LOST)).toEqual([])
})

test("a run log lost twice without a turn fails the session", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid, workers } = await startedScripted(o)
  void outcome(actor.prompt("b"))
  await waitFor(() => workers[0]!.deliveries.length === 1, { what: "the message" })
  loseLogThenFail(o, workers[0]!, actor.runId!)
  await waitFor(() => workers.length === 2, { what: "the fresh run" })
  const fresh = workers[1]!
  const runId = actor.runId!
  fresh.handlers.event(fresh.worker, { type: "event", name: "RunStarted", data: { run_id: runId } })
  loseLogThenFail(o, fresh, runId)
  await waitFor(() => status(o, sid) === "failed", { what: "the failure" })
  expect(o.office.store.getRun(runId)?.endReason).toBe(COULDNT_RESUME)
  expect(workers.length).toBe(2)
})

test("a fresh run whose log can't be made fails once, and the log names the errno and the folder, not the message", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid, workers } = await startedScripted(o)
  void outcome(actor.prompt("b"))
  await waitFor(() => workers[0]!.deliveries.length === 1, { what: "the message" })
  loseLogThenFail(o, workers[0]!, actor.runId!)
  await waitFor(() => workers.length === 2, { what: "the fresh run" })
  const runId = actor.runId!
  const message = "Error: EACCES: permission denied, mkdir '/secret/x'"
  loseLogThenFail(o, workers[1]!, runId, { type: "error", message, traceback: "", code: "EACCES", syscall: "mkdir" })
  await waitFor(() => status(o, sid) === "failed", { what: "the failure" })
  expect(o.office.store.getRun(runId)?.endReason).toBe(COULDNT_START)
  expect(workers.length).toBe(2)
  const log = path.join(o.office.paths.runs, runId, "log.jsonl")
  expect(o.logs).toContainEqual(
    `session ${sid}: its run ended (error: Error, EACCES from mkdir); its log ${log} was never made`,
  )
  expect(o.logs.filter((line) => line.includes("/secret"))).toEqual([])
})

test("an error frame's errno fields reach the log only when they read as one", async () => {
  const o = await chatOffice(await fakeLlm())
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const frame = { type: "error", message: "Error: rm -rf", traceback: "", code: "rm -rf", syscall: "mkdir /x" }
  loseLogThenFail(o, workers[0]!, actor.runId!, frame)
  await waitFor(() => status(o, sid) === "failed", { what: "the failure" })
  expect(o.logs).toContainEqual(expect.stringContaining("its run ended (error: Error); its log "))
  expect(o.logs.filter((line) => line.includes("rm -rf") || line.includes("/x"))).toEqual([])
})

test("a run folder deleted between turns starts a fresh run, and the old run couldn't resume", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  expect(await say(o, actor, sid, "a")).toBe("one")
  const old = actor.runId!
  fs.rmSync(path.join(o.office.paths.runs, old), { recursive: true })
  await actor.prompt("b")
  await waitFor(() => texts(o, sid).includes("two") && status(o, sid) === "idle", { what: "the reply to b" })
  expect(actor.runId).not.toBe(old)
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
  expect(o.logs).toContainEqual(`session ${sid}: its run's log is gone`)
  expect(errors(o, sid)).toContain(
    "This chat's earlier messages are gone (its run log was deleted); a fresh run answers without them.",
  )
})

test("a deleted current run log isn't seeded from an older run", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid, workers } = await startedScripted(o)
  const first = workers[0]!
  first.handlers.result(first.worker, notResumed(actor.runId!))
  first.handlers.exited(first.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the fresh run" })
  const fresh = workers[1]!
  const runId = actor.runId!
  expect(fresh.job.seed).not.toBeNull()
  fresh.handlers.event(fresh.worker, { type: "event", name: "RunStarted", data: { run_id: runId } })
  fresh.handlers.result(fresh.worker, waitingResult(runId))
  fresh.handlers.exited(fresh.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the run to rest" })
  fs.rmSync(path.join(o.office.paths.runs, runId), { recursive: true })
  void outcome(actor.prompt("c"))
  await waitFor(() => workers.length === 3, { what: "the next fresh run" })
  expect(workers[2]!.job).toMatchObject({ kind: "chat", seed: null })
  expect(o.office.store.getRun(runId)?.endReason).toBe(COULDNT_RESUME)
})

/** A `not_resumed` result frame of run `runId`. */
function notResumed(runId: string): Record<string, unknown> {
  return { type: "result", status: "not_resumed", run_id: runId, error_type: "ResumeError" }
}

test("a not resumed advance starts a fresh run with the deliveries it never applied", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const seen: string[] = []
  const actor = makeActor(o, sid, { live: spyLive(o, seen) })
  await actor.start()
  const old = actor.runId!
  const first = workers[0]!
  // The model asks the user twice and its manager once, each on its own call.
  for (const n of [1, 2]) {
    await first.handlers.askUser(first.worker, { ...ASKED, question: `Which ${n}?` }, `${old}/c${n}`)
  }
  await first.handlers.toolCall(first.worker, "company", "ask_manager", { question: "Budget?" }, `${old}/c3`)
  const asked = o.office.store.listQuestions({ sessionId: sid })
  expect(asked).toHaveLength(3)
  const waits = asked.map((q) => ({ ...TAKE, node: "chat#0/reply", call_id: q.call_id!, tool: q.source, inbox: null }))
  first.handlers.result(first.worker, waitingResult(old, waits))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  // A card answers the second question: its complete goes with the advance.
  const card2 = asked.find((q) => q.call_id === `${old}/c2`)!
  await actor.answer(card2.id, "B", "option")
  await waitFor(() => workers.length === 2, { what: "the advance" })
  const second = workers[1]!
  expect(second.job.deliver.map((d) => d.op)).toEqual(["complete"])
  // A message answers the first question; another message, an Esc and a third message follow.
  const a = outcome(actor.prompt("A"))
  await waitFor(() => second.deliveries.length === 1, { what: "the answer" })
  const b = outcome(actor.prompt("B"))
  await waitFor(() => second.deliveries.length === 2, { what: "the second message" })
  const cut = actor.interrupt()
  await waitFor(() => second.deliveries.length === 3, { what: "the interrupt" })
  const c = outcome(actor.prompt("C"))
  await waitFor(() => second.deliveries.length === 4, { what: "the third message" })
  expect(second.deliveries.map((d) => d.op)).toEqual(["complete", "send", "interrupt", "send"])
  const [, sendB, interrupt, sendC] = second.deliveries as [Delivery, Delivery, Delivery, Delivery]
  /** The worker's reply to `d`. */
  const reply = (d: Delivery, fields: Record<string, unknown>) =>
    second.handlers.deliverReply(second.worker, { type: "deliver_reply", id: d.id, ...fields })
  // The interrupt reached the log; yian then refused the advance before appending anything.
  reply(interrupt, { seq: 3, closed: [] })
  reply(second.job.deliver[0]!, { refused: "not_started" })
  reply(sendB, { refused: "not_started" })
  reply(sendC, { failed: "OSError" })
  second.handlers.result(second.worker, notResumed(old))
  second.handlers.exited(second.worker, 1)
  await cut
  await waitFor(() => workers.length === 3, { what: "the fresh run" })
  const fresh = workers[2]!
  const runId = actor.runId!
  expect(runId).not.toBe(old)
  expect(fresh.job).toMatchObject({
    kind: "chat",
    run_id: runId,
    seed: { log: path.join(o.office.paths.runs, old, "log.jsonl"), cancel: true },
  })
  // What the run never applied, the first answer as its message; no interrupt and no card answer again.
  const said = fresh.job.deliver.map((d) =>
    d.op === "send" ? (d.event as { parts: { text: string }[] }).parts.at(-1)!.text : d.op,
  )
  expect(said).toEqual(["A", "B", "C"])
  expect(fresh.job.deliver.slice(1)).toEqual([sendB, sendC])
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
  expect(o.office.store.getRun(runId)?.replacesRunId).toBe(old)
  expect(session(o, sid).run_ids).toEqual([old, runId])
  // The replaced run's open question goes stale once the fresh run starts.
  const open3 = asked.find((q) => q.call_id === `${old}/c3`)!
  expect(o.office.store.getQuestion(open3.id)!.status).toBe("open")
  // The replaced run is forgotten once the fresh run starts, and only then.
  expect(seen.filter((entry) => entry.startsWith("forget"))).toEqual([])
  fresh.handlers.event(fresh.worker, { type: "event", name: "RunStarted", data: { run_id: runId } })
  await waitFor(() => o.office.store.getQuestion(open3.id)!.status === "stale", { what: "the stale question" })
  expect(seen.filter((entry) => entry.startsWith("forget"))).toEqual([`forget ${old}`])
  // The card's answer, which no run read, is lost.
  expect(o.office.store.getQuestion(card2.id)!.status).toBe("stale")
  fresh.job.deliver.forEach((d, n) => {
    fresh.handlers.deliverReply(fresh.worker, { type: "deliver_reply", id: d.id, seq: n + 1 })
  })
  expect([await a, await b, await c]).toEqual(["queued", "queued", "queued"])
})

test("an end whose advance is not resumed still closes the fresh run", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const old = actor.runId!
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(old))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "asleep at the turn" })
  await actor.end()
  await waitFor(() => workers.length === 2, { what: "the end's advance" })
  const second = workers[1]!
  expect(second.job.deliver.map((d) => d.op)).toEqual(["close"])
  // The close reached the old run's log, but the advance was refused.
  second.handlers.deliverReply(second.worker, { type: "deliver_reply", id: second.job.deliver[0]!.id, seq: 2 })
  second.handlers.result(second.worker, notResumed(old))
  second.handlers.exited(second.worker, 1)
  await waitFor(() => workers.length === 3, { what: "the fresh run" })
  const fresh = workers[2]!
  expect(fresh.job.kind).toBe("chat")
  expect(fresh.job.deliver.map((d) => d.op)).toEqual(["close"])
  expect(status(o, sid)).toBe("ending")
  const ended = { type: "result", status: "succeeded", run_id: fresh.job.run_id, output: null, failure: null, waits: [] }
  fresh.handlers.deliverReply(fresh.worker, { type: "deliver_reply", id: fresh.job.deliver[0]!.id, seq: 1 })
  fresh.handlers.result(fresh.worker, ended)
  fresh.handlers.exited(fresh.worker, 0)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
})

/** Makes `o`'s next scripted spawn throw before it starts a worker, recording nothing. */
function failNextScripted(o: ChatOffice): void {
  const spawn = o.registry.spawn
  o.registry.spawn = async () => {
    o.registry.spawn = spawn
    throw new Error("the spawn failed")
  }
}

/** Points `o`'s office connection at another key, so a run started before no longer matches its record. */
async function changeKey(o: ChatOffice, fake: Awaited<ReturnType<typeof fakeLlm>>): Promise<void> {
  const file = path.join(o.office.paths.office, "connections", "office.json")
  const llm_config = { ...LLM_CONFIG, api_key: "sk-changed" }
  await writePrivate(file, JSON.stringify({ llm_config, env: fake.env(), prices: {} }))
}

test("a fresh run that cant spawn at end stops the run it replaced", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const old = actor.runId!
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(old))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "asleep at the turn" })
  // The key changed: End's advance is a fresh run, which can't spawn.
  await changeKey(o, fake)
  failNextScripted(o)
  expect(await outcome(actor.end())).toBe("503 cant_wake")
  expect(status(o, sid)).toBe("failed")
  const fresh = actor.runId!
  expect(session(o, sid).run_ids).toEqual([old, fresh])
  expect(o.office.store.getRun(old)?.endReason).toBe(NEW_MODEL)
  // The fresh run never started.
  expect(o.office.store.getRun(fresh)?.endReason).toBe(COULDNT_START)
  // Nothing cancelled the old run, which has a log: one cancel job for it; the fresh run never started.
  await waitFor(() => workers.length === 2, { what: "the cancel job" })
  expect(o.jobs.slice(1)).toMatchObject([{ run_id: old, advance: false, deliver: [{ op: "cancel" }] }])
})

test("an ending session whose fresh run cant spawn fails", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const old = actor.runId!
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(old))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "asleep at the turn" })
  await actor.end()
  await waitFor(() => workers.length === 2, { what: "the end's advance" })
  const second = workers[1]!
  second.handlers.deliverReply(second.worker, { type: "deliver_reply", id: second.job.deliver[0]!.id, seq: 2 })
  second.handlers.result(second.worker, notResumed(old))
  failNextScripted(o)
  second.handlers.exited(second.worker, 1)
  // Left ending it could never be ended.
  await waitFor(() => status(o, sid) === "failed", { what: "the failure" })
  // The fresh run never started.
  expect(o.office.store.getRun(actor.runId!)?.endReason).toBe(COULDNT_START)
  await expect(actor.end()).rejects.toMatchObject({ status: 409, code: "not_live" })
})

test("a fresh run carries a message answer as its message", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const old = actor.runId!
  const first = workers[0]!
  await first.handlers.askUser(first.worker, ASKED, `${old}/c1`)
  const waits = [{ ...TAKE, node: "chat#0/reply", call_id: `${old}/c1`, tool: "ask_user", inbox: null }]
  first.handlers.result(first.worker, waitingResult(old, waits))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await changeKey(o, fake)
  // The message answers the open question, but the fresh run never asked it: it gets the text as a message.
  const a = outcome(actor.prompt("A"))
  await waitFor(() => workers.length === 2, { what: "the fresh run" })
  const fresh = workers[1]!
  expect(fresh.job.kind).toBe("chat")
  expect(fresh.job.deliver.map((d) => d.op)).toEqual(["send"])
  const sent = fresh.job.deliver[0] as Extract<Delivery, { op: "send" }>
  expect((sent.event as { parts: { text: string }[] }).parts.at(-1)!.text).toBe("A")
  fresh.handlers.deliverReply(fresh.worker, { type: "deliver_reply", id: fresh.job.deliver[0]!.id, seq: 1 })
  expect(await a).toBe("queued")
})

test("the wake at timer fires again after a busy run fails twice", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const start = Date.parse("2026-10-25T00:00:00.000Z")
  const { scheduler, sleeps, clock } = steppedScheduler(start)
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { scheduler })
  await actor.start()
  const runId = actor.runId!
  const deadline = new Date(start + 3_600_000).toISOString()
  const asked = { node: "chat#0/reply", call_id: "q1", tool: "ask_user", inbox: null, deadline, settled: false }
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(runId, [asked]))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => sleeps.length === 1, { what: "the timer" })
  clock.now = Date.parse(deadline)
  sleeps[0]!.wake()
  await waitFor(() => workers.length === 2, { what: "the advance at the deadline" })
  // That worker, and its retry, find the run held by another process.
  for (const n of [1, 2]) {
    const { worker, handlers } = workers[n]!
    handlers.error(worker, { type: "error", message: `RunBusyError: run ${runId} is running`, traceback: "" })
    handlers.exited(worker, 1)
    await waitFor(() => workers.length === n + 2, { what: `worker ${n + 1}` })
  }
  // The advance never ran: the timer is armed for the same deadline, which has come.
  expect(o.kinds).toEqual(["chat", "advance", "advance", "advance"])
  expect(o.jobs[3]).toMatchObject({ kind: "advance", advance: true, deliver: [] })
})

test("an ending session whose run is busy twice fails", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(runId))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "asleep at the turn" })
  await actor.end()
  // End's advance, then its retry, find the run held by another process.
  for (const n of [1, 2]) {
    await waitFor(() => workers.length === n + 1, { what: `worker ${n + 1}` })
    const { worker, handlers, job } = workers[n]!
    expect(job.deliver.map((d) => d.op)).toEqual(["close"])
    handlers.error(worker, { type: "error", message: `RunBusyError: run ${runId} is running`, traceback: "" })
    handlers.exited(worker, 1)
  }
  // Left ending it could never be ended.
  await waitFor(() => status(o, sid) === "failed", { what: "the failure" })
  expect(o.office.store.getRun(runId)?.endReason).toBe(COULDNT_RESUME)
})

test("a capped session advances nothing and a raise answers what it queued", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const start = Date.parse("2026-10-25T00:00:00.000Z")
  const { scheduler, sleeps, clock } = steppedScheduler(start)
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { scheduler })
  await actor.start()
  const runId = actor.runId!
  const deadline = new Date(start + 3_600_000).toISOString()
  const take = { ...TAKE, deadline }
  workers[0]!.handlers.result(workers[0]!.worker, waitingResult(runId, [take]))
  workers[0]!.handlers.exited(workers[0]!.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle" && sleeps.length === 1, {
    what: "asleep at the turn",
  })
  // Over the company's $5 while idle at the turn.
  o.office.store.updateSession(sid, { cost: 6 })
  const sent = actor.prompt("hi")
  await waitFor(() => workers.length === 2, { what: "the delivering job" })
  const second = workers[1]!
  // It only delivers: no model call may start over the cap.
  expect(second.job).toMatchObject({ kind: "advance", advance: false })
  expect(second.job.deliver.map((d) => d.op)).toEqual(["send"])
  second.handlers.deliverReply(second.worker, { type: "deliver_reply", id: second.job.deliver[0]!.id, seq: 3 })
  expect(await sent).toBe("queued")
  second.handlers.result(second.worker, waitingResult(runId, [take]))
  second.handlers.exited(second.worker, 0)
  await waitFor(() => !actor.hasWorker && sleeps.length === 2, { what: "the timer armed again" })
  expect(state(o, sid)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
  // The deadline comes: the timer doesn't advance a capped run.
  clock.now = Date.parse(deadline)
  sleeps.at(-1)!.wake()
  await waitFor(() => o.logs.some((line) => line.includes("timer waits for its cost cap to be raised")), {
    what: "the capped wake",
  })
  await actor.checkCap()
  expect(workers).toHaveLength(2)
  // The raise advances the run, which takes the queued message.
  const raised = await actor.setCostCap(20)
  expect(raised.cost_cap_usd).toBe(20)
  expect(workers).toHaveLength(3)
  const third = workers[2]!
  expect(third.job).toMatchObject({ kind: "advance", advance: true, deliver: [] })
  expect(status(o, sid)).toBe("busy")
  /** The third worker's run sends `name` for `node`. */
  const event = (name: string, data: Record<string, unknown>) =>
    third.handlers.event(third.worker, { type: "event", name, data })
  event("NodeWoken", { node_id: "chat#0/heard" })
  event("NodeSucceeded", { node_id: "chat#0/heard" })
  event("NodeStarted", { node_id: "chat#0/reply" })
  event("NodeSucceeded", { node_id: "chat#0/reply" })
  event("NodeWaiting", { node_id: "chat#1/heard", call_ids: ["c2"] })
  third.handlers.result(third.worker, waitingResult(runId, [{ ...TAKE, node: "chat#1/heard", call_id: "c2" }]))
  third.handlers.exited(third.worker, 0)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the reply" })
  expect(session(o, sid)).toMatchObject({ turns: 1, capped: false })
})

test("a new actor over a capped session sends without advancing", async () => {
  const fake = await fakeLlm()
  fake.script(free("late"))
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.kinds.length
  expect(await actor.prompt("hi")).toBe("queued")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  expect(o.jobs.slice(before)).toMatchObject([{ kind: "advance", advance: false }])
  expect(fake.requests()).toHaveLength(0)
  expect(state(o, sid)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
  // The raise advances the run to the message it holds.
  await actor.setCostCap(20)
  await waitFor(() => texts(o, sid).includes("late") && status(o, sid) === "idle", { what: "the reply" })
  expect(o.kinds.slice(before)).toEqual(["advance", "advance"])
})

/** Starts a scripted session already over the company's $5 cap; its `chat` worker is `workers[0]`, still live. */
async function cappedStart(o: ChatOffice) {
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  o.office.store.updateSession(sid, { cost: 6 })
  const actor = makeActor(o, sid)
  await actor.start()
  return { workers, sid, actor, runId: actor.runId! }
}

/** The ops `scripted`'s worker was given, its job's and the ones sent while it ran. */
function ops(scripted: ScriptedWorker): string[] {
  return scripted.given().map((d) => d.op)
}

/** `scripted`'s worker acks every delivery it was given, rests waiting at the turn and exits. */
function rests(scripted: ScriptedWorker, runId: string): void {
  for (const d of scripted.given()) scripted.handlers.deliverReply(scripted.worker, { type: "deliver_reply", id: d.id, seq: 1 })
  scripted.handlers.result(scripted.worker, waitingResult(runId))
  scripted.handlers.exited(scripted.worker, 0)
}

test("over the cap a message sent while the run starts waits for a job that only delivers", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId } = await cappedStart(o)
  const sent = actor.prompt("hi")
  await drained(actor)
  // The start's chat job may call the model: the message stays out of it.
  expect(ops(workers[0]!)).toEqual([])
  rests(workers[0]!, runId)
  await waitFor(() => workers.length === 2, { what: "the delivering job" })
  expect(workers[1]!.job).toMatchObject({ kind: "advance", advance: false })
  expect(ops(workers[1]!)).toEqual(["send"])
  rests(workers[1]!, runId)
  expect(await sent).toBe("queued")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await actor.setCostCap(20)
  expect(workers).toHaveLength(3)
  expect(workers[2]!.job).toMatchObject({ kind: "advance", advance: true })
})

test("a busy retry of a chat job over the cap keeps messages out of it", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId } = await cappedStart(o)
  const sent = actor.prompt("hi")
  await drained(actor)
  const first = workers[0]!
  first.handlers.error(first.worker, { type: "error", message: `RunBusyError: run ${runId} is running`, traceback: "" })
  first.handlers.exited(first.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  expect(workers[1]!.job.kind).toBe("chat")
  expect(ops(workers[1]!)).toEqual([])
  rests(workers[1]!, runId)
  await waitFor(() => workers.length === 3, { what: "the delivering job" })
  expect(workers[2]!.job).toMatchObject({ kind: "advance", advance: false })
  expect(ops(workers[2]!)).toEqual(["send"])
  rests(workers[2]!, runId)
  expect(await sent).toBe("queued")
})

test("a message held from a busy retry is refused when the retry can't spawn", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId } = await cappedStart(o)
  const sent = outcome(actor.prompt("hi"))
  await drained(actor)
  failNextScripted(o)
  const first = workers[0]!
  first.handlers.error(first.worker, { type: "error", message: `RunBusyError: run ${runId} is running`, traceback: "" })
  first.handlers.exited(first.worker, 1)
  expect(await sent).toBe("503 cant_wake")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  // Nothing of it is left for the next job.
  const again = actor.prompt("again")
  await waitFor(() => workers.length === 2, { what: "the delivering job" })
  expect(workers[1]!.job).toMatchObject({ kind: "advance", advance: false })
  expect(ops(workers[1]!)).toEqual(["send"])
  rests(workers[1]!, runId)
  expect(await again).toBe("queued")
})

test("esc over the cap while a message is only being delivered sends no interrupt", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId, sid } = await cappedStart(o)
  rests(workers[0]!, runId)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "waiting", { what: "held at the cap" })
  const sent = actor.prompt("hi")
  await waitFor(() => workers.length === 2, { what: "the delivering job" })
  const second = workers[1]!
  expect(second.job).toMatchObject({ kind: "advance", advance: false })
  // No reply runs: an interrupt would cut the reply the raise starts.
  await actor.interrupt()
  expect(ops(second)).toEqual(["send"])
  rests(second, runId)
  expect(await sent).toBe("queued")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await actor.setCostCap(20)
  expect(workers).toHaveLength(3)
  expect(workers[2]!.job).toMatchObject({ kind: "advance", advance: true, deliver: [] })
})

test("esc over the cap in a chat job's start window sends no interrupt", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId } = await cappedStart(o)
  const sent = actor.prompt("hi")
  await actor.interrupt()
  expect(ops(workers[0]!)).toEqual([])
  rests(workers[0]!, runId)
  await waitFor(() => workers.length === 2, { what: "the delivering job" })
  expect(ops(workers[1]!)).toEqual(["send"])
  rests(workers[1]!, runId)
  expect(await sent).toBe("queued")
})

test("after a raise in the start window esc stops the held message's reply as right after sending", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId } = await cappedStart(o)
  const sent = actor.prompt("hi")
  await actor.setCostCap(20)
  const cut = actor.interrupt()
  await drained(actor)
  // Nothing overtakes the held message.
  expect(ops(workers[0]!)).toEqual([])
  rests(workers[0]!, runId)
  await waitFor(() => workers.length === 2, { what: "the advance" })
  expect(workers[1]!.job).toMatchObject({ kind: "advance", advance: true })
  expect(ops(workers[1]!)).toEqual(["send", "interrupt"])
  rests(workers[1]!, runId)
  expect(await sent).toBe("queued")
  await cut
})

test("after a raise while a delivering worker runs esc reaches it after the send", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId, sid } = await cappedStart(o)
  rests(workers[0]!, runId)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "waiting", { what: "held at the cap" })
  const sent = actor.prompt("hi")
  await waitFor(() => workers.length === 2, { what: "the delivering job" })
  await actor.setCostCap(20)
  const cut = actor.interrupt()
  await waitFor(() => workers[1]!.deliveries.length === 1, { what: "the interrupt" })
  expect(ops(workers[1]!)).toEqual(["send", "interrupt"])
  rests(workers[1]!, runId)
  expect(await sent).toBe("queued")
  await cut
})

test("end over the cap in the start window stops the run and refuses the held message", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId, sid } = await cappedStart(o)
  const first = workers[0]!
  const stops = countStops(first)
  const sent = outcome(actor.prompt("hi"))
  await actor.end()
  expect(stops()).toBe(1)
  expect(first.deliveries.filter((d) => d.op === "send")).toEqual([])
  first.handlers.error(first.worker, STOPPED_ERROR)
  first.handlers.exited(first.worker, 1)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.office.store.getRun(runId)?.endReason).toBe(ENDED_OVER_CAP)
  expect(await sent).toBe("409 not_live")
  await waitFor(() => workers.length === 2, { what: "the cancel job" })
  expect(o.jobs.slice(1)).toMatchObject([{ run_id: runId, advance: false, deliver: [{ op: "cancel" }] }])
})

test("end over the cap after the start's worker rested closes after the held message", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId, sid } = await cappedStart(o)
  const first = workers[0]!
  const sent = actor.prompt("hi")
  await drained(actor)
  first.handlers.result(first.worker, waitingResult(runId))
  await actor.end()
  first.handlers.exited(first.worker, 0)
  await waitFor(() => workers.length === 2, { what: "the ending advance" })
  // The take reads the message and the closed inbox: the flow skips the reply.
  expect(workers[1]!.job).toMatchObject({ kind: "advance", advance: true })
  expect(ops(workers[1]!)).toEqual(["send", "close"])
  const { worker, handlers } = workers[1]!
  for (const d of workers[1]!.given()) handlers.deliverReply(worker, { type: "deliver_reply", id: d.id, seq: 1 })
  expect(await sent).toBe("queued")
  handlers.result(worker, { type: "result", status: "succeeded", run_id: runId, output: null, failure: null, waits: [] })
  handlers.exited(worker, 0)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
})

test("end after a raise in the start window closes after the held message", async () => {
  const o = await chatOffice(await fakeLlm())
  const { workers, actor, runId } = await cappedStart(o)
  const sent = actor.prompt("hi")
  await actor.setCostCap(20)
  await actor.end()
  expect(ops(workers[0]!)).toEqual([])
  rests(workers[0]!, runId)
  await waitFor(() => workers.length === 2, { what: "the ending advance" })
  expect(ops(workers[1]!)).toEqual(["send", "close"])
  rests(workers[1]!, runId)
  expect(await sent).toBe("queued")
})

test("esc over the cap while the stopped reply's node runs still interrupts it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { prices: PRICES })
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const first = workers[0]!
  const stops = countStops(first)
  first.handlers.event(first.worker, { type: "event", name: "NodeStarted", data: { node_id: "chat#0/reply" } })
  modelCall(first, 6)
  await waitFor(() => stops() === 1 && session(o, sid).capped, { what: "the stop at the cap" })
  const cut = actor.interrupt()
  await waitFor(() => first.deliveries.length === 1, { what: "the interrupt" })
  expect(ops(first)).toEqual(["interrupt"])
  first.handlers.deliverReply(first.worker, { type: "deliver_reply", id: first.deliveries[0]!.id, seq: 1 })
  await cut
})

test("end over the cost cap on a waiting run closes it without a model call", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.kinds.length
  await actor.end()
  // The one advance a capped session may run: the take reads the inbox closed and the run succeeds.
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.jobs.slice(before)).toMatchObject([{ kind: "advance", advance: true, deliver: [{ op: "close" }] }])
  expect(fake.requests()).toHaveLength(0)
})

test("end over the cost cap after a message sent while capped closes the run without a model call", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const frames: unknown[] = []
  o.hooks.runFinished.push((_s, _runId, frame) => void frames.push(frame))
  const { actor, sid } = await startActor(o)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  const runId = actor.runId!
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.kinds.length
  expect(await actor.prompt("hi")).toBe("queued")
  await waitFor(() => !actor.hasWorker, { what: "the delivering worker to exit" })
  expect(o.jobs.slice(before)).toMatchObject([{ kind: "advance", advance: false, deliver: [{ op: "send" }] }])
  // The message settled the turn's take; the take reads it with the close and the flow skips the reply.
  await actor.end()
  await waitFor(() => status(o, sid) === "ended" && frames.length === 1, { what: "the end" })
  expect(o.jobs.slice(before + 1)).toMatchObject([{ kind: "advance", advance: true, deliver: [{ op: "close" }] }])
  expect(o.office.store.getRun(runId)?.endReason).not.toBe(ENDED_OVER_CAP)
  expect(frames).toMatchObject([{ type: "result", status: "succeeded" }])
  expect(fake.requests()).toHaveLength(0)
})

test("end over the cost cap on a stopped reply ends the session at once", async () => {
  const fake = await fakeLlm()
  fake.script(PRICEY, free("spare"))
  const gate = capGate()
  const o = await chatOffice(fake, { prices: PRICES, groups: gate.groups })
  const { actor, sid } = await startActor(o)
  gate.watch(o)
  await actor.prompt("hi")
  await waitFor(() => capItem(o) !== undefined && !actor.hasWorker && status(o, sid) === "waiting", {
    what: "the reply stopped at the cap",
  })
  const runId = actor.runId!
  const requests = fake.requests().length
  const before = o.kinds.length
  // An advance would resume the stopped reply and spend: the run is cancelled and the session ends.
  await actor.end()
  expect(status(o, sid)).toBe("ended")
  expect(o.office.store.getRun(runId)?.endReason).toBe(ENDED_OVER_CAP)
  await waitFor(() => o.kinds.length === before + 1, { what: "the cancel job" })
  expect(o.jobs.at(-1)).toMatchObject({ run_id: runId, advance: false, deliver: [{ op: "cancel" }] })
  expect(fake.requests()).toHaveLength(requests)
})

/** Starts a session on `o` whose reply to "hi" fails (`fake`'s held 500) after its cost reached the cap, and waits
 *  until the actor has handled the failure; returns the actor, the session, its failed run and the spawns so far. */
async function failedOverCap(
  o: ChatOffice,
  fake: Awaited<ReturnType<typeof fakeLlm>>,
): Promise<{ actor: SessionActor; sid: string; old: string; before: number }> {
  const { actor, sid } = await startActor(o)
  const old = actor.runId!
  expect(await actor.prompt("hi")).toBe("turn")
  await fake.waitForRequests(1, 30_000)
  // The reply's spending reached the cap before its next model call failed.
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.kinds.length
  fake.release()
  await waitFor(() => errors(o, sid).length === 1 && !actor.hasWorker && status(o, sid) === "waiting", {
    what: "the failed reply",
  })
  expect(errors(o, sid)[0]).toStartWith("The reply failed (")
  return { actor, sid, old, before }
}

test("a reply that fails over the cost cap holds its fresh run until the cap is raised", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500, hold: true }, free("Got it."))
  const o = await chatOffice(fake)
  const { actor, sid, old, before } = await failedOverCap(o, fake)
  // No fresh run yet: its reply would call the model over the cap.
  expect(o.kinds.slice(before)).toEqual([])
  expect(session(o, sid).run_ids).toEqual([old])
  await actor.checkCap()
  expect(capItem(o)).toBeDefined()
  expect(state(o, sid)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
  // A message meanwhile is queued for the fresh run at once.
  expect(await actor.prompt("more")).toBe("queued")
  expect(o.kinds.slice(before)).toEqual([])
  await actor.setCostCap(20)
  expect(o.kinds.slice(before)).toEqual(["chat"])
  const runId = actor.runId!
  expect(runId).not.toBe(old)
  expect(o.office.store.getRun(runId)?.replacesRunId).toBe(old)
  expect(o.jobs.at(-1)).toMatchObject({ kind: "chat", run_id: runId, advance: true, deliver: [{ op: "send" }] })
  await waitFor(() => texts(o, sid).includes("Got it.") && status(o, sid) === "idle", { what: "the fresh reply" })
  expect(texts(o, sid, "user")).toEqual(["hi", "more"])
  // The message is still shown live once the fresh run takes it.
  const shown = o.lives.filter((event) => event.type === "message.updated" && event.data.role === "user")
  expect(shown.map((event) => (event.data.parts as { text: string }[]).at(-1)!.text)).toEqual(["hi", "more"])
})

test("end while the fresh run of a failed reply is held closes it without a model call", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500, hold: true })
  const o = await chatOffice(fake)
  const { actor, sid, old, before } = await failedOverCap(o, fake)
  const requests = fake.requests().length
  await actor.end()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.jobs.slice(before)).toMatchObject([{ kind: "chat", deliver: [{ op: "close" }] }])
  expect(o.office.store.getRun(actor.runId!)?.replacesRunId).toBe(old)
  expect(fake.requests()).toHaveLength(requests)
})

test("a message held for the fresh run of a failed reply reaches the next run when the fresh worker dies", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const old = actor.runId!
  o.office.store.updateSession(sid, { cost: 6 })
  const first = workers[0]!
  first.handlers.result(first.worker, failedReply(old))
  first.handlers.exited(first.worker, 1)
  await waitFor(() => errors(o, sid).length === 1 && !actor.hasWorker, { what: "the failed reply" })
  expect(await actor.prompt("more")).toBe("queued")
  await actor.setCostCap(20)
  expect(workers).toHaveLength(2)
  const fresh = workers[1]!
  expect(fresh.job.kind).toBe("chat")
  const [send] = fresh.job.deliver
  expect(send).toMatchObject({ op: "send" })
  // Gone before it took the message: the message its caller heard was queued goes to the retry.
  fresh.handlers.exited(fresh.worker, 1)
  await waitFor(() => workers.length === 3, { what: "the retry" })
  expect(workers[2]!.job).toMatchObject({ kind: "advance", run_id: actor.runId, deliver: [send] })
})

test("a held fresh run that cant start after the raise fails the session", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500, hold: true })
  const o = await chatOffice(fake)
  const frames: unknown[] = []
  o.hooks.runFinished.push((_s, _runId, frame) => void frames.push(frame))
  const { actor, sid, old, before } = await failedOverCap(o, fake)
  // The connection can't be resolved: the fresh run fails before anything is stored.
  fs.chmodSync(path.join(o.office.connections.dir, "office.json"), 0o644)
  await actor.setCostCap(20)
  expect(status(o, sid)).toBe("failed")
  expect(o.kinds.slice(before)).toEqual([])
  expect(session(o, sid).run_ids).toEqual([old])
  expect(errors(o, sid).at(-1)).toStartWith("The session failed (")
  // Yian failed the run: no office end reason, and its failed result is how it ended.
  expect(o.office.store.getRun(old)?.endReason).toBeNull()
  await waitFor(() => frames.length === 1, { what: "the run's end" })
  expect(frames).toMatchObject([{ type: "result", status: "failed" }])
})

test("a session failed while the fresh run of a failed reply is held reports the failed run as yian ended it", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500, hold: true })
  const o = await chatOffice(fake)
  const frames: unknown[] = []
  o.hooks.runFinished.push((_s, _runId, frame) => void frames.push(frame))
  const { actor, sid, old, before } = await failedOverCap(o, fake)
  await actor.fail()
  expect(status(o, sid)).toBe("failed")
  expect(o.office.store.getRun(old)?.endReason).toBeNull()
  await waitFor(() => frames.length === 1, { what: "the run's end" })
  expect(frames).toMatchObject([{ type: "result", status: "failed" }])
  // Nothing to hard stop: yian ended the run.
  expect(o.kinds.slice(before)).toEqual([])
})

/** A `failed` result of run `runId` whose reply failed. */
function failedReply(runId: string): Record<string, unknown> {
  const failure = { node_id: "chat#0/reply", message: "boom" }
  return { type: "result", status: "failed", run_id: runId, output: null, failure, waits: [] }
}

/** Counts the stops sent to `scripted`'s worker. */
function countStops(scripted: ScriptedWorker): () => number {
  let stops = 0
  scripted.worker.stop = async () => {
    stops += 1
    return true
  }
  return () => stops
}

/** `scripted`'s run finishes a model call of `tokens` input tokens: $`tokens` at `PRICES`. */
function modelCall(scripted: ScriptedWorker, tokens: number): void {
  const usage = { input_tokens: tokens, output_tokens: 0 }
  scripted.handlers.event(scripted.worker, { type: "event", name: "ModelCallFinished", data: { model: "stub", usage } })
}

/** The `error` frame of a run the office's stop cut short. */
const STOPPED_ERROR = { type: "error", message: `Error: ${STOP_REASON}`, traceback: "" }

test("a model call that finishes after the session finished is charged", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { prices: PRICES })
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const first = workers[0]!
  const stops = countStops(first)
  await actor.fail()
  expect(status(o, sid)).toBe("failed")
  // The worker still runs its reply's model call when the session fails.
  modelCall(first, 6)
  await waitFor(() => session(o, sid).cost === 6, { what: "the charge" })
  // Finished: nothing is left to stop or hold.
  await actor.checkCap().catch(() => {})
  expect(stops()).toBe(0)
  expect(capItem(o)).toBeUndefined()
})

test("a run the cap stopped is not a death when the cap is raised before its worker exits", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { prices: PRICES })
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const first = workers[0]!
  const stops = countStops(first)
  modelCall(first, 6)
  await waitFor(() => stops() === 1 && capItem(o) !== undefined, { what: "the stop at the cap" })
  await actor.setCostCap(20)
  expect(workers).toHaveLength(1)
  first.handlers.error(first.worker, STOPPED_ERROR)
  first.handlers.exited(first.worker, 1)
  // The raise came first: the stopped reply resumes for real.
  await waitFor(() => workers.length === 2, { what: "the resumed worker" })
  expect(workers[1]!.job).toMatchObject({ kind: "advance", advance: true })
  // Its first death gets the one retry.
  workers[1]!.handlers.exited(workers[1]!.worker, 1)
  await waitFor(() => workers.length === 3, { what: "the retry" })
  expect(workers[2]!.job).toMatchObject({ kind: "advance", advance: true })
  expect(status(o, sid)).not.toBe("failed")
})

test("a run the cap stopped resets the death bound", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { prices: PRICES })
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  workers[0]!.handlers.exited(workers[0]!.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  const second = workers[1]!
  const stops = countStops(second)
  // The retry made progress: its reply ran to the cap.
  modelCall(second, 6)
  await waitFor(() => stops() === 1 && capItem(o) !== undefined, { what: "the stop at the cap" })
  second.handlers.error(second.worker, STOPPED_ERROR)
  second.handlers.exited(second.worker, 1)
  await waitFor(() => !actor.hasWorker, { what: "the stopped worker to exit" })
  await actor.setCostCap(20)
  await waitFor(() => workers.length === 3, { what: "the resumed worker" })
  // A death after the raise is a first one again: it gets the one retry.
  workers[2]!.handlers.exited(workers[2]!.worker, 1)
  await waitFor(() => workers.length === 4, { what: "the retry after the raise" })
  expect(workers[3]!.job).toMatchObject({ kind: "advance", advance: true })
  expect(status(o, sid)).not.toBe("failed")
})

test("end while a reply runs then a call over the cap ends the session over its cap", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { prices: PRICES })
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const first = workers[0]!
  const stops = countStops(first)
  first.handlers.event(first.worker, { type: "event", name: "NodeStarted", data: { node_id: "chat#0/reply" } })
  await actor.end()
  expect(first.deliveries.map((d) => d.op)).toEqual(["interrupt", "close"])
  expect(stops()).toBe(0)
  // The reply's model call crosses the cap before the interrupt cut it.
  modelCall(first, 6)
  await waitFor(() => stops() === 1, { what: "the stop at the cap" })
  first.handlers.error(first.worker, STOPPED_ERROR)
  first.handlers.exited(first.worker, 1)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.office.store.getRun(runId)?.endReason).toBe(ENDED_OVER_CAP)
  await waitFor(() => workers.length === 2, { what: "the cancel job" })
  expect(o.jobs.slice(1)).toMatchObject([{ run_id: runId, advance: false, deliver: [{ op: "cancel" }] }])
})

test("end over the cap with a lingering worker and a settled wait ends the session over its cap", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const first = workers[0]!
  const stops = countStops(first)
  o.office.store.updateSession(sid, { cost: 6 })
  await actor.end()
  expect(stops()).toBe(1)
  // The run came to rest before the stop, with a call settled: an advance would wake the agent and spend.
  const settled = { node: "chat#0/reply", call_id: "q1", tool: "ask_user", inbox: null, deadline: null, settled: true }
  first.handlers.result(first.worker, waitingResult(runId, [settled]))
  first.handlers.exited(first.worker, 0)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.office.store.getRun(runId)?.endReason).toBe(ENDED_OVER_CAP)
  await waitFor(() => workers.length === 2, { what: "the cancel job" })
  expect(o.jobs.slice(1)).toMatchObject([{ run_id: runId, advance: false, deliver: [{ op: "cancel" }] }])
})

test("a model call with no token counts is logged unpriced", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { prices: PRICES })
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const first = workers[0]!
  const usage = { input_tokens: "6", output_tokens: null }
  first.handlers.event(first.worker, { type: "event", name: "ModelCallFinished", data: { model: "stub", usage } })
  await waitFor(() => o.logs.some((line) => line.includes("unpriced")), { what: "the log line" })
  expect(session(o, sid).cost).toBe(0)
})

const SRC = fileURLToPath(new URL("../../src/", import.meta.url))
// The yian functions that drive a run: only a worker calls them, on the run it hosts.
const HOST_CALLS = new Set(["send", "complete", "close", "interrupt", "cancel", "advance"])
const HOST_MODULES = new Set(["@ngocbh/yian", "@ngocbh/yian/run"])
// Modules that call host functions and run in the worker: only src/worker/ loads them.
const WORKER_ONLY = new Set(["worker/main", "chat/history"])
// Strings are matched so that a `//` or `/*` inside one isn't read as a comment.
const COMMENT = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
// A static import's clause runs from `import` to `from`, across lines; a side-effect import names nothing.
const STATIC_IMPORT = /^[ \t]*import\s+(type\s+)?([^;"'`]*?)\s+from\s+["']([^"']+)["']/gm
const RE_EXPORT = /^[ \t]*export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+["']([^"']+)["']/gm
const DYNAMIC_IMPORT = /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g

/** The yian host functions `text` imports or re-exports, and its loads of worker-only modules; `file` is relative to src. */
function hostImports(file: string, text: string): string[] {
  /** The src-relative module a relative `spec` names, without its extension; `null` for a package. */
  const local = (spec: string) =>
    spec.startsWith(".") ? path.posix.join(path.posix.dirname(file), spec).replace(/\.[jt]s$/, "") : null
  // Block comments keep their line breaks so that the next line still starts a line.
  const code = text.replace(COMMENT, (match, string) => string ?? match.replace(/[^\n]/g, ""))
  const found: string[] = []
  for (const [, typeOnly, clause, spec] of [...code.matchAll(STATIC_IMPORT), ...code.matchAll(RE_EXPORT)]) {
    if (typeOnly) continue
    const mod = local(spec!)
    if (mod && WORKER_ONLY.has(mod)) found.push(`${file}: ${mod}.ts`)
    if (!HOST_MODULES.has(spec!)) continue
    if (clause!.includes("*")) found.push(`${file}: * from ${spec}`)
    for (const specifier of (clause!.match(/\{([^}]*)\}/)?.[1] ?? "").split(",")) {
      const words = specifier.trim().split(/\s+/)
      if (words.length > 1 && words[0] === "type") continue
      if (HOST_CALLS.has(words[0]!)) found.push(`${file}: ${words[0]} from ${spec}`)
    }
  }
  for (const [, spec] of code.matchAll(DYNAMIC_IMPORT)) {
    const mod = local(spec!)
    // The office's own entry point loads the worker's main for the `__worker` mode.
    if (mod && WORKER_ONLY.has(mod) && !(file === "main.ts" && mod === "worker/main")) found.push(`${file}: ${mod}.ts`)
    if (HOST_MODULES.has(spec!)) found.push(`${file}: import(${spec})`)
  }
  return found
}

test("no office code outside the worker calls a yian host function", () => {
  expect(hostImports("a/b.ts", 'import {\n  loadFlow,\n  send as deliver,\n} from "@ngocbh/yian"')).toEqual([
    "a/b.ts: send from @ngocbh/yian",
  ])
  expect(hostImports("a/b.ts", 'import yian, { advance } from "@ngocbh/yian/run"')).toEqual([
    "a/b.ts: advance from @ngocbh/yian/run",
  ])
  expect(hostImports("a/b.ts", 'import * as run from "@ngocbh/yian/run"')).toEqual(["a/b.ts: * from @ngocbh/yian/run"])
  expect(hostImports("a/b.ts", 'const y = await import("@ngocbh/yian")')).toEqual(["a/b.ts: import(@ngocbh/yian)"])
  // Comments inside an import clause, one with an apostrophe.
  expect(hostImports("a/b.ts", 'import {\n  loadFlow,\n  // drives the run\n  advance,\n} from "@ngocbh/yian/run"')).toEqual([
    "a/b.ts: advance from @ngocbh/yian/run",
  ])
  expect(hostImports("a/b.ts", "import {\n  loadFlow, // the run's flow\n  send,\n} from \"@ngocbh/yian\"")).toEqual([
    "a/b.ts: send from @ngocbh/yian",
  ])
  expect(hostImports("a/b.ts", 'import { /* host */ cancel } from "@ngocbh/yian"')).toEqual([
    "a/b.ts: cancel from @ngocbh/yian",
  ])
  expect(hostImports("a/b.ts", 'const glob = "src/*"\nimport { send } from "@ngocbh/yian"\nconst end = "*/"')).toEqual([
    "a/b.ts: send from @ngocbh/yian",
  ])
  // Re-exports.
  expect(hostImports("a/b.ts", 'export { advance as run } from "@ngocbh/yian/run"')).toEqual([
    "a/b.ts: advance from @ngocbh/yian/run",
  ])
  expect(hostImports("a/b.ts", 'export * from "@ngocbh/yian"')).toEqual(["a/b.ts: * from @ngocbh/yian"])
  expect(hostImports("a/b.ts", 'export * as run from "@ngocbh/yian/run"')).toEqual(["a/b.ts: * from @ngocbh/yian/run"])
  // The worker-only modules, in each spelling.
  for (const spec of ["../worker/main.ts", "../worker/main.js", "../worker/main"])
    expect(hostImports("a/b.ts", `import { STOP } from "${spec}"`)).toEqual(["a/b.ts: worker/main.ts"])
  expect(hostImports("a/b.ts", 'await import("../worker/main.ts")')).toEqual(["a/b.ts: worker/main.ts"])
  expect(hostImports("chat/b.ts", 'import { readSeed } from "./history.js"')).toEqual(["chat/b.ts: chat/history.ts"])
  expect(hostImports("a/b.ts", 'export { readSeed } from "../chat/history"')).toEqual(["a/b.ts: chat/history.ts"])
  expect(hostImports("a/b.ts", 'export * from "../chat/history.ts"')).toEqual(["a/b.ts: chat/history.ts"])
  for (const allowed of [
    'import type { send } from "@ngocbh/yian"',
    'import { type cancel, loadFlow } from "@ngocbh/yian"',
    'import { sendMessage } from "@ngocbh/yian"',
    'import { send } from "@ngocbh/yian/tools"',
    'import type { WorkerEnv } from "../worker/main.ts"',
    'import type { Seeded } from "../chat/history.ts"',
    'export type { FoldedRun } from "@ngocbh/yian/run"',
    'export { loadFlow } from "@ngocbh/yian"',
    '// import { send } from "@ngocbh/yian"',
    '/*\nimport { send } from "@ngocbh/yian"\n*/',
  ])
    expect(hostImports("a/b.ts", allowed)).toEqual([])
  expect(hostImports("main.ts", 'await import("./worker/main.ts")')).toEqual([])
  const files = fs
    .readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.startsWith("worker/") && file !== "chat/history.ts")
  expect(files).toContain("chat/session_actor.ts")
  expect(files.flatMap((file) => hostImports(file, fs.readFileSync(path.join(SRC, file), "utf8")))).toEqual([])
})

test("abandon after the session finished leaves its own end", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid } = await startActor(o)
  const runId = actor.runId!
  const ended: string[] = []
  o.hooks.sessionEnded.push((s) => void ended.push(s.status))
  // A finish queued before the abandon wins: its run keeps its own end.
  const failed = actor.fail()
  await actor.abandon("its card closed")
  await failed
  expect(status(o, sid)).toBe("failed")
  expect(o.office.store.getRun(runId)!.endReason).toBe(COULDNT_RESUME)
  await actor.abandon("later")
  expect(status(o, sid)).toBe("failed")
  expect(o.office.store.getRun(runId)!.endReason).toBe(COULDNT_RESUME)
  await waitFor(() => ended.length > 0, { what: "the end hook" })
  expect(ended).toEqual(["failed"])
})

// A kept worker: between turns the session's worker stays parked, and the next run call goes to it.

/** Session `sid`'s parked worker, once its run call has ended; fails if a worker runs. */
async function parkedWorker(o: ChatOffice, sid: string): Promise<Worker> {
  await waitFor(() => o.registry.get(sid)?.parked === true, { what: "the worker to park" })
  return o.registry.get(sid)!
}

test("a message to a waiting session goes to its parked worker", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  const first = await parkedWorker(o, sid)
  expect(actor.hasWorker).toBe(false)
  expect(await say(o, actor, sid, "a")).toBe("one")
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(await parkedWorker(o, sid)).toBe(first)
  expect(o.kinds).toEqual(["chat", "advance", "advance"])
  expect(o.reused()).toBe(2)
  expect(livingWorkers().filter((w) => w.pid === first.pid)).toHaveLength(1)
})

test("the idle timeout closes the parked worker and the next message spawns one", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const o = await chatOffice(fake)
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { keepMs: 300 })
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  const first = await parkedWorker(o, sid)
  expect(await first.wait(10_000)).toBe(0)
  expect(o.registry.get(sid)).toBeUndefined()
  expect(await say(o, actor, sid, "a")).toBe("one")
  expect(o.reused()).toBe(0)
  expect(o.kinds).toEqual(["chat", "advance"])
  expect(session(o, sid).run_ids).toHaveLength(1)
})

test("a parked worker is kept for 2 hours by default", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const sleeps: { ms: number; signal: AbortSignal | undefined; wake: () => void }[] = []
  const scheduler: Scheduler = {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        sleeps.push({ ms, signal, wake: resolve })
      }),
  }
  // The run index's bounded wait and the connection checks sleep too; only the idle timer's sleeps count here.
  const idle = () => sleeps.filter(({ ms }) => ms !== INDEX_WAIT_MS && ms !== CHECK_MS)
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { scheduler })
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  const first = await parkedWorker(o, sid)
  await waitFor(() => idle().length === 1, { what: "the idle timer" })
  expect(idle()[0]!.ms).toBe(7_200_000)
  expect(await say(o, actor, sid, "a")).toBe("one")
  expect((await parkedWorker(o, sid)).pid).toBe(first.pid)
  await waitFor(() => idle().length === 2, { what: "the next idle timer" })
  expect(idle().map(({ ms }) => ms)).toEqual([7_200_000, 7_200_000])
  expect(idle()[0]!.signal!.aborted).toBe(true)
  expect(idle()[1]!.signal!.aborted).toBe(false)
  idle()[1]!.wake()
  expect(await first.wait(10_000)).toBe(0)
  expect(o.registry.get(sid)).toBeUndefined()
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect((await parkedWorker(o, sid)).pid).not.toBe(first.pid)
  expect(o.kinds).toEqual(["chat", "advance", "advance"])
  expect(session(o, sid).run_ids).toHaveLength(1)
})

test("a parked worker killed between turns is not a death", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  for (const reply of ["one", "two"]) {
    const parked = await parkedWorker(o, sid)
    process.kill(-parked.pgid, "SIGKILL")
    await waitFor(() => o.registry.get(sid) === undefined, { what: "the killed worker gone" })
    expect(await say(o, actor, sid, reply)).toBe(reply)
  }
  expect(status(o, sid)).toBe("idle")
  expect(session(o, sid).run_ids).toHaveLength(1)
  expect(o.reused()).toBe(0)
})

test("a model switch closes the parked worker before the fresh runs spawn", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "on the second model" })
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  const { actor, sid } = await startActor(o)
  const parked = await parkedWorker(o, sid)
  o.office.store.updateSession(sid, { connection: "second", model: "stub-2" })
  expect(await say(o, actor, sid, "a")).toBe("on the second model")
  expect(o.kinds).toEqual(["chat", "chat"])
  expect(o.reused()).toBe(0)
  expect(parked.returncode).toBe(0)
  expect(session(o, sid).run_ids).toHaveLength(2)
  expect(o.logs.filter((line) => line.includes("WorkerExists"))).toEqual([])
})

test("end goes through the parked worker and the session ends", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid } = await startActor(o)
  const parked = await parkedWorker(o, sid)
  await actor.end()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(o.reused()).toBe(1)
  expect(o.jobs.at(-1)!.deliver.map((d) => d.op)).toEqual(["close"])
  expect(await parked.wait(10_000)).toBe(0)
  expect(o.registry.get(sid)).toBeUndefined()
})

test("over the cap a message goes as an advance false job and a raise advances on the parked worker", async () => {
  const fake = await fakeLlm()
  fake.script(free("after the raise"))
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  const parked = await parkedWorker(o, sid)
  // Over the company's $5 while idle at the turn.
  o.office.store.updateSession(sid, { cost: 6 })
  expect(await actor.prompt("hi")).toBe("queued")
  expect(o.jobs.at(-1)).toMatchObject({ kind: "advance", advance: false })
  expect(await parkedWorker(o, sid)).toBe(parked)
  expect(fake.requests()).toEqual([])
  await actor.setCostCap(20)
  await waitFor(() => texts(o, sid).includes("after the raise") && status(o, sid) === "idle", {
    what: "the reply after the raise",
  })
  expect(o.jobs.at(-1)).toMatchObject({ kind: "advance", advance: true })
  expect(o.reused()).toBe(2)
  expect(await parkedWorker(o, sid)).toBe(parked)
})

test("esc while the agent waits on a question interrupts through the parked worker", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "spare" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  const q = await card(o, sid, "ask_user")
  const parked = await parkedWorker(o, sid)
  const reused = o.reused()
  await actor.interrupt()
  const got = o.office.store.getQuestion(q.id)!
  expect([got.status, got.answer, got.answer_kind]).toEqual(["consumed", INTERRUPTED, "interrupted"])
  expect(o.jobs.at(-1)!.deliver.map((d) => d.op)).toEqual(["interrupt"])
  expect(o.reused()).toBe(reused + 1)
  await waitFor(() => status(o, sid) === "idle", { what: "the run at its next turn" })
  expect(await parkedWorker(o, sid)).toBe(parked)
})

test("the wake at timer advances on the parked worker", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [{ name: "ask_user", arguments: { question: "Which?", timeout: "1s" } }] },
    { content: "No answer, so A." },
  )
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  await card(o, sid, "ask_user")
  const parked = await parkedWorker(o, sid)
  const reused = o.reused()
  await waitFor(() => texts(o, sid).includes("No answer, so A.") && status(o, sid) === "idle", {
    what: "the reply after the timeout",
  })
  expect(o.reused()).toBe(reused + 1)
  expect(await parkedWorker(o, sid)).toBe(parked)
})

test("a delivery acked after a kept result is advanced on the parked worker", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const runId = actor.runId!
  const { worker, handlers, deliveries } = workers[0]!
  expect(workers[0]!.job.keep).toBe(true)
  const sent = actor.prompt("hi")
  await waitFor(() => deliveries.length === 1, { what: "the send" })
  handlers.result(worker, { ...waitingResult(runId), kept: true })
  // The run took the send after its result: nobody would move it now.
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[0]!.id, seq: 4 })
  await sent
  handlers.parked(worker)
  await waitFor(() => workers.length === 2, { what: "the re-advance" })
  expect(workers[1]!.worker).toBe(worker)
  expect(o.jobs[1]).toMatchObject({ kind: "advance", advance: true, deliver: [], keep: true })
  expect(status(o, sid)).toBe("busy")
})

test("a failed session releases its parked worker then runs its hard stop", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid } = await startActor(o)
  const runId = actor.runId!
  const parked = await parkedWorker(o, sid)
  await actor.fail()
  expect(status(o, sid)).toBe("failed")
  await actor.stopped
  expect(parked.returncode).toBe(0)
  expect(o.jobs.at(-1)).toMatchObject({ kind: "advance", run_id: runId, advance: false, deliver: [{ op: "cancel" }] })
  expect(o.logs.filter((line) => line.includes("can't be stopped"))).toEqual([])
  expect(o.registry.get(sid)).toBeUndefined()
})

test("an edited connection releases its sessions parked worker and leaves the others", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  const onOffice = await newSession(o)
  const onSecond = await newSession(o, { connection: "second" })
  for (const sid of [onOffice, onSecond]) {
    await makeActor(o, sid, { checkMs: 20 }).start()
    await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  }
  const rekeyed = await parkedWorker(o, onOffice)
  const kept = await parkedWorker(o, onSecond)
  // As `opencorp onboard` re-keys the office's connection, from outside the daemon.
  const provider = { llm_config: { ...LLM_CONFIG, api_key: "sk-rotated" }, env: fake.env() }
  await writePrivate(path.join(o.office.connections.dir, "office.json"), JSON.stringify(provider))
  expect(await rekeyed.wait(10_000)).toBe(0)
  expect(o.registry.get(onOffice)).toBeUndefined()
  // Several checks later, the other connection's worker is still parked.
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(o.registry.get(onSecond)).toBe(kept)
  expect(kept.parked).toBe(true)
})

test("a removed connection releases its sessions parked worker at once and leaves the others", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  const onOffice = await newSession(o)
  const onSecond = await newSession(o, { connection: "second" })
  const actors = []
  for (const sid of [onOffice, onSecond]) {
    const actor = makeActor(o, sid)
    actors.push(actor)
    await actor.start()
    await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  }
  const removed = await parkedWorker(o, onSecond)
  const kept = await parkedWorker(o, onOffice)
  await o.office.connections.remove("second")
  await Promise.all(actors.map((actor) => actor.connectionsChanged()))
  expect(removed.returncode).toBe(0)
  expect(o.registry.get(onSecond)).toBeUndefined()
  expect(o.registry.get(onOffice)).toBe(kept)
  expect(kept.parked).toBe(true)
})

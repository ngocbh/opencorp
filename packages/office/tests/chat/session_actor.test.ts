/** The session actor's host loop rules that have no Python test of their own. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { type Scheduler, SLEEP_CHUNK_MS } from "@ngocbh/yian/platform"
import type { LiveEvent } from "@opencorp/protocol"
import { INDEX_WAIT_MS, INTERRUPTED_CALL, type Wait } from "../../src/chat/session_actor.ts"
import { INTERRUPTED } from "../../src/questions/format.ts"
import { COULDNT_RESUME, COULDNT_START, ENDED_OVER_CAP, NEW_MODEL, WORKER_STOPPED } from "../../src/runs/outcomes.ts"
import { writePrivate } from "../../src/secrets.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { type Delivery, STOP_REASON } from "../../src/worker/job.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import { CEO } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
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
  fakeLlm,
  free,
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

test("esc answers an office call in flight", async () => {
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
  // The registry drops the worker at its exit; the actor's own exit job waits behind the update.
  await waitFor(() => calls > 0 && o.registry.get(sid) === undefined, { what: "the update and the worker's exit" })
  expect(status(o, sid)).not.toBe("ended")
  updated(true)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(calls).toBe(1)
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
  expect(calls).toBe(1)
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
  const failure = {
    node_id: "chat#0/reply",
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
  // The stop job reads the session's connection right after its log check, inside the exit's job.
  const { connections } = o.ctx
  const choice = connections.choice.bind(connections)
  let choices = 0
  connections.choice = (...args) => {
    choices += 1
    return choice(...args)
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
    const read = choices
    scripted.handlers.exited(scripted.worker, 0)
    // Queued after the exit: the exit job has run when it answers.
    await expect(actor.end()).rejects.toMatchObject({ status: 409, code: "not_live" })
    if (logged) {
      expect(choices).toBe(read + 1)
      await waitFor(() => o.kinds.length === before + 1, { what: "the cancel job" })
      expect(o.jobs.at(-1)).toMatchObject({ kind: "advance", advance: false, deliver: [{ op: "cancel" }] })
    } else {
      expect(choices).toBe(read)
      expect(o.kinds.length).toBe(before)
    }
  }
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
  await actor.prompt("hi")
  // The message's advance has its worker once the prompt returns.
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

/** A `not_resumed` result frame of run `runId`. */
function notResumed(runId: string): Record<string, unknown> {
  return { type: "result", status: "not_resumed", run_id: runId, error_type: "ResumeError" }
}

test("a not resumed advance starts a fresh run with the deliveries it never applied", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
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
  fresh.handlers.event(fresh.worker, { type: "event", name: "RunStarted", data: { run_id: runId } })
  await waitFor(() => o.office.store.getQuestion(open3.id)!.status === "stale", { what: "the stale question" })
  expect(o.office.store.getQuestion(card2.id)!.status).toBe("answered")
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

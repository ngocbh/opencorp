/** The session actor's host loop rules that have no Python test of their own. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import type { LiveEvent } from "@opencorp/protocol"
import { SessionActor } from "../../src/chat/session_actor.ts"
import { CEO } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  asleep,
  chatOffice,
  fakeLlm,
  makeActor,
  newSession,
  noWorkersLeft,
  say,
  scriptedWorker,
  session,
  startActor,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

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

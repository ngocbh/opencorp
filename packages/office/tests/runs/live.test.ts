/** What memory says about runs: each session actor's open nodes, its live run, and run.updated sent from them. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import type { RunUpdated } from "@opencorp/protocol"
import type { SessionActor } from "../../src/chat/session_actor.ts"
import { PING } from "../../src/daemon/bus.ts"
import { Live } from "../../src/runs/records.ts"
import { makeOffice, standInHarness } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  type ChatOffice,
  chatOffice,
  fakeLlm,
  makeActor,
  newSession,
  noWorkersLeft,
  scriptedWorker,
  status,
  TAKE,
  waitingResult,
} from "../chat/helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Makes `o`'s run.updated read `actor`'s live run, as the chat harness's `live` does. */
function liveFrom(o: ChatOffice, actor: SessionActor): void {
  o.office.harness = standInHarness({
    live: () => {
      const run = actor.liveRun()
      return new Live(run === null ? new Map() : new Map([[run.runId, run]]))
    },
  })
}

/** A reader of the run.updated `o`'s bus publishes from now on: each call returns every one so far. */
function updates(o: ChatOffice): () => Promise<RunUpdated[]> {
  const sub = o.office.bus.subscribe(null, { types: ["run.updated"] })
  const seen: RunUpdated[] = []
  return async () => {
    while (sub.queued > 0) {
      const item = await sub.next(0)
      if (item !== null && item !== PING) seen.push(item[1].data as RunUpdated)
    }
    return seen
  }
}

/** A new session's actor over `o` whose run changes go to the office's notifier, read from the actor's live run. */
async function liveActor(o: ChatOffice): Promise<{ actor: SessionActor; sid: string }> {
  const sid = await newSession(o)
  const actor = makeActor(o, sid, { runChanged: (id) => o.office.runChanged(id) })
  liveFrom(o, actor)
  return { actor, sid }
}

/** Whether `nodes` holds a reply node. */
function replying(nodes: readonly string[] | undefined): boolean {
  return (nodes ?? []).some((n) => n.endsWith("/reply"))
}

test("a runs open nodes are kept from its frames and sent", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello.", hold: true })
  const o = await chatOffice(fake)
  const { actor, sid } = await liveActor(o)
  const read = updates(o)
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  const runId = actor.runId!
  await actor.prompt("hi")
  await fake.waitForRequests(1, 30_000)
  await waitFor(() => replying(actor.liveRun()?.nodes), { what: "the reply's start" })
  expect(actor.liveRun()).toMatchObject({ runId, status: "running" })
  const sent = await waitFor(
    async () => {
      const got = (await read()).filter((u) => u.run_id === runId && replying(u.current_nodes))
      return got.length > 0 ? got : null
    },
    { what: "its run.updated" },
  )
  expect([sent[0]!.status, sent[0]!.session_id]).toEqual(["running", sid])
  fake.release()
  await waitFor(() => status(o, sid) === "idle", { what: "the next turn" })
  await waitFor(() => !replying(actor.liveRun()?.nodes), { what: "the reply's end" })
})

test("a new worker starts with no open nodes", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const old = workers[0]!
  old.handlers.event(old.worker, { type: "event", name: "NodeStarted", data: { node_id: "ghost" } })
  await waitFor(() => actor.liveRun()?.nodes.includes("ghost"), { what: "the node's start" })
  // Gone with no outcome: a plain advance takes over.
  old.handlers.exited(old.worker, null)
  await waitFor(() => workers.length === 2, { what: "the resumed worker" })
  expect(actor.liveRun()).toEqual({ runId: actor.runId!, status: "running", nodes: [] })
})

test("a run that has ended sends its end in its trailing event", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  scriptedWorker(o)
  const { actor } = await liveActor(o)
  const read = updates(o)
  await actor.start()
  const runId = actor.runId!
  await waitFor(async () => (await read()).length > 0, { what: "the start's run.updated" })
  // Within a second of the start's: coalesced, so the timer sends the trailing event, built after the end.
  await actor.fail()
  expect(actor.liveRun()).toBeNull()
  const last = await waitFor(
    async () => {
      const got = (await read()).at(-1)!
      return got.status === "running" ? null : got
    },
    { what: "the trailing event" },
  )
  expect(last).toMatchObject({ run_id: runId, status: "failed", current_nodes: [] })
})

test("office stop stops the run notifier", async () => {
  const office = makeOffice()
  const built: string[] = []
  office.runNotifier.changed("r", () => (built.push("r"), null))
  office.runNotifier.changed("r", () => (built.push("r again"), null)) // coalesced: arms the timer
  await office.stop()
  office.runNotifier.changed("s", () => (built.push("s"), null))
  expect(built).toEqual(["r"])
})

test("a fresh run shows no stale nodes before its worker starts", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const old = actor.runId!
  const first = workers[0]!
  first.handlers.event(first.worker, { type: "event", name: "NodeStarted", data: { node_id: "chat#0/reply" } })
  await waitFor(() => replying(actor.liveRun()?.nodes), { what: "the reply's start" })
  // The run can't be resumed: a fresh run replaces it, and its worker has sent nothing yet.
  const notResumed = { type: "result", status: "not_resumed", run_id: old, error_type: "RunLogError" }
  first.handlers.result(first.worker, notResumed)
  first.handlers.exited(first.worker, 0)
  await waitFor(() => workers.length === 2 && status(o, sid) === "busy", { what: "the fresh run's worker" })
  expect(actor.runId).not.toBe(old)
  expect(actor.liveRun()).toEqual({ runId: actor.runId!, status: "running", nodes: [] })
})

test("live run is the workers status and nodes and null without a worker", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const changed: string[] = []
  const actor = makeActor(o, sid, { runChanged: (id) => void changed.push(id) })
  expect(actor.liveRun()).toBeNull()
  await actor.start()
  const runId = actor.runId!
  expect(actor.liveRun()).toEqual({ runId, status: "running", nodes: [] })
  const { worker, handlers } = workers[0]!
  const n = changed.length
  handlers.event(worker, { type: "event", name: "NodeStarted", data: { node_id: "chat#0/reply" } })
  await waitFor(() => changed.length > n, { what: "the node's change" })
  expect(actor.liveRun()).toEqual({ runId, status: "running", nodes: ["chat#0/reply"] })
  handlers.event(worker, { type: "event", name: "NodeSucceeded", data: { node_id: "chat#0/reply" } })
  handlers.event(worker, { type: "event", name: "NodeWaiting", data: { node_id: "chat#1/heard", call_ids: ["c1"] } })
  handlers.result(worker, waitingResult(runId, [{ ...TAKE, node: "chat#1/heard" }]))
  await waitFor(() => status(o, sid) === "idle", { what: "the turn" })
  // At rest at its turn: the waiting node, not the open ones.
  expect(actor.liveRun()).toEqual({ runId, status: "idle", nodes: ["chat#1/heard"] })
  handlers.exited(worker, 0)
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  expect(actor.liveRun()).toBeNull()
  expect(new Set(changed)).toEqual(new Set([runId]))
})

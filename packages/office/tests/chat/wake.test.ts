/** Waking a sleeping session: one worker at a time, nothing lost (Python's `tests/chat/test_wake.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { SessionActor } from "../../src/chat/session_actor.ts"
import { writePrivate } from "../../src/secrets.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { newId } from "../../src/store/store.ts"
import { session as storedSession } from "../store/helpers.ts"
import { makeRegistry } from "../worker/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  ASKED,
  asleep,
  type ChatOffice,
  chatOffice,
  fakeLlm,
  followWorkers,
  makeActor,
  makeHarness,
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

/** Records the order in which `promise` and others like it settle under `name`. */
function track<T>(promise: Promise<T>, name: string, settled: string[]): Promise<T> {
  return promise.finally(() => settled.push(name))
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What a command settled with: its value, or the status and code of the error it was refused with. */
function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(String, (error) => `${error.status} ${error.code}`)
}

/** The office connection's file of `o`. */
function officeJson(o: ChatOffice): string {
  return path.join(o.office.paths.office, "connections", "office.json")
}

test("a waking run that cant start is dropped and its session kept", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "back" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  o.failNextSpawn()
  expect(await outcome(actor.prompt("hi"))).toBe("503 cant_wake")
  expect(status(o, sid)).toBe("idle")
  expect(actor.hasWorker).toBe(false)
  expect(await say(o, actor, sid, "again")).toBe("back")
})

test("a call after close all is refused as the office stopping", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  actor.close()
  await o.registry.closeAll()
  const { worker, handlers } = workers[0]!
  await expect(Promise.resolve().then(() => handlers.askUser(worker, ASKED, "c1"))).rejects.toThrow(
    "the office is stopping",
  )
  await expect(
    Promise.resolve().then(() => handlers.toolCall(worker, "workspace", "workspace_stub", {}, "c2")),
  ).rejects.toThrow("the office is stopping")
  expect(o.office.store.listQuestions({ sessionId: sid })).toEqual([])
})

test("a prompt wakes a sleeping session on its own run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const second = await reopen(o, first)
  const before = o.kinds.length
  expect(await say(o, second, sid, "b")).toBe("two")
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(session(o, sid).run_ids).toHaveLength(1)
  // The advanced run kept the conversation.
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("one")
})

test("two prompts to a sleeping session spawn one worker and both arrive", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "r1" }, { content: "r2" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const before = o.kinds.length
  const held = o.hold()
  const settled: string[] = []
  const a = track(actor.prompt("first"), "a", settled)
  await held.entered
  const b = track(actor.prompt("second"), "b", settled)
  await pause(200)
  // No message is answered before the wake has a worker.
  expect(settled).toEqual([])
  held.release()
  await Promise.all([a, b])
  await waitFor(() => {
    const all = JSON.stringify(fake.requests())
    return all.includes("first") && all.includes("second")
  }, { what: "both messages" })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(session(o, sid).run_ids).toHaveLength(1)
})

test("a prompt while the wake spawns waits for it and is delivered", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "r1" }, { content: "r2" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const held = o.hold()
  const settled: string[] = []
  const a = actor.prompt("first")
  await held.entered
  expect(o.registry.get(sid)).toBeUndefined()
  const b = track(actor.prompt("second"), "b", settled)
  await pause(200)
  // It waits for the wake, not on a session with no worker yet.
  expect(settled).toEqual([])
  held.release()
  await Promise.all([a, b])
  await waitFor(() => {
    const all = JSON.stringify(fake.requests())
    return all.includes("first") && all.includes("second")
  }, { what: "both messages" })
})

test("a steer to a sleeping session wakes it and is its next message", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "steered" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  await actor.steer("look here")
  await waitFor(() => JSON.stringify(texts(o, sid)) === JSON.stringify(["steered"]), { what: "the reply" })
  expect(texts(o, sid, "user")).toEqual(["look here"])
})

test("close all during a wake answers 503 and leaves the status", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "spare" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const held = o.hold()
  const sent = outcome(actor.prompt("hi"))
  await held.entered
  actor.close()
  const closing = o.registry.closeAll()
  held.release()
  expect(await sent).toBe("503 stopping")
  await closing
  expect(status(o, sid)).toBe("idle")
  expect(o.registry.get(sid)).toBeUndefined()
})

test.each([true, false])(
  "many callers on a sleeping session spawn one worker and every message arrives [%s]",
  async (held) => {
    const fake = await fakeLlm()
    fake.script(...Array.from({ length: 30 }, (_, i) => ({ content: `r${i}` })))
    const o = await chatOffice(fake)
    const { actor, sid } = await asleep(o)
    const ended: string[] = []
    o.hooks.sessionEnded.push((s) => void ended.push(s.id))
    const before = o.kinds.length
    const hold = held ? o.hold() : null
    const calls: [string, Promise<unknown>][] = [
      ...[0, 1, 2, 3, 4, 5].map((i): [string, Promise<unknown>] => [`prompt-${i}`, actor.prompt(`prompt-${i}`)]),
      ...[0, 1, 2].map((i): [string, Promise<unknown>] => [`steer-${i}`, actor.steer(`steer-${i}`)]),
      ["interrupt", actor.interrupt()],
    ]
    if (hold !== null) {
      await hold.entered
      await pause(300)
      hold.release()
    }
    const out = await Promise.all(calls.map(async ([name, call]) => [name, await call] as const))
    expect(o.kinds.slice(before)).toEqual(["advance"])
    expect(o.logs.filter((line) => line.includes("WorkerExists"))).toEqual([])
    const sent = out.filter(([name]) => name !== "interrupt")
    for (const [, got] of sent) expect(["turn", "queued", "steer"]).toContain(got as string)
    const accepted = sent.map(([name]) => name)
    // Not every message reaches a model request: the interrupt can stop the reply of the turn that took them.
    await waitFor(
      () => {
        const user = texts(o, sid, "user").join(" ")
        return accepted.every((text) => user.includes(text)) && status(o, sid) === "idle"
      },
      { what: "every accepted message" },
    )
    expect(ended).toEqual([])
  },
)

test("wakes racing close all leave the session to wake again", async () => {
  const fake = await fakeLlm()
  fake.script(...Array.from({ length: 30 }, (_, i) => ({ content: `r${i}` })))
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await waitFor(() => !first.hasWorker, { what: "the first worker to exit" })
  first.close()
  const ended: string[] = []
  o.hooks.sessionEnded.push((s) => void ended.push(s.id))
  for (let i = 0; i < 5; i++) {
    const registry = followWorkers(makeRegistry(o.office.store))
    const actor = new SessionActor({ ...o.ctx, workers: registry }, sid)
    o.actors.push(actor)
    const sends = [0, 1, 2].map((j) => outcome(actor.prompt(`m${i}-${j}`)))
    await pause([0, 20, 60, 150, 300][i]!)
    actor.close()
    await registry.closeAll()
    for (const got of await Promise.all(sends)) expect(["turn", "queued", "steer", "503 stopping"]).toContain(got)
    expect(registry.get(sid)).toBeUndefined()
    expect(["idle", "busy"]).toContain(status(o, sid))
    expect(ended).toEqual([])
  }
  // It still wakes.
  const last = makeActor(o, sid)
  await last.prompt("last")
  const heard = () => JSON.stringify(fake.requests().at(-1)?.messages ?? []).includes("last")
  await waitFor(() => heard() && status(o, sid) === "idle", { what: "the last message" })
})

test("interrupt on a sleeping session spawns nothing", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const before = o.kinds.length
  await actor.interrupt()
  expect(o.kinds.length).toBe(before)
  expect(actor.hasWorker).toBe(false)
  expect(status(o, sid)).toBe("idle")
})

test("end on a sleeping session runs its exit", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const ended: string[] = []
  o.hooks.sessionEnded.push((s) => void ended.push(s.status))
  await actor.end()
  await waitFor(() => status(o, sid) === "ended" && ended.length > 0, { what: "the end" })
  expect(ended).toEqual(["ended"])
  // The exit needs no reply.
  expect(fake.requests()).toEqual([])
})

test("an end that wakes the session turns a racing prompt away", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const held = o.hold()
  const ending = actor.end()
  await held.entered
  const late = outcome(actor.prompt("late"))
  held.release()
  await ending
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(await late).toBe("409 ending")
  expect(fake.requests()).toEqual([])
})

test("an end racing the prompt that wakes the session ends it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "spare" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const before = o.kinds.length
  const held = o.hold()
  const sent = outcome(actor.prompt("hi"))
  await held.entered
  const ending = outcome(actor.end())
  held.release()
  expect(await ending).toBe("undefined")
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  await sent
  expect(o.kinds.slice(before)).toEqual(["advance"])
})

test("a wake never resumes a session whose finish is in flight", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  const ended: string[] = []
  o.hooks.sessionEnded.push((s) => void ended.push(s.status))
  const { worker, handlers, deliveries } = workers[0]!
  handlers.event(worker, { type: "event", name: "NodeWaiting", data: { node_id: "chat#0/heard", call_ids: ["c1"] } })
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  await actor.end()
  expect(deliveries.map((d) => d.op)).toEqual(["close"])
  handlers.deliverReply(worker, { type: "deliver_reply", id: deliveries[0]!.id, seq: 2 })
  const succeeded = { type: "result", status: "succeeded", run_id: actor.runId, output: null, failure: null, waits: [] }
  handlers.result(worker, succeeded)
  handlers.exited(worker, 0)
  // Queued behind the exit, whose finish runs first.
  expect(await outcome(actor.prompt("late"))).toBe("409 not_live")
  expect(o.kinds).toEqual(["chat"])
  await waitFor(() => ended.length > 0, { what: "the session ended" })
  expect(ended).toEqual(["ended"])
  expect(status(o, sid)).toBe("ended")
})

test("a wake never resumes a session whose start is in flight", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "early reply" })
  const h = await makeHarness(fake)
  const held = h.hold()
  const starting = h.harness.startSession("minh", h.folder)
  await held.entered
  // The session and its actor exist from the store write: the prompt queues on the actor behind the start.
  const [stored] = h.store.listSessions()
  const prompted = outcome(h.harness.prompt(stored!.id, "early"))
  held.release()
  await starting
  expect(await prompted).toBe("queued")
  await waitFor(() => texts(h, stored!.id).includes("early reply") && status(h, stored!.id) === "idle", {
    what: "the reply",
  })
  expect(h.kinds).toEqual(["chat"])
})

test("a wake into a missing folder answers 422 and leaves the session idle", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { id } = await h.harness.startSession("minh", h.folder)
  await waitFor(() => status(h, id) === "idle", { what: "the first turn" })
  await h.reopen()
  const before = h.kinds.length
  fs.rmSync(h.folder, { recursive: true })
  expect(await outcome(h.harness.prompt(id, "hi"))).toBe("422 invalid_body")
  expect(status(h, id)).toBe("idle")
  expect(h.kinds.length).toBe(before)
})

test("a codex session is never woken as a composer one", async () => {
  // This harness has no Codex sessions to hand it to.
  const h = await makeHarness(await fakeLlm())
  const codex = h.store.createSession(
    storedSession({ harness: "codex", cwd: h.folder, repo_commit: await h.office.git.head() }),
  )
  h.store.addSessionRun(codex.id, newId())
  expect(await outcome(h.harness.prompt(codex.id, "hi"))).toBe("409 not_live")
  expect(h.kinds).toEqual([])
})

test("worker exit right after wake spawn is misread as stopping", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const before = o.kinds.length
  o.afterSpawn((worker) => {
    try {
      process.kill(-worker.pgid, "SIGKILL")
    } catch {}
  })
  expect(["queued", "turn"]).toContain(await actor.prompt("hi"))
  await waitFor(() => JSON.stringify(texts(o, sid)) === JSON.stringify(["one"]) && status(o, sid) === "idle", {
    what: "the reply",
  })
  // One respawn after the death, which kept the message.
  expect(o.kinds.slice(before)).toEqual(["advance", "advance"])
  expect(await say(o, actor, sid, "again")).toBe("two")
})

test("a wake whose provider cant resolve answers 503 and leaves the session idle", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "back" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  // Not private: the office's connection can't be read.
  fs.chmodSync(officeJson(o), 0o644)
  const questions = () => o.office.store.listQuestions({ sessionId: sid }).map((q) => [q.id, q.status])
  const asked = questions()
  const before = o.kinds.length
  expect(await outcome(actor.prompt("hi"))).toBe("503 cant_wake")
  expect(status(o, sid)).toBe("idle")
  expect(actor.hasWorker).toBe(false)
  expect(o.kinds.length).toBe(before)
  // Its cards are as they were, and no run was added.
  expect(questions()).toEqual(asked)
  expect(session(o, sid).run_ids).toHaveLength(1)
  // Fixed: the next message wakes it.
  fs.chmodSync(officeJson(o), 0o600)
  expect(await say(o, actor, sid, "hi")).toBe("back")
})

test("an end whose wake cant resolve fails the session", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  fs.chmodSync(officeJson(o), 0o644)
  expect(await outcome(actor.end())).toBe("503 cant_wake")
  expect(status(o, sid)).toBe("failed")
})

test("a wake whose fresh run cant spawn stays idle and the next wake starts fresh", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "b's reply" })
  const o = await chatOffice(fake, { llmConfig: { ...LLM_CONFIG, api_key: "sk-wake-one" } })
  const { actor, sid } = await asleep(o)
  // The key changed: the run's record no longer matches, so a fresh run replaces it.
  const llm_config = { ...LLM_CONFIG, api_key: "sk-wake-two" }
  await writePrivate(officeJson(o), JSON.stringify({ llm_config, env: fake.env(), prices: {} }))
  o.failNextSpawn()
  expect(await outcome(actor.prompt("a"))).toBe("503 cant_wake")
  expect(status(o, sid)).toBe("idle")
  expect(actor.hasWorker).toBe(false)
  const before = o.kinds.length
  expect(await say(o, actor, sid, "b")).toBe("b's reply")
  // The run that never started isn't resumed.
  expect(o.kinds.slice(before)).toEqual(["chat"])
  const runIds = session(o, sid).run_ids
  expect(runIds).toHaveLength(3)
  // Seeded from the first run, the newest that has a log.
  expect(o.jobs.at(-1)!.seed).toMatchObject({ log: path.join(o.office.paths.runs, runIds[0]!, "log.jsonl") })
})

test("an answered unread turn resumes at start", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "read it" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await asleep(o)
  // Over the cap the message only reaches the run's log: sent just before the office died, never read.
  o.office.store.updateSession(sid, { cost: 6 })
  expect(await first.prompt("hello")).toBe("queued")
  const actor = await reopen(o, first)
  o.office.store.updateSession(sid, { cost: 0 })
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.slice(before)).toEqual(["advance"])
  await waitFor(() => JSON.stringify(texts(o, sid)) === JSON.stringify(["read it"]), {
    what: "the reply to the unread message",
  })
  expect(JSON.stringify(fake.requests()[0]!.messages)).toContain("hello")
})

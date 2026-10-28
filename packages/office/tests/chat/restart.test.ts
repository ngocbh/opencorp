/** A new office picks each live session up from where yian's log says its run stands (Python's
 *  `tests/chat/test_restart.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { inspectRun } from "@ngocbh/yian/run"
import { now, Question } from "@opencorp/protocol"
import type { SessionActor } from "../../src/chat/session_actor.ts"
import type { LiveCalls } from "../../src/chat/transcript.ts"
import { COULDNT_RESUME, COULDNT_START, OFFICE_REPLACED } from "../../src/runs/outcomes.ts"
import { writePrivate } from "../../src/secrets.ts"
import { newId } from "../../src/store/store.ts"
import { LLM_CONFIG, type ScriptedReply } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import { sameProcess, startTime } from "../../src/install/proc.ts"
import { CEO } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import { makeRegistry } from "../worker/helpers.ts"
import {
  ASK_USER,
  asleep,
  card,
  type ChatOffice,
  chatOffice,
  EMPTY,
  fakeLlm,
  followWorkers,
  makeActor,
  makeHarness,
  newSession,
  noWorkersLeft,
  reopen,
  running,
  say,
  session,
  startActor,
  state,
  status,
  texts,
  unreadAtRestart,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** The office stops while `actor`'s worker runs: the actor closes, and the registry stops its worker, leaving the
 *  run stopped. Returns a new actor over the session, not yet restored. */
async function stopMidReply(o: ChatOffice, actor: SessionActor): Promise<SessionActor> {
  actor.close()
  await o.registry.close(actor.sessionId)
  return makeActor(o, actor.sessionId)
}

/** Sends `text` while the fake holds the reply's model call; resolves once the call arrived. */
async function heldReply(fake: Awaited<ReturnType<typeof fakeLlm>>, actor: SessionActor, text: string): Promise<void> {
  const before = fake.requests().length
  await actor.prompt(text)
  await fake.waitForRequests(before + 1, 30_000)
}

/** The office connection's file of `o`. */
function officeJson(o: ChatOffice): string {
  return path.join(o.office.paths.office, "connections", "office.json")
}

/** Whether the last model request of `fake` mentions `text`. */
function lastAsked(fake: Awaited<ReturnType<typeof fakeLlm>>, text: string): boolean {
  return JSON.stringify(fake.requests().at(-1)?.messages ?? []).includes(text)
}

test("restore leaves a run waiting at its turn asleep with no worker", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const runId = actor.runId
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(actor.hasWorker).toBe(false)
  expect(state(o, sid)).toEqual({ status: "idle", waiting_on: [], capped: false })
  expect(await say(o, actor, sid, "a")).toBe("one")
  expect(session(o, sid).run_ids).toEqual([runId!])
})

test("a message to a waiting run survives an office restart and is answered after it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "lost", hold: true }, { content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  const runId = first.runId!
  await heldReply(fake, first, "a")
  // Sent while the reply is held: the run's log has it.
  expect(await first.prompt("b")).toBe("steer")
  const actor = await stopMidReply(o, first)
  fake.release()
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.slice(before)).toEqual(["advance"])
  await waitFor(() => texts(o, sid).length >= 1 && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the replies after the restart",
  })
  await waitFor(() => fake.requests().some((r) => JSON.stringify(r.messages).includes("\\nb\\n")), {
    what: "the message reaching the model",
  })
  expect(texts(o, sid, "user")).toEqual(["a", "b"])
  expect(session(o, sid).run_ids).toEqual([runId])
})

test("restore advances a run with an answer that never reached it", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await first.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting" && !first.hasWorker, { what: "asleep on the question" })
  const actor = await reopen(o, first)
  // Stored just before the office died, so no complete took it to the run.
  o.office.store.answerQuestion(q.id, "A", "text", CEO)
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(o.jobs.at(-1)!.deliver).toMatchObject([{ op: "complete", call_id: q.call_id }])
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
  expect(o.office.store.getQuestion(q.id)!.status).toBe("consumed")
})

test("an answer that never reached a run over its cap goes with the advance a raise starts", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER, { content: "A it is." })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await first.prompt("hi")
  const q = await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting" && !first.hasWorker, { what: "asleep on the question" })
  const actor = await reopen(o, first)
  o.office.store.answerQuestion(q.id, "A", "text", CEO)
  // Over the company's $5 cap.
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(state(o, sid)).toMatchObject({ status: "waiting", capped: true })
  await actor.setCostCap(20)
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(o.jobs.at(-1)!).toMatchObject({ advance: true, deliver: [{ op: "complete", call_id: q.call_id }] })
  await waitFor(() => texts(o, sid).includes("A it is.") && status(o, sid) === "idle", { what: "the reply" })
})

test("a capped session is not advanced at restore", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "lost", hold: true }, { content: "back" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await heldReply(fake, first, "a")
  const actor = await stopMidReply(o, first)
  fake.release()
  // Over the company's $5 cap.
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(actor.hasWorker).toBe(false)
  expect(state(o, sid)).toEqual({ status: "waiting", waiting_on: [CEO], capped: true })
  await actor.setCostCap(20)
  expect(o.kinds.slice(before)).toEqual(["advance"])
  await waitFor(() => texts(o, sid).includes("back") && status(o, sid) === "idle", { what: "the resumed reply" })
})

test("restore reconciles a waiting runs questions with its pending calls", async () => {
  const fake = await fakeLlm()
  fake.script(ASK_USER)
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  const runId = first.runId!
  // The office died before it stored the model's question: the call is pending with none.
  const ask = spyOn(o.answers, "ask").mockImplementation((question) => question)
  await first.prompt("hi")
  await waitFor(() => fake.requests().length === 1 && !first.hasWorker, { what: "the run waiting on its call" })
  ask.mockRestore()
  expect(o.office.store.listQuestions({ sessionId: sid })).toEqual([])
  // And a question whose call the run no longer waits on.
  const t = now()
  const gone = o.office.store.addQuestion(
    Question.parse({
      id: newId(),
      session_id: sid,
      run_id: runId,
      node_id: null,
      call_id: `${runId}/gone`,
      source: "ask_user",
      asker: "minh",
      question: "Gone?",
      status: "open",
      created_at: t,
      updated_at: t,
    }),
  )
  const actor = await reopen(o, first)
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(o.office.store.getQuestion(gone.id)!.status).toBe("stale")
  const open = o.office.store.listQuestions({ sessionId: sid, status: "open" })
  expect(open.map((q) => [q.source, q.question])).toEqual([["ask_user", "Which?"]])
  expect(open[0]!.call_id!.startsWith(`${runId}/`)).toBe(true)
  expect(state(o, sid)).toEqual({ status: "waiting", waiting_on: [CEO], capped: false })
})

test("restore arms the wake at timer of a waiting run", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [{ name: "ask_user", arguments: { question: "Which?", timeout: "1s" } }] },
    { content: "No answer, so A." },
  )
  const o = await chatOffice(fake)
  // The first office's timer never fires.
  const frozen = {
    now: () => Date.now(),
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
  }
  const sid = await newSession(o)
  const first = makeActor(o, sid, { scheduler: frozen })
  await first.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  await first.prompt("hi")
  await card(o, sid, "ask_user")
  await waitFor(() => status(o, sid) === "waiting" && !first.hasWorker, { what: "asleep on the question" })
  first.close()
  // The office's own clock: the worker times the call out by the real time.
  const actor = makeActor(o, sid)
  const before = o.kinds.length
  await actor.restore()
  await waitFor(() => texts(o, sid).includes("No answer, so A.") && status(o, sid) === "idle", {
    what: "the reply after the timeout",
  })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(lastAsked(fake, "timed out: no answer")).toBe(true)
})

test("a run that ended while its session was live sleeps and its next message starts a fresh seeded run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const old = first.runId!
  await first.end()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  // The office died after the run ended, before the session's end was stored.
  o.office.store.updateSession(sid, { status: "idle" })
  const actor = await reopen(o, first)
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(state(o, sid)).toEqual({ status: "idle", waiting_on: [], capped: false })
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(o.kinds.slice(before)).toEqual(["chat"])
  const runIds = session(o, sid).run_ids
  expect(runIds).toEqual([old, actor.runId!])
  // The old run keeps yian's end; the fresh run links to it.
  expect(o.office.store.getRun(old)?.endReason ?? null).toBeNull()
  expect(o.office.store.getRun(actor.runId!)?.replacesRunId).toBe(old)
  expect(o.jobs.at(-1)!.seed).toMatchObject({ log: path.join(o.office.paths.runs, old, "log.jsonl") })
  // The fresh run carried the conversation.
  expect(lastAsked(fake, "one")).toBe(true)
})

test("a message over the cap to a session whose run yian ended is held for the fresh run a raise starts", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const old = first.runId!
  await first.end()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  // The office died after the run ended, before the session's end was stored.
  o.office.store.updateSession(sid, { status: "idle" })
  const actor = await reopen(o, first)
  // Over the company's $5 cap.
  o.office.store.updateSession(sid, { cost: 6 })
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(await actor.prompt("b")).toBe("queued")
  expect(o.kinds.length).toBe(before)
  expect(actor.hasWorker).toBe(false)
  expect(o.office.store.getRun(old)?.endReason ?? null).toBeNull()
  await actor.setCostCap(20)
  expect(o.kinds.slice(before)).toEqual(["chat"])
  await waitFor(() => texts(o, sid).includes("two") && status(o, sid) === "idle", { what: "the held message's reply" })
  expect(session(o, sid).run_ids).toEqual([old, actor.runId!])
  // The old run keeps yian's end; the fresh run links to it.
  expect(o.office.store.getRun(old)?.endReason ?? null).toBeNull()
  expect(o.office.store.getRun(actor.runId!)?.replacesRunId).toBe(old)
  expect(o.jobs.at(-1)!.seed).toMatchObject({ log: path.join(o.office.paths.runs, old, "log.jsonl") })
  // The fresh run carried the conversation and the held message.
  expect(lastAsked(fake, "one")).toBe(true)
  expect(lastAsked(fake, "\\nb\\n")).toBe(true)
})

test("an unreadable run log sleeps and its next message starts a fresh run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const old = first.runId!
  const actor = await reopen(o, first)
  // Emptied: yian can't inspect it.
  fs.writeFileSync(path.join(o.office.paths.runs, old, "log.jsonl"), "")
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(status(o, sid)).toBe("idle")
  expect(o.logs.some((line) => line.includes(sid) && line.includes("(RangeError)"))).toBe(true)
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(o.kinds.slice(before)).toEqual(["chat"])
  expect(session(o, sid).run_ids).toEqual([old, actor.runId!])
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
})

test("a run log that was never written sleeps and its next message starts a fresh run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  const old = first.runId!
  const actor = await reopen(o, first)
  // As a run whose worker never started it.
  fs.rmSync(path.join(o.office.paths.runs, old, "log.jsonl"))
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(status(o, sid)).toBe("idle")
  expect(await say(o, actor, sid, "a")).toBe("one")
  expect(o.kinds.slice(before)).toEqual(["chat"])
  expect(session(o, sid).run_ids).toEqual([old, actor.runId!])
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_START)
})

test("end on a restored session whose folder is gone fails it", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  for (const logged of [false, true]) {
    const s = await h.harness.startSession("minh", h.folder)
    await waitFor(() => status(h, s.id) === "idle" && !running(h.registry, s.id), { what: "the first turn" })
    const old = session(h, s.id).run_ids.at(-1)!
    const log = path.join(h.office.paths.runs, old, "log.jsonl")
    // Restore builds no run spec for a run with no log, nor for one whose log can't be read.
    if (logged) fs.writeFileSync(log, "")
    else fs.rmSync(log)
    await h.reopen()
    await h.harness.restore()
    expect(status(h, s.id)).toBe("idle")
    fs.renameSync(h.folder, `${h.folder}.moved`)
    try {
      await expect(h.harness.end(s.id)).rejects.toMatchObject({ status: 422 })
    } finally {
      fs.renameSync(`${h.folder}.moved`, h.folder)
    }
    expect(status(h, s.id)).toBe("failed")
    expect(h.store.getRun(old)?.endReason).toBe(logged ? COULDNT_RESUME : COULDNT_START)
  }
})

test("a session whose connection cant be resolved at restore still cancels its run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "slow", hold: true })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await heldReply(fake, first, "a")
  const runId = first.runId!
  const actor = await stopMidReply(o, first)
  // The connection file can't be used any more, as a removed sign-in.
  fs.chmodSync(officeJson(o), 0o644)
  const before = o.kinds.length
  await actor.restore()
  expect(status(o, sid)).toBe("failed")
  await waitFor(() => o.kinds.length === before + 1, { what: "the cancel job" })
  expect(o.jobs.at(-1)).toMatchObject({ kind: "advance", run_id: runId, advance: false, deliver: [{ op: "cancel" }] })
  const log = path.join(o.office.paths.runs, runId, "log.jsonl")
  await waitFor(() => inspectRun(log).status === "cancelled", { what: "the run cancelled" })
})

test("an ending session whose run yian ended ends at restore", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  const old = first.runId!
  await first.end()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  // The office died after the run succeeded, before the session's end was stored.
  o.office.store.updateSession(sid, { status: "ending" })
  const actor = await reopen(o, first)
  const ended: [string, string][] = []
  o.hooks.sessionEnded.push((s) => void ended.push([s.id, s.status]))
  const before = o.kinds.length
  await actor.restore()
  expect(status(o, sid)).toBe("ended")
  expect(o.kinds.length).toBe(before)
  expect(o.office.store.getRun(old)?.endReason ?? null).toBeNull()
  await waitFor(() => ended.length > 0, { what: "the session ended" })
  expect(ended).toEqual([[sid, "ended"]])
})

test("an ending session whose run yian failed ends at restore with yian's failure", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 500, hold: true })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  const old = first.runId!
  await heldReply(fake, first, "a")
  // The fresh run that would replace the failed reply's can't start: the failed run stays the session's.
  const resolve = spyOn(o.office.connections, "resolve").mockRejectedValue(new Error("the connection can't be read"))
  fake.release()
  await waitFor(() => status(o, sid) === "failed", { what: "the failed session" })
  resolve.mockRestore()
  // The office died after the run failed, before the session's end was stored.
  o.office.store.updateSession(sid, { status: "ending" })
  const actor = await reopen(o, first)
  const finished: (Frame | null)[] = []
  o.hooks.runFinished.push((_s, runId, frame) => void (runId === old && finished.push(frame)))
  await actor.restore()
  expect(status(o, sid)).toBe("failed")
  expect(o.office.store.getRun(old)?.endReason ?? null).toBeNull()
  await waitFor(() => finished.length > 0, { what: "the run finished" })
  // Yian's failure, in a worker result frame's form.
  expect(finished[0]).toMatchObject({ status: "failed", run_id: old, failure: { node_id: expect.any(String) } })
})

/** A started session whose run yian ended (its session's end was never stored, so it is idle), under a new actor not
 *  yet restored; `old` is that run. */
async function endedWhileLive(o: ChatOffice): Promise<{ actor: SessionActor; sid: string; old: string }> {
  const { actor: first, sid } = await startActor(o)
  const old = first.runId!
  await first.end()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  o.office.store.updateSession(sid, { status: "idle" })
  return { actor: await reopen(o, first), sid, old }
}

test("end on a session whose run yian ended ends it without a fresh run", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid, old } = await endedWhileLive(o)
  await actor.restore()
  const ended: string[] = []
  o.hooks.sessionEnded.push((s) => void ended.push(s.status))
  const before = o.kinds.length
  await actor.end()
  expect(status(o, sid)).toBe("ended")
  await waitFor(() => ended.length > 0, { what: "the session ended" })
  expect(ended).toEqual(["ended"])
  expect(o.kinds.length).toBe(before)
  expect(session(o, sid).run_ids).toEqual([old])
  expect(o.office.store.getRun(old)?.endReason ?? null).toBeNull()
})

test("fail on a session whose run yian ended writes no end reason", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid, old } = await endedWhileLive(o)
  await actor.restore()
  const ended: string[] = []
  o.hooks.sessionEnded.push((s) => void ended.push(s.status))
  const before = o.kinds.length
  await actor.fail()
  expect(status(o, sid)).toBe("failed")
  await waitFor(() => ended.length > 0, { what: "the session ended" })
  // Time for a hard stop's cancel job to have spawned.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(o.kinds.length).toBe(before)
  expect(o.office.store.getRun(old)?.endReason ?? null).toBeNull()
})

test("a question open on a run yian ended goes stale at restore and the session settles idle", async () => {
  const o = await chatOffice(await fakeLlm())
  const { actor, sid, old } = await endedWhileLive(o)
  // An office that died before it handled the call's close left its card open and the session waiting on it.
  const t = now()
  const open = o.office.store.addQuestion(
    Question.parse({
      id: newId(),
      session_id: sid,
      run_id: old,
      node_id: null,
      call_id: `${old}/ask`,
      source: "ask_user",
      asker: "minh",
      question: "Which?",
      status: "open",
      created_at: t,
      updated_at: t,
    }),
  )
  o.office.store.updateSession(sid, { status: "waiting", waiting_on: [CEO] })
  const before = o.kinds.length
  await actor.restore()
  expect(o.office.store.getQuestion(open.id)!.status).toBe("stale")
  expect(state(o, sid)).toEqual({ status: "idle", waiting_on: [], capped: false })
  expect(o.kinds.length).toBe(before)
})

test("restore fails a live session that never got a run", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor: other, sid } = await asleep(o)
  // The office died before its run.
  const orphan = await newSession(o)
  const ended: [string, string][] = []
  o.hooks.sessionEnded.push((s) => void ended.push([s.id, s.status]))
  const actor = makeActor(o, orphan)
  await Promise.all([actor.restore(), other.restore()])
  expect(status(o, orphan)).toBe("failed")
  await waitFor(() => ended.length > 0, { what: "the session ended" })
  expect(ended).toEqual([[orphan, "failed"]])
  expect(actor.hasWorker || other.hasWorker).toBe(false)
  expect(status(o, sid)).toBe("idle")
})

test("a restart on a changed connection carries history", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "lost", hold: true }, { content: "two" }, { content: "three" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const old = first.runId!
  await heldReply(fake, first, "b")
  const actor = await stopMidReply(o, first)
  fake.release()
  // The office's key changed while it was down: the run's record no longer gives what it ran on.
  const llm_config = { ...LLM_CONFIG, api_key: "sk-restart-two" }
  await writePrivate(officeJson(o), JSON.stringify({ llm_config, env: fake.env(), prices: {} }))
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.slice(before)).toEqual(["chat"])
  expect(session(o, sid).run_ids).toEqual([old, actor.runId!])
  expect(o.office.store.getRun(old)?.endReason).toBe(OFFICE_REPLACED)
  await waitFor(() => !actor.hasWorker && status(o, sid) === "idle", { what: "the fresh run at its turn" })
  await say(o, actor, sid, "c")
  expect(lastAsked(fake, "one")).toBe(true)
})

test("a resume refused after a tool spec change carries history", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "lost", hold: true }, { content: "two" }, { content: "three" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const old = first.runId!
  await heldReply(fake, first, "b")
  first.close()
  await o.registry.close(sid)
  fake.release()
  // The new office serves one more toolbox tool: yian refuses to resume the run with another tool spec.
  const extra = { description: "Does something new.", parameters: EMPTY, call: () => "ok" }
  const actor = makeActor(o, sid, {
    spec: async (s) => {
      const spec = await o.ctx.spec(s)
      return {
        ...spec,
        groups: (c) => {
          const built = spec.groups(c)
          return { ...built, toolbox: { ...built.toolbox, extra } }
        },
      }
    },
  })
  const before = o.kinds.length
  await actor.restore()
  await waitFor(() => o.kinds.length === before + 2 && !actor.hasWorker && status(o, sid) === "idle", {
    what: "the fresh run at its turn",
  })
  expect(o.kinds.slice(before)).toEqual(["advance", "chat"])
  expect(session(o, sid).run_ids).toEqual([old, actor.runId!])
  expect(o.office.store.getRun(old)?.endReason).toBe(COULDNT_RESUME)
  expect(o.jobs.at(-1)!.seed).toMatchObject({ log: path.join(o.office.paths.runs, old, "log.jsonl") })
  await say(o, actor, sid, "c")
  expect(lastAsked(fake, "one")).toBe(true)
})

test("restore twice does nothing the second time", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "lost", hold: true }, { content: "back" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await heldReply(fake, first, "a")
  const actor = await stopMidReply(o, first)
  fake.release()
  const before = o.kinds.length
  await actor.restore()
  await waitFor(() => texts(o, sid).includes("back") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the resumed reply",
  })
  await actor.restore()
  expect(o.kinds.slice(before)).toEqual(["advance"])
})

// Python's test_restart.py, in its words.

/** Kills `sid`'s live worker's process group, as a crash would. */
function kill(o: ChatOffice, sid: string): void {
  process.kill(-o.registry.get(sid)!.pgid, "SIGKILL")
}

/** An office tool, `block` in the toolbox (`groups`, for `chatOffice`), whose call never returns; `entered`
 *  resolves once it is called. */
function blocker(): { groups: Record<string, Record<string, OfficeTool>>; entered: Promise<void> } {
  let called!: () => void
  const entered = new Promise<void>((resolve) => (called = resolve))
  const block: OfficeTool = {
    description: "Blocks.",
    parameters: EMPTY,
    call: () => {
      called()
      return new Promise<never>(() => {})
    },
  }
  return { groups: { toolbox: { block } }, entered }
}

/** A model turn that calls `block`. */
const BLOCK: ScriptedReply = { tool_calls: [{ name: "block", arguments: {} }] }

/** Session `sid`'s assistant parts, each as its type and its text or state, with `live` giving the calls in
 *  flight. */
function parts(o: ChatOffice, sid: string, live?: LiveCalls): [string, string][] {
  return o.transcript
    .messages(sid, session(o, sid).run_ids, live)
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      message.parts.map((part): [string, string] =>
        part.type === "text" ? ["text", part.text] : [part.type, part.type === "tool" ? part.state : ""],
      ),
    )
}

test("a killed worker resumes the same run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "lost", hold: true }, { content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  const runId = actor.runId!
  await heldReply(fake, actor, "a")
  const before = o.kinds.length
  kill(o, sid)
  await waitFor(() => texts(o, sid).includes("one") && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the resumed reply",
  })
  // The advance resumed the run, which waits at its turn again.
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(state(o, sid)).toEqual({ status: "idle", waiting_on: [], capped: false })
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(session(o, sid).run_ids).toEqual([runId])
  expect(texts(o, sid, "user")).toContain("a")
})

test("a second kill in a row fails the session", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "lost", hold: true }, { content: "lost again", hold: true })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await heldReply(fake, actor, "a")
  const first = o.registry.get(sid)!
  const before = o.jobs.length
  kill(o, sid)
  await fake.waitForRequests(2, 30_000)
  expect(o.registry.get(sid)).not.toBe(first)
  kill(o, sid)
  await waitFor(() => status(o, sid) === "failed", { what: "the failure" })
  // The failure hard-stops the run with a cancel job the finish doesn't await, so only the respawns count.
  expect(o.jobs.slice(before).filter((job) => job.advance).map((job) => job.kind)).toEqual(["advance"])
  // Left open for the manager.
  const item = session(o, sid).work_item_id!
  expect(o.office.store.getWorkItem(item)!.status).toBe("in_progress")
})

test("a new office leaves an idle session asleep until its next message", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const actor = await reopen(o, first)
  // Left for the next office.
  expect(status(o, sid)).toBe("idle")
  const before = o.kinds.length
  await actor.restore()
  expect(o.kinds.length).toBe(before)
  expect(actor.hasWorker).toBe(false)
  expect(status(o, sid)).toBe("idle")
  // The message wakes it.
  expect(await say(o, actor, sid, "b")).toBe("two")
  expect(session(o, sid).run_ids).toHaveLength(1)
})

test("max turns counts turns from before a worker restart", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "lost", hold: true }, { content: "two" })
  const o = await chatOffice(fake, { defaults: { max_turns: 2 } })
  const { actor, sid } = await startActor(o)
  expect(await say(o, actor, sid, "a")).toBe("one")
  await heldReply(fake, actor, "b")
  kill(o, sid)
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
  expect(texts(o, sid)).toEqual(["one", "two"])
})

test("an office that dies mid turn is reaped and its run resumed", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "never seen", hold: true }, { content: "Resumed." })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  const runId = first.runId!
  await heldReply(fake, first, "a")
  const old = o.registry.get(sid)!
  // The office died: nothing of it acts on its worker again, which still holds the run.
  first.close()
  // The next office's registry.
  const actor = makeActor(o, sid, { workers: followWorkers(makeRegistry(o.office.store)) })
  // Its spawn reaps the dead office's worker, then resumes the run.
  await actor.restore()
  expect(await old.wait(10_000)).not.toBeNull()
  fake.release()
  await waitFor(() => texts(o, sid).at(-1) === "Resumed." && status(o, sid) === "idle", {
    what: "the resumed turn",
  })
  expect(session(o, sid).run_ids).toEqual([runId])
  expect(lastAsked(fake, "\\na\\n")).toBe(true)
})

test("a worker that cant start at a wake fails only that wake", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "for b" }, { content: "for a" })
  const o = await chatOffice(fake)
  const [one, two] = [await asleep(o), await asleep(o)]
  await Promise.all([one.actor.restore(), two.actor.restore()])
  o.failNextSpawn()
  await expect(one.actor.prompt("a")).rejects.toMatchObject({ status: 503, code: "cant_wake" })
  await waitFor(() => !one.actor.hasWorker, { what: "the failed wake" })
  expect(status(o, one.sid)).toBe("idle")
  expect(await say(o, two.actor, two.sid, "b")).toBe("for b")
  // The failed one wakes once it can.
  expect(await say(o, one.actor, one.sid, "a")).toBe("for a")
})

test("a session whose restore fails fails alone and the others restore", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "read it" })
  const h = await makeHarness(fake)
  const sids: string[] = []
  for (let i = 0; i < 3; i++) {
    const s = await h.harness.startSession("minh", h.folder)
    await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
    sids.push(s.id)
  }
  const [broken, resumed, idle] = sids as [string, string, string]
  // Two runs restore must advance, and one at its turn; the first's run can't be built.
  await unreadAtRestart(h, broken, resumed)
  const spec = h.harness.spec.bind(h.harness)
  spyOn(h.harness, "spec").mockImplementation(async (session) => {
    if (session.id === broken) throw new Error("the store can't read this session")
    return spec(session)
  })
  // Doesn't throw.
  await h.harness.restore()
  expect(status(h, broken)).toBe("failed")
  await waitFor(() => texts(h, resumed).includes("read it") && status(h, resumed) === "idle", {
    what: "the resumed reply",
  })
  expect(status(h, idle)).toBe("idle")
  expect(h.registry.get(idle)).toBeUndefined()
})

test("a worker that dies again after good turns resumes again", async () => {
  const fake = await fakeLlm()
  fake.script(
    { content: "lost", hold: true },
    { content: "r0" },
    { content: "r1" },
    { content: "r2" },
    { content: "lost again", hold: true },
    { content: "r3" },
  )
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await heldReply(fake, actor, "t0")
  kill(o, sid)
  await waitFor(() => texts(o, sid).includes("r0") && status(o, sid) === "idle", { what: "the resume" })
  expect(await say(o, actor, sid, "t1")).toBe("r1")
  expect(await say(o, actor, sid, "t2")).toBe("r2")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  await heldReply(fake, actor, "t3")
  kill(o, sid)
  await waitFor(() => texts(o, sid).at(-1) === "r3" && status(o, sid) === "idle", { what: "the second resume" })
  expect(texts(o, sid)).toEqual(["r0", "r1", "r2", "r3"])
})

test("a session ending when the office stops ends after restore", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "slow", hold: true }, { content: "done" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  await heldReply(fake, first, "a")
  // The office stops before the worker sees the end.
  o.registry.get(sid)!.deliver = async () => true
  await first.end()
  expect(status(o, sid)).toBe("ending")
  const actor = await stopMidReply(o, first)
  fake.release()
  await actor.restore()
  await waitFor(() => status(o, sid) === "ended", { what: "the end" })
})

test("a killed worker leaves no part unfinished", async () => {
  const fake = await fakeLlm()
  const gate = blocker()
  fake.script(BLOCK, { content: "Done.", hold: true })
  const o = await chatOffice(fake, { groups: gate.groups })
  const { actor, sid } = await startActor(o)
  await actor.prompt("a")
  await gate.entered
  expect(parts(o, sid, actor)).toEqual([["tool", "running"]])
  kill(o, sid)
  // The resumed run closed the call its crash cut; its next model call is the live reply, empty until it streams.
  await fake.waitForRequests(2, 30_000)
  const resumed = JSON.stringify([
    ["tool", "interrupted"],
    ["text", ""],
  ])
  // The live reply opens when its model call's event reaches the actor, which may follow the request.
  await waitFor(() => JSON.stringify(parts(o, sid, actor)) === resumed, { what: "the resumed reply" })
  fake.release()
  await waitFor(() => status(o, sid) === "idle" && texts(o, sid).includes("Done."), { what: "the reply" })
  expect(parts(o, sid, actor)).toEqual([
    ["tool", "interrupted"],
    ["text", "Done."],
  ])
})

test("a stopping office leaves no part unfinished", async () => {
  const fake = await fakeLlm()
  const gate = blocker()
  fake.script(BLOCK, { content: "never seen", hold: true })
  const o = await chatOffice(fake, { groups: gate.groups })
  const { actor, sid } = await startActor(o)
  await actor.prompt("a")
  await gate.entered
  // The registry's stop reaches the worker before the closed actor's answer to the call, so the call gets no result.
  await stopMidReply(o, actor)
  expect(parts(o, sid, actor)).toEqual([["tool", "interrupted"]])
})

test("restore interrupts tool parts a dead office left running", async () => {
  const fake = await fakeLlm()
  const gate = blocker()
  fake.script(BLOCK, { content: "Resumed." })
  const o = await chatOffice(fake, { groups: gate.groups })
  const { actor: first, sid } = await startActor(o)
  await first.prompt("a")
  await gate.entered
  // The office died, and its worker with it.
  first.close()
  kill(o, sid)
  await waitFor(() => o.registry.get(sid) === undefined, { what: "the worker gone" })
  // Nothing runs the run, so the log's call with no result is cut.
  expect(parts(o, sid)).toEqual([["tool", "interrupted"]])
  const actor = makeActor(o, sid)
  await actor.restore()
  await waitFor(() => status(o, sid) === "idle" && texts(o, sid).includes("Resumed."), { what: "the resumed reply" })
  expect(parts(o, sid, actor)).toEqual([
    ["tool", "interrupted"],
    ["text", "Resumed."],
  ])
})

test("an office restarted while workers were parked reaps them and restores each session", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const started = [await startActor(o), await startActor(o)]
  const parked: { pid: number; started: number | null }[] = []
  for (const { sid } of started) {
    await waitFor(() => o.registry.get(sid)?.parked === true, { what: "the worker to park" })
    const { pid } = o.registry.get(sid)!
    parked.push({ pid, started: startTime(pid) })
  }
  // The office died: a new office has its own registry and actors, while the old workers still run.
  const registry = o.newRegistry()
  const actors = started.map(({ sid }) => makeActor(o, sid, { workers: registry }))
  for (const actor of actors) await actor.restore()
  for (const [i, reply] of ["one", "two"].entries()) {
    const sid = started[i]!.sid
    expect(await say(o, actors[i]!, sid, reply)).toBe(reply)
    expect(session(o, sid).run_ids).toHaveLength(1)
    expect(sameProcess(parked[i]!.pid, parked[i]!.started!)).toBe(false)
  }
})

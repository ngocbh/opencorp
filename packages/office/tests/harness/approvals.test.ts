/** Codex requests as cards: store, then reply; first answer wins; stale when Codex no longer waits. */
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { type Part, QuestionPage } from "@opencorp/protocol"
import { HarnessError } from "../../src/chat/state.ts"
import type { CodexProcess } from "../../src/harness/codex.ts"
import { masked } from "../../src/harness/sessions.ts"
import { killGroup, sameProcess } from "../../src/install/proc.ts"
import { DuplicateKey, StoreError } from "../../src/store/store.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
import { question } from "../store/helpers.ts"
import { type Codex, allGone, approvalTurn, makeCodex, messages, openCard, start, status } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

const SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"
const SID = "01M53FTBYV710JBB471KEBQDVC"

/** A JSON-RPC error reply's code. */
const code = (reply: unknown) => (reply as { code: number }).code

test("an approval is an open card on a waiting session", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  expect([q.source, q.run_id, q.node_id, q.asker, q.options[0]]).toEqual(["harness", "turn_1", "1", "minh", "Approve"])
  // Someone must answer it.
  await waitFor(() => status(h, sid) === "waiting", { what: "waiting on the card" })
})

test("a request no card can be made from gets a json rpc error", async () => {
  const h = makeCodex()
  const broken = fc.commandApproval(3, "c1", "touch a")
  // Not as the pinned schema says: Codex would otherwise wait on it until Esc.
  delete broken.params.itemId
  h.fake.script([[broken]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  await waitFor(() => 3 in h.fake.replies(), { what: "the error reply" })
  expect(code(h.fake.replies()[3])).toBe(-32603)
  await waitFor(() => status(h, sid) === "idle", { what: "Codex going on" })
  expect(h.store.listQuestions({ sessionId: sid })).toEqual([])
})

test("a card the store refuses is an error reply and the turn still ends", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandApproval(1, "c1", "touch a", { wait: false }), { sleep: 0.3 }]])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  spyOn(h.store, "addQuestion").mockImplementation((q) => {
    throw new DuplicateKey(`question ${q.run_id}/${q.node_id} exists`)
  })
  await h.sessions.prompt(sid, "make a")
  await waitFor(() => 1 in h.fake.replies(), { what: "the error reply" })
  expect(code(h.fake.replies()[1])).toBe(-32603)
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  expect(live.requests.size === 0 && live.byRequest.size === 0).toBe(true)
  // A card that is gone expires quietly.
  h.sessions.event(live, { type: "request_resolved", key: "no-such-question" })
  expect(h.lines).toContain(`codex session ${sid}: card no-such-question is gone`)
})

test("turnless cards of two app servers with one pid dont collide", async () => {
  const h = makeCodex()
  const step = fc.urlElicitation(8, "gh", "Sign in", "https://e.com/l", { wait: false })
  h.fake.script([[step, { sleep: 5 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "sign in")
  const first = await openCard(h, sid)
  const live = h.sessions.get(sid)!
  const real = live.process!
  const errors: [unknown, number][] = []
  // A later app-server of this session that got the same pid, and numbers its requests from the same start.
  const twin = {
    pid: real.pid,
    alive: true,
    rpc: { replyError: async (id: unknown, code: number) => void errors.push([id, code]) },
  } as unknown as CodexProcess
  live.process = twin
  try {
    live.requested(twin, 8, step.request, fc.fill(step.params, "", h.workspace, "thr_1"))
    await live.post("ran", () => {})
  } finally {
    live.process = real
  }
  const cards = h.store.listQuestions({ sessionId: sid, status: "open" })
  expect(errors).toEqual([])
  expect(cards).toHaveLength(2)
  expect(new Set(cards.map((q) => q.run_id)).size).toBe(2)
  expect(cards.every((q) => q.run_id.startsWith("codex-"))).toBe(true)
  expect(cards.map((q) => q.id)).toContain(first.id)
})

/** The tool parts of the session's messages, from the live events. */
function toolParts(h: Codex, sid: string): Extract<Part, { type: "tool" }>[] {
  return messages(h, sid).flatMap((m) => m.parts.flatMap((p) => (p.type === "tool" ? [p] : [])))
}

test("an approvals answer is codexs reply and its resolved leaves the card consumed", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  expect((await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })).status).toBe("consumed")
  await waitFor(() => Bun.deepEquals(h.fake.replies()[1], { decision: "accept" }), { what: "the reply" })
  await waitFor(
    () => h.fake.messages("out").some((m) => m.method === "serverRequest/resolved" && m.params.requestId === 1),
    { what: "Codex's resolved" },
  )
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  const got = h.store.getQuestion(q.id)!
  expect([got.status, got.answer, got.answered_by]).toEqual(["consumed", "Approve", "ngocbh"])
  const [part, ...more] = toolParts(h, sid)
  expect(more).toEqual([])
  expect(part!.input.approval).toEqual({ decision: "accept", by: "ngocbh" })
  expect(part!.state).toBe("completed")
})

test("an answer no reply can be made from tells codex it failed", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  // No Cards here to check it first, as on a route without them: "Maybe" isn't one of the options.
  expect((await h.sessions.answer(q.id, "Maybe", "option", { by: "ngocbh" })).status).toBe("stale")
  await waitFor(() => 1 in h.fake.replies(), { what: "the error reply" })
  expect(code(h.fake.replies()[1])).toBe(-32602)
  await waitFor(() => status(h, sid) === "idle", { what: "Codex going on" })
  expect(toolParts(h, sid).every((p) => !("approval" in p.input))).toBe(true)
})

test("an answer with no named sender is the openers", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace, "ngocbh")
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  expect((await h.sessions.answer(q.id, "Approve", "option")).answered_by).toBe("ngocbh")
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  const [part, ...more] = toolParts(h, sid)
  expect(more).toEqual([])
  expect((part!.input.approval as { by: string }).by).toBe("ngocbh")
})

test("two answerers make one reply", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  const results = await Promise.allSettled(
    ["Approve", "Deny and stop"].map((c) => h.sessions.answer(q.id, c, "option", { by: "ngocbh" })),
  )
  const outcomes = results.map((r) =>
    r.status === "fulfilled" ? r.value.status : r.reason instanceof HarnessError ? r.reason.code : r.reason,
  )
  expect(outcomes.sort()).toEqual(["consumed", "not_open"])
  await waitFor(() => 1 in h.fake.replies(), { what: "the one reply" })
  expect(h.fake.messages().filter((m) => m.id === 1 && !("method" in m))).toHaveLength(1)
  // What Codex got is what the store kept.
  const stored = h.store.getQuestion(q.id)!.answer as string
  expect(h.fake.replies()[1]).toEqual({
    decision: ({ Approve: "accept", "Deny and stop": "cancel" } as Record<string, string>)[stored],
  })
})

test("an answer that codex resolved first goes stale with no reply", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandApproval(1, "c1", "touch a", { wait: false }), { sleep: 5 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  const live = h.sessions.get(sid)!
  const answerQuestion = h.store.answerQuestion.bind(h.store)
  // Codex resolves between the store and the reply.
  spyOn(h.store, "answerQuestion").mockImplementation((...args) => {
    const got = answerQuestion(...args)
    live.notified(live.process!, "serverRequest/resolved", { requestId: 1 })
    return got
  })
  expect((await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })).status).toBe("stale")
  expect(1 in h.fake.replies()).toBe(false)
  expect(toolParts(h, sid).every((p) => !("approval" in p.input))).toBe(true)
})

test("an answer after the app server died goes stale", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  const live = h.sessions.get(sid)!
  const w = h.store.listWorkers()[0]!
  if (sameProcess(w.pid, w.startTime)) killGroup(w.pgid)
  await waitFor(() => !live.process || !live.process.alive, { what: "death" })
  try {
    expect((await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })).status).toBe("stale")
  } catch (error) {
    // The app-server's exit expired the card first.
    if (!(error instanceof HarnessError)) throw error
    expect(error.code).toBe("not_open")
  }
  expect(1 in h.fake.replies()).toBe(false)
})

test("an unanswered card goes stale when codex resolves it", async () => {
  const h = makeCodex()
  h.fake.script([
    [fc.commandApproval(1, "c1", "touch a", { wait: false }), { sleep: 0.3 }, { resolve: 1 }, { sleep: 5 }],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  await waitFor(() => h.store.getQuestion(q.id)?.status === "stale", { what: "stale" })
  // The turn goes on.
  await waitFor(() => status(h, sid) === "busy", { what: "busy" })
})

test("a card codex left waiting at its turns end goes stale", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandApproval(1, "c1", "touch a", { wait: false }), { sleep: 0.3 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  expect(h.fake.messages("out").some((m) => m.method === "serverRequest/resolved")).toBe(false)
  await waitFor(() => h.store.getQuestion(q.id)?.status === "stale", { what: "stale" })
})

test("an unserved request gets a json rpc error", async () => {
  const h = makeCodex()
  const params = { threadId: "{thread}", turnId: "{turn}", callId: "x", namespace: null, tool: "t", arguments: {} }
  h.fake.script([[{ request: "item/tool/call", id: 9, wait: true, params }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => 9 in h.fake.replies(), { what: "the error reply" })
  expect(code(h.fake.replies()[9])).toBe(-32601)
  await waitFor(() => status(h, sid) === "idle", { what: "Codex going on" })
  expect(h.store.listQuestions({ sessionId: sid })).toEqual([])
})

test("an answer that waited too long for its reply tells codex it came too late", async () => {
  const h = makeCodex({ replyWaitMs: 200 })
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  const live = h.sessions.get(sid)!
  let begin!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => (begin = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  // The session's queue is busy past the answer's wait.
  void live.post("hold", async () => {
    begin()
    await released
  })
  await began
  expect((await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })).status).toBe("stale")
  release()
  await waitFor(() => 1 in h.fake.replies(), { what: "the error reply" })
  // With no card left, Codex mustn't wait on one.
  expect(code(h.fake.replies()[1])).toBe(-32603)
  await waitFor(() => status(h, sid) === "idle", { what: "Codex going on" })
  expect(live.requests.size).toBe(0)
  expect(h.store.getQuestion(q.id)!.status).toBe("stale")
})

test("on a card with a secret only what is known to be safe is stored", () => {
  const pages = [
    { question: "Paste it", header: "Token", options: [], secret: true },
    QuestionPage.parse({ question: "Where?", header: "Env", options: [] }),
  ]
  const secretCard = question(SID, { source: "harness", questions: pages })
  expect(masked(secretCard, { Token: SENTINEL, Env: "dev" })).toEqual({ Token: "[secret]", Env: "dev" })
  expect(masked(secretCard, { Env: "dev", Tokn: SENTINEL })).toEqual({ Env: "dev", Tokn: "[secret]" })
  expect(masked(secretCard, SENTINEL)).toBe("[secret]")
  expect(masked(secretCard, [SENTINEL])).toBe("[secret]")
  const plain = question(SID, { source: "harness", questions: [pages[1]!] })
  expect(masked(plain, { Env: "dev", Other: "x" })).toEqual({ Env: "dev", Other: "x" })
  expect(masked(question(SID, { source: "harness", options: ["Approve"] }), "Approve")).toBe("Approve")
})

test("a card that cant be marked consumed after the reply still answers", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  const set = h.store.setQuestionStatus.bind(h.store)
  spyOn(h.store, "setQuestionStatus").mockImplementation((id, to) => {
    if (to === "consumed") throw new StoreError("the disk is full")
    return set(id, to)
  })
  // Codex has the reply: the answer stands, as answered, rather than failing the request.
  expect((await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })).status).toBe("answered")
  await waitFor(() => Bun.deepEquals(h.fake.replies()[1], { decision: "accept" }), { what: "the reply" })
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  const [part, ...more] = toolParts(h, sid)
  expect(more).toEqual([])
  expect(part!.input.approval).toEqual({ decision: "accept", by: "ngocbh" })
  expect(h.lines).toContain(`codex session ${sid}: card ${q.id} wasn't marked consumed (StoreError)`)
})

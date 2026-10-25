/** Codex requests as cards: store, then reply; first answer wins; stale when Codex no longer waits. */
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { QuestionPage } from "@opencorp/protocol"
import type { CodexProcess } from "../../src/harness/codex.ts"
import { masked } from "../../src/harness/sessions.ts"
import { DuplicateKey } from "../../src/store/store.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
import { question } from "../store/helpers.ts"
import { allGone, approvalTurn, makeCodex, openCard, start, status } from "./helpers.ts"

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

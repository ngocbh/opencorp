/** Codex requests as cards: store, then reply; first answer wins; stale when Codex no longer waits. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { type Part, QuestionPage } from "@opencorp/protocol"
import { HarnessError } from "../../src/chat/state.ts"
import type { CodexProcess } from "../../src/harness/codex.ts"
import { masked } from "../../src/harness/sessions.ts"
import { register } from "../../src/extensions/questions.ts"
import { killGroup, sameProcess } from "../../src/install/proc.ts"
import { DuplicateKey, type QuestionRecord, StoreError } from "../../src/store/store.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
import { question } from "../store/helpers.ts"
import {
  type Codex,
  allGone,
  approvalTurn,
  codexLog,
  makeCodex,
  messages,
  openCard,
  start,
  status,
} from "./helpers.ts"

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

test("an approval answered after a steer lands on the commands part", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a", { by: "ngocbh" })
  const q = await openCard(h, sid)
  expect(await h.sessions.prompt(sid, "and b", { by: "ngocbh" })).toBe("steer")
  await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  expect(toolParts(h, sid).map((p) => [p.state, (p.input.approval as { decision: string }).decision])).toEqual([
    ["completed", "accept"],
  ])
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

test("office stop makes an answer waiting for its reply give up at once", async () => {
  const h = makeCodex({ stopWaitMs: 200 })
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  const live = h.sessions.get(sid)!
  let begin!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => (begin = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  // A job the stop can't wait out, with the reply's job queued behind it.
  void live.post("hold", async () => {
    begin()
    await released
  })
  await began
  // No await comes between the answer's store write and its reply job's post, so the job is queued now.
  const answering = h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" })
  try {
    expect(h.store.getQuestion(q.id)!.status).toBe("answered")
    await h.sessions.closeAll()
    expect((await answering).status).toBe("stale")
  } finally {
    release()
  }
  expect(1 in h.fake.replies()).toBe(false)
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
  expect(sameProcess(w.pid, w.startTime)).toBe(true)
  killGroup(w.pgid)
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

/** The session's open cards by node id. */
function openByNode(h: Codex, sid: string): Record<string, QuestionRecord> {
  return Object.fromEntries(h.store.listQuestions({ sessionId: sid, status: "open" }).map((q) => [q.node_id, q]))
}

test("two cards open and close independently and a message leaves them alone", async () => {
  const h = makeCodex()
  h.fake.script([
    [
      fc.commandApproval(1, "c1", "touch a", { wait: false }),
      fc.permissionsApproval(2, "p1", { wait: false }),
      { wait_reply: 1 },
      { wait_reply: 2 },
    ],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => h.store.listQuestions({ sessionId: sid, status: "open" }).length === 2, { what: "two cards" })
  expect(await h.sessions.prompt(sid, "also do b")).toBe("steer")
  const byNode = openByNode(h, sid)
  const second = await h.sessions.answer(byNode["2"]!.id, "Approve for this session", "option", { by: "ngocbh" })
  expect(second.status).toBe("consumed")
  expect(h.store.getQuestion(byNode["1"]!.id)!.status).toBe("open")
  expect((await h.sessions.answer(byNode["1"]!.id, "Approve", "option", { by: "ngocbh" })).status).toBe("consumed")
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  expect((h.fake.replies()[2] as { scope: string }).scope).toBe("session")
  expect(h.fake.replies()[1]).toEqual({ decision: "accept" })
})

test("esc makes open cards stale though codex never resolves them", async () => {
  const h = makeCodex()
  h.fake.script([approvalTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "make a")
  const q = await openCard(h, sid)
  const live = h.sessions.get(sid)!
  const notified = live.notified.bind(live)
  // Real Codex sends no serverRequest/resolved for a request an interrupt leaves waiting; the fake does.
  spyOn(live, "notified").mockImplementation((p, m, params) => {
    if (m !== "serverRequest/resolved") notified(p, m, params)
  })
  await h.sessions.interrupt(sid)
  await waitFor(() => h.store.getQuestion(q.id)!.status === "stale" && status(h, sid) === "idle", {
    what: "stale card, idle session",
  })
  const refused = await h.sessions.answer(q.id, "Approve", "option", { by: "ngocbh" }).catch((error) => error)
  expect(refused).toBeInstanceOf(HarnessError)
  expect(refused.code).toBe("not_open")
  expect(1 in h.fake.replies()).toBe(false)
})

/** The secret test's two pages: a secret token and a plain choice. */
const PAGES = [
  fc.question("token", "Token", "Paste it", { secret: true }),
  fc.question("env", "Env", "Where?", { options: ["prod", "dev"] }),
]

/** Throws unless no store file (the WAL included) holds SENTINEL; there are at least two of them. */
function storeLacksSentinel(h: Codex): void {
  const store = h.office.paths.store
  const dir = path.dirname(store)
  // The store runs in WAL mode: the secret could sit in the -wal file before a checkpoint.
  const files = fs.readdirSync(dir).filter((name) => name.startsWith(path.basename(store)))
  expect(files.length).toBeGreaterThanOrEqual(2)
  for (const name of files) expect(fs.readFileSync(path.join(dir, name)).includes(SENTINEL)).toBe(false)
}

test("a secret answer reaches codex and never the store", async () => {
  const h = makeCodex()
  h.fake.script([[fc.userInput(4, "u1", PAGES)]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "deploy")
  const q = await openCard(h, sid)
  expect(q.questions!.map((p) => p.secret)).toEqual([true, false])
  const got = await h.sessions.answer(q.id, { Token: SENTINEL, Env: "dev" }, "text", { by: "ngocbh" })
  expect([got.status, got.answer]).toEqual(["consumed", { Token: "[secret]", Env: "dev" }])
  const reply = { answers: { token: { answers: [SENTINEL] }, env: { answers: ["dev"] } } }
  await waitFor(() => Bun.deepEquals(h.fake.replies()[4], reply), { what: "the reply" })
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  expect(h.store.getQuestion(q.id)!.answer).toEqual({ Token: "[secret]", Env: "dev" })
  storeLacksSentinel(h)
  expect(codexLog(h, sid)).not.toContain(SENTINEL)
  expect(JSON.stringify(h.storeEvents)).not.toContain(SENTINEL)
  expect(JSON.stringify(h.events)).not.toContain(SENTINEL)
  expect(JSON.stringify(h.sessions.currentTurn(sid))).not.toContain(SENTINEL)
  expect(h.lines.join("\n")).not.toContain(SENTINEL)
})

test("a secret answer no reply can be made from is in no log error or reply", async () => {
  const h = makeCodex()
  h.fake.script([
    [
      fc.userInput(4, "u1", PAGES, { wait: false }),
      fc.userInput(5, "u2", PAGES, { wait: false }),
      { wait_reply: 4 },
      { wait_reply: 5 },
    ],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "deploy")
  await waitFor(() => h.store.listQuestions({ sessionId: sid, status: "open" }).length === 2, { what: "two cards" })
  const byNode = openByNode(h, sid)
  // No cards to check it first: a string isn't a record, so no reply can be made from it.
  const got = await h.sessions.answer(byNode["4"]!.id, SENTINEL, "text", { by: "ngocbh" })
  expect([got.status, got.answer]).toEqual(["stale", null])
  await waitFor(() => 4 in h.fake.replies(), { what: "the error reply" })
  expect(code(h.fake.replies()[4])).toBe(-32602)
  expect(JSON.stringify(h.fake.replies()[4])).not.toContain(SENTINEL)
  h.office.harness = h.sessions
  register(h.office)
  const cards = h.office.cards!
  try {
    const refused = await cards
      .answer(byNode["5"]!.id, { Token: SENTINEL, Env: "nope" }, "text", { by: "ngocbh" })
      .catch((error) => error)
    expect(refused).toBeInstanceOf(HarnessError)
    expect([refused.status, refused.code]).toEqual([422, "invalid_answer"])
    expect(refused.message).not.toContain(SENTINEL)
    expect(h.store.getQuestion(byNode["5"]!.id)!.status).toBe("open")
  } finally {
    await cards.close()
  }
  expect(h.lines.join("\n")).not.toContain(SENTINEL)
  expect(codexLog(h, sid)).not.toContain(SENTINEL)
  expect(JSON.stringify(h.storeEvents)).not.toContain(SENTINEL)
  expect(JSON.stringify(h.events)).not.toContain(SENTINEL)
  expect(JSON.stringify(h.sessions.currentTurn(sid))).not.toContain(SENTINEL)
  storeLacksSentinel(h)
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

test("a request no card can show is refused with its reason and logged", async () => {
  const h = makeCodex()
  const many = fc.userInput(9, "u3", [0, 1, 2, 3, 4].map((i) => fc.question(`q${i}`, `Q${i}`, SENTINEL)))
  h.fake.script([[many]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => 9 in h.fake.replies(), { what: "the error reply" })
  expect(h.fake.replies()[9]).toEqual({ code: -32603,
    message: "OpenCorp can't show item/tool/requestUserInput with more than four questions" })
  expect(h.lines).toContain(
    `codex session ${sid}: no card can show item/tool/requestUserInput with more than four questions`)
  expect(h.lines.join("\n")).not.toContain(SENTINEL)
  await waitFor(() => status(h, sid) === "idle", { what: "Codex going on" })
  expect(h.store.listQuestions({ sessionId: sid })).toEqual([])
})

test("an approval with no decision a card can offer is refused, not left unanswerable", async () => {
  const h = makeCodex()
  const step = fc.commandApproval(9, "c1", `echo ${SENTINEL}`)
  step.params.availableDecisions = [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: [SENTINEL] } }]
  h.fake.script([[step]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => 9 in h.fake.replies(), { what: "the error reply" })
  expect(h.fake.replies()[9]).toEqual({ code: -32603,
    message: "OpenCorp can't show item/commandExecution/requestApproval with no option a card can offer" })
  expect(h.lines.filter((x) => x.includes("no card can show"))).toEqual([
    `codex session ${sid}: no card can show item/commandExecution/requestApproval with no option a card can offer`])
  expect(h.lines.join("\n")).not.toContain(SENTINEL)
  await waitFor(() => status(h, sid) === "idle", { what: "Codex going on" })
  expect(h.store.listQuestions({ sessionId: sid })).toEqual([])
})

test("an elicitation in a mode a card cannot answer is refused without echoing the mode", async () => {
  const h = makeCodex()
  const params = { serverName: "gh", threadId: "{thread}", turnId: "{turn}", mode: SENTINEL, message: "Pick" }
  h.fake.script([[{ request: "mcpServer/elicitation/request", id: 9, wait: true, params }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => 9 in h.fake.replies(), { what: "the error reply" })
  expect(code(h.fake.replies()[9])).toBe(-32603)
  expect(JSON.stringify(h.fake.replies()[9])).not.toContain(SENTINEL)
  expect(h.lines).toContain(
    `codex session ${sid}: no card can show mcpServer/elicitation/request in a mode a card can't answer`)
  expect(h.lines.join("\n")).not.toContain(SENTINEL)
  await waitFor(() => status(h, sid) === "idle", { what: "Codex going on" })
  expect(h.store.listQuestions({ sessionId: sid })).toEqual([])
})

test("cards answer a codex card and refuse its other actions", async () => {
  const h = makeCodex()
  h.office.harness = h.sessions
  register(h.office)
  const cards = h.office.cards!
  try {
    h.fake.script([approvalTurn()])
    const sid = await start(h, h.workspace)
    await h.sessions.prompt(sid, "make a")
    const q = await openCard(h, sid)
    // An approval takes an option.
    await expect(cards.answer(q.id, "approve it please", "text", { by: "ngocbh" })).rejects.toBeInstanceOf(HarnessError)
    for (const refused of [
      () => cards.openSide(q.id, "why?", { by: "ngocbh" }),
      () => cards.sendBack(q.id, "", { by: "ngocbh" }),
      () => cards.stop(q.id, { by: "ngocbh" }),
    ]) {
      const error = await refused().catch((e) => e)
      expect(error).toBeInstanceOf(HarnessError)
      expect(error.code).toBe("harness_card")
    }
    expect(h.store.getQuestion(q.id)!.status).toBe("open")
    expect((await cards.answer(q.id, "Approve", "option", { by: "ngocbh" })).status).toBe("consumed")
    await waitFor(() => Bun.deepEquals(h.fake.replies()[1], { decision: "accept" }), { what: "the reply" })
  } finally {
    await cards.close()
  }
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

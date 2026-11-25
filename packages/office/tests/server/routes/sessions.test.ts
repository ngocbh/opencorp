/** Session routes. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { type LiveEvent, Message, MessagePage } from "@opencorp/protocol"
import { z } from "zod"
import { newToken } from "../../../src/runtime/auth/tokens.ts"
import { HarnessError } from "../../../src/runtime/sessions/state.ts"
import { Transcript } from "../../../src/features/chat/transcript.ts"
import type { Office } from "../../../src/server/office.ts"
import { register } from "../../../src/features/questions/extension.ts"
import * as fc from "../../../src/testing/fake_codex.ts"
import { writePrivate } from "../../../src/util/private_files.ts"
import { fakeLlm, makeHarness, noWorkersLeft, status as chatStatus } from "../../features/chat/helpers.ts"
import {
  YES,
  allGone,
  makeCodex,
  openCard,
  picked,
  questionTurn,
  requestsValid,
  start,
  status,
  texts,
} from "../../features/codex/helpers.ts"
import { tempDir, unusableFolders, waitFor } from "../../helpers.ts"
import { session } from "../../runtime/store/helpers.ts"
import {
  addHuman,
  bearer,
  CEO,
  frames,
  giveDevice,
  makeOffice,
  parse,
  raw,
  type Reply,
  request,
  served,
  standInHarness,
  take,
  ULID,
  within,
} from "../helpers.ts"

setDefaultTimeout(60_000)
afterAll(allGone)
afterAll(noWorkersLeft)

/** POSTs `body` as JSON, or nothing when it is null. */
function post(sock: string, target: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  if (body === null) return request(sock, "POST", target, { headers })
  return request(sock, "POST", target, {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** GETs `target`. */
function get(sock: string, target: string): Promise<Reply> {
  return request(sock, "GET", target)
}

/** The reply's error code. */
function errorOf(r: Reply): string {
  return (r.json() as { error: string }).error
}

/** The ids of the sessions in the reply. */
function ids(r: Reply): string[] {
  return (r.json() as { id: string }[]).map((s) => s.id)
}

/** Opens `target` with a `node:http` request; resolves with the response, whose data events stream. The request
 *  is destroyed when the test finishes. */
function openEvents(sock: string, target: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: target, agent: false }, (res) => {
      // The cleanup's destroy cuts an unfinished response, which then errors with nobody reading it.
      res.on("error", () => {})
      resolve(res)
    })
    onTestFinished(() => req.destroy())
    req.on("error", reject)
    req.end()
  })
}

/** Hires ava with a device and returns its token; from then on a tokenless request needs a token. */
function withToken(office: Office): string {
  addHuman(office.paths.company, "ava")
  const token = newToken()
  giveDevice(office.paths.company, "ava", "pc", token)
  return token
}

/** `pairs` as a query string, encoded. */
function query(pairs: [string, string][]): string {
  return "?" + new URLSearchParams(pairs)
}

test("list sessions filters and limits", async () => {
  const office = makeOffice()
  const a = office.store.createSession(session({ person: "minh" }))
  office.store.createSession(session({ person: "ngocbh" }))
  const b = office.store.createSession(session({ person: "minh" }))
  const { sock } = await served(office)
  expect(ids(await get(sock, "/sessions" + query([["person", "minh"]])))).toEqual([b.id, a.id])
  expect(ids(await get(sock, "/sessions" + query([["limit", "1"]])))).toHaveLength(1)
})

const STATUS_PARAMS: [string, [string, string][]][] = [
  ["repeated", [["status", "busy"], ["status", "idle"]]],
  ["comma separated", [["status", "busy, idle"]]],
]

test.each(STATUS_PARAMS)("list sessions filters by status repeated or comma separated [%s]", async (_case, params) => {
  const office = makeOffice()
  const busy = office.store.createSession(session({ status: "busy" }))
  const idle = office.store.createSession(session({ status: "idle" }))
  office.store.createSession(session({ status: "ended" }))
  const { sock } = await served(office)
  const r = await get(sock, "/sessions" + query(params))
  expect(r.status).toBe(200)
  expect(new Set(ids(r))).toEqual(new Set([busy.id, idle.id]))
})

test("list sessions filters by kind and folder", async () => {
  const office = makeOffice()
  const here = office.store.createSession(session({ cwd: "/w/app" }))
  office.store.createSession(session({ cwd: "/w/app", kind: "side" }))
  office.store.createSession(session({ cwd: "/w/other" }))
  const { sock } = await served(office)
  const r = await get(sock, "/sessions" + query([["kind", "main"], ["cwd", "/w/app"], ["limit", "500"]]))
  expect(r.status).toBe(200)
  expect(ids(r)).toEqual([here.id])
})

test("list sessions defaults to fifty", async () => {
  const office = makeOffice()
  for (let i = 0; i < 51; i++) office.store.createSession(session())
  const { sock } = await served(office)
  expect(ids(await get(sock, "/sessions"))).toHaveLength(50)
})

// "²".isdigit() is true, but neither Python's int() nor the route takes it.
test.each(["0", "501", "x", "²"])("bad limit is 422 [%s]", async (limit) => {
  const { sock } = await served(makeOffice())
  const r = await get(sock, "/sessions" + query([["limit", limit]]))
  expect(r.status).toBe(422)
  // The fixed text: it echoes nothing of the request.
  expect(r.json()).toEqual({ error: "invalid_body", message: "limit must be an integer from 1 to 500" })
})

test("get session", async () => {
  const office = makeOffice()
  const s = office.store.createSession(session())
  const { sock } = await served(office)
  const r = await get(sock, `/sessions/${s.id}`)
  expect(r.status).toBe(200)
  expect(r.json()).toEqual(s)
})

test("missing session is 404", async () => {
  // No harness: a missing session's 404 comes before the 501.
  const { sock } = await served(makeOffice())
  for (const target of [`/sessions/${ULID}`, `/sessions/${ULID}/messages`]) {
    const r = await get(sock, target)
    expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
  }
})

/** Message `i` of session `sid`: a user message on even `i`, a reply on odd, by ids that sort as the office's. */
function numbered(sid: string, i: number): z.input<typeof Message> {
  const id = `${ULID}:${String(i).padStart(12, "0")}`
  const role = i % 2 === 0 ? "user" : "assistant"
  const parts = [{ id: `${id}:0`, type: "text" as const, text: `m${i}` }]
  return { id, session_id: sid, role, parts, created_at: "2026-11-23T10:00:00.000Z" }
}

/** An office with session `sid`, whose stand-in harness answers its messages from `list` (as the test changes it)
 *  and session `other`'s from `others`. */
async function pagedOffice(count: number) {
  const office = makeOffice()
  const sid = office.store.createSession(session()).id
  const other = office.store.createSession(session()).id
  const list = Array.from({ length: count }, (_, i) => numbered(sid, i))
  const others = [numbered(other, 0), numbered(other, 1)]
  office.harness = standInHarness({ messages: (id) => (id === sid ? list : id === other ? others : []) })
  const { sock } = await served(office)
  return { sock, sid, other, list }
}

/** A page of session `sid`'s messages read with `params`: its texts and its `next`. */
async function pageOf(sock: string, sid: string, params: [string, string][]) {
  const r = await get(sock, `/sessions/${sid}/messages` + query(params))
  expect(r.status).toBe(200)
  const page = MessagePage.parse(r.json())
  return { texts: page.messages.map((m) => (m.parts[0] as { text: string }).text), next: page.next }
}

test("a message page is the newest messages, oldest first, with the cursor of the older ones", async () => {
  const { sock, sid } = await pagedOffice(5)
  const page = await pageOf(sock, sid, [["limit", "2"]])
  expect(page.texts).toEqual(["m3", "m4"])
  expect(page.next).toEqual(expect.any(String))
})

test("older pages follow the cursor to the first message, whose page has no next", async () => {
  const { sock, sid } = await pagedOffice(5)
  const first = await pageOf(sock, sid, [["limit", "2"]])
  const second = await pageOf(sock, sid, [["limit", "2"], ["before", first.next!]])
  expect(second.texts).toEqual(["m1", "m2"])
  const last = await pageOf(sock, sid, [["limit", "2"], ["before", second.next!]])
  expect(last).toEqual({ texts: ["m0"], next: null })
})

test("a page that holds the whole transcript has no next, and an empty one is an empty page", async () => {
  const { sock, sid, list } = await pagedOffice(5)
  expect(await pageOf(sock, sid, [["limit", "5"]])).toEqual({ texts: ["m0", "m1", "m2", "m3", "m4"], next: null })
  list.length = 0
  expect(await pageOf(sock, sid, [["limit", "20"]])).toEqual({ texts: [], next: null })
})

test("a message that arrives between pages leaves the older pages as they were", async () => {
  const { sock, sid, list } = await pagedOffice(5)
  const first = await pageOf(sock, sid, [["limit", "2"]])
  list.push(numbered(sid, 5), numbered(sid, 6))
  expect(await pageOf(sock, sid, [["limit", "2"], ["before", first.next!]])).toMatchObject({ texts: ["m1", "m2"] })
  expect((await pageOf(sock, sid, [["limit", "2"]])).texts).toEqual(["m5", "m6"])
})

test("a cursor alone reads a page of up to fifty, and no paging param reads the whole list", async () => {
  const { sock, sid } = await pagedOffice(60)
  const first = await pageOf(sock, sid, [["limit", "1"]])
  const page = await pageOf(sock, sid, [["before", first.next!]])
  expect(page.texts).toHaveLength(50)
  expect(page.texts.at(-1)).toBe("m58")
  const whole = await get(sock, `/sessions/${sid}/messages`)
  expect(z.array(Message).parse(whole.json())).toHaveLength(60)
})

/** `value` as JSON in base64url, as a cursor's form. */
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

const BAD_CURSORS: [string, (sid: string) => string][] = [
  ["empty", () => ""],
  ["not base64url", () => "not a cursor!"],
  ["not json", () => Buffer.from("{nope").toString("base64url")],
  ["not an object", () => encoded(["x"])],
  ["no id", (sid) => encoded({ session: sid })],
  ["an empty id", (sid) => encoded({ session: sid, id: "" })],
  ["a message the transcript lacks", (sid) => encoded({ session: sid, id: "sk-planted" })],
  ["too long", (sid) => encoded({ session: sid, id: "x".repeat(2000) })],
  ["a key no cursor has", (sid) => encoded({ session: sid, id: `${ULID}:000000000001`, more: 1 })],
  ["a session that isn't an id", () => encoded({ session: "sk-planted", id: `${ULID}:000000000001` })],
]

test.each(BAD_CURSORS)("a bad cursor is a 400 that echoes nothing [%s]", async (_case, cursor) => {
  const { sock, sid } = await pagedOffice(5)
  const before = cursor(sid)
  const r = await get(sock, `/sessions/${sid}/messages` + query([["limit", "2"], ["before", before]]))
  expect([r.status, errorOf(r)]).toEqual([400, "bad_cursor"])
  if (before !== "") expect(r.text).not.toContain(before)
  expect(r.text).not.toContain("sk-planted")
})

test("a cursor from another session is a 400", async () => {
  const { sock, sid, other } = await pagedOffice(5)
  const theirs = await pageOf(sock, other, [["limit", "1"]])
  const r = await get(sock, `/sessions/${sid}/messages` + query([["limit", "2"], ["before", theirs.next!]]))
  expect([r.status, errorOf(r)]).toEqual([400, "bad_cursor"])
  expect((r.json() as { message: string }).message).toContain("another session")
})

test.each(["0", "501", "x", "²", "", "1.5"])("a page limit out of bounds is 422 [%s]", async (limit) => {
  const { sock, sid } = await pagedOffice(5)
  const r = await get(sock, `/sessions/${sid}/messages` + query([["limit", limit]]))
  expect(r.status).toBe(422)
  expect(r.json()).toEqual({ error: "invalid_body", message: "limit must be an integer from 1 to 500" })
})

test("a page limit of one and of five hundred are pages", async () => {
  const { sock, sid } = await pagedOffice(5)
  expect((await pageOf(sock, sid, [["limit", "1"]])).texts).toEqual(["m4"])
  expect((await pageOf(sock, sid, [["limit", "500"]])).texts).toHaveLength(5)
})

test("a page of a missing session is 404", async () => {
  const { sock } = await pagedOffice(5)
  const r = await get(sock, `/sessions/${ULID}/messages` + query([["limit", "2"], ["before", "x"]]))
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
})

test("messages are a live codex sessions current turn then empty", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  const c = h.codex!
  const { sock } = await served(h.office)
  c.fake.script([fc.agentMessage("m1", "Hi")])
  const sid = await start(c, h.folder)
  await c.sessions.prompt(sid, "hello")
  await waitFor(() => texts(c, sid).join() === "Hi" && status(c, sid) === "idle")
  const r = await get(sock, `/sessions/${sid}/messages`)
  expect(r.status).toBe(200)
  expect(r.json()).toEqual(JSON.parse(JSON.stringify(z.array(Message).parse(c.sessions.currentTurn(sid)))))
  expect((r.json() as { role: string }[]).map((m) => m.role)).toEqual(["user", "assistant"])
  await c.sessions.end(sid)
  await waitFor(() => status(c, sid) === "ended")
  expect((await get(sock, `/sessions/${sid}/messages`)).json()).toEqual([])
})

const NEED_A_HARNESS: [string, string, unknown][] = [
  ["create", "/sessions", { person: "minh", cwd: "/w/app" }],
  ["prompt", `/sessions/${ULID}/prompt`, { text: "hi" }],
  ["steer", `/sessions/${ULID}/steer`, { text: "hi" }],
  ["interrupt", `/sessions/${ULID}/interrupt`, null],
  ["end", `/sessions/${ULID}/end`, null],
  ["continue", `/sessions/${ULID}/continue`, null],
  ["cost-cap", `/sessions/${ULID}/cost-cap`, { cost_cap_usd: 10 }],
  ["model", `/sessions/${ULID}/model`, { connection: "office", model: "stub" }],
]

test.each(NEED_A_HARNESS)("session actions need a harness [%s]", async (_case, target, body) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await post(sock, target, body)
  expect([r.status, errorOf(r)]).toEqual([501, "not_implemented"])
})

test("continue answers with the new session opened by the caller", async () => {
  const office = makeOffice()
  const calls: [string, string | null][] = []
  office.harness = standInHarness({
    continueSession: async (id, { by = null } = {}) => {
      calls.push([id, by])
      return session({ harness: "codex", parent_session_id: id, opened_by: by })
    },
  })
  const token = withToken(office)
  const { sock } = await served(office, { tokens: true })
  const r = await post(sock, `/sessions/${ULID}/continue`, null, bearer(token))
  expect(r.status).toBe(200)
  expect((r.json() as { parent_session_id: string }).parent_session_id).toBe(ULID)
  expect(calls).toEqual([[ULID, "ava"]])
})

test("a refused continue is its api error", async () => {
  const office = makeOffice()
  office.harness = standInHarness({
    continueSession: async (id) => {
      throw new HarnessError(409, "live", `session ${id} is still open`)
    },
  })
  const { sock } = await served(office)
  const r = await post(sock, `/sessions/${ULID}/continue`, null)
  expect([r.status, errorOf(r)]).toEqual([409, "live"])
})

test("a codex session over the routes", async () => {
  const h = await makeHarness(await fakeLlm(), { codex: true })
  const c = h.codex!
  // Before served, so the office's start runs the cards' sweep.
  register(h.office)
  const { sock } = await served(h.office)
  c.fake.script([questionTurn()])
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder, harness: "codex" })
  expect(r.status).toBe(200)
  const created = r.json() as { id: string }
  expect(created).toMatchObject({ person: "minh", harness: "codex", opened_by: CEO })
  const sid = created.id
  await waitFor(() => status(c, sid) === "idle", { what: "the Codex session to load" })
  const it = frames(await openEvents(sock, `/events?session=${sid}`))
  expect(await take(it, 1)).toEqual([["comment", null, "connected"]])
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "make a" })).json()).toEqual({ ok: true })
  const live = await within(
    (async () => {
      for (;;) {
        const step = await it.next()
        if (step.done) throw new Error("the stream ended")
        const [kind, , data] = step.value
        if (kind === "live" && ["part.updated", "part.delta"].includes((data as LiveEvent).type))
          return data as LiveEvent
      }
    })(),
  )
  expect(live.session_id).toBe(sid)
  const card = await openCard(c, sid)
  const answered = await post(sock, `/questions/${card.id}/answer`, { answer: YES, answer_kind: "text" })
  expect(answered.status).toBe(200)
  expect(answered.json()).toMatchObject({ status: "consumed", answered_by: CEO })
  await waitFor(() => JSON.stringify(c.fake.replies()[1]) === JSON.stringify(picked("Yes")), {
    what: "the reply",
  })
  await waitFor(() => status(c, sid) === "idle", { what: "the turn to end" })
  expect((await post(sock, `/sessions/${sid}/interrupt`, null)).json()).toEqual({ ok: true })
  expect((await post(sock, `/sessions/${sid}/end`, null)).json()).toEqual({ ok: true })
  await waitFor(() => status(c, sid) === "ended", { what: "the session to end" })
  const late = await post(sock, `/sessions/${sid}/prompt`, { text: "late" })
  expect([late.status, errorOf(late)]).toEqual([409, "not_live"])
  requestsValid(c.fake)
})

test("a codex prompt or steer a prompt check refuses is 422 and echoes nothing", async () => {
  const h = makeCodex()
  h.office.harness = h.sessions
  const { sock } = await served(h.office)
  h.hooks.promptCheck.push((_s, text) => (text === "nope" ? "not that" : null))
  h.fake.script([fc.agentMessage("m1", "Done")])
  const sid = await start(h, h.workspace)
  for (const action of ["prompt", "steer"]) {
    const r = await post(sock, `/sessions/${sid}/${action}`, { text: "nope" })
    expect([r.status, r.json()]).toEqual([422, { error: "refused", message: "not that" }])
    expect(r.text).not.toContain("nope")
  }
  expect((await post(sock, `/sessions/${sid}/steer`, { text: "Also Rome." })).json()).toEqual({ ok: true })
  const inputs = () => (h.fake.calls("turn/start") as { input: { text: string }[] }[]).map((c) => c.input[0]!.text)
  await waitFor(() => inputs().includes("Also Rome."), { what: "the steer's turn" })
  expect(inputs()).not.toContain("nope")
})

test("a cost cap or a model on a codex session is 422 not supported", async () => {
  const h = makeCodex()
  h.office.harness = h.sessions
  const { sock } = await served(h.office)
  h.fake.script([])
  const sid = await start(h, h.workspace)
  const bodies: [string, unknown][] = [
    ["cost-cap", { cost_cap_usd: 50 }],
    ["model", { connection: "office", model: "gpt-4o" }],
  ]
  for (const [action, body] of bodies) {
    const r = await post(sock, `/sessions/${sid}/${action}`, body)
    expect([r.status, errorOf(r)]).toEqual([422, "not_supported"])
    const missing = await post(sock, `/sessions/${ULID}/${action}`, body)
    expect([missing.status, errorOf(missing)]).toEqual([404, "not_found"])
  }
})

test("a codex session's mode can't be switched: codex runs under its employee's permission", async () => {
  const h = makeCodex()
  h.office.harness = h.sessions
  const { sock } = await served(h.office)
  h.fake.script([])
  const sid = await start(h, h.workspace)
  const r = await post(sock, `/sessions/${sid}/mode`, { mode: "ask" })
  expect([r.status, errorOf(r)]).toEqual([422, "not_supported"])
  expect(h.store.getSession(sid)!.mode).toBe("auto")
  const missing = await post(sock, `/sessions/${ULID}/mode`, { mode: "ask" })
  expect([missing.status, errorOf(missing)]).toEqual([404, "not_found"])
})

/** [label, target, raw JSON body, the 422's message]. */
const REFUSED_BODIES: [string, string, string, string][] = [
  [
    "unknown key",
    "/sessions",
    JSON.stringify({ person: "minh", cwd: "/w", "sk-sentinel-key": "sk-sentinel-value" }),
    "an extra field: isn't allowed",
  ],
  [
    "bad type",
    "/sessions",
    JSON.stringify({ person: "minh", cwd: { "sk-sentinel-key": 1 } }),
    "cwd: has the wrong type",
  ],
  ["empty text", `/sessions/${ULID}/prompt`, JSON.stringify({ text: "" }), "text: is too short"],
  ["blank prompt", `/sessions/${ULID}/prompt`, JSON.stringify({ text: "  " }), "text: isn't in the right format"],
  ["nul prompt", `/sessions/${ULID}/prompt`, JSON.stringify({ text: "\u0000" }), "text: isn't in the right format"],
  ["blank steer", `/sessions/${ULID}/steer`, JSON.stringify({ text: "  " }), "text: isn't in the right format"],
  ["nul steer", `/sessions/${ULID}/steer`, JSON.stringify({ text: "\u0000" }), "text: isn't in the right format"],
  ["empty model", "/sessions", JSON.stringify({ person: "minh", cwd: "/w", model: "" }), "model: is too short"],
  [
    "padded model",
    `/sessions/${ULID}/model`,
    JSON.stringify({ connection: "office", model: " sk-sentinel" }),
    "model: isn't in the right format",
  ],
  [
    "long model",
    "/sessions",
    JSON.stringify({ person: "minh", cwd: "/w", model: "sk-sentinel".repeat(30) }),
    "model: is too long",
  ],
  [
    "too deep",
    `/sessions/${ULID}/prompt`,
    '{"text":' + "[".repeat(65) + '"sk-sentinel"' + "]".repeat(65) + "}",
    "the body is nested too deeply",
  ],
]

test.each(REFUSED_BODIES)(
  "session bodies a schema refuses are 422 and echo nothing [%s]",
  async (_case, target, text, message) => {
    const office = makeOffice()
    const { sock } = await served(office)
    const r = await request(sock, "POST", target, { headers: { "content-type": "application/json" }, body: text })
    // The body is parsed before the harness is looked up, so no harness still gives 422.
    expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message }])
    expect(r.text).not.toContain("sk-sentinel")
  },
)

/** A prompt's head declaring a 2 MiB body; no body byte follows. */
const BIG_HEAD =
  `POST /sessions/${ULID}/prompt HTTP/1.1\r\nhost: office\r\ncontent-type: application/json\r\n` +
  "content-length: 2097152\r\n\r\n"

test("anyone who may chat may switch its model", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const company = h.office.paths.company
  addHuman(company, "ava")
  const ava = newToken()
  const ceo = newToken()
  giveDevice(company, "ava", "pc", ava)
  giveDevice(company, CEO, "mac", ceo)
  const { sock } = await served(h.office, { tokens: true })
  const started = await post(sock, "/sessions", { person: "minh", cwd: h.folder }, bearer(ceo))
  expect(started.status).toBe(200)
  const sid = (started.json() as { id: string }).id
  await waitFor(() => h.store.getSession(sid)!.status === "idle", { what: "the first turn" })
  let r = await post(sock, `/sessions/${sid}/model`, { connection: "second", model: "stub-5" }, bearer(ava))
  expect(r.status).toBe(200)
  const switched = r.json() as { connection: string; model: string | null; model_note: string | null }
  expect([switched.connection, switched.model, switched.model_note]).toEqual(["second", "stub-5", null])
  r = await post(sock, `/sessions/${sid}/model`, { connection: "gone", model: "stub-5" }, bearer(ava))
  expect([r.status, errorOf(r)]).toEqual([422, "unknown_connection"])
  // Security: the refusal echoes nothing of the request.
  expect(r.text).not.toContain("gone")
  const bad = { llm_config: { provider: "nope-provider", model: "stub-3" } }
  await writePrivate(path.join(h.office.connections.dir, "third.json"), JSON.stringify(bad))
  r = await post(sock, `/sessions/${sid}/model`, { connection: "third", model: "stub-5" }, bearer(ava))
  expect([r.status, errorOf(r)]).toEqual([409, "connection_unusable"])
  // Security: it names the connection, never its file or what the file holds.
  expect(r.text).not.toContain(h.office.paths.home)
  expect(r.text).not.toContain("nope-provider")
  const stored = h.store.getSession(sid)!
  expect([stored.connection, stored.model]).toEqual(["second", "stub-5"])
  expect((await post(sock, `/sessions/${sid}/end`, null, bearer(ceo))).json()).toEqual({ ok: true })
  await waitFor(() => h.store.getSession(sid)!.status === "ended", { what: "the end" })
})

test("the opener switches a chat's mode, and anyone else is refused", async () => {
  const h = await makeHarness(await fakeLlm())
  const company = h.office.paths.company
  addHuman(company, "ava")
  const ava = newToken()
  const ceo = newToken()
  giveDevice(company, "ava", "pc", ava)
  giveDevice(company, CEO, "mac", ceo)
  const { sock } = await served(h.office, { tokens: true })
  const started = await post(sock, "/sessions", { person: "minh", cwd: h.folder }, bearer(ceo))
  expect(started.status).toBe(200)
  const opened = started.json() as { id: string; mode: string; opened_by: string | null }
  const sid = opened.id
  expect([opened.mode, opened.opened_by]).toEqual(["auto", CEO])
  await waitFor(() => h.store.getSession(sid)!.status === "idle", { what: "the first turn" })
  let r = await post(sock, `/sessions/${sid}/mode`, { mode: "ask" }, bearer(ava))
  expect([r.status, errorOf(r)]).toEqual([403, "forbidden"])
  expect(h.store.getSession(sid)!.mode).toBe("auto")
  for (const mode of ["default", "ask", "dontAsk"] as const) {
    r = await post(sock, `/sessions/${sid}/mode`, { mode }, bearer(ceo))
    expect([r.status, (r.json() as { mode: string }).mode]).toEqual([200, mode])
    expect(h.store.getSession(sid)!.mode).toBe(mode)
  }
  r = await post(sock, `/sessions/${sid}/mode`, { mode: "yolo" }, bearer(ceo))
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
  r = await post(sock, `/sessions/${ULID}/mode`, { mode: "ask" }, bearer(ceo))
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
  expect((await post(sock, `/sessions/${sid}/end`, null, bearer(ceo))).json()).toEqual({ ok: true })
  await waitFor(() => h.store.getSession(sid)!.status === "ended", { what: "the end" })
  r = await post(sock, `/sessions/${sid}/mode`, { mode: "auto" }, bearer(ceo))
  expect([r.status, errorOf(r)]).toEqual([409, "not_live"])
  expect(h.store.getSession(sid)!.mode).toBe("dontAsk")
})

test("session writes are refused before their body is read", async () => {
  const office = makeOffice()
  withToken(office)
  const { sock } = await served(office, { tokens: true })
  const got = await raw(sock, BIG_HEAD, { until: "close" })
  const res = parse(got.text)
  expect([res.status, JSON.parse(res.body).error]).toEqual([401, "unauthenticated"])
  expect(res.head.toLowerCase()).toContain("\r\nconnection: close")
  expect(got.closed).toBe(true)
})

test("the body cap holds on session routes", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const got = await raw(sock, BIG_HEAD, { until: "close" })
  const res = parse(got.text)
  expect([res.status, JSON.parse(res.body).error]).toEqual([413, "body_too_large"])
  expect(res.head.toLowerCase()).toContain("\r\nconnection: close")
  expect(got.closed).toBe(true)
})

test("an unexpected harness error is a 500 that logs its type only", async () => {
  const office = makeOffice()
  const lines: string[] = []
  office.harness = standInHarness({
    continueSession: async () => {
      throw new Error("sk-sentinel")
    },
  })
  const { sock } = await served(office, { log: (l) => lines.push(l) })
  const r = await post(sock, `/sessions/${ULID}/continue`, null)
  expect([r.status, errorOf(r)]).toEqual([500, "internal_error"])
  expect(lines.some((l) => l.includes("internal error on POST /sessions/:id/continue: Error"))).toBe(true)
  expect(lines.join("\n")).not.toContain("sk-sentinel")
  expect(r.text).not.toContain("sk-sentinel")
})

type Chat = Awaited<ReturnType<typeof makeHarness>>

/** Opens minh's chat in `h.folder` over the routes, with `headers`, and waits for its first turn; returns its id. */
async function open(h: Chat, sock: string, headers: Record<string, string> = {}): Promise<string> {
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder }, headers)
  expect(r.status).toBe(200)
  const sid = (r.json() as { id: string }).id
  await waitFor(() => chatStatus(h, sid) === "idle", { what: "the first turn" })
  return sid
}

/** Session `sid`'s messages over the routes, each checked as a protocol `Message`. */
async function messagesOf(sock: string, sid: string, headers: Record<string, string> = {}) {
  const r = await request(sock, "GET", `/sessions/${sid}/messages`, { headers })
  expect(r.status).toBe(200)
  return z.array(Message).parse(r.json())
}

/** Each message's role, its text and its author. */
function said(messages: z.output<typeof Message>[]): [string, string, string | null | undefined][] {
  return messages.map((m) => [
    m.role,
    m.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    m.author,
  ])
}

/** Waits until session `sid` has `n` messages and is idle. */
async function settled(h: Chat, sock: string, sid: string, n: number, headers: Record<string, string> = {}) {
  await waitFor(async () => (await messagesOf(sock, sid, headers)).length === n && chatStatus(h, sid) === "idle", {
    what: `${n} messages`,
  })
}

test("messages in order", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "hello" }, { content: "ok" })
  const sid = await open(h, sock)
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hi" })).json()).toEqual({ ok: true })
  await settled(h, sock, sid, 2)
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "again" })).json()).toEqual({ ok: true })
  await settled(h, sock, sid, 4)
  const r = await get(sock, `/sessions/${sid}/messages`)
  const messages = z.array(Message).parse(r.json())
  expect(said(messages).map(([role, text]) => [role, text])).toEqual([
    ["user", "hi"],
    ["assistant", "hello"],
    ["user", "again"],
    ["assistant", "ok"],
  ])
  const ids = messages.map((m) => m.id)
  expect(ids).toEqual([...ids].sort())
  const runs = new Transcript(h.office.paths.runs).messages(sid, h.store.getSession(sid)!.run_ids)
  expect(r.json()).toEqual(JSON.parse(JSON.stringify(runs)))
})

test("a chat's transcript in pages is its whole list, and a turn after the first page leaves the cursor good", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "hello" }, { content: "ok" }, { content: "bye" })
  const sid = await open(h, sock)
  for (const [text, n] of [["hi", 2], ["again", 4]] as const) {
    expect((await post(sock, `/sessions/${sid}/prompt`, { text })).json()).toEqual({ ok: true })
    await settled(h, sock, sid, n)
  }
  const page = (params: [string, string][]) =>
    get(sock, `/sessions/${sid}/messages` + query(params)).then((r) => MessagePage.parse(r.json()))
  const newest = await page([["limit", "3"]])
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "last" })).json()).toEqual({ ok: true })
  await settled(h, sock, sid, 6)
  const older = await page([["limit", "3"], ["before", newest.next!]])
  expect(older.next).toBeNull()
  const whole = await messagesOf(sock, sid)
  expect([...older.messages, ...newest.messages]).toEqual(whole.slice(0, 4))
  expect((await page([["limit", "2"]])).messages).toEqual(whole.slice(4))
})

test("messages of a log with a bad line show the messages before it", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "hello" })
  const sid = await open(h, sock)
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hi" })).json()).toEqual({ ok: true })
  await settled(h, sock, sid, 2)
  const runId = h.store.getSession(sid)!.run_ids.at(-1)!
  fs.appendFileSync(path.join(h.office.paths.runs, runId, "log.jsonl"), "not a record\n")
  const r = await get(sock, `/sessions/${sid}/messages`)
  expect(r.status).toBe(200)
  expect(said(z.array(Message).parse(r.json())).map(([role, text]) => [role, text])).toEqual([
    ["user", "hi"],
    ["assistant", "hello"],
  ])
})

test("messages of a log that can not be read are a 500 that names no path", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "hello" })
  const sid = await open(h, sock)
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hi" })).json()).toEqual({ ok: true })
  await settled(h, sock, sid, 2)
  const runId = h.store.getSession(sid)!.run_ids.at(-1)!
  // A folder where the log was: opening it works, reading it fails EISDIR.
  const log = path.join(h.office.paths.runs, runId, "log.jsonl")
  fs.renameSync(log, `${log}.moved`)
  fs.mkdirSync(log)
  const r = await get(sock, `/sessions/${sid}/messages`)
  expect(r.status).toBe(500)
  expect(r.json()).toEqual({ error: "internal_error", message: "internal error" })
  expect(r.text).not.toContain(runId)
})

test("a chat over the routes", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "Hi there." })
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder })
  expect(r.status).toBe(200)
  expect((r.json() as { person: string }).person).toBe("minh")
  const sid = (r.json() as { id: string }).id
  await waitFor(() => chatStatus(h, sid) === "idle", { what: "the first turn" })

  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hello" })).json()).toEqual({ ok: true })
  await settled(h, sock, sid, 2)
  expect(said(await messagesOf(sock, sid))).toEqual([
    ["user", "hello", CEO],
    ["assistant", "Hi there.", null],
  ])

  const low = await post(sock, `/sessions/${sid}/cost-cap`, { cost_cap_usd: 0 })
  expect([low.status, errorOf(low)]).toEqual([422, "cap_too_low"])
  const capped = await post(sock, `/sessions/${sid}/cost-cap`, { cost_cap_usd: 9 })
  expect((capped.json() as { cost_cap_usd: number }).cost_cap_usd).toBe(9)
  expect((await post(sock, `/sessions/${sid}/interrupt`, null)).json()).toEqual({ ok: true })
  expect((await post(sock, `/sessions/${sid}/end`, null)).json()).toEqual({ ok: true })
  await waitFor(() => chatStatus(h, sid) === "ended", { what: "the session to end" })
  const late = await post(sock, `/sessions/${sid}/prompt`, { text: "late" })
  expect([late.status, errorOf(late)]).toEqual([409, "not_live"])
})

test("a cap too low names the cost so far rounded up, never the cap asked for", async () => {
  const h = await makeHarness(await fakeLlm())
  const { sock } = await served(h.office)
  const sid = ((await post(sock, "/sessions", { person: "minh", cwd: h.folder })).json() as { id: string }).id
  await waitFor(() => chatStatus(h, sid) === "idle", { what: "the first turn" })
  const message = (r: Reply) => (r.json() as { message: string }).message
  h.store.updateSession(sid, { cost: 0.000525 })
  const low = await post(sock, `/sessions/${sid}/cost-cap`, { cost_cap_usd: 0.00051 })
  expect([low.status, errorOf(low)]).toEqual([422, "cap_too_low"])
  // A cap above the figure shown is above the cost.
  expect(message(low)).toContain("($0.0006)")
  expect(message(low)).not.toContain("0.00051")
  expect((await post(sock, `/sessions/${sid}/cost-cap`, { cost_cap_usd: 0.0007 })).status).toBe(200)
  h.store.updateSession(sid, { cost: 0.0051 })
  expect(message(await post(sock, `/sessions/${sid}/cost-cap`, { cost_cap_usd: 0.005 }))).toContain("($0.0051)")
  expect((await post(sock, `/sessions/${sid}/end`, null)).json()).toEqual({ ok: true })
  await waitFor(() => chatStatus(h, sid) === "ended", { what: "the session to end" })
})

test("a chat starts on the requested connection and model", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const { sock } = await served(h.office)
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder, connection: "second", model: "stub-5" })
  expect(r.status).toBe(200)
  const created = r.json() as { id: string; connection: string; model: string; model_note: string | null }
  expect([created.connection, created.model, created.model_note]).toEqual(["second", "stub-5", null])
  await waitFor(() => chatStatus(h, created.id) === "idle", { what: "the first turn" })
  expect((await post(sock, `/sessions/${created.id}/end`, null)).json()).toEqual({ ok: true })
  await waitFor(() => chatStatus(h, created.id) === "ended", { what: "the session to end" })
})

test("a chat is credited to the verified person", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const company = h.office.paths.company
  addHuman(company, "ava")
  const ava = newToken()
  const ceo = newToken()
  giveDevice(company, "ava", "pc", ava)
  giveDevice(company, CEO, "mac", ceo)
  const { sock } = await served(h.office, { tokens: true })
  fake.script({ content: "Hi Ava." }, { content: "Hi Ngoc." })
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder }, bearer(ava))
  expect(r.status).toBe(200)
  const created = r.json() as { id: string; opened_by: string; work_item_id: string }
  expect(created.opened_by).toBe("ava")
  expect(h.store.getWorkItem(created.work_item_id)!.requester).toBe("ava")
  const sid = created.id
  await waitFor(() => chatStatus(h, sid) === "idle", { what: "the first turn" })
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hello" }, bearer(ava))).status).toBe(200)
  await settled(h, sock, sid, 2, bearer(ceo))
  // Someone else in the same chat is credited as themselves; a steer with no reply running is a prompt.
  expect((await post(sock, `/sessions/${sid}/steer`, { text: "hi too" }, bearer(ceo))).status).toBe(200)
  await settled(h, sock, sid, 4, bearer(ceo))
  const users = said(await messagesOf(sock, sid, bearer(ceo))).filter(([role]) => role === "user")
  expect(users.map(([, text, author]) => [text, author])).toEqual([
    ["hello", "ava"],
    ["hi too", CEO],
  ])
  const system = (fake.requests()[0]!.messages as { content: string }[])[0]!.content
  expect(system).toContain("You're talking with Ava (@ava), your peer.")
})

test("end is ending at once and a second end is a no op", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "Working", hold: 30 }, { content: "never" })
  const sid = await open(h, sock)
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hi" })).json()).toEqual({ ok: true })
  await fake.waitForRequests(1, 30_000)

  expect((await post(sock, `/sessions/${sid}/end`, null)).json()).toEqual({ ok: true })
  expect(chatStatus(h, sid)).toBe("ending")
  expect((await post(sock, `/sessions/${sid}/end`, null)).json()).toEqual({ ok: true })
  for (const action of ["prompt", "steer"]) {
    const r = await post(sock, `/sessions/${sid}/${action}`, { text: "more" })
    expect([r.status, errorOf(r)]).toEqual([409, "ending"])
  }
  fake.release()
  await waitFor(() => chatStatus(h, sid) === "ended", { what: "the session to end" })
  for (const action of ["interrupt", "end"]) {
    const r = await post(sock, `/sessions/${sid}/${action}`, null)
    expect([r.status, errorOf(r)]).toEqual([409, "not_live"])
  }
})

test("a steer reaches a running reply and a prompt check can refuse", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  h.hooks.promptCheck.push((_s, text) => (text === "nope" ? "not that" : null))
  fake.script({ content: "Working", hold: 30 }, { content: "Done." })
  const sid = await open(h, sock)
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hi" })).json()).toEqual({ ok: true })
  await fake.waitForRequests(1, 30_000)

  for (const action of ["prompt", "steer"]) {
    const r = await post(sock, `/sessions/${sid}/${action}`, { text: "nope" })
    expect([r.status, r.json()]).toEqual([422, { error: "refused", message: "not that" }])
    expect(r.text).not.toContain("nope")
  }
  expect((await post(sock, `/sessions/${sid}/steer`, { text: "Also Rome." })).json()).toEqual({ ok: true })
  fake.release()
  const requests = await fake.waitForRequests(2, 30_000)
  expect(JSON.stringify(requests[1]!.messages)).toContain("Also Rome.")
  expect(JSON.stringify(fake.requests())).not.toContain("nope")
})

test("a blank message or a bad model name never reaches a live chat", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const { sock } = await served(h.office)
  fake.script({ content: "Hi there." })
  const sid = await open(h, sock)
  const before = fake.requests().length
  for (const action of ["prompt", "steer"]) {
    for (const text of ["  ", "\n", "\u0000"]) {
      const r = await post(sock, `/sessions/${sid}/${action}`, { text })
      expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message: "text: isn't in the right format" }])
    }
  }
  const model = h.store.getSession(sid)!.model
  for (const bad of [" ", "stub ", "x".repeat(300)]) {
    const r = await post(sock, `/sessions/${sid}/model`, { connection: "office", model: bad })
    expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
  }
  expect(h.store.getSession(sid)!.model).toBe(model)
  // A message that shows is still sent as typed, trailing space and all.
  expect((await post(sock, `/sessions/${sid}/prompt`, { text: "hello " })).json()).toEqual({ ok: true })
  await settled(h, sock, sid, 2)
  expect(fake.requests().length).toBe(before + 1)
  expect(said(await messagesOf(sock, sid))[0]).toEqual(["user", "hello ", CEO])
})

const BROKEN_SPECS: [string, Error, number, string][] = [
  ["RuntimeError", new Error("sentinel"), 500, "start_failed"],
  // The folder vanished after the start's check.
  ["HarnessError", new HarnessError(422, "invalid_body", "the folder is gone"), 422, "invalid_body"],
]

test.each(BROKEN_SPECS)("a spec that cant be built fails the session [%s]", async (_case, error, code, name) => {
  const h = await makeHarness(await fakeLlm())
  const lines: string[] = []
  const { sock } = await served(h.office, { log: (line) => lines.push(line) })
  const ended: string[] = []
  h.hooks.sessionEnded.push((s) => void ended.push(s.status))
  spyOn(h.harness, "spec").mockRejectedValue(error)
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder })
  expect([r.status, errorOf(r)]).toEqual([code, name])
  const [s, ...rest] = h.store.listSessions()
  expect(rest).toEqual([])
  await waitFor(() => ended.length > 0, { what: "the session to end" })
  expect([s!.status, ended]).toEqual(["failed", ["failed"]])
  const late = await post(sock, `/sessions/${s!.id}/prompt`, { text: "hi" })
  expect([late.status, errorOf(late)]).toEqual([409, "not_live"])
  // The office log names the error's type only; neither it nor the reply holds the error's text.
  expect(h.logs.some((line) => line.includes(`can't start (${error.name})`))).toBe(true)
  expect([...h.logs, ...lines].join("\n")).not.toContain("sentinel")
  expect(r.text).not.toContain("sentinel")
})

test("a new chat in a folder the office cant open or name is a 422 that names no path", async () => {
  const h = await makeHarness(await fakeLlm())
  const lines: string[] = []
  const { sock } = await served(h.office, { log: (line) => lines.push(line) })
  const { folders, restore } = unusableFolders()
  try {
    for (const [, cwd, message] of [...folders, ["missing", path.join(tempDir(), "gone"), "cwd is not a folder"]]) {
      const r = await post(sock, "/sessions", { person: "minh", cwd })
      expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message }])
      expect(r.text).not.toContain(path.basename(cwd!))
    }
  } finally {
    restore()
  }
  const log = [...h.logs, ...lines].join("\n")
  expect(log).not.toContain("internal error")
  expect(log).not.toContain("d".repeat(250))
  expect(log).not.toContain("a".repeat(300))
  expect(h.store.listSessions()).toEqual([])
})

test("a start that fails on a missing file logs its errno code, not its message", async () => {
  const h = await makeHarness(await fakeLlm())
  const lines: string[] = []
  const { sock } = await served(h.office, { log: (line) => lines.push(line) })
  const gone = Object.assign(new Error("ENOENT: sentinel '/old/checkout/fs_helper.ts'"), {
    code: "ENOENT",
    syscall: "realpath",
    path: "/old/checkout/fs_helper.ts",
  })
  spyOn(h.harness, "spec").mockRejectedValue(gone)
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder })
  expect([r.status, errorOf(r)]).toEqual([500, "start_failed"])
  expect(h.logs.some((line) => line.endsWith("can't start (Error ENOENT realpath)"))).toBe(true)
  for (const text of [...h.logs, ...lines, r.text]) {
    expect(text).not.toContain("sentinel")
    expect(text).not.toContain("/old/checkout")
  }
})

/** [label, target, body, status, error code]. */
const BAD_CHAT_REQUESTS: [string, string, unknown, number, string][] = [
  ["create nobody 404", "/sessions", { person: "nobody", cwd: "/tmp" }, 404, "not_found"],
  ["create a human 422", "/sessions", { person: "ngocbh", cwd: "/tmp" }, 422, "not_an_agent"],
  ["create relative cwd 422", "/sessions", { person: "minh", cwd: "relative" }, 422, "invalid_body"],
  ["create codex 422", "/sessions", { person: "minh", cwd: "/tmp", harness: "codex" }, 422, "unsupported_harness"],
  ["create root cwd 422", "/sessions", { person: "minh", cwd: "/" }, 422, "unsafe_workspace"],
  ["prompt missing 404", `/sessions/${ULID}/prompt`, { text: "hi" }, 404, "not_found"],
  ["prompt empty 422", `/sessions/${ULID}/prompt`, { text: "" }, 422, "invalid_body"],
  ["interrupt missing 404", `/sessions/${ULID}/interrupt`, null, 404, "not_found"],
  ["end missing 404", `/sessions/${ULID}/end`, null, 404, "not_found"],
  ["cost cap missing 404", `/sessions/${ULID}/cost-cap`, { cost_cap_usd: 1 }, 404, "not_found"],
  ["model missing 404", `/sessions/${ULID}/model`, { connection: "office", model: "stub" }, 404, "not_found"],
  ["model empty 422", `/sessions/${ULID}/model`, { connection: "office", model: "" }, 422, "invalid_body"],
  ["model absent 422", `/sessions/${ULID}/model`, { connection: "office" }, 422, "invalid_body"],
  ["answer missing 404", `/questions/${ULID}/answer`, { answer: "x", answer_kind: "text" }, 404, "not_found"],
]

test.each(BAD_CHAT_REQUESTS)("chat routes refuse bad requests [%s]", async (_case, target, body, code, name) => {
  const h = await makeHarness(await fakeLlm())
  const { sock } = await served(h.office)
  const r = await post(sock, target, body)
  expect([r.status, errorOf(r)]).toEqual([code, name])
  // A 422 says which field failed, never its value: no handle, and no path at all.
  if (code === 422 && target === "/sessions") {
    const { message } = r.json() as { message: string }
    expect(message).not.toContain((body as { person: string }).person)
    expect(message).not.toContain("/")
  }
})

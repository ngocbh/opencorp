/** Session routes. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { Message } from "@opencorp/protocol"
import { z } from "zod"
import * as fc from "../../src/testing/fake_codex.ts"
import { allGone, makeCodex, start, status, texts } from "../harness/helpers.ts"
import { waitFor } from "../helpers.ts"
import { session } from "../store/helpers.ts"
import { makeOffice, type Reply, request, served, ULID } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

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

test("messages are a live codex sessions current turn then empty", async () => {
  const h = makeCodex()
  h.office.harness = h.sessions
  const { sock } = await served(h.office)
  h.fake.script([fc.agentMessage("m1", "Hi")])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "hello")
  await waitFor(() => texts(h, sid).join() === "Hi" && status(h, sid) === "idle")
  const r = await get(sock, `/sessions/${sid}/messages`)
  expect(r.status).toBe(200)
  expect(r.json()).toEqual(JSON.parse(JSON.stringify(z.array(Message).parse(h.sessions.currentTurn(sid)))))
  expect((r.json() as { role: string }[]).map((m) => m.role)).toEqual(["user", "assistant"])
  await h.sessions.end(sid)
  await waitFor(() => status(h, sid) === "ended")
  expect((await get(sock, `/sessions/${sid}/messages`)).json()).toEqual([])
})

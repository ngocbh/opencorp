/** The no-office host's routes, through the office's own pipeline: only the owner answers cards and sends keys, keys
 *  reach the shell and no log, the office's other routes aren't served, and only the host's token is taken. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { type Message, MessagePage } from "@opencorp/protocol"
import { newToken } from "../../../src/runtime/auth/tokens.ts"
import { YES } from "../../../src/runtime/questions/approval.ts"
import type { LocalHost } from "../../../src/server/local/host.ts"
import { OWNER } from "../../../src/server/local/host.ts"
import { type LocalContext, localRoutes } from "../../../src/server/local/routes.ts"
import { serveLocal } from "../../../src/server/local/serve.ts"
import { fakeLlm } from "../../features/chat/helpers.ts"
import { shortDir, waitFor } from "../../helpers.ts"
import { session } from "../../runtime/store/helpers.ts"
import { bearer, type Reply, request, serve } from "../helpers.ts"
import { AGENT, cards, startHost, terminalCall, until } from "./helpers.ts"

setDefaultTimeout(90_000)

/** POSTs `body` as JSON. */
function post(sock: string, target: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request(sock, "POST", target, {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

const errorOf = (r: Reply) => [r.status, (r.json() as { error: string }).error]

/** A host whose agent has run `echo ready` in shell 1 and holds `touch a` on a card, in ask mode. */
async function holding() {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "echo ready", why: "ready" })], match: AGENT },
    { content: "Ready.", match: AGENT },
    { tool_calls: [terminalCall("run", { command: "touch a", why: "a", shell: "shell 1" })], match: AGENT },
    { content: "Done.", match: AGENT },
  )
  const started = await startHost(fake)
  const { host } = started
  await until(host, "idle")
  await host.prompt("get ready", OWNER)
  await waitFor(async () => (await host.messages()).length === 2 && host.session()?.status === "idle", {
    what: "the first reply",
  })
  host.setMode("ask", OWNER)
  await host.prompt("touch a", OWNER)
  const [card] = await cards(host, 1)
  const [shell] = host.instruments.list(host.id)
  return { ...started, card: card!, shell: shell! }
}

test("only the owner may answer cards or send keys", async () => {
  const { host, card, shell } = await holding()
  const { sock } = await serve<LocalContext>(localRoutes(), {
    context: (info) => ({ host, person: "ava", signal: info.signal, query: info.query }),
  })
  const sid = host.id
  expect(errorOf(await post(sock, `/questions/${card.id}/answer`, { answer: YES, answer_kind: "option" }))).toEqual([
    403,
    "forbidden",
  ])
  expect(errorOf(await post(sock, `/sessions/${sid}/instruments/${shell.id}/keys`, { data: "ls\r" }))).toEqual([
    403,
    "forbidden",
  ])
  expect(errorOf(await post(sock, `/sessions/${sid}/instruments/${shell.id}/size`, { cols: 100, rows: 30 }))).toEqual([
    403,
    "forbidden",
  ])
  expect(errorOf(await post(sock, `/sessions/${sid}/mode`, { mode: "auto" }))).toEqual([403, "forbidden"])
  expect(host.question(card.id)?.status).toBe("open")

  const served = await serveLocal(host, { tmpdir: shortDir() })
  const owner = bearer(served.token)
  const answered = await post(served.socket, `/questions/${card.id}/answer`, { answer: YES, answer_kind: "option" }, owner)
  expect(answered.status).toBe(200)
  expect(answered.json()).toMatchObject({ id: card.id, status: "answered", answered_by: OWNER })
  await served.close()
})

test("keys reach the shell and are never logged", async () => {
  const { host, shell } = await holding()
  const logs: string[] = []
  const served = await serveLocal(host, { tmpdir: shortDir(), log: (line) => logs.push(line) })
  const owner = bearer(served.token)
  const target = `/sessions/${host.id}/instruments/${shell.id}`
  expect((await post(served.socket, `${target}/keys`, { data: "echo key-7f3a9\r" }, owner)).status).toBe(200)
  const screen = async () => {
    const reply = await request(served.socket, "GET", `${target}/screen`, { headers: owner })
    const { data } = reply.json() as { data: string }
    return Buffer.from(data, "base64").toString("utf8")
  }
  await waitFor(async () => (await screen()).split("key-7f3a9").length > 2, { what: "the shell's echo" })
  expect((await post(served.socket, `${target}/size`, { cols: 100, rows: 30 }, owner)).status).toBe(200)
  const listed = await request(served.socket, "GET", `/sessions/${host.id}/instruments`, { headers: owner })
  expect((listed.json() as { size: unknown }[])[0]!.size).toEqual({ cols: 100, rows: 30 })
  await served.close()
  expect(logs.join("\n")).not.toContain("key-7f3a9")
})

test("the host's messages come whole, or in pages as the office pages them", async () => {
  const record = session()
  const messages: Message[] = ["a", "b", "c"].map((text, i) => ({
    id: `m${i}`,
    session_id: record.id,
    role: "user",
    parts: [{ id: `p${i}`, type: "text", text }],
    created_at: record.created_at,
  }))
  // Only what the messages route reads of the host.
  const host = {
    session: (id?: string) => (id === undefined || id === record.id ? record : undefined),
    messages: async () => messages,
  }
  const { sock } = await serve<LocalContext>(localRoutes(), {
    context: (info) => ({ host: host as unknown as LocalHost, person: OWNER, signal: info.signal, query: info.query }),
  })
  const read = (query: string) => request(sock, "GET", `/sessions/${record.id}/messages${query}`)
  expect((await read("")).json()).toHaveLength(3)
  const newest = MessagePage.parse((await read("?limit=2")).json())
  expect(newest.messages.map((m) => m.id)).toEqual(["m1", "m2"])
  const older = MessagePage.parse((await read(`?limit=2&before=${newest.next}`)).json())
  expect([older.messages.map((m) => m.id), older.next]).toEqual([["m0"], null])
  expect(errorOf(await read("?limit=2&before=nope"))).toEqual([400, "bad_cursor"])
  expect(errorOf(await read("?limit=0"))).toEqual([422, "invalid_body"])
})

test("an office-only route answers 404 no_route", async () => {
  const fake = await fakeLlm()
  const { host } = await startHost(fake)
  const served = await serveLocal(host, { tmpdir: shortDir() })
  const owner = bearer(served.token)
  for (const target of ["/connections", "/hq", "/runs", "/office", "/profiles/opencorp", "/costs"]) {
    const reply = await request(served.socket, "GET", target, { headers: owner })
    expect([target, ...errorOf(reply)]).toEqual([target, 404, "no_route"])
  }
  // A route served with another method is the pipeline's 405, as on the office.
  expect(errorOf(await post(served.socket, "/sessions", { person: "opencorp", cwd: "/" }, owner))).toEqual([
    405,
    "method_not_allowed",
  ])
  expect(errorOf(await request(served.socket, "GET", "/sessions/01JZZZZZZZZZZZZZZZZZZZZZZZ", { headers: owner }))).toEqual([
    404,
    "not_found",
  ])
  await served.close()
})

test("a wrong token of the right length is refused", async () => {
  const fake = await fakeLlm()
  const { host } = await startHost(fake)
  const served = await serveLocal(host, { tmpdir: shortDir() })
  const { token } = served
  const wrong = newToken()
  expect(wrong.length).toBe(token.length)
  const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")
  for (const headers of [{}, bearer(wrong), bearer(flipped), bearer(token.slice(0, -1)), { authorization: token }]) {
    const reply = await request(served.socket, "GET", "/whoami", { headers })
    expect(errorOf(reply)).toEqual([401, "unauthenticated"])
    expect(reply.text).not.toContain(token)
  }
  const ok = await request(served.socket, "GET", "/whoami", { headers: bearer(token) })
  expect(ok.json()).toEqual({ person: OWNER, device: null })
  await served.close()
})

test("a card's stop is Esc on its chat: only the owner's, and the call is answered interrupted", async () => {
  const { host, card } = await holding()
  const asOwner = await serve<LocalContext>(localRoutes(), {
    context: (info) => ({ host, person: OWNER, signal: info.signal, query: info.query }),
  })
  const asAva = await serve<LocalContext>(localRoutes(), {
    context: (info) => ({ host, person: "ava", signal: info.signal, query: info.query }),
  })
  expect(errorOf(await post(asAva.sock, `/questions/${card.id}/stop`, {}))).toEqual([403, "forbidden"])
  const stopped = await post(asOwner.sock, `/questions/${card.id}/stop`, {})
  expect(stopped.status).toBe(200)
  expect(stopped.json()).toMatchObject({ id: card.id, answer_kind: "interrupted" })
  await until(host, "idle")
  expect(errorOf(await post(asOwner.sock, `/questions/${card.id}/stop`, {}))).toEqual([409, "not_open"])
})

/** The guard every HQ request passes before routing. */
import fs from "node:fs"
import type { ServerResponse } from "node:http"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { z } from "zod"
import { LIMITS, type Limits, type Route, createServer, requestListener } from "../../src/daemon/http.ts"
import { listenUnix } from "../../src/daemon/sockets.ts"
import { CSP, HEADERS, type Inner, MAX_API_BODY, hqGuard } from "../../src/hq/guard.ts"
import { shortDir, waitFor } from "../helpers.ts"
import { Conn, parse, raw } from "../daemon/helpers.ts"

setDefaultTimeout(30_000)

const PORT = 49380
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://${HOST}`
/** The limits of the tests that wait for the runtime's 408. */
const SHORT: Limits = { ...LIMITS, connectionsCheckingInterval: 100, headersTimeout: 500, requestTimeout: 500 }

/** One request the guard's listener got: whether its promise settled, and its response. */
type Call = { settled: boolean; res: ServerResponse }

/** Serves `inner` behind the guard on a unix socket until the current test finishes. */
async function guarded(
  inner: Inner,
  { port = PORT, devOrigins, limits }: { port?: number | null; devOrigins?: string[]; limits?: Limits } = {},
): Promise<{ sock: string; calls: Call[] }> {
  const guard = hqGuard(inner, { port, devOrigins })
  const calls: Call[] = []
  const server = createServer((req, res) => {
    const call: Call = { settled: false, res }
    calls.push(call)
    void guard(req, res).then(() => {
      call.settled = true
    })
  }, limits)
  const sock = path.join(shortDir(), "s")
  onTestFinished(async () => {
    // As tests/daemon/helpers.ts's `serve`: on Bun, closeAllConnections also stops the listener.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(sock, { force: true })
  })
  await listenUnix(server, sock)
  return { sock, calls }
}

/** An inner that records the targets it served and answers with the body's length and whether it got one. */
function echo(): { inner: Inner; ran: string[] } {
  const ran: string[] = []
  const inner: Inner = (req, res, body) => {
    ran.push(req.url ?? "")
    const text = JSON.stringify({ length: body?.length ?? 0, whole: body !== undefined })
    res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) })
    res.end(text)
  }
  return { inner, ran }
}

type Message = {
  host?: string | null
  origin?: string | null
  headers?: string[]
  body?: string
  /** Asks the server to close the connection after its reply (the default), so `raw` reads to the end. */
  close?: boolean
}

/** A raw HTTP/1.1 request; `body` is sent with its Content-Length. */
function message(
  method: string,
  target: string,
  { host = HOST, origin = ORIGIN, headers = [], body, close = true }: Message = {},
): string {
  const lines = [`${method} ${target} HTTP/1.1`]
  if (host !== null) lines.push(`Host: ${host}`)
  if (origin !== null) lines.push(`Origin: ${origin}`)
  lines.push(...headers)
  if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
  if (close) lines.push("Connection: close")
  return `${lines.join("\r\n")}\r\n\r\n${body ?? ""}`
}

const JSON_TYPE = "Content-Type: application/json"

/** The values of header `name` in a raw response head. */
function values(head: string, name: string): string[] {
  return head
    .split("\r\n")
    .slice(1)
    .filter((line) => line.toLowerCase().startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim())
}

/** Expects `head` to carry each of HQ's headers exactly once, with HQ's value. */
function expectSecurityHeaders(head: string): void {
  for (const [name, value] of Object.entries(HEADERS)) expect(values(head, name)).toEqual([value])
}

const closes = (head: string) => values(head, "connection").some((v) => v.toLowerCase() === "close")

/** Sends `head`, then a byte every 100 ms; what came back and whether the server closed within `ms`. */
function trickle(sock: string, head: string, ms = 4000): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(sock)
    let text = ""
    let timer: ReturnType<typeof setInterval> | undefined
    const finish = (closed: boolean) => {
      clearTimeout(start)
      clearInterval(timer)
      clearTimeout(deadline)
      socket.destroy()
      resolve({ text, closed })
    }
    const write = () => {
      if (socket.writable) socket.write("x")
    }
    // The runtime checks its timeouts every 100 ms here (SHORT), counted from about when this test's server
    // started. Writing half way between its checks lets a reply be read first: a write after the server closed
    // fails with EPIPE, and the failure drops a reply not yet read.
    const start = setTimeout(() => {
      write()
      timer = setInterval(write, 100)
    }, 50)
    const deadline = setTimeout(() => finish(false), ms)
    socket.on("connect", () => socket.write(head))
    socket.on("data", (data: Buffer) => (text += data.toString()))
    socket.on("end", () => finish(true))
    socket.on("close", () => finish(true))
    socket.on("error", () => finish(true))
  })
}

/** A POST head from the app's own page that promises a `length`-byte JSON body. */
const post = (target: string, { host = HOST, length = 1000 } = {}) =>
  message("POST", target, { host, headers: [JSON_TYPE, `Content-Length: ${length}`], close: false })

/** Resolves once `call` settles, or fails after `ms`. */
async function settles(call: Call | undefined, ms = 3000): Promise<void> {
  await waitFor(() => call?.settled, { timeout: ms, what: "the guard to settle" })
}

/** One chunk of a chunked body. */
const chunk = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`

test("a write up to 16 kib reaches the app whole", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const body = "x".repeat(MAX_API_BODY)
  const whole = parse((await raw(sock, message("POST", "/api/pair", { headers: [JSON_TYPE], body }))).text)
  expect([whole.status, JSON.parse(whole.body)]).toEqual([200, { length: MAX_API_BODY, whole: true }])

  const conn = await Conn.open(sock)
  conn.send(
    message("POST", "/api/pair", { headers: [JSON_TYPE, "Transfer-Encoding: chunked"] }) + chunk(body.slice(0, 9000)),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  conn.send(`${chunk(body.slice(9000))}0\r\n\r\n`)
  const chunked = await conn.response()
  expect([chunked.status, JSON.parse(chunked.body)]).toEqual([200, { length: MAX_API_BODY, whole: true }])
  expect(ran).toHaveLength(2)
})

test("a declared length over 16 kib is 413 before the body is read", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const conn = await Conn.open(sock)
  conn.send(post("/api/pair", { length: 17000 }))
  const r = await conn.response()
  expect([r.status, JSON.parse(r.body).error]).toEqual([413, "too_large"])
  expect(ran).toEqual([])
})

test("a client that goes away mid body never reaches the app", async () => {
  const { inner, ran } = echo()
  const { sock, calls } = await guarded(inner)
  const conn = await Conn.open(sock)
  conn.send(`${post("/api/pair")}{"code":`)
  await waitFor(() => calls.length, { timeout: 3000, what: "the request" })
  conn.socket.destroy()
  await settles(calls[0])
  expect(ran).toEqual([])
  expect(calls[0]!.res.headersSent).toBe(false)
})

test("a 408 closes the connection while the client still trickles", async () => {
  const { inner } = echo()
  const { sock, calls } = await guarded(inner, { limits: SHORT })
  const { text, closed } = await trickle(sock, post("/api/pair"))
  expect(text.startsWith("HTTP/1.1 408")).toBe(true)
  expect(closes(parse(text).head)).toBe(true)
  expect(closed).toBe(true)
  await settles(calls[0])
})

test("a body that stops arriving is 408", async () => {
  const { inner, ran } = echo()
  const { sock, calls } = await guarded(inner, { limits: SHORT })
  const conn = await Conn.open(sock)
  conn.send(`${post("/api/pair")}{"code":`)
  const r = await conn.response({ timeout: 3000 })
  expect(r.status).toBe(408)
  expect(await conn.closed({ timeout: 3000 })).toBe(true)
  await settles(calls[0])
  expect(ran).toEqual([])
})

test("a 413 closes the connection before the body is read", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const { text, closed } = await trickle(sock, post("/api/pair", { length: 20000 }))
  expect(text.startsWith("HTTP/1.1 413")).toBe(true)
  expect(closed).toBe(true)
  expect(ran).toEqual([])
})

test("a response that leaves the body unread closes the connection", async () => {
  const { sock } = await guarded((_req, res) => {
    res.writeHead(405, { "content-type": "application/json", "content-length": "2" }).end("{}")
  })
  const { text, closed } = await trickle(sock, post("/some/page"))
  expect(text.startsWith("HTTP/1.1 405")).toBe(true)
  expect(closes(parse(text).head)).toBe(true)
  expect(closed).toBe(true)
})

test("a refusal closes the connection", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const { text, closed } = await trickle(sock, post("/api/pair", { host: `evil.example:${PORT}` }))
  expect(text.startsWith("HTTP/1.1 403")).toBe(true)
  expect(closed).toBe(true)
  expect(ran).toEqual([])
})

test("a read body keeps the connection open", async () => {
  const { inner } = echo()
  const { sock } = await guarded(inner)
  const conn = await Conn.open(sock)
  conn.send(message("POST", "/api/pair", { headers: [JSON_TYPE], body: '{"code":"x"}', close: false }))
  const r = await conn.response()
  expect(r.status).toBe(200)
  expect(closes(r.head)).toBe(false)
  conn.send(message("GET", "/api/health", { close: false }))
  expect((await conn.response()).status).toBe(200)
})

test.each([
  ["POST http://127.0.0.1:49380/api/pair", "POST", `http://${HOST}/api/pair`, HOST, "bad_target"],
  ["GET http://evil.example/x", "GET", "http://evil.example/x", `localhost:${PORT}`, "bad_target"],
  // Bun answers an asterisk-form target itself, before any listener runs.
  ["OPTIONS *", "OPTIONS", "*", HOST, null],
] as const)("only origin form targets pass [%s]", async (_label, method, target, host, code) => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const headers = ["Content-Type: text/plain"]
  const { text } = await raw(sock, message(method, target, { host, origin: null, headers, body: "hi", close: false }))
  const r = parse(text)
  expect(r.status).toBe(400)
  if (code) expect(JSON.parse(r.body).error).toBe(code)
  else expect(closes(r.head)).toBe(true)
  expect(ran).toEqual([])
})

test("the security headers replace a routes own", async () => {
  const inners: Inner[] = [
    (_req, res) => {
      res.writeHead(200, { "x-frame-options": "SAMEORIGIN", "Content-Security-Policy": "default-src *" }).end("{}")
    },
    (_req, res) => {
      res.setHeader("X-Frame-Options", "SAMEORIGIN")
      res.end()
    },
    // The array forms of writeHead's headers; a name given twice keeps both values.
    (_req, res) => {
      res.writeHead(200, ["X-Frame-Options", "SAMEORIGIN", "Set-Cookie", "a=1", "Set-Cookie", "b=2"]).end()
    },
    (_req, res) => {
      res
        .writeHead(200, [
          ["X-Frame-Options", "SAMEORIGIN"],
          ["Set-Cookie", "a=1"],
          ["Set-Cookie", "b=2"],
        ])
        .end()
    },
  ]
  for (const [i, inner] of inners.entries()) {
    const { sock } = await guarded(inner)
    const r = parse((await raw(sock, message("GET", "/", { origin: null }))).text)
    expect(r.status).toBe(200)
    expectSecurityHeaders(r.head)
    expect(values(r.head, "content-security-policy")).toEqual([CSP])
    if (i >= 2) expect(values(r.head, "set-cookie")).toEqual(["a=1", "b=2"])
  }
})

test("a streamed response passes through unbuffered", async () => {
  let finished = false
  const { sock } = await guarded(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (let i = 0; i < 3; i++) {
      res.write(`data: ${i}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    finished = true
    res.end()
  })
  const early: boolean[] = []
  const socket = net.connect(sock)
  onTestFinished(() => socket.destroy())
  socket.on("data", (data: Buffer) => {
    for (const _ of data.toString().matchAll(/data: \d/g)) early.push(!finished)
  })
  socket.write(message("GET", "/api/stream", { origin: null }))
  await new Promise((resolve) => socket.on("close", resolve))
  expect(early).toEqual([true, true, true])
})

type Branch = {
  name: string
  method?: string
  target?: string
  host?: string
  origin?: string | null
  headers?: string[]
  body?: string
  port?: number | null
  devOrigins?: string[]
  status: number
  error?: string
}

const json = { headers: [JSON_TYPE], body: '{"code":"x"}' }
const refusedHost = { status: 403, error: "host_not_allowed" }
const passes = { status: 200 }

/** The refusal branches over the echo stand-in; a case with status 200 passes to it. */
const BRANCHES: Branch[] = [
  ...[`127.0.0.1:${PORT + 1}`, `evil.example:${PORT}`, `[::1]:${PORT}`, "127.0.0.1", `127.0.0.1.:${PORT}`, ""].map(
    (host) => ({ name: `host ${host || "empty"}`, host, origin: null, ...refusedHost }),
  ),
  { name: `host ${HOST}`, origin: null, ...passes },
  { name: "hq sock host 127.0.0.1:5555", port: null, host: "127.0.0.1:5555", origin: null, ...passes },
  { name: "hq sock host rebind.example:5555", port: null, host: "rebind.example:5555", origin: null, ...refusedHost },
  { name: "localhost GET /api/health", host: `localhost:${PORT}`, origin: null, ...refusedHost },
  {
    name: "localhost script asset",
    target: "/assets/a.js",
    host: `localhost:${PORT}`,
    origin: null,
    headers: ["Sec-Fetch-Dest: script"],
    ...refusedHost,
  },
  { name: "localhost POST /pair", method: "POST", target: "/pair", host: `localhost:${PORT}`, ...refusedHost },
  { name: "localhost on another port", target: "/pair", host: `localhost:${PORT + 1}`, origin: null, ...refusedHost },
  ...["same-site", "cross-site"].map((site) => ({
    name: `fetch site ${site} on api`,
    headers: [`Sec-Fetch-Site: ${site}`],
    status: 403,
    error: "cross_site",
  })),
  ...["same-origin", "none"].map((site) => ({
    name: `fetch site ${site} on api`,
    headers: [`Sec-Fetch-Site: ${site}`],
    ...passes,
  })),
  { name: "fetch site cross-site on a page", target: "/", headers: ["Sec-Fetch-Site: cross-site"], ...passes },
  ...["http://127.0.0.1:3000", "http://localhost:49380", "null", `https://127.0.0.1:${PORT}`].map((origin) => ({
    name: `origin ${origin} on a read`,
    origin,
    status: 403,
    error: "origin_not_allowed",
  })),
  { name: "no origin on a read", origin: null, ...passes },
  {
    name: "hq sock origin of the forwarded port",
    port: null,
    host: "127.0.0.1:5555",
    origin: "http://127.0.0.1:5555",
    ...passes,
  },
  {
    name: "hq sock origin of another port",
    port: null,
    host: "127.0.0.1:5555",
    origin: "http://127.0.0.1:5556",
    status: 403,
    error: "origin_not_allowed",
  },
  {
    name: "a write with no origin",
    method: "POST",
    target: "/api/pair",
    origin: null,
    ...json,
    status: 403,
    error: "origin_not_allowed",
  },
  {
    name: "a dev origin on a write",
    method: "POST",
    target: "/api/pair",
    origin: "http://localhost:5173",
    devOrigins: ["http://localhost:5173"],
    ...json,
    ...passes,
  },
  ...[["text/plain"], ["application/x-www-form-urlencoded"], ["multipart/form-data"], []].map((kind) => ({
    name: `a write typed ${kind[0] ?? "nothing"}`,
    method: "POST",
    target: "/api/pair",
    headers: kind.map((k) => `Content-Type: ${k}`),
    body: '{"code":"x"}',
    status: 415,
    error: "json_required",
  })),
  {
    name: "a body-less write typed json with a charset",
    method: "POST",
    target: "/api/nope",
    headers: ["Content-Type: application/json; charset=utf-8"],
    ...passes,
  },
  {
    name: "an escaped api path is judged decoded",
    method: "POST",
    target: "/%61pi/pair",
    origin: null,
    ...json,
    status: 403,
    error: "origin_not_allowed",
  },
]

test.each(BRANCHES)("the guard checks each refusal branch [$name]", async (c) => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner, { port: c.port === undefined ? PORT : c.port, devOrigins: c.devOrigins })
  const { method = "GET", target = "/api/health", host, origin, headers, body } = c
  const r = parse((await raw(sock, message(method, target, { host, origin, headers, body }))).text)
  expect(r.status).toBe(c.status)
  if (c.error) expect(JSON.parse(r.body).error).toBe(c.error)
  expect(ran).toHaveLength(c.status === 200 ? 1 : 0)
})

test("the guard refuses host before fetch metadata before origin before json", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const text = (m: Message) =>
    raw(sock, message("POST", "/api/pair", { headers: ["Content-Type: text/plain"], body: "x", ...m })).then(
      ({ text }) => JSON.parse(parse(text).body).error,
    )
  expect(await text({ host: "evil.example:49380", origin: "http://evil.example:49380" })).toBe("host_not_allowed")
  expect(
    await text({
      headers: ["Content-Type: text/plain", "Sec-Fetch-Site: cross-site"],
      origin: "http://127.0.0.1:3000",
    }),
  ).toBe("cross_site")
  expect(await text({ origin: "http://127.0.0.1:3000" })).toBe("origin_not_allowed")
  expect(await text({})).toBe("json_required")
  expect(ran).toEqual([])
})

test("a localhost page visit is sent to 127 0 0 1 with its path and query", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const visit = async (target: string, headers: string[] = []) => {
    const opts = { host: `localhost:${PORT}`, origin: null, headers, close: false }
    const r = parse((await raw(sock, message("GET", target, opts))).text)
    expect(r.status).toBe(307)
    expect(r.body).toBe("")
    expectSecurityHeaders(r.head)
    expect(closes(r.head)).toBe(true)
    return values(r.head, "location")
  }
  expect(await visit("/pair?x=1")).toEqual([`${ORIGIN}/pair?x=1`])
  expect(await visit("/people/a%2Fb", ["Sec-Fetch-Dest: document"])).toEqual([`${ORIGIN}/people/a%2Fb`])
  // Bun reads the raw bytes of a target as UTF-8.
  expect(await visit("/é")).toEqual([`${ORIGIN}/%C3%A9`])
  expect(await visit('/a"b')).toEqual([`${ORIGIN}/a%22b`])
  expect(ran).toEqual([])
})

test("an implicit head carries the security headers", async () => {
  const { sock } = await guarded((_req, res) => {
    res.end("x")
  })
  const r = parse((await raw(sock, message("GET", "/", { origin: null }))).text)
  expect([r.status, r.body]).toEqual([200, "x"])
  expectSecurityHeaders(r.head)
})

/** The pipeline's options for tests that need no context. */
const pipeline = { context: () => ({}), log: () => {} }

test("a 404 from the pipeline carries the headers and keeps the connection", async () => {
  const { sock } = await guarded(requestListener([], pipeline))
  const conn = await Conn.open(sock)
  conn.send(message("POST", "/api/nope", { ...json, close: false }))
  const r = await conn.response()
  expect([r.status, JSON.parse(r.body).error]).toEqual([404, "no_route"])
  expectSecurityHeaders(r.head)
  expect(closes(r.head)).toBe(false)
  conn.send(message("GET", "/api/nope", { close: false }))
  expect((await conn.response()).status).toBe(404)
})

test("a body the guard read reaches the route once", async () => {
  const got: unknown[] = []
  const route: Route<object> = {
    method: "POST",
    path: "/api/pair",
    body: z.strictObject({ code: z.string() }),
    handler: (_ctx, _params, body) => {
      got.push(body)
      return { ok: true }
    },
  }
  const { sock, calls } = await guarded(requestListener([route], pipeline))
  const r = parse((await raw(sock, message("POST", "/api/pair", json))).text)
  expect([r.status, JSON.parse(r.body)]).toEqual([200, { ok: true }])
  expect(got).toEqual([{ code: "x" }])
  await settles(calls[0])
})

test("the first origin header counts", async () => {
  const { inner } = echo()
  const { sock } = await guarded(inner)
  const send = (origins: string[]) =>
    raw(sock, message("GET", "/api/health", { origin: null, headers: origins.map((o) => `Origin: ${o}`) })).then(
      ({ text }) => parse(text).status,
    )
  expect(await send([ORIGIN, "http://evil.example"])).toBe(200)
  expect(await send(["http://evil.example", ORIGIN])).toBe(403)
})

test("a chunked write past the cap is refused while it is read", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const head = message("POST", "/api/pair", { headers: [JSON_TYPE, "Transfer-Encoding: chunked"], close: false })
  const { text, closed } = await raw(sock, `${head}${chunk("x".repeat(9000))}${chunk("x".repeat(8100))}0\r\n\r\n`)
  const r = parse(text)
  expect([r.status, JSON.parse(r.body).error]).toEqual([413, "too_large"])
  expectSecurityHeaders(r.head)
  expect(closes(r.head)).toBe(true)
  expect(closed).toBe(true)
  expect(ran).toEqual([])
})

test("a refused request is answered before any body byte is read", async () => {
  const { inner } = echo()
  const { sock } = await guarded(inner)
  const conn = await Conn.open(sock)
  conn.send(message("POST", "/api/pair", { host: `evil.example:${PORT}`, headers: [JSON_TYPE, "Content-Length: 10"] }))
  const r = await conn.response()
  expect([r.status, JSON.parse(r.body).error]).toEqual([403, "host_not_allowed"])
})

test("an error in the app is a 500 with the headers", async () => {
  const { sock, calls } = await guarded(() => {
    throw new Error("boom")
  })
  const r = parse((await raw(sock, message("GET", "/api/health", { close: false }))).text)
  expect([r.status, JSON.parse(r.body)]).toEqual([500, { error: "internal_error", message: "internal error" }])
  expectSecurityHeaders(r.head)
  expect(closes(r.head)).toBe(true)
  await settles(calls[0])
})

test("an expect 100 continue write gets 100 only after the checks", async () => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner)
  const body = '{"code":"x"}'
  const head = (m: Message, length = body.length) =>
    message("POST", "/api/pair", {
      headers: [JSON_TYPE, "Expect: 100-continue", `Content-Length: ${length}`],
      close: false,
      ...m,
    })

  const conn = await Conn.open(sock)
  conn.send(head({}))
  expect((await conn.response()).status).toBe(100)
  conn.send(body)
  expect((await conn.response()).status).toBe(200)
  expect(ran).toHaveLength(1)

  const refused: [Message, number, number][] = [
    [{ host: `evil.example:${PORT}` }, body.length, 403],
    [
      { headers: ["Content-Type: text/plain", "Expect: 100-continue", `Content-Length: ${body.length}`] },
      body.length,
      415,
    ],
    [{}, MAX_API_BODY + 1, 413],
  ]
  for (const [m, length, status] of refused) {
    const c = await Conn.open(sock)
    c.send(head(m, length))
    expect((await c.response()).status).toBe(status)
  }
  expect(ran).toHaveLength(1)
})

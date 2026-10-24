/** The guard every HQ request passes before routing. */
import type { IncomingMessage, OutgoingHttpHeader } from "node:http"
import net from "node:net"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { z } from "zod"
import { LIMITS, type Limits, type Route, requestListener } from "../../src/daemon/http.ts"
import { type Inner, MAX_API_BODY, requestPath } from "../../src/hq/guard.ts"
import { waitFor } from "../helpers.ts"
import { Conn, makeOffice, parse, raw } from "../daemon/helpers.ts"
import {
  type Call,
  HOST,
  JSON_TYPE,
  type Message,
  ORIGIN,
  PORT,
  closes,
  expectSecurityHeaders,
  guarded,
  hqClient,
  makeHq,
  message,
  post,
  trickle,
  values,
  web,
} from "./helpers.ts"

setDefaultTimeout(30_000)

/** The limits of the tests that wait for the runtime's 408. */
const SHORT: Limits = { ...LIMITS, connectionsCheckingInterval: 100, headersTimeout: 500, requestTimeout: 500 }

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

/** Resolves once `call` settles, or fails after 3 s. */
async function settles(call: Call | undefined): Promise<void> {
  await waitFor(() => call?.settled, { timeout: 3000, what: "the guard to settle" })
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
  const { text, closed } = await trickle(sock, post("/api/pair"), { now: true })
  // A write racing the close can fail with EPIPE and drop the 408 before it is read: only the close is certain.
  expect(text === "" || text.startsWith("HTTP/1.1 408")).toBe(true)
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
  expect(closes(r.head)).toBe(true)
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
  const cases: { inner: Inner; cookies?: string[] }[] = [
    {
      inner: (_req, res) => {
        res.writeHead(200, { "x-frame-options": "SAMEORIGIN", "Content-Security-Policy": "default-src *" }).end("{}")
      },
    },
    {
      inner: (_req, res) => {
        res.setHeader("X-Frame-Options", "SAMEORIGIN")
        res.end()
      },
    },
    // The array forms of writeHead's headers; a name given twice keeps both values.
    {
      inner: (_req, res) => {
        res.writeHead(200, ["X-Frame-Options", "SAMEORIGIN", "Set-Cookie", "a=1", "Set-Cookie", "b=2"]).end()
      },
      cookies: ["a=1", "b=2"],
    },
    // A pair's value may be an array: each item stays its own header line.
    {
      inner: (_req, res) => {
        const pairs = [
          ["X-Frame-Options", "SAMEORIGIN"],
          ["Set-Cookie", ["a=1", "b=2"]],
          ["Set-Cookie", "c=3"],
        ]
        res.writeHead(200, pairs as unknown as OutgoingHttpHeader[]).end()
      },
      cookies: ["a=1", "b=2", "c=3"],
    },
  ]
  for (const { inner, cookies } of cases) {
    const { sock } = await guarded(inner)
    const r = parse((await raw(sock, message("GET", "/", { origin: null }))).text)
    expect(r.status).toBe(200)
    expectSecurityHeaders(r.head)
    if (cookies) expect(values(r.head, "set-cookie")).toEqual(cookies)
  }
})

test("a streamed response passes through unbuffered", async () => {
  const seen: string[] = []
  const { sock } = await guarded(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (let i = 0; i < 3; i++) {
      res.write(`data: ${i}\n\n`)
      // The next chunk waits for the client to read this one: behind a guard that buffers, it never does, the wait
      // throws, and the guard drops the connection.
      await waitFor(() => seen.includes(String(i)), { timeout: 3000, what: `the client to read chunk ${i}` })
    }
    res.end()
  })
  let text = ""
  const socket = net.connect(sock)
  onTestFinished(() => socket.destroy())
  socket.on("data", (data: Buffer) => {
    text += data.toString()
    seen.splice(0, seen.length, ...[...text.matchAll(/data: (\d)/g)].map((m) => m[1]!))
  })
  socket.write(message("GET", "/api/stream", { origin: null }))
  await new Promise((resolve) => socket.on("close", resolve))
  expect(seen).toEqual(["0", "1", "2"])
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
  },  {
    // uvicorn decodes an invalid byte to U+FFFD, so the run around it still decodes.
    name: "an escaped api path with an invalid byte is judged decoded",
    method: "POST",
    target: "/%61%70%69%2F%FF",
    origin: null,
    ...json,
    status: 403,
    error: "origin_not_allowed",
  },
]

test.each(BRANCHES)("the guard checks each refusal branch [$name]", async (c) => {
  const { inner, ran } = echo()
  const { sock } = await guarded(inner, { port: c.port, devOrigins: c.devOrigins })
  const { method = "GET", target = "/api/health", host, origin, headers, body } = c
  // Only a 200 asks for close, so `raw` reads to its end; a refusal must close the connection itself.
  const request = message(method, target, { host, origin, headers, body, close: c.status === 200 })
  const r = parse((await raw(sock, request)).text)
  expect(r.status).toBe(c.status)
  if (c.error) expect(JSON.parse(r.body).error).toBe(c.error)
  if (c.status !== 200) {
    expectSecurityHeaders(r.head)
    expect(closes(r.head)).toBe(true)
  }
  expect(ran).toHaveLength(c.status === 200 ? 1 : 0)
})

test("a path is decoded as uvicorn decodes it", () => {
  const path = (url: string) => requestPath({ url } as IncomingMessage)
  expect(path("/a%FFb%41")).toBe("/a\uFFFDbA")
  expect(path("/%61%70%69%2F%FF?x=%41")).toBe("/api/\uFFFD")
  expect(path("/%E2%82%AC%zz")).toBe("/\u20AC%zz")
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

/** HQ attached to a started office of its own. */
const newHq = () => makeHq(makeOffice())

/** The `error` of a JSON reply. */
const error = (r: { json(): unknown }) => (r.json() as { error: string }).error

test.each([`127.0.0.1:${PORT + 1}`, `evil.example:${PORT}`, `[::1]:${PORT}`, "127.0.0.1", `127.0.0.1.:${PORT}`, ""])(
  "tcp takes only 127 0 0 1 and the bound port [%s]",
  async (host) => {
    const r = await (await hqClient(await newHq(), { host })).get("/api/health")
    expect([r.status, error(r)]).toEqual([403, "host_not_allowed"])
  },
)

test("tcp takes 127 0 0 1 on the bound port", async () => {
  expect((await (await hqClient(await newHq())).get("/api/health")).status).toBe(200)
})

test("hq sock takes any loopback port but no hostname", async () => {
  const hq = await newHq()
  expect((await (await hqClient(hq, { port: null, host: "127.0.0.1:5555" })).get("/api/health")).status).toBe(200)
  expect((await (await hqClient(hq, { port: null, host: "rebind.example:5555" })).get("/api/health")).status).toBe(
    403,
  )
})

test("a localhost document request redirects to 127 0 0 1 keeping path and query", async () => {
  const c = await hqClient(await newHq(), { host: `localhost:${PORT}` })
  let r = await c.get("/pair?x=1")
  expect([r.status, r.headers.location]).toEqual([307, `http://127.0.0.1:${PORT}/pair?x=1`])
  r = await c.get("/people/a%2Fb", { headers: { "sec-fetch-dest": "document" } })
  expect([r.status, r.headers.location]).toEqual([307, `http://127.0.0.1:${PORT}/people/a%2Fb`])
})

test.each([
  ["GET /api/health", "GET", "/api/health", null, `localhost:${PORT}`],
  ["GET /assets/a.js script", "GET", "/assets/a.js", "script", `localhost:${PORT}`],
  ["POST /pair", "POST", "/pair", null, `localhost:${PORT}`],
  ["GET /pair on another port", "GET", "/pair", null, `localhost:${PORT + 1}`],
] as const)("any other localhost request is 403 [%s]", async (_label, method, path, dest, host) => {
  const headers: Record<string, string> = dest ? { "sec-fetch-dest": dest } : {}
  const r = await (await hqClient(await newHq(), { host, headers })).request(method, path)
  expect([r.status, error(r)]).toEqual([403, "host_not_allowed"])
})

test.each([
  ["same-site", 403],
  ["cross-site", 403],
  ["same-origin", 200],
  ["none", 200],
] as const)("fetch metadata on api [%s]", async (site, status) => {
  const r = await (await hqClient(await newHq(), { headers: { "sec-fetch-site": site } })).get("/api/health")
  expect(r.status).toBe(status)
  if (status !== 200) expect(error(r)).toBe("cross_site")
})

test("fetch metadata doesnt gate the apps pages", async () => {
  const c = await hqClient(await newHq(), { headers: { "sec-fetch-site": "cross-site" } })
  expect((await c.get("/")).status).not.toBe(403)
})

test.each(["http://127.0.0.1:3000", "http://localhost:49380", "null", `https://127.0.0.1:${PORT}`])(
  "an api request with a foreign origin is 403 even a read [%s]",
  async (origin) => {
    const r = await (await hqClient(await newHq(), { headers: { origin } })).get("/api/health")
    expect([r.status, error(r)]).toEqual([403, "origin_not_allowed"])
  },
)

test("a read with no origin or its own passes", async () => {
  const hq = await newHq()
  expect((await (await hqClient(hq)).get("/api/health")).status).toBe(200)
  expect((await (await hqClient(hq, { headers: { origin: ORIGIN } })).get("/api/health")).status).toBe(200)
})

test("on hq sock the origin must match the forwarded port", async () => {
  const hq = await newHq()
  const client = (origin: string) => hqClient(hq, { port: null, host: "127.0.0.1:5555", headers: { origin } })
  expect((await (await client("http://127.0.0.1:5555")).get("/api/health")).status).toBe(200)
  expect((await (await client("http://127.0.0.1:5556")).get("/api/health")).status).toBe(403)
})

test("a write without an origin is 403", async () => {
  const r = await (await hqClient(await newHq())).post("/api/pair", { code: "x" })
  expect([r.status, error(r)]).toEqual([403, "origin_not_allowed"])
})

test("a dev origin passes", async () => {
  const hq = await newHq()
  hq.config = { ...hq.config, devOrigins: ["http://localhost:5173"] }
  const c = await hqClient(hq, { headers: { origin: "http://localhost:5173" } })
  expect((await c.post("/api/nope", {})).status).toBe(401) // past the guard, to the session check
})

test.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "None"])(
  "a write that isnt json is 415 [%s]",
  async (kind) => {
    const headers: Record<string, string> = kind === "None" ? {} : { "content-type": kind }
    const r = await (await web(await newHq())).request("POST", "/api/pair", { body: '{"code":"x"}', headers })
    expect([r.status, error(r)]).toEqual([415, "json_required"])
  },
)

test("a body less write with the json type passes", async () => {
  const c = await web(await newHq())
  const r = await c.post("/api/nope", undefined, { headers: { "content-type": "application/json; charset=utf-8" } })
  expect(r.status).toBe(401) // past the guard, to the session check
})

test("the guard refuses in order host then fetch metadata then origin then json", async () => {
  const hq = await newHq()
  const text = { body: "x", headers: { "content-type": "text/plain" } }
  const refused = async (opts: Parameters<typeof hqClient>[1]) =>
    error(await (await hqClient(hq, opts)).request("POST", "/api/pair", text))
  expect(await refused({ host: "evil.example:49380", headers: { origin: "http://evil.example:49380" } })).toBe(
    "host_not_allowed",
  )
  expect(await refused({ headers: { origin: ORIGIN, "sec-fetch-site": "cross-site" } })).toBe("cross_site")
  expect(await refused({ headers: { origin: "http://127.0.0.1:3000" } })).toBe("origin_not_allowed")
})

test("a write over 16 kib is 413 with or without a length", async () => {
  const c = await web(await newHq())
  const big = Buffer.from(JSON.stringify({ code: "x".repeat(17000) }))
  const headers = { "content-type": "application/json" }
  let r = await c.request("POST", "/api/pair", { body: big, headers })
  expect([r.status, error(r)]).toEqual([413, "too_large"])
  async function* chunks() {
    yield big.subarray(0, 9000)
    yield big.subarray(9000)
  }
  r = await c.request("POST", "/api/pair", { chunks: chunks(), headers })
  expect([r.status, error(r)]).toEqual([413, "too_large"])
})

test.each(["/api/health", "/api/nope", "/missing.js", "/"])(
  "every response carries the security headers [%s]",
  async (path) => {
    const r = await (await web(await newHq())).get(path)
    expect(String(r.headers["content-security-policy"]).startsWith("default-src 'none'; script-src 'self'")).toBe(
      true,
    )
    const { headers } = r
    expect([
      headers["x-frame-options"],
      headers["x-content-type-options"],
      headers["referrer-policy"],
      headers["cross-origin-opener-policy"],
    ]).toEqual(["DENY", "nosniff", "no-referrer", "same-origin"])
  },
)

test("a refusal and a redirect carry them too", async () => {
  const hq = await newHq()
  expect((await (await hqClient(hq, { host: "evil.example:49380" })).get("/")).headers).toHaveProperty(
    "content-security-policy",
  )
  const r = await (await hqClient(hq, { host: `localhost:${PORT}` })).get("/")
  expect([r.status, r.headers["x-frame-options"]]).toEqual([307, "DENY"])
})

test("a 500 carries them too", async () => {
  const hq = await newHq()
  hq.health = () => {
    throw new Error("boom")
  }
  const r = await (await hqClient(hq)).get("/api/health")
  expect([r.status, r.headers["x-frame-options"]]).toEqual([500, "DENY"])
})

test("a websocket upgrade is served as plain http", async () => {
  const c = await hqClient(await newHq())
  const upgrade = [
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
  ]
  // No Connection: close, so the only Connection token is Upgrade and the request is a real upgrade.
  const opts = { origin: null, headers: upgrade, close: false }
  const r = parse((await raw(c.sock, message("GET", "/api/health", opts), { until: "head" })).text)
  expect(r.status).toBe(200)
  expectSecurityHeaders(r.head)
})

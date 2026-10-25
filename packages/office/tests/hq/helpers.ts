/** HQ test helpers (Python's `tests/hq/conftest.py` and `net.py`): an office with HQ attached but not listening, and
 *  clients for its HQ app. */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import type { ServerResponse } from "node:http"
import { expect, onTestFinished } from "bun:test"
import { type Limits, createServer } from "../../src/daemon/http.ts"
import type { Office } from "../../src/daemon/office.ts"
import { listenUnix } from "../../src/daemon/sockets.ts"
import { createHqApp } from "../../src/hq/api.ts"
import { type Hq, attach } from "../../src/hq/core.ts"
import { HEADERS, type Inner, hqGuard } from "../../src/hq/guard.ts"
import { HQ_LIMITS } from "../../src/hq/servers.ts"
import { shortDir } from "../helpers.ts"
import { CEO, type Reply, request } from "../daemon/helpers.ts"

export const PORT = 49380
export const HOST = `127.0.0.1:${PORT}`
export const ORIGIN = `http://${HOST}`

/** A built app in `dir/dist`: index.html, one hashed asset, theme.js and build.json (Python's `dist`). */
export function dist(dir: string): string {
  const root = path.join(dir, "dist")
  fs.mkdirSync(path.join(root, "assets"), { recursive: true })
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>OpenCorp HQ</title>")
  fs.writeFileSync(path.join(root, "assets", "index-abc123.js"), "console.log(1)")
  fs.writeFileSync(path.join(root, "theme.js"), "// theme")
  fs.writeFileSync(path.join(root, "build.json"), JSON.stringify({ build: "b1", api: "x" }))
  return root
}

/** HQ attached to `office` and the office started, with `settings` as office/hq.json (default
 *  {tcp: false, app_dir: <home>/dist}); `logs` collects HQ's log lines (Python's `hq` fixture). */
export async function makeHq(
  office: Office,
  { settings, logs }: { settings?: Record<string, unknown>; logs?: string[] } = {},
): Promise<Hq> {
  fs.mkdirSync(office.paths.office, { recursive: true, mode: 0o700 })
  const data = settings ?? { tcp: false, app_dir: path.join(office.paths.home, "dist") }
  fs.writeFileSync(path.join(office.paths.office, "hq.json"), JSON.stringify(data))
  const hq = attach(office, { log: (line) => logs?.push(line) })
  // makeOffice stops the office when the test finishes.
  await office.start()
  return hq
}

/** What `HqClient.request` sends besides the method and target. */
export type RequestOpts = {
  headers?: Record<string, string>
  json?: unknown
  body?: string | Buffer
  chunks?: AsyncIterable<Buffer>
  query?: [string, string][] | Record<string, string>
}

/** A client of one HQ app served on a unix socket, with a cookie jar (Python's httpx clients). */
export class HqClient {
  readonly sock: string
  readonly cookies = new Map<string, string>()
  readonly #headers: Record<string, string>

  constructor(sock: string, headers: Record<string, string>) {
    this.sock = sock
    this.#headers = headers
  }

  /** One request with the client's headers, `opts.headers` over them, and the jar's cookies unless a `cookie`
   *  header is given; keeps the cookies the reply sets. */
  async request(method: string, target: string, opts: RequestOpts = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...this.#headers }
    for (const [name, value] of Object.entries(opts.headers ?? {})) headers[name.toLowerCase()] = value
    let body = opts.body
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(opts.json)
    }
    if (headers.cookie === undefined && this.cookies.size > 0)
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    let url = target
    if (opts.query !== undefined) {
      const query = new URLSearchParams(opts.query).toString()
      if (query) url += (url.includes("?") ? "&" : "?") + query
    }
    const reply = await request(this.sock, method, url, { headers, body, chunks: opts.chunks, setHost: false })
    for (const cookie of [reply.headers["set-cookie"] ?? []].flat()) {
      const first = cookie.split(";")[0]!
      const at = first.indexOf("=")
      const name = first.slice(0, at).trim()
      if (/;\s*max-age=0\s*(;|$)/i.test(cookie)) this.cookies.delete(name)
      else this.cookies.set(name, first.slice(at + 1))
    }
    return reply
  }

  get(target: string, opts?: Omit<RequestOpts, "json" | "body" | "chunks">): Promise<Reply> {
    return this.request("GET", target, opts)
  }

  post(target: string, json?: unknown, opts?: Omit<RequestOpts, "json">): Promise<Reply> {
    return this.request("POST", target, { ...opts, json })
  }
}

/** Serves `createHqApp(hq, {port})` on a unix socket with `limits` (HQ's by default) until the test finishes; a
 *  client sending `host` and `headers` whose requests come from `peer` (null: none, as on hq.sock) (Python's
 *  `hq_client`; ASGITransport's default peer was 127.0.0.1). */
export async function hqClient(
  hq: Hq,
  {
    port = PORT,
    host = HOST,
    peer = "127.0.0.1",
    headers = {},
    limits = HQ_LIMITS,
  }: {
    port?: number | null
    host?: string
    peer?: string | null
    headers?: Record<string, string>
    limits?: Limits
  } = {},
): Promise<HqClient> {
  const app = createHqApp(hq, { port })
  const server = createServer(
    (req, res) => {
      // A unix socket has no remote address; the TCP listener's requests come from 127.0.0.1.
      if (peer !== null) Object.defineProperty(req.socket, "remoteAddress", { value: peer, configurable: true })
      return app(req, res)
    },
    limits,
  )
  const sock = path.join(shortDir(), "hq.sock")
  onTestFinished(async () => {
    // On Bun, closeAllConnections also stops the listener, so close's callback may get ERR_SERVER_NOT_RUNNING.
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    fs.rmSync(sock, { force: true })
  })
  await listenUnix(server, sock)
  const sent: Record<string, string> = { host }
  for (const [name, value] of Object.entries(headers)) sent[name.toLowerCase()] = value
  return new HqClient(sock, sent)
}

/** A client sending the app's own origin (Python's `web`). */
export function web(hq: Hq): Promise<HqClient> {
  return hqClient(hq, { headers: { origin: ORIGIN } })
}

/** A pairing code minted for the CEO, by the CEO. */
export async function pairCode(hq: Hq): Promise<string> {
  return (await hq.mint(CEO, { issuer: CEO, openFile: false })).path.split("#")[1]!
}

/** `web` with a browser session for the CEO, paired; asserts the pair answered 200 (Python's `signed_in`). */
export async function signedIn(hq: Hq): Promise<HqClient> {
  const client = await web(hq)
  expect((await client.post("/api/pair", { code: await pairCode(hq) })).status).toBe(200)
  return client
}

/** A TCP port on 127.0.0.1 that nothing listens on right now (Python's `free_port`). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/** One request the guard's listener got: whether its promise settled, and its response. */
export type Call = { settled: boolean; res: ServerResponse }

/** Serves `inner` behind the guard on a unix socket until the current test finishes. */
export async function guarded(
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

export type Message = {
  host?: string | null
  origin?: string | null
  headers?: string[]
  body?: string
  /** Asks the server to close the connection after its reply (the default), so `raw` reads to the end. */
  close?: boolean
}

/** A raw HTTP/1.1 request; `body` is sent with its Content-Length. */
export function message(
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

export const JSON_TYPE = "Content-Type: application/json"

/** The values of header `name` in a raw response head. */
export function values(head: string, name: string): string[] {
  return head
    .split("\r\n")
    .slice(1)
    .filter((line) => line.toLowerCase().startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim())
}

/** Expects `head` to carry each of HQ's headers exactly once, with HQ's value. */
export function expectSecurityHeaders(head: string): void {
  for (const [name, value] of Object.entries(HEADERS)) expect(values(head, name)).toEqual([value])
}

/** Whether a raw response head asks to close the connection. */
export const closes = (head: string) => values(head, "connection").some((v) => v.toLowerCase() === "close")

/** Sends `head`, then a byte every 100 ms: from the start with `now`, else once a reply's head has arrived, so
 *  the reply is read before a write can fail with EPIPE. What came back and whether the server closed in 4 s. */
export function trickle(sock: string, head: string, { now = false } = {}): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(sock)
    let text = ""
    let timer: ReturnType<typeof setInterval> | undefined
    const finish = (closed: boolean) => {
      clearInterval(timer)
      clearTimeout(deadline)
      socket.destroy()
      resolve({ text, closed })
    }
    const start = () => {
      timer ??= setInterval(() => {
        if (socket.writable) socket.write("x")
      }, 100)
    }
    const deadline = setTimeout(() => finish(false), 4000)
    socket.on("connect", () => {
      socket.write(head)
      if (now) start()
    })
    socket.on("data", (data: Buffer) => {
      text += data.toString()
      if (text.includes("\r\n\r\n")) start()
    })
    socket.on("end", () => finish(true))
    socket.on("close", () => finish(true))
    socket.on("error", () => finish(true))
  })
}

/** A POST head from the app's own page that promises a `length`-byte JSON body. */
export const post = (target: string, { host = HOST, length = 1000 } = {}) =>
  message("POST", target, { host, headers: [JSON_TYPE, `Content-Length: ${length}`], close: false })

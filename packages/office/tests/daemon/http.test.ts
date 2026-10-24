/** The office's sockets and HTTP pipeline: a 0700 office dir, 0600 unix sockets, HQ's TCP socket on loopback. */
import fs from "node:fs"
import http, { type IncomingHttpHeaders } from "node:http"
import net from "node:net"
import path from "node:path"
import { describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { AnswerRequest, LoginRequest, SetPasswordRequest } from "@opencorp/protocol"
import { z } from "zod"
import {
  HttpError,
  LIMITS,
  type Limits,
  MAX_BODY,
  type RequestInfo,
  type Route,
  createServer,
  logLine,
  readBody,
  requestListener,
} from "../../src/daemon/http.ts"
import {
  OfficeStartError,
  listenTcp,
  listenUnix,
  makeOfficeDir,
  removeStaleSocket,
} from "../../src/daemon/sockets.ts"
import { NotFound } from "../../src/store/store.ts"
import { shortDir, tempDir, waitFor } from "../helpers.ts"

setDefaultTimeout(30_000)

/** The context the test routes see. */
type Ctx = { person: string; signal: AbortSignal; query: URLSearchParams }

const defaultContext = (info: RequestInfo): Ctx => ({ person: "ngocbh", signal: info.signal, query: info.query })

/** Serves `routes` on a unix socket until the current test finishes; `settled` counts answered requests. */
async function serve(
  routes: readonly Route<Ctx>[],
  {
    log = () => {},
    context = defaultContext,
    limits,
  }: { log?: (line: string) => void; context?: (info: RequestInfo) => Ctx | Promise<Ctx>; limits?: Limits } = {},
): Promise<{ sock: string; server: http.Server; settled: () => number }> {
  let settled = 0
  const listener = requestListener(routes, { context, log })
  const server = createServer((req, res) => listener(req, res).finally(() => settled++), limits)
  const sock = path.join(shortDir(), "o.sock")
  onTestFinished(async () => {
    // On Bun's node:http, closeAllConnections also stops the listener, so close's callback gets
    // ERR_SERVER_NOT_RUNNING; on Node close is still needed. The other order force-closes nothing on Bun.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(sock, { force: true })
  })
  await listenUnix(server, sock)
  return { sock, server, settled: () => settled }
}

type Reply = { status: number; headers: IncomingHttpHeaders; text: string; json(): unknown }

/** One request over `node:http`, on a fresh connection. Under `bun test` this client is fetch-based, so
 *  assertions about `connection: close` or reuse go through `raw` or `Conn`. */
function request(
  sock: string,
  method: string,
  target: string,
  {
    headers = {},
    body,
    chunks,
  }: { headers?: Record<string, string>; body?: Buffer | string; chunks?: AsyncIterable<Buffer> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let responded = false
    const req = http.request({ socketPath: sock, method, path: target, headers, agent: false }, (res) => {
      responded = true
      const parts: Buffer[] = []
      res.on("data", (part: Buffer) => parts.push(part))
      res.on("error", reject)
      res.on("end", () => {
        const text = Buffer.concat(parts).toString()
        resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    // A write error (EPIPE, ECONNRESET) after the server answered is the server not reading the rest.
    const failed = (error: unknown) => {
      if (!responded) reject(error)
    }
    req.on("error", failed)
    if (chunks)
      (async () => {
        for await (const chunk of chunks) req.write(chunk)
        req.end()
      })().catch(failed)
    else req.end(body)
  })
}

/** Writes `text` on a new connection and reads until the first line, the end of the head, or EOF. `closed`
 *  is true only when the peer ended the connection (a reset counts). */
function raw(
  sock: string,
  text: string,
  { until = "close", timeout = 9000 }: { until?: "line" | "head" | "close"; timeout?: number } = {},
): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock)
    let got = ""
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("raw read timed out"))
    }, timeout)
    const finish = (closed: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ text: got, closed })
    }
    socket.on("connect", () => socket.write(text))
    socket.on("data", (data: Buffer) => {
      got += data.toString()
      if ((until === "line" && got.includes("\r\n")) || (until === "head" && got.includes("\r\n\r\n"))) finish(false)
    })
    socket.on("end", () => finish(true))
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") return finish(true)
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    })
  })
}

/** The status, head and body of one raw response. */
function parse(text: string): { status: number; head: string; body: string } {
  const at = text.indexOf("\r\n\r\n")
  const head = at < 0 ? text : text.slice(0, at)
  return { status: Number(head.split(" ")[1]), head, body: at < 0 ? "" : text.slice(at + 4) }
}

/** A raw `method target` request on its own connection, asking the server to close it after. */
async function exchange(sock: string, method: string, target: string) {
  const { text } = await raw(sock, `${method} ${target} HTTP/1.1\r\nhost: office\r\nconnection: close\r\n\r\n`)
  return parse(text)
}

/** One held connection, for keep-alive checks. */
class Conn {
  private buf = Buffer.alloc(0)
  private ended = false
  private wake: (() => void) | undefined

  private constructor(readonly socket: net.Socket) {
    const end = () => {
      this.ended = true
      this.wake?.()
    }
    socket.on("data", (data: Buffer) => {
      this.buf = Buffer.concat([this.buf, data])
      this.wake?.()
    })
    socket.on("end", end)
    socket.on("close", end)
    socket.on("error", end)
  }

  static async open(sock: string): Promise<Conn> {
    const socket = net.connect(sock)
    onTestFinished(() => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve())
      socket.once("error", reject)
    })
    return new Conn(socket)
  }

  send(text: string): void {
    this.socket.write(text)
  }

  /** Waits until `ready()` holds or `deadline` passes; false if it didn't hold. */
  private async until(ready: () => boolean, deadline: number): Promise<boolean> {
    while (!ready()) {
      const left = deadline - performance.now()
      if (this.ended || left <= 0) return ready()
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.wake = undefined
          resolve()
        }
        const timer = setTimeout(done, left)
        this.wake = done
      })
    }
    return true
  }

  /** The next whole response, as soon as it is all read. */
  async response({ timeout = 9000 } = {}): Promise<{ status: number; head: string; body: string }> {
    const deadline = performance.now() + timeout
    if (!(await this.until(() => this.buf.includes("\r\n\r\n"), deadline))) throw new Error("no response head")
    const at = this.buf.indexOf("\r\n\r\n")
    const head = this.buf.subarray(0, at).toString()
    const end = at + 4 + Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? 0)
    if (!(await this.until(() => this.buf.length >= end, deadline))) throw new Error("short response body")
    const body = this.buf.subarray(at + 4, end).toString()
    this.buf = this.buf.subarray(end)
    return { status: Number(head.split(" ")[1]), head, body }
  }

  /** Whether the peer ends or resets the connection (or already has) within `timeout`. */
  closed({ timeout = 9000 } = {}): Promise<boolean> {
    return this.until(() => this.ended, performance.now() + timeout)
  }
}

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777
}

/** A server closed when the current test finishes. */
function server(): net.Server {
  const s = net.createServer((conn) => conn.end())
  onTestFinished(() => new Promise<void>((resolve) => (s.listening ? s.close(() => resolve()) : resolve())))
  return s
}

/** Closes `s` and waits for it. */
function close(s: net.Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())))
}

/** A unix socket at `socketPath` whose server is closed: the file stays, as after a crash. */
async function staleSocket(socketPath: string): Promise<void> {
  const s = server()
  await listenUnix(s, socketPath)
  await close(s)
}

describe("sockets", () => {
  test("socket is 0600 even with a loose umask", async () => {
    const dir = shortDir()
    const sock = path.join(dir, "s.sock")
    const old = process.umask(0o022)
    try {
      await listenUnix(server(), sock)
    } finally {
      process.umask(old)
    }
    expect(mode(sock)).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(["s.sock"]) // the temp folder is gone
  })

  test("the socket mode leaves the process umask as it found it", async () => {
    const sock = path.join(shortDir(), "s.sock")
    const prev = process.umask(0o027)
    let after: number
    try {
      await listenUnix(server(), sock)
    } finally {
      // Restores the umask and reads the one listenUnix left, in one call.
      after = process.umask(prev)
    }
    expect(after).toBe(0o027)
    expect(mode(sock)).toBe(0o600)
  })

  test("too long socket path is a clear error", async () => {
    const sock = path.join(tempDir(), "x".repeat(120), "office.sock")
    const err = await listenUnix(server(), sock).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OfficeStartError)
    expect((err as Error).message).toMatch(/socket path too long/)
  })

  test("office dir is created 0700", () => {
    const office = path.join(shortDir(), "home", "office")
    makeOfficeDir(office)
    expect(mode(office)).toBe(0o700)
  })

  test("a loose office dir is tightened to 0700", () => {
    const office = path.join(shortDir(), "office")
    fs.mkdirSync(office)
    fs.chmodSync(office, 0o755)
    makeOfficeDir(office)
    expect(mode(office)).toBe(0o700)
  })

  test.each(["dir", "missing"])("a symlinked office dir is refused [%s]", (target) => {
    const dir = shortDir()
    const elsewhere = path.join(dir, "elsewhere")
    if (target === "dir") fs.mkdirSync(elsewhere)
    const office = path.join(dir, "office")
    fs.symlinkSync(elsewhere, office)
    let err: unknown
    try {
      makeOfficeDir(office)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OfficeStartError)
    expect((err as Error).message).toContain(office)
    expect(!fs.existsSync(elsewhere) || fs.readdirSync(elsewhere).length === 0).toBe(true)
  })

  test("an office dir owned by someone else is refused", () => {
    const dir = shortDir()
    const office = path.join(dir, "office")
    fs.mkdirSync(office)
    expect(() => makeOfficeDir(office, fs.statSync(dir).uid + 1)).toThrow(OfficeStartError)
    expect(() => makeOfficeDir(office, fs.statSync(dir).uid + 1)).toThrow(/owned by uid/)
  })

  test("a stale socket is removed", async () => {
    const sock = path.join(shortDir(), "s.sock")
    await staleSocket(sock) // closing leaves the file, as a crash does
    expect(fs.lstatSync(sock).isSocket()).toBe(true)
    removeStaleSocket(sock)
    expect(fs.existsSync(sock)).toBe(false)
    removeStaleSocket(sock) // nothing there is fine
  })

  test.each(["dir", "file", "symlink"])("something else at the socket path is refused [%s]", async (kind) => {
    const dir = shortDir()
    const sock = path.join(dir, "s.sock")
    if (kind === "dir") fs.mkdirSync(sock)
    else if (kind === "file") fs.writeFileSync(sock, "mine")
    else {
      await staleSocket(path.join(dir, "real.sock"))
      fs.symlinkSync(path.join(dir, "real.sock"), sock)
    }
    expect(() => removeStaleSocket(sock)).toThrow(OfficeStartError)
    expect(() => removeStaleSocket(sock)).toThrow(/not a socket/)
    expect(() => fs.lstatSync(sock)).not.toThrow()
  })

  test("the tcp socket listens on loopback and never shares the port", async () => {
    const first = server()
    const port = await listenTcp(first, 0)
    expect((first.address() as net.AddressInfo).address).toBe("127.0.0.1")
    const err = await listenTcp(server(), port).catch((e: unknown) => e)
    expect((err as NodeJS.ErrnoException).code).toBe("EADDRINUSE")
  })

  test("the tcp socket binds a port left in time wait", async () => {
    // The server side closes its one connection first, so that connection sits in TIME_WAIT on the
    // server's port, as after a restart with a browser stream open.
    const listener = server()
    const port = await listenTcp(listener, 0)
    const client = net.connect(port, "127.0.0.1")
    onTestFinished(() => client.destroy())
    // The client reads to EOF, then ends: a FIN, not a RST that clears TIME_WAIT.
    await new Promise<void>((resolve, reject) => {
      client.on("error", reject)
      client.on("data", () => {})
      client.on("end", () => {
        client.end()
        resolve()
      })
    })
    await new Promise<void>((resolve) => client.on("close", () => resolve()))
    await close(listener)
    expect(await listenTcp(server(), port)).toBe(port)
  })
})

const SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"

const people: Route<Ctx> = { method: "GET", path: "/people", handler: () => [{ handle: "ngocbh" }] }
const session: Route<Ctx> = { method: "GET", path: "/sessions/:id", handler: (_, p) => ({ id: p.id }) }
const boom: Route<Ctx> = {
  method: "GET",
  path: "/boom",
  handler: () => {
    throw new Error("disk on fire")
  },
}

describe("routes", () => {
  test("unknown route is an api error", async () => {
    const { sock } = await serve([people])
    const r = await request(sock, "GET", "/nope")
    expect(r.status).toBe(404)
    expect(r.json()).toEqual({ error: "no_route", message: "no route GET /nope" })
  })

  test("absolute form target is rewritten to its path", async () => {
    const root: Route<Ctx> = { method: "GET", path: "/", handler: () => ({ root: true }) }
    const { sock } = await serve([people, session, root])
    const got = await exchange(sock, "GET", "http://office/sessions/S1")
    expect([got.status, JSON.parse(got.body)]).toEqual([200, { id: "S1" }])
    const top = await exchange(sock, "GET", "http://office")
    expect([top.status, JSON.parse(top.body)]).toEqual([200, { root: true }])
    const plain = await exchange(sock, "GET", "/people")
    expect([plain.status, JSON.parse(plain.body)]).toEqual([200, [{ handle: "ngocbh" }]])
  })

  test("wrong method is 405 with every allowed method", async () => {
    const add: Route<Ctx> = { method: "POST", path: "/people", handler: () => ({}) }
    const messages: Route<Ctx> = { method: "GET", path: "/sessions/:id/messages", handler: () => [] }
    const { sock } = await serve([people, add, messages])
    let r = await request(sock, "DELETE", "/people")
    expect(r.status).toBe(405)
    expect(r.json()).toEqual({ error: "method_not_allowed", message: "DELETE is not allowed on /people" })
    expect(r.headers.allow).toBe("GET, HEAD, POST")
    r = await request(sock, "POST", "/sessions/X/messages")
    expect(r.status).toBe(405)
    expect(r.headers.allow).toBe("GET, HEAD")
  })

  test("unexpected error is a 500 api error", async () => {
    const { sock } = await serve([boom])
    const r = await request(sock, "GET", "/boom")
    expect(r.status).toBe(500)
    expect(r.json()).toEqual({ error: "internal_error", message: "internal error" })
  })

  test("a 500 closes its connection so the next request works", async () => {
    const { sock } = await serve([people, boom])
    const conn = await Conn.open(sock)
    conn.send("GET /boom HTTP/1.1\r\nhost: office\r\n\r\n")
    const r = await conn.response()
    expect(r.status).toBe(500)
    expect(r.head.toLowerCase()).toContain("\r\nconnection: close")
    expect(await conn.closed()).toBe(true)
    expect((await request(sock, "GET", "/people")).status).toBe(200)
  })

  test("a decoded slash or dot dot in a param is a 404", async () => {
    const { sock } = await serve([session])
    for (const target of ["/sessions/a%2Fb", "/sessions/%2E%2E"]) {
      const r = await exchange(sock, "GET", target)
      expect([r.status, JSON.parse(r.body).error]).toEqual([404, "no_route"])
    }
    const r = await exchange(sock, "GET", "/sessions/a%20b")
    expect([r.status, JSON.parse(r.body)]).toEqual([200, { id: "a b" }])
  })

  test("a malformed or empty path segment is a 404", async () => {
    const lines: string[] = []
    const messages: Route<Ctx> = { method: "GET", path: "/sessions/:id/messages", handler: () => [] }
    const { sock } = await serve([people, session, messages], { log: (line) => lines.push(line) })
    for (const target of ["/people%", "/%zz/x", "/sessions//messages", "/sessions/"]) {
      const r = await exchange(sock, "GET", target)
      expect([target, r.status, JSON.parse(r.body).error]).toEqual([target, 404, "no_route"])
    }
    expect(lines).toEqual([])
  })

  test("a get route can refuse head", async () => {
    const events: Route<Ctx> = { method: "GET", path: "/events", head: false, handler: () => ({}) }
    const { sock } = await serve([events])
    const r = await request(sock, "HEAD", "/events")
    expect(r.status).toBe(405)
    expect(r.headers.allow).toBe("GET")
    expect((await request(sock, "GET", "/events")).status).toBe(200)
  })

  test("the context runs before routing", async () => {
    const add: Route<Ctx> = { method: "POST", path: "/people", handler: () => ({}) }
    const { sock } = await serve([add], {
      context: () => {
        throw new HttpError(401, "unauthenticated", "who are you")
      },
    })
    const r = await request(sock, "GET", "/nope")
    expect(r.status).toBe(401)
    expect(r.json()).toEqual({ error: "unauthenticated", message: "who are you" })
    const got = await raw(sock, "POST /people HTTP/1.1\r\nhost: office\r\ncontent-length: 5\r\n\r\nhello")
    const res = parse(got.text)
    expect(res.status).toBe(401)
    expect(res.head.toLowerCase()).toContain("\r\nconnection: close")
    expect(got.closed).toBe(true)
  })

  test("a reply that fails its schema is a 500 that leaks nothing", async () => {
    const lines: string[] = []
    const leaky: Route<Ctx> = {
      method: "GET",
      path: "/leaky",
      reply: z.strictObject({ a: z.string() }),
      handler: () => ({ a: "x", [SENTINEL]: 1 }),
    }
    const { sock } = await serve([leaky], { log: (line) => lines.push(line) })
    const r = await request(sock, "GET", "/leaky")
    expect(r.status).toBe(500)
    expect(r.json()).toEqual({ error: "internal_error", message: "internal error" })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEndWith(": ZodError")
    expect(r.text + lines.join("\n")).not.toContain(SENTINEL)
  })

  test("a wildcard param is decoded once", async () => {
    const folder: Route<Ctx> = { method: "GET", path: "/folders/*cwd/people", handler: (_, p) => ({ cwd: p.cwd }) }
    const { sock } = await serve([folder])
    for (const [target, cwd] of [
      ["/folders/%2Fw%2Fapp/people", "/w/app"],
      ["/folders//w/app/people", "/w/app"],
      ["/folders/%252F/people", "%2F"],
    ]) {
      const r = await exchange(sock, "GET", target!)
      expect([target, r.status, JSON.parse(r.body)]).toEqual([target, 200, { cwd }])
    }
    const r = await exchange(sock, "GET", "/folders/%2Fa%2F..%2Fb/people")
    expect([r.status, JSON.parse(r.body).error]).toEqual([404, "no_route"])
  })

  test("head on a get route answers without a body", async () => {
    const { sock } = await serve([people])
    const r = await request(sock, "HEAD", "/people")
    expect(r.status).toBe(200)
    expect(r.text).toBe("")
    expect(r.headers["content-type"]).toBe("application/json")
  })

  test("a reply is parsed so its defaults are filled", async () => {
    const tagged: Route<Ctx> = {
      method: "GET",
      path: "/tagged",
      reply: z.strictObject({ a: z.string(), tags: z.array(z.string()).default(() => []) }),
      handler: () => ({ a: "x" }),
    }
    const { sock } = await serve([tagged])
    const r = await request(sock, "GET", "/tagged")
    expect(r.status).toBe(200)
    expect(r.text).toBe('{"a":"x","tags":[]}')
  })

  test("a 500 logs only the error type", async () => {
    const lines: string[] = []
    const typed: Route<Ctx> = {
      method: "GET",
      path: "/boom",
      handler: () => {
        throw new TypeError(SENTINEL)
      },
    }
    const { sock } = await serve([typed], { log: (line) => lines.push(line) })
    const r = await request(sock, "GET", "/boom")
    expect(r.status).toBe(500)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\S+ ERROR opencorp\.daemon\.http: internal error on GET \/boom: TypeError$/)
    expect(r.text + lines.join("\n")).not.toContain(SENTINEL)
  })

  test("an http error is its status code and message", async () => {
    let ran = false
    const guarded: Route<Ctx> = {
      method: "GET",
      path: "/mine",
      guard: () => {
        throw new HttpError(403, "forbidden", "not yours")
      },
      handler: () => {
        ran = true
        return {}
      },
    }
    const { sock } = await serve([guarded])
    const r = await request(sock, "GET", "/mine")
    expect(r.status).toBe(403)
    expect(r.json()).toEqual({ error: "forbidden", message: "not yours" })
    expect(ran).toBe(false)
  })

  test("a store not found is 404 not found", async () => {
    const missing: Route<Ctx> = {
      method: "GET",
      path: "/questions/:id",
      handler: () => {
        throw new NotFound("no question q9")
      },
    }
    const { sock } = await serve([missing])
    const r = await request(sock, "GET", "/questions/q9")
    expect(r.status).toBe(404)
    expect(r.text).toBe('{"error":"not_found","message":"no question q9"}')
  })

  test("the request signal aborts when the client goes away", async () => {
    let started = false
    let aborted = false
    const slow: Route<Ctx> = {
      method: "GET",
      path: "/slow",
      handler: async (ctx) => {
        started = true
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve))
        aborted = true
        throw ctx.signal.reason
      },
    }
    const lines: string[] = []
    const { sock, settled } = await serve([slow], { log: (line) => lines.push(line) })
    const conn = await Conn.open(sock)
    conn.send("GET /slow HTTP/1.1\r\nhost: office\r\n\r\n")
    await waitFor(() => started, { timeout: 9000, what: "the handler to start" })
    conn.socket.destroy()
    await waitFor(() => aborted, { timeout: 9000, what: "the signal to abort" })
    await waitFor(() => settled() === 1, { timeout: 9000, what: "the request to settle" })
    expect(lines).toEqual([]) // an abort is no 500 and logs nothing
  })
})

/** Short deadlines, checked often, so a stalled request is cut within a test's time. */
const SHORT: Limits = {
  connectionsCheckingInterval: 200,
  headersTimeout: 1000,
  requestTimeout: 1500,
  keepAliveTimeout: 4000,
}

describe("server", () => {
  test("a websocket upgrade is served as plain http on the office socket", async () => {
    const health: Route<Ctx> = { method: "GET", path: "/health", handler: () => ({ ok: true }) }
    const { sock } = await serve([health])
    const got = await raw(
      sock,
      "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      { until: "line", timeout: 5000 },
    )
    expect(got.text).toStartWith("HTTP/1.1 200")
  })

  test("the office server has no upgrade listener", () => {
    expect(createServer(() => {}).listenerCount("upgrade")).toBe(0)
  })

  test("the listener limits are the designs values", () => {
    expect(LIMITS).toEqual({
      connectionsCheckingInterval: 1000,
      headersTimeout: 10_000,
      requestTimeout: 20_000,
      keepAliveTimeout: 4000,
    })
    const s = createServer(() => {})
    expect([s.headersTimeout, s.requestTimeout, s.keepAliveTimeout, s.timeout]).toEqual([10_000, 20_000, 4000, 0])
    expect(s.maxConnections).toBe(http.createServer().maxConnections)
    expect(createServer(() => {}, { ...LIMITS, maxConnections: 2 }).maxConnections).toBe(2)
  })

  test(
    "a stalled head is cut with 408",
    async () => {
      // requestTimeout is out of reach, so the 408 is headersTimeout's.
      const { sock } = await serve([people], { limits: { ...SHORT, requestTimeout: 20_000 } })
      // The status line tells this deadline from the runtime's own close of a never-finished head at about 12 s,
      // which sends no status line.
      const got = await raw(sock, "GET / HTTP/1.1\r\nHost: x\r\n", { until: "line", timeout: 9000 })
      expect(got.text).toStartWith("HTTP/1.1 408")
    },
    15_000,
  )

  test(
    "a slow reply is not cut by the request timeout",
    async () => {
      const slow: Route<Ctx> = {
        method: "GET",
        path: "/slow",
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2500))
          return { ok: true }
        },
      }
      const { sock } = await serve([slow], { limits: SHORT })
      const r = await exchange(sock, "GET", "/slow")
      expect([r.status, JSON.parse(r.body)]).toEqual([200, { ok: true }])
    },
    15_000,
  )

  test("connections past max connections are closed", async () => {
    const { sock, server } = await serve([people], { limits: { ...LIMITS, maxConnections: 2 } })
    const one = await Conn.open(sock)
    const two = await Conn.open(sock)
    await waitFor(() => new Promise<boolean>((r) => server.getConnections((_, n) => r(n === 2))), {
      timeout: 10_000,
      what: "two connections",
    })
    expect(await raw(sock, "", { until: "close" })).toEqual({ text: "", closed: true })
    for (const conn of [one, two]) {
      conn.send("GET /people HTTP/1.1\r\nHost: x\r\n\r\n")
      expect((await conn.response()).status).toBe(200)
    }
  })

  test("a log line is the time level logger and message", () => {
    const at = new Date("2026-10-23T01:02:03.004Z")
    expect(logLine("INFO", "opencorp.hq.login", "sign-in for @ngocbh throttled", at)).toBe(
      "2026-10-23T01:02:03.004Z INFO opencorp.hq.login: sign-in for @ngocbh throttled",
    )
  })
})

/** The body test routes; `answered()` counts runs of the answer handler (Python's "the question is answered"). */
function bodyRoutes(...extra: Route<Ctx>[]): { routes: Route<Ctx>[]; answered: () => number } {
  let answered = 0
  const routes: Route<Ctx>[] = [
    {
      method: "POST",
      path: "/questions/:id/answer",
      body: AnswerRequest,
      guard: (_, p) => {
        if (p.id !== "q1") throw new HttpError(404, "not_found", `no question ${p.id}`)
      },
      reply: z.strictObject({ answer: z.unknown() }),
      handler: (_, __, body) => {
        answered++
        return { answer: (body as AnswerRequest).answer }
      },
    },
    { method: "PUT", path: "/people/:handle/password", body: SetPasswordRequest, handler: () => ({ ok: true }) },
    { method: "POST", path: "/login", body: LoginRequest, handler: () => ({ ok: true }) },
    { method: "GET", path: "/people", handler: () => [] },
    {
      method: "POST",
      path: "/guarded",
      body: z.unknown(),
      guard: () => {
        throw new HttpError(403, "forbidden", "no")
      },
      handler: () => ({}),
    },
    ...extra,
  ]
  return { routes, answered: () => answered }
}

/** Serves the body test routes plus `extra`. */
async function serveBodies(extra: Route<Ctx>[] = [], options: Parameters<typeof serve>[1] = {}) {
  const { routes, answered } = bodyRoutes(...extra)
  return { ...(await serve(routes, options)), answered }
}

const answerBody = (text: string) => `{"answer": "${text}", "answer_kind": "text"}`

/** An answer body of exactly `size` bytes. */
const answerOfSize = (size: number) => answerBody("x".repeat(size - answerBody("").length))

/** `count` chunks of 64 KiB. */
async function* chunksOf64k(count: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < count; i++) yield Buffer.alloc(64 * 1024, "x")
}

const ANSWER = "/questions/q1/answer"

describe("bodies", () => {
  test("a body at the cap is read", async () => {
    const { sock, answered } = await serveBodies()
    const body = answerOfSize(MAX_BODY)
    expect(Buffer.byteLength(body)).toBe(MAX_BODY)
    const r = await request(sock, "POST", ANSWER, { body })
    expect(r.status).toBe(200)
    expect((r.json() as { answer: string }).answer.length).toBe(MAX_BODY - answerBody("").length)
    expect(answered()).toBe(1)
  })

  test("a body over the cap is 413", async () => {
    const { sock, answered } = await serveBodies()
    const r = await request(sock, "POST", ANSWER, { body: answerOfSize(MAX_BODY + 1) })
    expect(r.status).toBe(413)
    expect(r.text).toBe('{"error":"body_too_large","message":"request body is over 1048576 bytes"}')
    expect(answered()).toBe(0)
  })

  test("a too large content length is refused before reading", async () => {
    const { sock, answered } = await serveBodies()
    const got = await raw(sock, `POST ${ANSWER} HTTP/1.1\r\nhost: office\r\ncontent-length: 67108864\r\n\r\n`, {
      until: "close",
    })
    const res = parse(got.text)
    expect(got.text).toStartWith("HTTP/1.1 413")
    expect(JSON.parse(res.body)).toEqual({ error: "body_too_large", message: "request body is over 1048576 bytes" })
    expect(got.closed).toBe(true)
    expect(answered()).toBe(0)
  })

  test("a chunked body stops being read past the cap", async () => {
    let pulled = 0
    async function* chunks(): AsyncGenerator<Buffer> {
      for (let i = 0; i < (64 * MAX_BODY) / 65536; i++) {
        pulled++
        yield Buffer.alloc(65536, "x")
      }
    }
    const err = await readBody(Object.assign(chunks(), { headers: {} })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect([(err as HttpError).status, (err as HttpError).code]).toEqual([413, "body_too_large"])
    expect(pulled).toBeLessThanOrEqual(MAX_BODY / 65536 + 1)
  })

  test("deeply nested json is 422", async () => {
    const { sock } = await serveBodies()
    const r = await request(sock, "POST", ANSWER, { body: "[".repeat(100_000) + "]".repeat(100_000) })
    expect([r.status, (r.json() as { error: string }).error]).toEqual([422, "invalid_body"])
  })

  test("over the cap on a real socket leaves the client working", async () => {
    const { sock } = await serveBodies()
    for (const content of [{ body: Buffer.alloc(4 * MAX_BODY, "x") }, { chunks: chunksOf64k(64) }]) {
      const r = await request(sock, "POST", ANSWER, content)
      expect([r.status, (r.json() as { error: string }).error]).toEqual([413, "body_too_large"])
      expect((await request(sock, "GET", "/people")).status).toBe(200)
    }
  })

  // A 422 never echoes the body: a password or key sent there would come back in the response.

  test("a short password is 422 without the password", async () => {
    const { sock } = await serveBodies()
    const r = await request(sock, "PUT", "/people/ngocbh/password", { body: JSON.stringify({ password: "Zq7xWv" }) })
    const got = r.json() as { error: string; message: string }
    expect([r.status, got.error]).toEqual([422, "invalid_body"])
    expect(r.text).not.toContain("Zq7xWv")
    expect(got.message).toContain("password")
  })

  test("an extra key is 422 without its name", async () => {
    const { sock } = await serveBodies()
    const body = JSON.stringify({ password: "long-enough-password", [SENTINEL]: 1 })
    const r = await request(sock, "PUT", "/people/ngocbh/password", { body })
    const got = r.json() as { error: string; message: string }
    expect([r.status, got.error]).toEqual([422, "invalid_body"])
    expect(r.text).not.toContain(SENTINEL)
    expect(got.message).toContain("an extra field")
  })

  test("a bad login body is 422 without its values or extra keys", async () => {
    const { sock } = await serveBodies()
    const body = JSON.stringify({
      handle: "ngocbh",
      password: [SENTINEL],
      device: "laptop",
      token_sha256: "0".repeat(64),
      [SENTINEL]: SENTINEL,
    })
    const r = await request(sock, "POST", "/login", { body })
    expect([r.status, (r.json() as { error: string }).error]).toEqual([422, "invalid_body"])
    expect(r.text).not.toContain(SENTINEL)
  })

  test("errors name neither a literal nor a union tag input", async () => {
    const Cat = z.strictObject({ type: z.literal("cat") })
    const Dog = z.strictObject({ type: z.literal("dog") })
    const Pets = z.strictObject({ colour: z.enum(["red", "blue"]), pet: z.discriminatedUnion("type", [Cat, Dog]) })
    const pets: Route<Ctx> = { method: "POST", path: "/pets", body: Pets, handler: () => ({}) }
    const { sock } = await serveBodies([pets])
    const body = JSON.stringify({ colour: SENTINEL, pet: { type: SENTINEL } })
    const r = await request(sock, "POST", "/pets", { body })
    expect(r.status).toBe(422)
    expect(r.text).not.toContain(SENTINEL)
    const message = (r.json() as { message: string }).message
    expect(message).toBe("colour: isn't an allowed value; pet: isn't an allowed value")
  })

  test("a body that isnt json is 422", async () => {
    const { sock } = await serveBodies()
    const r = await request(sock, "POST", ANSWER, { body: "{" + SENTINEL })
    expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message: "the body isn't JSON" }])
  })

  test("json nested 64 deep is read and 65 deep is 422", async () => {
    const any: Route<Ctx> = { method: "POST", path: "/any", body: z.unknown(), handler: () => ({ ok: true }) }
    const { sock } = await serveBodies([any])
    const nested = (depth: number, inner = "") => "[".repeat(depth) + inner + "]".repeat(depth)
    expect((await request(sock, "POST", "/any", { body: nested(64) })).status).toBe(200)
    const r = await request(sock, "POST", "/any", { body: nested(65) })
    expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message: "the body is nested too deeply" }])
    // Brackets in a string, after an escaped quote, don't count: this is 64 deep.
    const inString = nested(63, JSON.stringify(['"' + "[".repeat(100)]))
    expect((await request(sock, "POST", "/any", { body: inString })).status).toBe(200)
    // A string ending in an escaped backslash closes at the next quote; the brackets in the string after it
    // don't count either.
    const backslash = nested(63, JSON.stringify(["\\", "[".repeat(100)]))
    expect((await request(sock, "POST", "/any", { body: backslash })).status).toBe(200)
  })

  test("the guard runs before any body byte is read", async () => {
    const { sock } = await serveBodies()
    const got = await raw(sock, "POST /guarded HTTP/1.1\r\nhost: office\r\ncontent-length: 10\r\n\r\n", {
      until: "close",
    })
    const res = parse(got.text)
    expect([res.status, JSON.parse(res.body)]).toEqual([403, { error: "forbidden", message: "no" }])
    expect(res.head.toLowerCase()).toContain("\r\nconnection: close")
    expect(got.closed).toBe(true)
  })

  test("a body that isnt utf 8 is 422", async () => {
    const { sock } = await serveBodies()
    const r = await request(sock, "POST", ANSWER, { body: Buffer.from([0xff, 0xfe]) })
    expect([r.status, r.json()]).toEqual([422, { error: "invalid_body", message: "the body isn't JSON" }])
  })

  test(
    "a stalled body is cut with 408",
    async () => {
      const lines: string[] = []
      const { sock, settled, answered } = await serveBodies([], { limits: SHORT, log: (line) => lines.push(line) })
      const got = await raw(sock, `POST ${ANSWER} HTTP/1.1\r\nhost: office\r\ncontent-length: 10\r\n\r\nabc`, {
        until: "line",
        timeout: 9000,
      })
      expect(got.text).toStartWith("HTTP/1.1 408")
      await waitFor(() => settled() === 1, { timeout: 10_000, what: "the pipeline to settle" })
      expect(answered()).toBe(0)
      expect(lines).toEqual([])
    },
    15_000,
  )

  test("an unread body closes the connection and a read one keeps it", async () => {
    const ping: Route<Ctx> = { method: "POST", path: "/ping", handler: () => ({ ok: true }) }
    const { sock } = await serveBodies([ping])
    const unread = await Conn.open(sock)
    unread.send("POST /ping HTTP/1.1\r\nhost: office\r\ncontent-length: 5\r\n\r\nhello")
    const first = await unread.response()
    expect(first.status).toBe(200)
    expect(first.head.toLowerCase()).toContain("\r\nconnection: close")
    expect(await unread.closed()).toBe(true)

    const read = await Conn.open(sock)
    const body = answerBody("yes")
    read.send(`POST ${ANSWER} HTTP/1.1\r\nhost: office\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    const second = await read.response()
    expect(second.status).toBe(200)
    expect(second.head.toLowerCase()).not.toContain("connection: close")
    read.send("GET /people HTTP/1.1\r\nhost: office\r\n\r\n")
    expect((await read.response()).status).toBe(200)
  })
})

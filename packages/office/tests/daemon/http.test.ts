/** The office's sockets and HTTP pipeline: a 0700 office dir, 0600 unix sockets, HQ's TCP socket on loopback. */
import fs from "node:fs"
import http, { type IncomingHttpHeaders } from "node:http"
import net from "node:net"
import path from "node:path"
import { describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { z } from "zod"
import {
  HttpError,
  LIMITS,
  type Limits,
  type RequestInfo,
  type Route,
  createServer,
  logLine,
  requestListener,
} from "../../src/daemon/http.ts"
import {
  OfficeStartError,
  listenTcp,
  listenUnix,
  makeOfficeDir,
  removeStaleSocket,
} from "../../src/daemon/sockets.ts"
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
      const { sock } = await serve([people], { limits: SHORT })
      // The status line tells this deadline from the runtime's own cut at about 12 s, which sends nothing.
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

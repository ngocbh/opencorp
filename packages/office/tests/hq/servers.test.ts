/** HQ's servers: limits per listener, isolation from office.sock, bind and rebind. */
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { RequestInfo } from "../../src/daemon/http.ts"
import type { Office, RequestContext } from "../../src/daemon/office.ts"
import { allRoutes } from "../../src/daemon/routes/index.ts"
import { listenUnix } from "../../src/daemon/sockets.ts"
import type { Hq } from "../../src/hq/core.ts"
import { HQ_LIMITS, Listeners, MAX_OPEN } from "../../src/hq/servers.ts"
import { shortDir, waitFor } from "../helpers.ts"
import { CEO, Conn, type Reply, makeOffice, request, serve } from "../daemon/helpers.ts"
import { freePort, hqClient, makeHq, pairCode } from "./helpers.ts"

setDefaultTimeout(30_000)

const REQUEST = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:5555\r\n\r\n"
/** A request head that never ends. */
const STALLED = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:55"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A started office with HQ attached, its hq.json turning TCP on at a free port; `logs` gets HQ's log lines. */
async function setup(): Promise<{ office: Office; hq: Hq; logs: string[] }> {
  const office = makeOffice()
  const logs: string[] = []
  const settings = { tcp: true, port: await freePort(), app_dir: path.join(office.paths.home, "dist") }
  const hq = await makeHq(office, { settings, logs })
  return { office, hq, logs }
}

/** Moves the office's dir to a short path, so hq.sock fits in sun_path. */
function shortOffice(office: Office, dir = shortDir()): void {
  ;(office.paths as { office: string }).office = dir
}

/** The hq.sock flavour of the HQ app on a short-path unix socket, with HQ's limits unless `limits` is given. */
function hqServed(hq: Hq, limits = HQ_LIMITS) {
  return hqClient(hq, {
    port: null,
    peer: null,
    host: "127.0.0.1:5555",
    headers: { origin: "http://127.0.0.1:5555" },
    limits,
  })
}

/** The office's own routes on a unix socket, every request acting as the CEO. */
async function officeSock(office: Office): Promise<string> {
  const context = (info: RequestInfo): RequestContext => ({
    office,
    person: CEO,
    device: null,
    signal: info.signal,
    query: info.query,
  })
  return (await serve(allRoutes(), { context })).sock
}

/** Writes `text` on a new connection to `sock` and reads until the first line (unless `line` is false), the peer
 *  closing, or `ms`; `closed` is whether the peer ended or reset the connection. */
function attempt(
  sock: string,
  text: string,
  { ms = 2000, line = true } = {},
): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(sock)
    let got = ""
    const finish = (closed: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ text: got, closed })
    }
    const timer = setTimeout(() => finish(false), ms)
    socket.on("connect", () => socket.write(text))
    socket.on("data", (data: Buffer) => {
      got += data.toString()
      if (line && got.includes("\r\n")) finish(false)
    })
    socket.on("end", () => finish(true))
    socket.on("close", () => finish(true))
    socket.on("error", () => finish(true))
  })
}

/** One GET to 127.0.0.1:`port` on a fresh connection. */
function tcpGet(port: number, target: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on("data", (part: Buffer) => parts.push(part))
      res.on("error", reject)
      res.on("end", () => {
        const text = Buffer.concat(parts).toString()
        resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    req.on("error", reject)
    req.end()
  })
}

/** GET /api/health over hq.sock. */
function sockHealth(hq: Hq): Promise<Reply> {
  return request(hq.socket, "GET", "/api/health", { headers: { host: "127.0.0.1:5555" }, setHost: false })
}

const closeServer = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** A plain `net` server listening on 127.0.0.1:`port`, closed when the test finishes. */
async function hold(port: number): Promise<net.Server> {
  const holder = net.createServer()
  onTestFinished(() => closeServer(holder))
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject)
    holder.listen(port, "127.0.0.1", () => resolve())
  })
  return holder
}

test("the 65th connection is closed and office sock still answers", async () => {
  const { office, hq } = await setup()
  const client = await hqServed(hq)
  const sock = await officeSock(office)
  for (let i = 0; i < MAX_OPEN; i++) await Conn.open(client.sock)
  expect(await attempt(client.sock, "")).toEqual({ text: "", closed: true })
  expect((await request(sock, "GET", "/health")).status).toBe(200)
})

test("a connection without a full request head is closed", async () => {
  const { hq } = await setup()
  const client = await hqServed(hq, { ...HQ_LIMITS, headersTimeout: 300, connectionsCheckingInterval: 100 })
  const stalled = await attempt(client.sock, STALLED, { line: false })
  expect(stalled.closed).toBe(true)
  expect(stalled.text).toStartWith("HTTP/1.1 408")
  expect((await attempt(client.sock, REQUEST)).text).toStartWith("HTTP/1.1 200")
})

test("the next request head on a kept alive connection has its own deadline", async () => {
  const { hq } = await setup()
  const client = await hqServed(hq, { ...HQ_LIMITS, headersTimeout: 300, connectionsCheckingInterval: 100 })
  const conn = await Conn.open(client.sock)
  conn.send(REQUEST)
  expect((await conn.response({ timeout: 2000 })).status).toBe(200)
  conn.send("G")
  expect(await conn.closed({ timeout: 2000 })).toBe(true)
})

test("a websocket upgrade is served as plain http on hq", async () => {
  const { hq } = await setup()
  const client = await hqServed(hq)
  const upgrade =
    "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
  expect((await attempt(client.sock, upgrade)).text).toStartWith("HTTP/1.1 200")
})

test("idle connections never 503 the owner", async () => {
  const { hq } = await setup()
  const client = await hqServed(hq)
  // The owner's keep-alive connection, kept open.
  const owner = await Conn.open(client.sock)
  owner.send(REQUEST)
  expect((await owner.response({ timeout: 2000 })).status).toBe(200)
  for (let i = 0; i < MAX_OPEN - 2; i++) await Conn.open(client.sock)
  // The 64th open connection.
  expect((await attempt(client.sock, REQUEST)).text).toStartWith("HTTP/1.1 200")
})

test("hq never serves socket routes and the socket never serves hq", async () => {
  const { office, hq } = await setup()
  const web = await hqServed(hq)
  expect((await web.post("/api/pair", { code: await pairCode(hq) })).status).toBe(200)
  const sock = await officeSock(office)
  const page = await web.get("/hq", { headers: { "sec-fetch-dest": "document" } })
  expect(page.headers["content-type"]).not.toContain("application/json")
  const r = await request(sock, "GET", "/api/health")
  expect([r.status, (r.json() as { error: string }).error]).toEqual([404, "no_route"])
})

test("hq sock is 0600 and tcp listens on the port", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  const listeners = new Listeners(hq)
  await listeners.start()
  try {
    await waitFor(() => hq.boundPort, { timeout: 3000, what: "the TCP bind" })
    expect(fs.statSync(hq.socket).mode & 0o777).toBe(0o600)
    expect((await hq.status()).url).toBe(`http://127.0.0.1:${hq.config.port}/`)
    expect((await tcpGet(hq.config.port, "/api/health")).json()).toMatchObject({ ok: true })
    expect((await sockHealth(hq)).json()).toMatchObject({ ok: true })
    expect(listeners.servers).toHaveLength(2)
    for (const { server } of listeners.servers)
      expect([server.maxConnections, server.headersTimeout, server.requestTimeout, server.timeout]).toEqual([
        64, 10_000, 10_000, 0,
      ])
  } finally {
    await listeners.stop()
  }
  expect(fs.existsSync(hq.socket)).toBe(false)
  expect(hq.boundPort).toBeNull()
})

test("a stale hq sock is replaced", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  // Closing leaves the file, as a crash does.
  const stale = net.createServer()
  await listenUnix(stale, hq.socket)
  await closeServer(stale)
  const listeners = new Listeners(hq)
  await listeners.start()
  try {
    expect(hq.socketError).toBeNull()
    expect((await sockHealth(hq)).status).toBe(200)
  } finally {
    await listeners.stop()
  }
})

test("a taken port is retried and picked up once free", async () => {
  const { office, hq, logs } = await setup()
  shortOffice(office)
  const holder = await hold(hq.config.port)
  const listeners = new Listeners(hq, { retryMs: 200 })
  await listeners.start()
  try {
    await sleep(500)
    const { tcp } = await hq.status()
    expect(tcp.listening).toBe(false)
    expect(tcp.error).toBeTruthy()
    expect(tcp.next_retry_at).toBeTruthy()
    // Only state changes are logged.
    expect(logs.filter((line) => line.includes("can't listen on 127.0.0.1"))).toHaveLength(1)
    await closeServer(holder)
    await waitFor(() => hq.boundPort, { timeout: 2000, what: "the TCP bind" })
    const after = await hq.status()
    expect([after.tcp.error, after.tcp.next_retry_at]).toEqual([null, null])
  } finally {
    await listeners.stop()
  }
})

test("stop ends the retries", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  const holder = await hold(hq.config.port)
  const listeners = new Listeners(hq, { retryMs: 100 })
  await listeners.start()
  await sleep(200)
  await listeners.stop()
  await closeServer(holder)
  await sleep(300)
  expect(hq.boundPort).toBeNull()
  // Nobody took the port after stop.
  await closeServer(await hold(hq.config.port))
})

test("with tcp off only hq sock listens", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  const listeners = new Listeners(hq)
  await listeners.start()
  try {
    expect(fs.existsSync(hq.socket)).toBe(true)
    expect((await hq.status()).tcp).toEqual({
      enabled: false,
      port: hq.config.port,
      listening: false,
      error: null,
      next_retry_at: null,
    })
  } finally {
    await listeners.stop()
  }
})

test("a failed hq sock bind is the status socket error", async () => {
  const { office, hq } = await setup()
  // hq.sock's path is now past sun_path.
  const deep = path.join(shortDir(), "d".repeat(110))
  fs.mkdirSync(deep)
  shortOffice(office, deep)
  hq.config = { ...hq.config, tcp: false }
  const listeners = new Listeners(hq)
  // The office runs on.
  await listeners.start()
  try {
    const status = await hq.status()
    expect(status.socket_error).toBe(hq.socketError)
    expect(status.socket_error).toBeTruthy()
    // Said once, by socket_error.
    expect((status.warnings ?? []).filter((w) => w.includes("isn't listening on"))).toEqual([])
  } finally {
    await listeners.stop()
  }
})

test.skipIf(process.getuid?.() === 0)("an os error at hq sock is the socket error too", async () => {
  const { office, hq } = await setup()
  const dir = shortDir()
  shortOffice(office, dir)
  hq.config = { ...hq.config, tcp: false }
  const listeners = new Listeners(hq)
  // No search permission, so reading what is at hq.sock fails.
  fs.chmodSync(dir, 0o600)
  try {
    // The office runs on.
    await listeners.start()
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  try {
    expect((await hq.status()).socket_error).toContain("EACCES")
  } finally {
    await listeners.stop()
  }
})

test.each([["file"], ["dir"]])("stop leaves alone what start refused at hq sock [%s]", async (kind) => {
  const { office, hq } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  if (kind === "file") fs.writeFileSync(hq.socket, "not ours")
  else fs.mkdirSync(hq.socket)
  const listeners = new Listeners(hq)
  await listeners.start()
  expect(hq.socketError).not.toBeNull()
  await listeners.stop()
  expect(fs.existsSync(hq.socket)).toBe(true)
  expect(hq.socketError).toBeNull()
})

test("a tcp server that dies is noticed and the port bound again", async () => {
  const { office, hq, logs } = await setup()
  // No hq.sock: TCP only.
  shortOffice(office, path.join(shortDir(), "nope"))
  const listeners = new Listeners(hq, { retryMs: 100 })
  await listeners.start()
  try {
    await waitFor(() => hq.boundPort, { timeout: 3000, what: "the TCP bind" })
    const first = listeners.servers.find((s) => s.port !== null)!.server
    first.emit("error", new Error("crashed"))
    await waitFor(() => hq.boundPort !== null && listeners.servers.some((s) => s.port !== null && s.server !== first), {
      timeout: 3000,
      what: "the TCP rebind",
    })
    expect(logs.some((line) => line.includes("crashed"))).toBe(true)
    expect(hq.tcpError).toBeNull()
    expect((await tcpGet(hq.boundPort!, "/api/health")).status).toBe(200)
  } finally {
    await listeners.stop()
  }
})

test("a hq sock server that exits is a socket error not a stopped office", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  const listeners = new Listeners(hq)
  await listeners.start()
  try {
    listeners.servers.find((s) => s.port === null)!.server.emit("error", new Error("exited"))
    await waitFor(async () => (await hq.status()).socket_error?.startsWith("its server ended"), {
      timeout: 2000,
      what: "the socket error",
    })
  } finally {
    await listeners.stop()
  }
  expect(fs.existsSync(hq.socket)).toBe(false)
})

test.skipIf(process.getuid?.() === 0)("stop logs what went wrong instead of raising", async () => {
  const { office, hq, logs } = await setup()
  // The runtime refuses this port.
  hq.config = { ...hq.config, tcp: true, port: 70000 }
  const dir = shortDir()
  shortOffice(office, dir)
  const listeners = new Listeners(hq)
  await listeners.start()
  await waitFor(() => logs.some((line) => line.includes("127.0.0.1:70000")), {
    timeout: 2000,
    what: "the bind's warning",
  })
  // hq.sock can't be removed now.
  fs.chmodSync(dir, 0o500)
  try {
    await listeners.stop()
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  expect(logs.some((line) => line.includes("HQ can't listen on 127.0.0.1:70000"))).toBe(true)
  expect(logs.some((line) => line.includes("couldn't remove"))).toBe(true)
})

test("an hq server leaves the signal handlers to the office", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  const before = { int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") }
  const listeners = new Listeners(hq)
  await listeners.start()
  try {
    expect(hq.socketError).toBeNull()
    expect({ int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") }).toEqual(before)
  } finally {
    await listeners.stop()
  }
})

test(
  "64 stalled heads leave hq answering within 12 s",
  async () => {
    const { office, hq } = await setup()
    shortOffice(office)
    hq.config = { ...hq.config, tcp: false }
    const listeners = new Listeners(hq)
    await listeners.start()
    try {
      let started = 0
      for (let i = 0; i < MAX_OPEN; i++) {
        const conn = await Conn.open(hq.socket)
        if (i === 0) started = performance.now()
        conn.send(STALLED)
      }
      // HQ is full, so what frees it is the head deadline.
      expect(await attempt(hq.socket, REQUEST)).toEqual({ text: "", closed: true })
      for (;;) {
        if ((await attempt(hq.socket, REQUEST, { ms: 1000 })).text.startsWith("HTTP/1.1 200")) break
        if (performance.now() - started > 20_000) break
        await sleep(250)
      }
      const elapsed = performance.now() - started
      // The measured time shows in a failure.
      expect({ ms: Math.round(elapsed), within: elapsed < 12_000 }).toMatchObject({ within: true })
    } finally {
      await listeners.stop()
    }
  },
  30_000,
)

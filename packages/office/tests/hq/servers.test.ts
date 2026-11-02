/** HQ's servers: limits per listener, isolation from office.sock, bind and rebind. */
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { RequestInfo } from "../../src/daemon/http.ts"
import type { Office, RequestContext } from "../../src/daemon/office.ts"
import { allRoutes } from "../../src/daemon/routes/index.ts"
import { hasLoopback6, listenTcp, listenUnix } from "../../src/daemon/sockets.ts"
import type { Hq } from "../../src/hq/core.ts"
import { HQ_LIMITS, Listeners, MAX_OPEN } from "../../src/hq/servers.ts"
import { shortDir, waitFor } from "../helpers.ts"
import { CEO, Conn, type Reply, ends, frames, makeOffice, request, serve, take, within } from "../daemon/helpers.ts"
import { HqClient, freePort, hqClient, makeHq, pairCode } from "./helpers.ts"

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
  // The host's real accounts would add a warning.
  hq.otherUsers = async () => []
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

/** One GET to `host`:`port` (127.0.0.1 by default) on a fresh connection, with `headers`. */
function tcpGet(
  port: number,
  target: string,
  { host = "127.0.0.1", headers = {} }: { host?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: target, headers, agent: false }, (res) => {
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

/** A plain `net` server listening on `host`:`port` (127.0.0.1 by default), closed when the test finishes. */
async function hold(port: number, host = "127.0.0.1"): Promise<net.Server> {
  const holder = net.createServer()
  onTestFinished(() => closeServer(holder))
  await new Promise<void>((resolve, reject) => {
    holder.once("error", reject)
    holder.listen(port, host, () => resolve())
  })
  return holder
}

/** Whether a connection to `host`:`port` is refused. */
function refused(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    socket.on("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.on("error", () => resolve(true))
  })
}

const LOOPBACK6 = hasLoopback6()

/** The kept server on `address`, if any. */
const on = (listeners: Listeners, address: string) => listeners.servers.filter((s) => s.address === address)

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
    if (LOOPBACK6) await waitFor(() => on(listeners, "::1").length, { timeout: 3000, what: "the ::1 bind" })
    expect(fs.statSync(hq.socket).mode & 0o777).toBe(0o600)
    expect((await hq.status()).url).toBe(`http://127.0.0.1:${hq.config.port}/`)
    expect((await tcpGet(hq.config.port, "/api/health")).json()).toMatchObject({ ok: true })
    expect((await sockHealth(hq)).json()).toMatchObject({ ok: true })
    expect(listeners.servers).toHaveLength(LOOPBACK6 ? 3 : 2)
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

test("start waits for the first tcp bind", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  const listeners = new Listeners(hq, { retryMs: 100 })
  await listeners.start()
  try {
    expect(hq.boundPort).toBe(hq.config.port)
    expect((await hq.status()).tcp.listening).toBe(true)
    // The first ::1 attempt has settled too.
    if (LOOPBACK6) expect(on(listeners, "::1").length === 1 || hq.loopback6Error !== null).toBe(true)
  } finally {
    await listeners.stop()
  }
  await hold(hq.config.port)
  const blocked = new Listeners(hq, { retryMs: 100 })
  await blocked.start()
  try {
    expect(hq.boundPort).toBeNull()
    expect(hq.tcpError).toBeTruthy()
  } finally {
    await blocked.stop()
  }
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

test("a live hq sock at start is left and reported", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  const other = net.createServer((conn) => conn.end())
  onTestFinished(() => closeServer(other))
  await listenUnix(other, hq.socket)
  const ino = fs.lstatSync(hq.socket).ino
  const listeners = new Listeners(hq)
  await listeners.start()
  try {
    expect(hq.socketError).toMatch(/live listener/)
    expect(listeners.servers).toHaveLength(0)
  } finally {
    await listeners.stop()
  }
  expect(fs.lstatSync(hq.socket).ino).toBe(ino)
  await new Promise<void>((resolve, reject) => {
    const conn = net.connect({ path: hq.socket }, () => {
      conn.destroy()
      resolve()
    })
    conn.on("error", reject)
  })
})

test("stop leaves an hq sock that isnt its own", async () => {
  const { office, hq, logs } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  const listeners = new Listeners(hq)
  await listeners.start()
  let ino: number
  try {
    expect(hq.socketError).toBeNull()
    fs.unlinkSync(hq.socket)
    const other = net.createServer()
    await listenUnix(other, hq.socket)
    await closeServer(other)
    ino = fs.lstatSync(hq.socket).ino
  } finally {
    await listeners.stop()
  }
  expect(fs.lstatSync(hq.socket).ino).toBe(ino!)
  expect(logs.some((line) => line.includes(`WARNING`) && line.includes(`HQ left ${hq.socket}`))).toBe(true)
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
    const first = on(listeners, "127.0.0.1")[0]!.server
    first.emit("error", new Error("crashed"))
    await waitFor(() => hq.boundPort !== null && on(listeners, "127.0.0.1").some((s) => s.server !== first), {
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

test.skipIf(!LOOPBACK6)("tcp listens on 127.0.0.1 and ::1 at the same port", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  for (const port of [hq.config.port, 0]) {
    hq.config = { ...hq.config, port }
    const listeners = new Listeners(hq)
    await listeners.start()
    try {
      await waitFor(() => hq.boundPort !== null && on(listeners, "::1").length, { timeout: 3000, what: "both binds" })
      const at = hq.boundPort!
      if (port) expect(at).toBe(port)
      expect(on(listeners, "::1").map((s) => s.port)).toEqual([at])
      const reply = await tcpGet(at, "/api/health", { host: "::1", headers: { host: `127.0.0.1:${at}` } })
      expect(reply.status).toBe(200)
      expect((await hq.status()).warnings).toEqual([])
    } finally {
      await listeners.stop()
    }
  }
})

test.skipIf(!LOOPBACK6)("localhost over ::1 is sent to 127.0.0.1 and any other host is refused", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  const listeners = new Listeners(hq)
  await listeners.start()
  try {
    await waitFor(() => on(listeners, "::1").length, { timeout: 3000, what: "the ::1 bind" })
    const port = hq.config.port
    const page = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }
    const local = await tcpGet(port, "/", { host: "::1", headers: { ...page, host: `localhost:${port}` } })
    expect([local.status, local.headers.location]).toEqual([307, `http://127.0.0.1:${port}/`])
    const v6 = await tcpGet(port, "/", { host: "::1", headers: { ...page, host: `[::1]:${port}` } })
    expect(v6.status).toBe(403)
  } finally {
    await listeners.stop()
  }
})

test.skipIf(!LOOPBACK6)("a held ::1 warns, 127.0.0.1 still serves, and ::1 is taken once free", async () => {
  const { office, hq, logs } = await setup()
  shortOffice(office)
  const port = hq.config.port
  const holder = await hold(port, "::1")
  const listeners = new Listeners(hq, { retryMs: 100 })
  await listeners.start()
  try {
    await waitFor(() => hq.loopback6Error, { timeout: 3000, what: "the ::1 error" })
    await sleep(300)
    const status = await hq.status()
    expect(status.tcp.listening).toBe(true)
    expect(status.tcp.error).toBeNull()
    const said = (status.warnings ?? []).filter((w) => w.includes(`can't hold [::1]:${port}`))
    expect(said).toHaveLength(1)
    expect(said[0]).toStartWith(`http://localhost:${port}/ may reach another program`)
    expect(said[0]).toEndWith(`Open http://127.0.0.1:${port}/`)
    // Only state changes are logged.
    expect(logs.filter((line) => line.includes(`can't hold [::1]:${port}`))).toHaveLength(1)
    expect((await tcpGet(port, "/api/health")).status).toBe(200)
    await closeServer(holder)
    await waitFor(() => on(listeners, "::1").length, { timeout: 3000, what: "the ::1 bind" })
    expect(hq.loopback6Error).toBeNull()
    expect((await hq.status()).warnings).toEqual([])
  } finally {
    await listeners.stop()
  }
})

test.skipIf(!LOOPBACK6)("a ::1 server that dies leaves the 127.0.0.1 state alone", async () => {
  const { office, hq, logs } = await setup()
  shortOffice(office)
  const listeners = new Listeners(hq, { retryMs: 100 })
  await listeners.start()
  try {
    await waitFor(() => on(listeners, "::1").length, { timeout: 3000, what: "the ::1 bind" })
    const bound = hq.boundPort
    const first = on(listeners, "::1")[0]!.server
    first.emit("error", new Error("crashed"))
    expect([hq.boundPort, hq.tcpError, hq.nextRetryAt]).toEqual([bound, null, null])
    expect(hq.loopback6Error).toStartWith("its server ended")
    expect(logs.some((line) => line.includes("[::1]") && line.includes("crashed"))).toBe(true)
    await waitFor(() => on(listeners, "::1").some((s) => s.server !== first), { timeout: 3000, what: "the rebind" })
    expect([hq.boundPort, hq.loopback6Error]).toEqual([bound, null])
  } finally {
    await listeners.stop()
  }
})

test.skipIf(!LOOPBACK6)("a dying 127.0.0.1 server takes ::1 down and clears its warning", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  const port = hq.config.port
  const holder = await hold(port, "::1")
  const listeners = new Listeners(hq, { retryMs: 100 })
  await listeners.start()
  try {
    await waitFor(() => hq.loopback6Error, { timeout: 3000, what: "the ::1 error" })
    on(listeners, "127.0.0.1")[0]!.server.emit("error", new Error("crashed"))
    expect(hq.loopback6Error).toBeNull()
    expect(on(listeners, "::1")).toEqual([])
    expect((await hq.status()).warnings).toEqual([])
    await closeServer(holder)
    await waitFor(() => hq.boundPort !== null && on(listeners, "::1").length, { timeout: 3000, what: "both binds" })
    const reply = await tcpGet(port, "/api/health", { host: "::1", headers: { host: `127.0.0.1:${port}` } })
    expect(reply.status).toBe(200)
  } finally {
    await listeners.stop()
  }
})

test.skipIf(!LOOPBACK6)("a ::1 bind that settles after its 127.0.0.1 server died is closed", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  let open: (() => void) | null = null
  let held = 0
  const listen = async (server: net.Server, port: number, host?: string) => {
    if (host === "::1" && held++ === 0) await new Promise<void>((resolve) => (open = resolve))
    return listenTcp(server, port, host)
  }
  const listeners = new Listeners(hq, { retryMs: 100, listen })
  const starting = listeners.start()
  try {
    await waitFor(() => open, { timeout: 3000, what: "the held ::1 bind" })
    on(listeners, "127.0.0.1")[0]!.server.emit("error", new Error("crashed"))
    open!()
    await starting
    await waitFor(() => hq.boundPort !== null && on(listeners, "::1").length, { timeout: 3000, what: "both binds" })
    await sleep(300)
    expect(on(listeners, "::1").map((s) => s.port)).toEqual([hq.boundPort])
    expect(hq.loopback6Error).toBeNull()
  } finally {
    await starting
    await listeners.stop()
  }
})

test("without an ipv6 loopback only 127.0.0.1 is tried", async () => {
  const { office, hq, logs } = await setup()
  shortOffice(office)
  const listeners = new Listeners(hq, { loopback6: () => false })
  await listeners.start()
  try {
    await waitFor(() => hq.boundPort, { timeout: 3000, what: "the TCP bind" })
    await sleep(200)
    expect(on(listeners, "::1")).toEqual([])
    expect(hq.loopback6Error).toBeNull()
    expect(logs.filter((line) => line.includes("::1"))).toEqual([])
  } finally {
    await listeners.stop()
  }
})

test.skipIf(!LOOPBACK6)("stop closes both tcp servers and ends the ::1 retries", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  const port = hq.config.port
  const holder = await hold(port, "::1")
  const listeners = new Listeners(hq, { retryMs: 100 })
  await listeners.start()
  await waitFor(() => hq.loopback6Error, { timeout: 3000, what: "the ::1 error" })
  await listeners.stop()
  expect(hq.loopback6Error).toBeNull()
  await closeServer(holder)
  await sleep(300)
  expect(await refused(port, "127.0.0.1")).toBe(true)
  expect(await refused(port, "::1")).toBe(true)
  // Nobody took ::1 after stop.
  await closeServer(await hold(port, "::1"))
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

test("stop refuses new connections while running handlers finish", async () => {
  const { office, hq } = await setup()
  shortOffice(office)
  hq.config = { ...hq.config, tcp: false }
  const listeners = new Listeners(hq)
  await listeners.start()
  let stopping: Promise<void> | undefined
  try {
    const client = new HqClient(hq.socket, { host: "127.0.0.1:5555", origin: "http://127.0.0.1:5555" })
    expect((await client.post("/api/pair", { code: await pairCode(hq) })).status).toBe(200)
    const it = frames(await client.stream("/api/events"))
    expect(await take(it, 1)).toEqual([["comment", null, "connected"]])
    // The bus is still open, so the stream keeps its handler running through stop's wait.
    stopping = listeners.stop()
    expect(await attempt(hq.socket, REQUEST)).toEqual({ text: "", closed: true })
    // As the office's stop does before HQ's stop hook.
    office.bus.close()
    expect(await ends(it)).toBe(true)
    await within(stopping)
  } finally {
    office.bus.close()
    await (stopping ?? listeners.stop())
  }
  expect(fs.existsSync(hq.socket)).toBe(false)
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

/** HQ's listeners: one node:http server each, so HQ's limits and failures never reach office.sock. */
import fs from "node:fs"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { stamp } from "@opencorp/protocol"
import {
  HANDLER_WAIT_MS,
  LIMITS,
  type Level,
  type Limits,
  createServer,
  logLine,
  trackRequests,
} from "../daemon/http.ts"
import { listenTcp, listenUnix, removeStaleSocket } from "../daemon/sockets.ts"
import { createHqApp } from "./api.ts"
import type { Hq } from "./core.ts"
import { BODY_TIMEOUT } from "./guard.ts"

/** How often a TCP port someone else holds is tried again, in ms. */
export const RETRY_MS = 5000

/** At most this many open connections per HQ listener; past it a new connection is closed at once. */
export const MAX_OPEN = 64

/** HQ's listener limits: the office's, a 10 s request (head and body), at most MAX_OPEN connections. */
export const HQ_LIMITS: Readonly<Limits> = { ...LIMITS, requestTimeout: BODY_TIMEOUT, maxConnections: MAX_OPEN }

/** One running HQ server, its TCP port (null for hq.sock), and its running requests (`trackRequests`). */
export interface Served {
  server: Server
  port: number | null
  requests: { settled(ms: number): Promise<void> }
}

type App = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function typeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error
}

/** Closes `server` and its connections; resolves once closed, whatever its callback reports. */
function close(server: Server): Promise<void> {
  server.closeAllConnections()
  // closeAllConnections already stopped the listener on this runtime, so close reports ERR_SERVER_NOT_RUNNING.
  return new Promise((resolve) => server.close(() => resolve()))
}

/** HQ's servers for one office: on hq.sock always, and on TCP 127.0.0.1 when enabled, retried every `retryMs`
 *  until the port is free. A taken port never stops the office. */
export class Listeners {
  readonly #hq: Hq
  readonly #retryMs: number
  #servers: Served[] = []
  #binding: Promise<void> | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  /** The reason the last WARNING about the TCP bind gave. */
  #said: string | null = null
  #ownsSocket = false
  #stopping = false

  constructor(hq: Hq, { retryMs = RETRY_MS }: { retryMs?: number } = {}) {
    this.#hq = hq
    this.#retryMs = retryMs
  }

  /** The servers running now. */
  get servers(): readonly Served[] {
    return this.#servers
  }

  #log(level: Level, text: string): void {
    try {
      this.#hq.log(logLine(level, "opencorp.hq.servers", text))
    } catch {
      // A broken log must not reject a bind nobody awaits or skip a step of stop.
    }
  }

  /** Listens on hq.sock, and starts binding TCP in the background. */
  async start(): Promise<void> {
    const hq = this.#hq
    try {
      // The office holds its lock, so no live office owns a socket there.
      removeStaleSocket(hq.socket)
      const tracked = trackRequests(createHqApp(hq, { port: null }))
      const server = createServer(tracked.listener, HQ_LIMITS)
      await listenUnix(server, hq.socket)
      this.#keep({ server, port: null, requests: tracked })
      this.#ownsSocket = true
      hq.socketError = null
    } catch (error) {
      // Kept for GET /hq and doctor: a path too long for sun_path mustn't fail silently, and hq.sock failing
      // mustn't stop the office.
      this.#log("ERROR", `HQ can't listen on ${hq.socket}: ${messageOf(error)}`)
      hq.socketError = messageOf(error)
    }
    if (hq.config.tcp) this.#binding = this.#bindTcp()
  }

  /** One attempt at binding TCP; a failure schedules the next. Never rejects: an unhandled rejection would
   *  crash the daemon. */
  async #bindTcp(): Promise<void> {
    const hq = this.#hq
    const port = hq.config.port
    let server: Server | undefined
    let bound = false
    try {
      // The app needs the bound port (hq.json may say 0), so it is set once the bind resolves, which happens
      // before any request on the server can be read.
      let app: App | undefined
      const tracked = trackRequests(async (req, res) => {
        // Only a fallback: the app is always set before a request can arrive.
        if (app) return app(req, res)
        res.destroy()
      })
      server = createServer(tracked.listener, HQ_LIMITS)
      let at: number
      try {
        at = await listenTcp(server, port)
      } catch (error) {
        if (this.#stopping) return
        const why = messageOf(error)
        hq.tcpError = why
        if (why !== this.#said) {
          const every = `trying again every ${this.#retryMs / 1000} s`
          this.#log("WARNING", `HQ can't listen on 127.0.0.1:${port} (${why}); ${every}`)
          this.#said = why
        }
        this.#retry()
        return
      }
      bound = true
      if (this.#stopping) {
        await close(server)
        return
      }
      app = createHqApp(hq, { port: at })
      this.#keep({ server, port: at, requests: tracked })
      hq.boundPort = at
      hq.tcpError = null
      hq.nextRetryAt = null
      this.#said = null
      this.#log("INFO", `HQ listening on http://127.0.0.1:${at}/`)
    } catch (error) {
      // A kept server serves on; one that isn't must not stay open without an app.
      if (!this.#servers.some((s) => s.server === server)) {
        if (server && bound) await close(server)
        if (!this.#stopping) this.#retry()
      }
      this.#log("ERROR", `HQ's TCP bind failed: ${typeOf(error)}`)
    }
  }

  /** Says when the next TCP bind is, and starts it after `retryMs`. */
  #retry(): void {
    this.#hq.nextRetryAt = stamp(new Date(Date.now() + this.#retryMs))
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#binding = this.#bindTcp()
    }, this.#retryMs)
    // A pending retry must not keep the process alive.
    this.#timer.unref()
  }

  /** Keeps `served`, and makes a failure of its server end it: logged, dropped, and said in the status; a TCP
   *  listener binds its port again after `retryMs`. */
  #keep(served: Served): void {
    this.#servers.push(served)
    served.server.on("error", (error: unknown) => {
      if (this.#stopping || !this.#servers.includes(served)) return
      const where = served.port === null ? this.#hq.socket : `127.0.0.1:${served.port}`
      const why = `it failed: ${(error instanceof Error && error.message) || typeOf(error)}`
      this.#log("ERROR", `HQ's server on ${where} ended (${why})`)
      this.#servers = this.#servers.filter((s) => s !== served)
      void close(served.server)
      if (served.port === null) this.#hq.socketError = `its server ended (${why})`
      else {
        this.#hq.boundPort = null
        this.#hq.tcpError = `its server ended (${why})`
        this.#retry()
      }
    })
  }

  /** Stops binding, refuses new connections, gives every server's running handlers up to HANDLER_WAIT_MS to finish
   *  (their streams already ended with the office's bus), then closes every server and its connections, and
   *  removes hq.sock. What goes wrong on the way is logged: the office's other stop hooks still run. Never
   *  rejects. */
  async stop(): Promise<void> {
    const hq = this.#hq
    this.#stopping = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    await this.#binding
    this.#binding = null
    const servers = this.#servers
    // No new connections while running handlers finish, as uvicorn's graceful shutdown stopped accepting first.
    // Not close(): on this runtime a close() before closeAllConnections() leaves the open connections open.
    for (const served of servers) served.server.maxConnections = 0
    // Settled before closing, so a stream that is writing its end isn't cut short.
    await Promise.all(servers.map((served) => served.requests.settled(HANDLER_WAIT_MS)))
    await Promise.all(servers.map((served) => close(served.server)))
    this.#servers = []
    hq.boundPort = hq.tcpError = hq.nextRetryAt = hq.socketError = null
    this.#said = null
    // Never what start found there and refused.
    if (this.#ownsSocket)
      try {
        fs.rmSync(hq.socket, { force: true })
      } catch (error) {
        this.#log("ERROR", `HQ couldn't remove ${hq.socket}: ${messageOf(error)}`)
      }
    this.#ownsSocket = false
    this.#stopping = false
  }
}

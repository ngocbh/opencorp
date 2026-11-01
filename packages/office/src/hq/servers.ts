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
  errorType,
  logLine,
  trackRequests,
} from "../daemon/http.ts"
import { hasLoopback6, listenTcp, listenUnix, messageOf, removeStaleSocket } from "../daemon/sockets.ts"
import { createHqApp } from "./api.ts"
import type { Hq } from "./core.ts"
import { BODY_TIMEOUT } from "./guard.ts"

/** How often a TCP port someone else holds is tried again, in ms. */
export const RETRY_MS = 5000

/** At most this many open connections per HQ listener; past it a new connection is closed at once. */
export const MAX_OPEN = 64

/** HQ's listener limits: the office's, a 10 s request (head and body), at most MAX_OPEN connections. */
export const HQ_LIMITS: Readonly<Limits> = { ...LIMITS, requestTimeout: BODY_TIMEOUT, maxConnections: MAX_OPEN }

/** One running HQ server, its TCP port and address (null for hq.sock), and its running requests
 *  (`trackRequests`). */
export interface Served {
  server: Server
  port: number | null
  address: "127.0.0.1" | "::1" | null
  requests: { settled(ms: number): Promise<void> }
}

type App = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Closes `server` and its connections; resolves once closed, whatever its callback reports. */
function close(server: Server): Promise<void> {
  server.closeAllConnections()
  // closeAllConnections already stopped the listener on this runtime, so close reports ERR_SERVER_NOT_RUNNING.
  return new Promise((resolve) => server.close(() => resolve()))
}

/**
 * HQ's servers for one office: on hq.sock always, and on TCP 127.0.0.1 when enabled, retried every `retryMs` until
 * the port is free. A taken port never stops the office.
 *
 * While 127.0.0.1 listens, HQ also holds [::1] at the same port, when the host has an IPv6 loopback: browsers try
 * ::1 first for `localhost`, so whoever held it would get the owner's localhost visits, which the guard sends on to
 * 127.0.0.1 only when they reach HQ. A ::1 that someone else holds is a warning and retried; it never stops TCP.
 */
export class Listeners {
  readonly #hq: Hq
  readonly #retryMs: number
  readonly #loopback6: () => boolean
  readonly #listen: typeof listenTcp
  #servers: Served[] = []
  #binding: Promise<void> | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  /** The reason the last WARNING about the TCP bind gave. */
  #said: string | null = null
  /** Counts the 127.0.0.1 servers kept: a ::1 bind or retry for an older one is dropped. */
  #gen = 0
  #binding6: Promise<void> | null = null
  #timer6: ReturnType<typeof setTimeout> | null = null
  /** The reason the last WARNING about the ::1 bind gave. */
  #said6: string | null = null
  #ownsSocket = false
  #stopping = false

  /** `loopback6` says whether to hold ::1 too, and `listen` binds TCP; tests replace them. */
  constructor(
    hq: Hq,
    {
      retryMs = RETRY_MS,
      loopback6 = hasLoopback6,
      listen = listenTcp,
    }: { retryMs?: number; loopback6?: () => boolean; listen?: typeof listenTcp } = {},
  ) {
    this.#hq = hq
    this.#retryMs = retryMs
    this.#loopback6 = loopback6
    this.#listen = listen
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
      this.#keep({ server, port: null, address: null, requests: tracked })
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
        at = await this.#listen(server, port)
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
      this.#keep({ server, port: at, address: "127.0.0.1", requests: tracked })
      hq.boundPort = at
      hq.tcpError = null
      hq.nextRetryAt = null
      this.#said = null
      this.#log("INFO", `HQ listening on http://127.0.0.1:${at}/`)
      this.#binding6 = this.#bindLoopback6(at, ++this.#gen)
      await this.#binding6
    } catch (error) {
      // A kept server serves on; one that isn't must not stay open without an app.
      if (!this.#servers.some((s) => s.server === server)) {
        if (server && bound) await close(server)
        if (!this.#stopping) this.#retry()
      }
      this.#log("ERROR", `HQ's TCP bind failed: ${errorType(error)}`)
    }
  }

  /** One attempt at holding [::1]:`port` for the 127.0.0.1 server `gen`; a failure schedules the next. Never
   *  rejects, and never touches the 127.0.0.1 state. */
  async #bindLoopback6(port: number, gen: number): Promise<void> {
    const hq = this.#hq
    let server: Server | undefined
    try {
      if (!this.#loopback6()) return
      const tracked = trackRequests(createHqApp(hq, { port }))
      server = createServer(tracked.listener, HQ_LIMITS)
      try {
        await this.#listen(server, port, "::1")
      } catch (error) {
        if (this.#stopping || gen !== this.#gen) return
        const why = messageOf(error)
        hq.loopback6Error = why
        if (why !== this.#said6) {
          const every = `trying again every ${this.#retryMs / 1000} s`
          this.#log("WARNING", `HQ can't hold [::1]:${port} (${why}), so localhost may reach another program; ${every}`)
          this.#said6 = why
        }
        this.#retry6(port, gen)
        return
      }
      // 127.0.0.1's server ended or the office is stopping while this bound: this port is no longer HQ's to hold.
      if (this.#stopping || gen !== this.#gen) {
        await close(server)
        return
      }
      this.#keep({ server, port, address: "::1", requests: tracked })
      hq.loopback6Error = null
      this.#said6 = null
      this.#log("INFO", `HQ also holds [::1]:${port}`)
    } catch (error) {
      if (server && !this.#servers.some((s) => s.server === server)) await close(server)
      this.#log("ERROR", `HQ's [::1] bind failed: ${errorType(error)}`)
    }
  }

  /** Starts the next [::1] bind for the 127.0.0.1 server `gen` after `retryMs`. */
  #retry6(port: number, gen: number): void {
    if (this.#timer6 !== null) clearTimeout(this.#timer6)
    this.#timer6 = setTimeout(() => {
      this.#timer6 = null
      if (this.#stopping || gen !== this.#gen) return
      this.#binding6 = this.#bindLoopback6(port, gen)
    }, this.#retryMs)
    // A pending retry must not keep the process alive.
    this.#timer6.unref()
  }

  /** Lets go of [::1] when its 127.0.0.1 server ends: the next bind may land on another port (hq.json may say 0). */
  #drop6(): void {
    this.#gen++
    if (this.#timer6 !== null) clearTimeout(this.#timer6)
    this.#timer6 = null
    for (const served of this.#servers) if (served.address === "::1") void close(served.server)
    this.#servers = this.#servers.filter((s) => s.address !== "::1")
    this.#hq.loopback6Error = null
    this.#said6 = null
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
   *  listener binds its port again after `retryMs`, and a 127.0.0.1 one lets go of [::1] until then. */
  #keep(served: Served): void {
    this.#servers.push(served)
    served.server.on("error", (error: unknown) => {
      if (this.#stopping || !this.#servers.includes(served)) return
      const hq = this.#hq
      const where =
        served.address === null
          ? hq.socket
          : served.address === "::1"
            ? `[::1]:${served.port}`
            : `127.0.0.1:${served.port}`
      const why = `it failed: ${(error instanceof Error && error.message) || errorType(error)}`
      this.#log("ERROR", `HQ's server on ${where} ended (${why})`)
      this.#servers = this.#servers.filter((s) => s !== served)
      void close(served.server)
      if (served.address === null) hq.socketError = `its server ended (${why})`
      else if (served.address === "::1") {
        hq.loopback6Error = `its server ended (${why})`
        this.#retry6(served.port!, this.#gen)
      } else {
        this.#drop6()
        hq.boundPort = null
        hq.tcpError = `its server ended (${why})`
        this.#retry()
      }
    })
  }

  /** Stops binding, refuses new connections and closes idle ones, gives every server's running handlers up to
   *  HANDLER_WAIT_MS to finish (their streams already ended with the office's bus), then closes every server and its
   *  connections, and removes hq.sock. What goes wrong on the way is logged: the office's other stop hooks still
   *  run. Never rejects. */
  async stop(): Promise<void> {
    const hq = this.#hq
    this.#stopping = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    if (this.#timer6 !== null) clearTimeout(this.#timer6)
    this.#timer = this.#timer6 = null
    await this.#binding
    this.#binding = null
    await this.#binding6
    this.#binding6 = null
    const servers = this.#servers
    // No new connections while running handlers finish, as uvicorn's graceful shutdown stopped accepting and
    // closed idle connections first: a request on an idle keep-alive connection would start a handler that the
    // closing below cuts. Not close(): on this runtime a close() before closeAllConnections() leaves the open
    // connections open.
    for (const served of servers) {
      served.server.maxConnections = 0
      served.server.closeIdleConnections()
    }
    // Settled before closing, so a stream that is writing its end isn't cut short.
    await Promise.all(servers.map((served) => served.requests.settled(HANDLER_WAIT_MS)))
    await Promise.all(servers.map((served) => close(served.server)))
    this.#servers = []
    hq.boundPort = hq.tcpError = hq.nextRetryAt = hq.socketError = hq.loopback6Error = null
    this.#said = this.#said6 = null
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

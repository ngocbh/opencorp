/** The Hq object: HQ's settings, ids and shared state, attached to an office. */
import path from "node:path"
import { type Health, type HqStatus, type PairCode, now, stamp } from "@opencorp/protocol"
import type { CompanySnapshots } from "../company/snapshot.ts"
import { CompanySource } from "../company/source.ts"
import type { Office } from "../daemon/office.ts"
import { PING_MS } from "../daemon/routes/events.ts"
import { cookieKey } from "./auth.ts"
import { type HqConfig, loadConfig } from "./config.ts"
import { Logins } from "./login.ts"
import { PairCodes } from "./pairing.ts"
import { Listeners } from "./servers.ts"
import { BrowserSessions } from "./sessions.ts"
import { otherUsers } from "./status.ts"
import { BuildInfo, officeApi } from "./version.ts"

/** What HQ's listeners, routes and socket routes share for one office. */
export class Hq {
  readonly office: Office
  config: HqConfig
  readonly api: string
  readonly build: BuildInfo
  readonly snapshots: CompanySnapshots
  readonly sessions: BrowserSessions
  readonly codes: PairCodes
  /** Part of the session cookie's name, kept in the office dir (`cookieKey`). */
  readonly cookieKey: string
  logins: Logins
  /** The Source view's trees and files. */
  readonly source: CompanySource
  /** Gets formatted log lines (`logLine`), for HQ's modules and its pipeline. */
  readonly log: (line: string) => void
  /** The TCP listener's port while it listens; set by the listeners. */
  boundPort: number | null = null
  /** Why the TCP listener isn't listening; set by the listeners. */
  tcpError: string | null = null
  /** When the listeners next try to bind TCP; set by the listeners. */
  nextRetryAt: string | null = null
  /** Why hq.sock isn't listening, when binding it failed. */
  socketError: string | null = null
  /** How long an idle `/api/events` waits before a ping, in ms; tests shorten it. */
  pingMs = PING_MS
  /** Whether starting HQ starts its listeners (the daemon); tests attach without them. */
  listen = false
  /** HQ's listeners while they run. */
  listeners: Listeners | null = null
  /** Who else uses this host; tests replace it. */
  otherUsers: () => Promise<string[]> = otherUsers

  constructor(office: Office, config: HqConfig, log: (line: string) => void) {
    this.office = office
    this.config = config
    this.log = log
    this.api = officeApi()
    this.build = new BuildInfo(config.appDir)
    this.snapshots = office.snapshots
    this.sessions = new BrowserSessions(office.store, this.snapshots)
    this.codes = new PairCodes(office.paths.office, { log })
    this.cookieKey = cookieKey(office.paths.office)
    this.logins = new Logins(this.sessions)
    this.source = new CompanySource(office.git)
  }

  /** HQ for `office`, with the settings in its `hq.json`, sharing its company snapshot cache. */
  static create(office: Office, { log }: { log: (line: string) => void }): Hq {
    return new Hq(office, loadConfig(office.paths.office, { log }), log)
  }

  /** The path of hq.sock. */
  get socket(): string {
    return path.join(this.office.paths.office, "hq.sock")
  }

  /** `http://127.0.0.1:<port><path>` while TCP is listening, else null. */
  url(path = "/"): string | null {
    return this.boundPort === null ? null : `http://127.0.0.1:${this.boundPort}${path}`
  }

  /** `GET /api/health`: the office's key and the built app's, if there is one. */
  health(): Health {
    return { ok: true, office: { api: this.api }, app: this.build.read() }
  }

  /** A one-time link for `handle`, asked for by `issuer`. */
  async mint(handle: string, { issuer, openFile }: { issuer: string; openFile: boolean }): Promise<PairCode> {
    const minted = await this.codes.mint(handle, { issuer, url: (code) => this.url(`/pair#${code}`), openFile })
    return {
      path: `/pair#${minted.code}`,
      url: this.url(`/pair#${minted.code}`),
      socket: this.socket,
      port: this.boundPort ?? this.config.port,
      expires_at: stamp(minted.expiresAt),
      open_file: minted.file,
    }
  }

  /** Where HQ listens now, for `opencorp pair` and `opencorp doctor`. */
  async status(): Promise<HqStatus> {
    return {
      socket: this.socket,
      tcp: {
        enabled: this.config.tcp,
        port: this.boundPort ?? this.config.port,
        listening: this.boundPort !== null,
        error: this.tcpError,
        next_retry_at: this.nextRetryAt,
      },
      url: this.url(),
      health: this.health(),
      socket_error: this.socketError,
      warnings: await this.warnings(),
    }
  }

  /** What `opencorp doctor` and `opencorp pair` should mention, besides `socket_error` and TCP's own state. */
  async warnings(): Promise<string[]> {
    const found = this.config.problem === null ? [] : [`settings ignored: ${this.config.problem}`]
    if (this.config.tcp) {
      const others = await this.otherUsers()
      if (others.length > 0)
        found.push(
          `the web port is on and this host has other users (${others.join(", ")}): any of them could take the ` +
            `port while the office is down. Turn it off with "tcp": false in ` +
            path.join(this.office.paths.office, "hq.json"),
        )
    }
    return found
  }

  /** Delete expired browser sessions and the redirect files a crash left, then start the listeners if `listen`. */
  async start(): Promise<void> {
    this.office.store.pruneHqSessions(now())
    this.codes.removeLeftovers()
    if (this.listen) {
      this.listeners = new Listeners(this)
      await this.listeners.start()
    }
  }

  /** Stop the listeners, forget pending codes and delete their redirect files. */
  async stop(): Promise<void> {
    try {
      const listeners = this.listeners
      this.listeners = null
      await listeners?.stop()
    } finally {
      this.codes.close()
    }
  }
}

/**
 * Attach HQ to `office` (`office.hq`): attached last, it starts after everything else and stops first.
 *
 * `listen` starts the listeners on start (the daemon); tests attach without them.
 */
export function attach(
  office: Office,
  { log, listen = true }: { log: (line: string) => void; listen?: boolean },
): Hq {
  const hq = Hq.create(office, { log })
  hq.listen = listen
  office.hq = hq
  office.onStart.push(() => hq.start())
  office.onStop.push(() => hq.stop())
  return hq
}

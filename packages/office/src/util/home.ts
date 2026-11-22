/** Paths under an OpenCorp home: the office's files and folders. */
import path from "node:path"

/** Where the office keeps its files under an OpenCorp home. */
export class OfficePaths {
  readonly home: string
  readonly company: string
  readonly office: string
  readonly store: string
  readonly socket: string
  readonly pidfile: string
  /** The single-daemon lock. */
  readonly lock: string
  readonly worktrees: string
  readonly runs: string
  readonly sessions: string
  readonly memory: string
  readonly secrets: string
  /** The harnesses' MCP folders: a folder per session for the MCP servers its employee may use. */
  readonly mcp: string

  constructor(home: string) {
    this.home = home
    this.company = path.join(home, "company")
    this.office = path.join(home, "office")
    this.store = path.join(this.office, "store.sqlite")
    this.socket = path.join(this.office, "office.sock")
    this.pidfile = path.join(this.office, "office.pid")
    this.lock = path.join(this.office, "office.lock")
    this.worktrees = path.join(this.office, "worktrees")
    this.runs = path.join(this.office, "runs")
    this.sessions = path.join(this.office, "sessions")
    this.memory = path.join(this.office, "memory")
    this.secrets = path.join(this.office, "secrets")
    this.mcp = path.join(this.office, "mcp")
  }

  /** HQ's unix socket, in the office dir. */
  get hqSocket(): string {
    return path.join(this.office, "hq.sock")
  }

  /** The directory a session's worker runs in. */
  runDir(sessionId: string): string {
    return path.join(this.runs, sessionId)
  }

  /** The directory a chat session's workers run in. */
  sessionDir(sessionId: string): string {
    return path.join(this.sessions, sessionId)
  }
}

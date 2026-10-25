/** The office's live Codex sessions, each with its own app-server. */
import fs from "node:fs"
import path from "node:path"
import type { Hooks } from "../chat/hooks.ts"
import type { Office } from "../daemon/office.ts"
import type { Store } from "../store/store.ts"
import { workerEnv } from "../worker/spawn.ts"
import { CLOSE_GRACE_MS, CodexProcess, CodexStartError, appServerCommand } from "./codex.ts"
import { type CodexSession, END_WAIT_MS, REPLY_WAIT_MS, STOP_WAIT_MS } from "./session.ts"

/** What `CodexSessions.launch` needs of a session. */
export type Launchable = Pick<CodexSession, "sessionId" | "cwd" | "launchingAs" | "notified" | "requested" | "exited">

/** How `CodexSessions` starts app-servers, how long it waits, and where its warnings go. */
export type CodexSessionsOptions = {
  /** Replaces the `codex app-server` command of the codex the daemon pinned; tests pass the fake's. */
  command?: () => string[]
  /** An app-server's environment (default the worker environment). */
  env?: () => Record<string, string>
  closeGraceMs?: number
  stopWaitMs?: number
  endWaitMs?: number
  replyWaitMs?: number
  /** Where warnings go (default `console.error`). */
  log?: (line: string) => void
}

/** Each live Codex session of the office, with its own app-server.
 *
 *  `hooks` are the chat harness's: Codex sessions fire `promptCheck`, `endStatus` and `sessionEnded` (never the run
 *  hooks: Codex turns are not office runs). */
export class CodexSessions {
  readonly office: Office
  readonly store: Store
  readonly hooks: Hooks
  readonly closeGraceMs: number
  readonly stopWaitMs: number
  readonly endWaitMs: number
  readonly replyWaitMs: number
  readonly log: (line: string) => void
  readonly #command: (() => string[]) | undefined
  readonly #env: () => Record<string, string>

  constructor(office: Office, hooks: Hooks, options: CodexSessionsOptions = {}) {
    this.office = office
    this.store = office.store
    this.hooks = hooks
    this.#command = options.command
    this.#env = options.env ?? (() => workerEnv(process.env))
    this.closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS
    this.endWaitMs = options.endWaitMs ?? END_WAIT_MS
    this.replyWaitMs = options.replyWaitMs ?? REPLY_WAIT_MS
    this.log = options.log ?? ((line) => console.error(line))
  }

  /** A started, initialized app-server for `live`, in its cwd, with the worker environment; rejects with
   *  `CodexStartError` if `live` is already stopped. */
  async launch(live: Launchable): Promise<CodexProcess> {
    const env = this.#env()
    const runDir = this.office.paths.runDir(live.sessionId)
    // The umask may narrow the mode, and an earlier stretch's dir keeps its old one; the app-server's own mkdir of
    // its log's dir uses the default mode.
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(runDir, 0o700)
    const command = this.#command
      ? this.#command()
      : appServerCommand(this.office.tools.codex, process.env.OPENCORP_CODEX_BIN)
    // Each callback says which app-server it came from, so the session drops what an earlier one still sends.
    const proc: CodexProcess = new CodexProcess(this.store, `harness:${live.sessionId}`, {
      command,
      cwd: live.cwd,
      env,
      log: path.join(runDir, "codex.log"),
      onNotification: (method, params) => live.notified(proc, method, params),
      onRequest: (id, method, params) => live.requested(proc, id, method, params),
      onExit: (p) => live.exited(p),
      logLine: this.log,
    })
    // Before it spawns, so office stop can kill it mid-handshake.
    if (!live.launchingAs(proc)) throw new CodexStartError("The office is stopping.")
    await proc.start()
    return proc
  }
}

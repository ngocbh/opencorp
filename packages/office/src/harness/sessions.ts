/** The office's live Codex sessions, each with its own app-server. */
import fs from "node:fs"
import path from "node:path"
import type { HarnessPolicy } from "@opencorp/protocol"
import type { Hooks } from "../chat/hooks.ts"
import { HarnessError, notWaiting } from "../chat/state.ts"
import { loadRepo } from "../company/loader.ts"
import type { Office } from "../daemon/office.ts"
import type { SessionRecord, Store } from "../store/store.ts"
import { workerEnv } from "../worker/spawn.ts"
import type { HarnessEvent } from "./adapter.ts"
import { CLOSE_GRACE_MS, CodexProcess, CodexStartError, appServerCommand } from "./codex.ts"
import { CodexSession, END_WAIT_MS, REPLY_WAIT_MS, STOP_WAIT_MS } from "./session.ts"

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
  readonly #live = new Map<string, CodexSession>()
  /** Set by `closeAll`: no session starts after office stop. */
  #closed = false

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

  /** The live session `sessionId`, if it has one. */
  get(sessionId: string): CodexSession | undefined {
    return this.#live.get(sessionId)
  }

  /** Loads `session`'s thread in a new app-server, as a job of the session's queue; a failure there fails the
   *  session. Rejects only if the session can't be set up at all, before anything is live. */
  async start(session: SessionRecord, { resume = false }: { resume?: boolean } = {}): Promise<void> {
    const author = await this.opener(session)
    if (this.#closed) return // the office is stopping: the session stays as it is, for restore
    const live = new CodexSession(this, session, { author })
    this.#live.set(session.id, live)
    live.start({ resume })
  }

  /** A message: `turn`, `steer` (a turn was running), or `queued` (until the thread is loaded). */
  async prompt(sessionId: string, text: string, { by = null }: { by?: string | null } = {}) {
    const live = this.#must(sessionId)
    for (const refusal of this.hooks.fire("promptCheck", this.store.getSession(sessionId), text))
      if (refusal) throw new HarnessError(422, "refused", String(refusal))
    return live.prompt(text, { by })
  }

  /** Ends the session `sessionId`. */
  async end(sessionId: string): Promise<void> {
    await this.#must(sessionId).end()
  }

  /** Office stop: kills every app-server and skips every session's later jobs; sessions keep their status for
   *  `restore`. Once it resolves, no Codex session touches the store (unless a job outlived `stopWaitMs`). */
  async closeAll(): Promise<void> {
    this.#closed = true
    const live = [...this.#live.values()]
    this.#live.clear()
    // In parallel, so the stop stays bounded by one session's wait, whatever the number of sessions.
    await Promise.all(live.map((session) => session.shutdown()))
  }

  /** Drops `live` and ends its session: `ended` (or the first `endStatus`, such as `debriefing`) or `failed`.
   *  `sessionEnded` fires once. */
  async finished(live: CodexSession, status: "ended" | "failed"): Promise<void> {
    if (this.#live.get(live.sessionId) === live) this.#live.delete(live.sessionId)
    const session = this.store.getSession(live.sessionId)!
    let final: SessionRecord["status"] = status
    if (status === "ended") {
      final = this.hooks.fire("endStatus", session).find((s) => s) ?? "ended"
      // First, so no client sees an ended session with its work still open.
      if (session.work_item_id) this.store.updateWorkItem(session.work_item_id, { status: "done" })
    }
    const updated = this.store.updateSession(live.sessionId, notWaiting(final))
    await this.hooks.notify("sessionEnded", updated)
  }

  /** The session's person's harness policy at the session's pinned commit. */
  async policy(sessionId: string): Promise<HarnessPolicy | null> {
    const session = this.store.getSession(sessionId)!
    const person = loadRepo(await this.office.git.pin(session.repo_commit)).people.get(session.person)
    return person?.harness_policy ?? null
  }

  /** Who a message with no named sender is from: the session's opener, else the pinned company's CEO. */
  async opener(session: SessionRecord): Promise<string | null> {
    if (session.opened_by) return session.opened_by
    const repo = loadRepo(await this.office.git.pin(session.repo_commit))
    return repo.company?.ceo ?? null
  }

  /** Publishes what `live`'s translator writes on the bus, as live events.
   *
   *  Requests and their resolutions are not handled yet: the question cards will store the question and mark it
   *  stale. */
  event(live: CodexSession, e: HarnessEvent): void {
    const session_id = live.sessionId
    if (e.type === "message") this.office.bus.publishLive({ type: "message.updated", session_id, data: e.message })
    else if (e.type === "part")
      this.office.bus.publishLive({ type: "part.updated", session_id, data: { message_id: e.messageId, part: e.part } })
    else if (e.type === "delta")
      this.office.bus.publishLive({
        type: "part.delta",
        session_id,
        data: { message_id: e.messageId, part_id: e.partId, text: e.text },
      })
  }

  /** A started, initialized app-server for `live`, in its cwd, with the worker environment; rejects with
   *  `CodexStartError` if `live` is already stopped. */
  async launch(live: Launchable): Promise<CodexProcess> {
    const env = this.#env()
    const runDir = this.office.paths.runDir(live.sessionId)
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
    // Made 0o700 here: CodexProcess.start's mkdir uses the default mode, the umask may narrow ours, and a dir left
    // by an earlier app-server keeps its old mode.
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(runDir, 0o700)
    await proc.start()
    return proc
  }

  #must(sessionId: string): CodexSession {
    const live = this.#live.get(sessionId)
    if (live !== undefined) return live
    if (this.store.getSession(sessionId) === undefined)
      throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    throw new HarnessError(409, "not_live", `session ${sessionId} has no live Codex app-server`)
  }
}

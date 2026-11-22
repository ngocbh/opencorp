/** The office's Claude Code sessions: each an employee chat's instrument and that chat's child session, one `claude`
 *  process each, under the employee's permission (`claudeSession`), its lines the session's live transcript. The
 *  employee writes through the chat's instrument, and the owner through the session's routes; both as `next`, so a
 *  message sent while Claude Code works is read in the same turn once its running tool calls finish, and one sent as
 *  that turn ends starts the next. Esc interrupts the running turn and cancels every message no turn has started
 *  (`cancel_queued`), and drops one still waiting for Claude Code to start, unsent.
 *
 *  **Its process comes and goes.** A session idle for `idleMs` (five minutes, as the upstream TUI's) stops its Claude
 *  Code, and the next message resumes the same conversation (`--resume`); so does the next message after Claude Code
 *  exits on its own (a crash), whose turn is marked interrupted and whose process group is killed, so nothing it
 *  started outlives it. Only a resume that can't start fails the session. Its end and an office stop take every
 *  Claude Code of the session with it: the running one, one starting, and one the idle stop is closing. An office
 *  stop ends every session without telling its instrument, which keeps it to continue after the restart, and a start
 *  ends what a crash left live, marking its record interrupted. After a restart, the chat's instrument continues one
 *  (`resumeInstrument`): the same child session, Claude Code started with `--resume` by the same path. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { authoredText } from "@ngocbh/yian"
import { type HarnessUsage, type Message, Session, now } from "@opencorp/protocol"
import type { CompanyGit } from "../../company/git.ts"
import { loadRepo, missingPerson } from "../../company/loader.ts"
import type { Bus } from "../../runtime/bus.ts"
import type { Tools } from "../../runtime/service/programs.ts"
import {
  type EmployeePermission,
  checkClaudeInstall,
  gitRootOf,
  harnessHomes,
} from "../../runtime/sandbox/harness_profile.ts"
import {
  fenceIn,
  freshFolder,
  harnessRoot,
  removeFolder,
  sweepTemp,
} from "../../runtime/sandbox/harness_temp.ts"
import { type OfficePaths as SandboxOfficePaths, UnsafeProfile, UnsafeWorkspace } from "../../runtime/sandbox/policy.ts"
import { checkFolder } from "../../runtime/sessions/folder.ts"
import { employeePermission } from "../../runtime/sessions/permission.ts"
import { instructions } from "../../runtime/sessions/speakers.ts"
import { HarnessError, continueFirst, notWaiting, resumable, writeState } from "../../runtime/sessions/state.ts"
import { LIVE, type SessionRecord, type Store } from "../../runtime/store/store.ts"
import { workerEnv } from "../../runtime/worker/spawn.ts"
import type { OfficePaths } from "../../util/home.ts"
import { startTime } from "../../util/proc.ts"
import {
  CLOSE_GRACE_MS,
  ClaudeMissing,
  ClaudeProcess,
  ClaudeStartError,
  READ_ONLY_FIX,
  SOCAT_MISSING,
  ClaudeSandboxUnavailable,
  claudeSession,
  nativeClaude,
  readOnlyFails,
  socatNeeded,
  toolsBeyond,
} from "../../tools/claude/claude.ts"
import { markClaudeInterrupted } from "../../tools/claude/instrument.ts"
import { claudeJson } from "../../tools/claude/mcp.ts"
import { prepareSocat } from "../../tools/claude/socat.ts"
import { type Msg, nameOf } from "../../tools/claude/stream.ts"
import { Translator } from "../../tools/claude/translate.ts"
import type { HarnessEvent } from "../../tools/harness/adapter.ts"
import type { ThreadEvents, ThreadState } from "../../tools/harness/instrument.ts"

/** What the Claude Code sessions use of the office; `Office` has all of it. */
export interface ClaudeOffice {
  readonly paths: OfficePaths
  readonly store: Store
  readonly git: CompanyGit
  readonly bus: Bus
  /** The programs the daemon resolved at start; spawn only these. */
  readonly tools: Tools
  /** What every workspace must stay clear of, and the owner's home. */
  readonly guards: SandboxOfficePaths
}

/** How `ClaudeSessions` runs Claude Code, how long it waits, and where its warnings go. */
export type ClaudeSessionsOptions = {
  /** The `claude` to run in place of the one the daemon pinned; tests pass the fake's. */
  claude?: string
  /** A session's environment before Claude Code's fixed variables (default the worker environment). */
  env?: () => Record<string, string>
  /** The office's environment: its `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (default `process.env`). */
  environ?: Record<string, string | undefined>
  /** Where the harness temp folder is (`harnessRoot`; default `/tmp`); tests pass their own. */
  tmpBase?: string
  /** Milliseconds an idle session keeps its Claude Code before it stops (default `IDLE_MS`). */
  idleMs?: number
  /** Milliseconds Claude Code has to exit once its stdin closes (default `CLOSE_GRACE_MS`). */
  closeGraceMs?: number
  /** Milliseconds an end waits for an interrupted turn to stop (default `STOP_WAIT_MS`). */
  stopWaitMs?: number
  /** Where warnings go (default `console.error`). */
  log?: (line: string) => void
  /** The platform Claude Code's sandbox runs on (default `process.platform`). */
  platform?: NodeJS.Platform
  /** The socat to run in place of the one the daemon pinned, or null for none; tests pass a stand-in's. */
  socat?: string | null
  /** The libraries a socat loads (default `lddLibraries`); tests pass what a stand-in's would. */
  socatLibraries?: (file: string) => string[]
}

/** How long an idle session keeps its Claude Code: five minutes, as the upstream TUI's sessions do. */
export const IDLE_MS = 5 * 60_000
/** How long an end waits for an interrupted turn to stop before it closes Claude Code anyway. */
export const STOP_WAIT_MS = 15_000
/** What a session is told it may not do. */
const NOT_SUPPORTED = "a Claude Code session runs on Claude Code's own login and model, held to its employee's permission"
const ENDED = "This Claude Code session has ended."
const MISSING =
  "Claude Code isn't installed where the office can find it (on its PATH when it started). Install it " +
  "(https://code.claude.com/docs/en/setup), sign in by running `claude`, restart the office, then run `opencorp doctor`."

/** What one start of a session's Claude Code runs (`ClaudeSessions.prepare`). */
type Prepared = ReturnType<typeof claudeSession>

/** What makes a Claude Code session an employee's instrument: what hears its events and states, how each message reads
 *  to Claude Code (its author's label around it), and what Claude Code is told of its speakers at each start. */
interface InstrumentOf {
  readonly observer: ThreadEvents
  wire(text: string, author: string | null): string
  readonly instructions: string
  /** Who a message with no named sender is from: the chat's owner. */
  readonly owner: string | null
}

/** Each live Claude Code session of the office. */
export class ClaudeSessions {
  readonly office: ClaudeOffice
  readonly store: Store
  readonly log: (line: string) => void
  readonly idleMs: number
  readonly closeGraceMs: number
  readonly stopWaitMs: number
  readonly #claude: string | undefined
  readonly #env: () => Record<string, string>
  readonly #environ: Record<string, string | undefined>
  readonly #tmpBase: string | undefined
  readonly #platform: NodeJS.Platform
  readonly #socat: string | undefined
  readonly #libraries: ((file: string) => string[]) | undefined
  readonly #live = new Map<string, ClaudeSession>()
  /** How the owner's message continues each instrument session an office restart cut off (`resumable`). */
  readonly #resumers = new Map<string, (by: string | null) => Promise<void>>()
  #closed = false

  constructor(office: ClaudeOffice, options: ClaudeSessionsOptions = {}) {
    this.office = office
    this.store = office.store
    this.#claude = options.claude
    this.#env = options.env ?? (() => workerEnv(process.env))
    this.#environ = options.environ ?? process.env
    this.#tmpBase = options.tmpBase
    this.#platform = options.platform ?? process.platform
    this.#socat = options.socat === undefined ? office.tools.socat : (options.socat ?? undefined)
    this.#libraries = options.socatLibraries
    this.idleMs = options.idleMs ?? IDLE_MS
    this.closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS
    this.log = options.log ?? ((line) => console.error(line))
  }

  /** The live session `sessionId`, if it has one. */
  get(sessionId: string): ClaudeSession | undefined {
    return this.#live.get(sessionId)
  }

  /**
   * Starts Claude Code session `id` as the instrument of `chat`, a live chat whose employee drives it: its child
   * session (`kind: "instrument"`, `instrument_of`, `harness: "claude"`), with no work item of its own, in the chat's
   * folder and at its commit, under the employee's permission. Claude Code reads each message inside its author's
   * `label`, and is told at each start that `owner`'s word wins; `observer` hears its events and states. Resolves once
   * Claude Code has started, signed in and at least its floor.
   *
   * Refused (`HarnessError`) for a person who doesn't use the claude harness at the chat's commit, a folder the
   * session-folder checks refuse, or an office that is stopping; a start that fails fails the session and rejects with
   * 422 `start_failed`, whose message says what to fix.
   */
  async startInstrument(
    chat: SessionRecord,
    id: string,
    { observer, label, owner }: { observer: ThreadEvents; label: (author: string | null) => string; owner: string | null },
  ): Promise<SessionRecord> {
    if (this.#closed) throw new HarnessError(503, "stopping", "the office is stopping")
    await this.#usesClaude(chat)
    const real = checkFolder(this.office, chat.cwd, this.log)
    const t = now()
    const session = this.store.createSession(
      Session.parse({
        id,
        person: chat.person,
        harness: "claude",
        office: os.hostname(),
        cwd: real,
        repo_commit: chat.repo_commit,
        status: "starting",
        kind: "instrument",
        work_item_id: null,
        opened_by: chat.opened_by,
        connection: chat.connection,
        model: null,
        model_note: null,
        // The Claude Code session's own id, which a resume names.
        harness_session_id: randomUUID(),
        parent_session_id: null,
        instrument_of: chat.id,
        created_at: t,
        updated_at: t,
      }),
    )
    return this.#begin(session, chat, { observer, label, owner }, { resumed: false })
  }

  /**
   * Continues Claude Code session `id`, an instrument of `chat` that an office restart cut off, on its Claude Code
   * session `claudeId`: the same child session, live again, Claude Code started with `--resume` by the path every
   * start takes (`prepare`: the employee's permission at the chat's commit, a fresh temp folder, the install check,
   * socat, and the network's and a read-only folder's refusals; and the tool allowlist at its first line), with the
   * speakers as `startInstrument` sets them. Resolves once Claude Code has started.
   *
   * Refused as `startInstrument` is, as `resumable` refuses a session that isn't that chat's on that Claude Code
   * session, and 409 `live` for one live here; a start that fails fails the session and rejects with 422
   * `start_failed`, saying what to fix.
   */
  async resumeInstrument(
    chat: SessionRecord,
    id: string,
    claudeId: string,
    { observer, label, owner }: { observer: ThreadEvents; label: (author: string | null) => string; owner: string | null },
  ): Promise<SessionRecord> {
    const stopping = () => new HarnessError(503, "stopping", "the office is stopping")
    const live = () => new HarnessError(409, "live", `Claude Code session ${id} is live`)
    if (this.#closed) throw stopping()
    if (this.#live.has(id)) throw live()
    resumable(this.store, chat, id, { harness: "claude", harnessSessionId: claudeId, log: this.log })
    await this.#usesClaude(chat)
    const real = checkFolder(this.office, chat.cwd, this.log)
    // Again after the waits; from here on nothing waits before it is live, so restore can't end it between.
    if (this.#closed) throw stopping()
    if (this.#live.has(id)) throw live()
    const session = this.store.updateSession(id, {
      ...notWaiting("starting"), harness_turn_id: null, cwd: real, repo_commit: chat.repo_commit,
    })
    return this.#begin(session, chat, { observer, label, owner }, { resumed: true })
  }

  /** Refused (`HarnessError`) unless `chat`'s person uses the claude harness at the chat's commit. */
  async #usesClaude(chat: SessionRecord): Promise<void> {
    const repo = loadRepo(await this.office.git.pin(chat.repo_commit))
    const person = repo.people.get(chat.person)
    if (person === undefined) throw new HarnessError(404, "not_found", missingPerson(repo, chat.person))
    if (!person.harnesses.includes("claude")) {
      throw new HarnessError(
        422,
        "unsupported_harness",
        `@${chat.person} doesn't use the claude harness: the owner adds claude to their person's harnesses`,
      )
    }
  }

  /** Makes stored `session` live as `chat`'s instrument and starts its Claude Code (`resumed`: with `--resume`);
   *  resolves once Claude Code has started, and a start that fails fails the session. */
  async #begin(
    session: SessionRecord,
    chat: SessionRecord,
    { observer, label, owner }: { observer: ThreadEvents; label: (author: string | null) => string; owner: string | null },
    { resumed }: { resumed: boolean },
  ): Promise<SessionRecord> {
    const id = session.id
    const live = new ClaudeSession(
      this,
      session,
      {
        observer,
        wire: (text, author) => authoredText(label(author), text),
        instructions: instructions(label, chat.person, owner),
        owner,
      },
      { resumed },
    )
    this.#live.set(id, live)
    const stopping = () => new HarnessError(503, "stopping", "the office is stopping")
    if (this.#closed) {
      // The office began stopping meanwhile: nothing will drive it, and its instrument hears so from the refusal.
      await live.finish("ended", { tell: false })
      throw stopping()
    }
    try {
      await live.launch()
    } catch (error) {
      // Ended while it started: the end, or the office's stop, has ended it.
      if (live.over) throw this.#closed ? stopping() : new HarnessError(409, "not_live", `Claude Code session ${id} has ended`)
      const why = live.failure(error)
      await live.finish("failed", { tell: false })
      throw new HarnessError(422, "start_failed", why)
    }
    return this.store.getSession(id)!
  }

  /** A message from `by` (the chat's owner when null): a turn, or a steer of the running one; one to a session an
   *  office restart cut off continues it first, through its chat's instrument. 404 for no session, 409 `not_live` for
   *  one that has ended. */
  async prompt(sessionId: string, text: string, { by = null }: { by?: string | null } = {}): Promise<string> {
    if (!this.#live.has(sessionId)) await continueFirst(this.#resumers.get(sessionId), by)
    return this.#must(sessionId).prompt(text, by)
  }

  /** Lets a message to session `id`, which an office restart cut off, continue it first through `resume` (its
   *  chat's instrument); null takes that away. */
  resumable(id: string, resume: ((by: string | null) => Promise<void>) | null): void {
    if (resume === null) this.#resumers.delete(id)
    else this.#resumers.set(id, resume)
  }

  /** A steer is a `prompt`: Claude Code reads a message sent mid-turn in the same turn by itself. */
  async steer(sessionId: string, text: string, { by = null }: { by?: string | null } = {}): Promise<string> {
    return this.prompt(sessionId, text, { by })
  }

  /** Esc: interrupts the running turn, whoever started it. */
  async interrupt(sessionId: string): Promise<void> {
    await this.#must(sessionId).interrupt()
  }

  /** Ends the session: its turn is interrupted and Claude Code closes. */
  async end(sessionId: string): Promise<void> {
    const live = this.#live.get(sessionId)
    if (live !== undefined) return live.end()
    this.#claudeSession(sessionId)
  }

  /** The session's current turn, what a client reads before following its live events: empty when it isn't live. */
  messages(sessionId: string): Message[] {
    this.#claudeSession(sessionId)
    const live = this.#live.get(sessionId)
    return live ? structuredClone(live.turn) : []
  }

  /** Not supported on a Claude Code session. */
  async notSupported(sessionId: string): Promise<never> {
    this.#claudeSession(sessionId)
    throw new HarnessError(422, "not_supported", NOT_SUPPORTED)
  }

  /** An instrument session isn't continued: its employee starts another, from their chat. */
  async continueSession(sessionId: string): Promise<never> {
    this.#claudeSession(sessionId)
    throw new HarnessError(
      422,
      "not_continuable",
      "this Claude Code session was an employee's instrument: only its employee starts another, from their chat",
    )
  }

  /** Office stop: every session ends, its Claude Code stopped, and its instrument isn't told, so it keeps the session
   *  to continue after the restart; no session starts after. */
  async closeAll(): Promise<void> {
    this.#closed = true
    const live = [...this.#live.values()]
    // In parallel, so the stop stays bounded by one session's wait, whatever the number of sessions.
    await Promise.all(live.map((session) => session.shutdown()))
  }

  /** After an office restart, each Claude Code session that was live ends: its chat's instrument went with the
   *  office, so nothing drives it until that chat's next instrument continues it (`resumeInstrument`). Its record is
   *  marked interrupted, and the temp folders a crash left go. One continued meanwhile is left as it is. */
  async restore(): Promise<void> {
    this.#sweep()
    for (const session of this.store.listSessions({ status: [...LIVE] })) {
      if (this.#closed) return
      if (session.harness !== "claude" || this.#live.has(session.id)) continue
      try {
        if (session.instrument_of !== null) markClaudeInterrupted(this.recordDir(session.instrument_of, session.id))
      } catch (error) {
        this.log(`claude session ${session.id}: its record wasn't marked interrupted (${nameOf(error)})`)
      }
      try {
        this.store.updateSession(session.id, { ...notWaiting("ended"), harness_turn_id: null })
      } catch (error) {
        this.log(`can't end Claude Code session ${session.id} (${nameOf(error)})`)
      }
    }
  }

  /** Where the record of chat `chat`'s Claude Code session `id` is. */
  recordDir(chat: string, id: string): string {
    return path.join(this.office.paths.sessionDir(chat), "claude", id)
  }

  /** The harness temp folder, `/tmp/opencorp-<uid>/claude` unless the options moved it. */
  root(): string {
    return harnessRoot("claude", this.#tmpBase)
  }

  /** What one start of `live`'s Claude Code runs: the pinned `claude` (or the options'), checked as it will run
   *  (`checkClaudeInstall`), since it runs as the owner; the employee's permission over the session's folder, with a
   *  fresh, private temp folder, and on Linux the pinned socat, readied for its sandbox (`prepareSocat`: checked, run
   *  once, and, outside the system folders, linked into `<root>/<session>.bin` with the folders it loads from read);
   *  the owner's MCP servers the employee may use, from the owner's `.claude.json`, their definitions in a fresh
   *  private folder `<root>/<session>.mcp` that the employee's commands can't read (their temp folder they can), and
   *  a log line naming each allowed server that loads nothing; the session's instructions; and its environment, the
   *  worker's with Claude Code's fixed variables. A new session starts with its own id; a later start resumes it.
   *  Throws `ClaudeMissing` with no Claude Code, `ClaudeSandboxUnavailable` with no socat where the sandbox needs it,
   *  and as the checks do. */
  async prepare(live: ClaudeSession, { resume }: { resume: boolean }): Promise<Prepared> {
    const found = this.#claude ?? this.office.tools.claude
    if (found === undefined) throw new ClaudeMissing(MISSING)
    const socat = socatNeeded(this.#platform) ? this.#socat : undefined
    if (socatNeeded(this.#platform) && socat === undefined) throw new ClaudeSandboxUnavailable(`${SOCAT_MISSING}.`)
    const install = { ...nativeClaude(found), found }
    const root = this.root()
    const permission = await this.#permission(live.sessionId, {
      gitRoot: gitRootOf(live.cwd),
      tmpdir: freshFolder(root, live.sessionId),
      fence: fenceIn(root),
      harnessHomes: harnessHomes(this.#environ),
    })
    if (permission.network) {
      throw new UnsafeProfile(
        `@${live.person}'s permission turns the network on, which Claude Code can't hold to a list of hosts yet; the ` +
          "owner turns it off in their person's harness_policy, or they use Codex for work that needs the network",
      )
    }
    if (!permission.writable && readOnlyFails(this.#platform)) {
      throw new UnsafeProfile(`@${live.person}'s folder is read-only to them, and ${READ_ONLY_FIX}`)
    }
    checkClaudeInstall(permission, install)
    if (socat !== undefined) {
      const name = `${live.sessionId}.bin`
      const prepared = prepareSocat(permission, socat, { root, name, libraries: this.#libraries, env: this.#env() })
      if (prepared.programs !== null) permission.programs = prepared.programs
      permission.programReads = prepared.reads
    }
    if ((permission.allowedMcp ?? []).length > 0) permission.secrets = freshFolder(root, `${live.sessionId}.mcp`)
    const home = this.office.guards.home ?? os.homedir()
    const configDir = this.#environ.CLAUDE_CONFIG_DIR || path.join(home, ".claude")
    const config = claudeJson(this.#environ, home)
    const id = live.claudeId
    const started = claudeSession(permission, {
      claude: install.run,
      configDir,
      claudeJson: config,
      prompt: live.instrument.instructions,
      ...(resume ? { resume: id } : { sessionId: id }),
    })
    // Names only, each plain (`employeePermission` keeps no other): never a definition.
    const { missing } = started.mcp
    if (missing.length > 0) {
      const [servers, are, load] = missing.length === 1 ? ["server", "isn't", "it doesn't"] : ["servers", "aren't", "they don't"]
      this.log(
        `claude session ${live.sessionId}: @${live.person}'s allowed MCP ${servers} ${missing.join(", ")} ${are} ` +
          `defined in your Claude Code config (${config}), or that file can't be read, so ${load} load`,
      )
    }
    return { ...started, env: { ...this.#env(), ...started.env } }
  }

  /** A Claude Code for `live`, not started yet, running `command` in its folder, recorded for the start-up reaper once
   *  it spawns; its lines go to `live`. */
  process(live: ClaudeSession, prepared: Prepared): ClaudeProcess {
    const runDir = this.office.paths.runDir(live.sessionId)
    const key = `harness:${live.sessionId}`
    const proc: ClaudeProcess = new ClaudeProcess({
      command: prepared.command,
      cwd: live.cwd,
      env: prepared.env,
      log: path.join(runDir, "claude.log"),
      environ: this.#environ,
      instructions: prepared.instructions,
      mcp: prepared.mcp,
      onMessage: (msg) => live.line(proc, msg),
      onExit: (p) => live.exited(p),
      logLine: this.log,
      track: (pid) => {
        // A 0 start time never matches a process, so the reaper never signals such a row.
        this.store.recordWorker(key, { pid, pgid: pid, startTime: startTime(pid) ?? 0 })
        return () => this.store.removeWorker(key, pid)
      },
    })
    // Made 0o700 here: the umask may narrow ours, and a folder an earlier start left keeps its old mode.
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(runDir, 0o700)
    return proc
  }

  /** Drops `live` once it finished, and its temp, programs and MCP servers' folders. */
  dropped(live: ClaudeSession): void {
    if (this.#live.get(live.sessionId) === live) this.#live.delete(live.sessionId)
    try {
      removeFolder(this.root(), live.sessionId)
      removeFolder(this.root(), `${live.sessionId}.bin`)
      removeFolder(this.root(), `${live.sessionId}.mcp`)
    } catch (error) {
      this.log(`claude session ${live.sessionId}: its temp folder wasn't removed (${nameOf(error)})`)
    }
  }

  /** The session's employee's permission for one start in its folder, from the people at the session's pinned
   *  commit; what the people at head may write, and every live session's folder, stay off its PATH. */
  async #permission(
    sessionId: string,
    thread: Pick<EmployeePermission, "gitRoot" | "tmpdir" | "fence" | "harnessHomes">,
  ): Promise<EmployeePermission> {
    const session = this.store.getSession(sessionId)!
    const { git, guards, paths } = this.office
    const repo = loadRepo(await git.pin(session.repo_commit))
    const head = loadRepo(await git.pin(await git.head()))
    const workspaces = this.store.listSessions({ status: [...LIVE] }).map((s) => s.cwd)
    const office = { home: guards.home ?? os.homedir(), officeHome: paths.home, guards }
    return employeePermission(repo, session, thread, office, this.log, { repos: [head], workspaces })
  }

  /** Removes what a crashed office left in the harness temp folder: the temp folder of each of this office's
   *  sessions with no live Claude Code here, and a doctor probe's whose process is gone. */
  #sweep(): void {
    try {
      const ours = (folder: string) => {
        const name = folder.replace(/\.(bin|mcp)$/, "")
        return !this.#live.has(name) && this.store.getSession(name) !== undefined
      }
      sweepTemp(this.root(), ours, this.log)
    } catch (error) {
      this.log(`claude: the harness temp folder wasn't swept (${nameOf(error)})`)
    }
  }

  /** The stored Claude Code session `sessionId`: 404 when there is none, or it is another harness's. */
  #claudeSession(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId)
    if (session === undefined || session.harness !== "claude") {
      throw new HarnessError(404, "not_found", `no Claude Code session ${sessionId}`)
    }
    return session
  }

  #must(sessionId: string): ClaudeSession {
    const live = this.#live.get(sessionId)
    if (live !== undefined) return live
    this.#claudeSession(sessionId)
    throw new HarnessError(409, "not_live", `Claude Code session ${sessionId} has ended`)
  }
}

/** One live Claude Code session: its process (none while idle-stopped), its translator, the messages Claude Code
 *  hasn't finished with, and its state as the store and its instrument see it. */
export class ClaudeSession {
  readonly sessionId: string
  readonly cwd: string
  readonly person: string
  /** The Claude Code session's own id, which each later start resumes. */
  readonly claudeId: string
  readonly instrument: InstrumentOf
  readonly translator: Translator
  /** The current turn's messages, which a client reads before following the live events. */
  turn: Message[] = []
  /** The running Claude Code; null before the first start, once it stopped idle or exited, and once finished. */
  proc: ClaudeProcess | null = null
  readonly #owner: ClaudeSessions
  readonly #store: Store
  /** The uuids of the messages sent that Claude Code hasn't finished with: completed, cancelled, or in a result. */
  readonly #pending = new Set<string>()
  /** Whether Claude Code says how each message fares (`command_lifecycle`). */
  #lifecycle = false
  /** The uuids of the messages that wait for Claude Code to start before they are written, and of those Esc dropped
   *  meanwhile, which are never written. */
  readonly #unsent = new Set<string>()
  readonly #dropped = new Set<string>()
  #state: ThreadState = "starting"
  #starting: Promise<ClaudeProcess> | null = null
  /** The Claude Code being started, which an end or an office stop kills. */
  #launching: ClaudeProcess | null = null
  /** A Claude Code going away (the idle stop closing it, or a crash's group being killed), and when it has: a start
   *  waits for it, and an end or an office stop kills it. */
  #retiring: ClaudeProcess | null = null
  #retired: Promise<void> | null = null
  /** Whether a Claude Code of this session has started, so the next start resumes it. */
  #started = false
  #idle: ReturnType<typeof setTimeout> | null = null
  #ending: Promise<void> | null = null
  /** Wakes an end waiting for the interrupted turn to stop. */
  #stopped: (() => void) | null = null
  #finished = false
  #usage: HarnessUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }

  /** `resumed`: a session an earlier office started, so its first start resumes it, and its token counts go on. */
  constructor(
    owner: ClaudeSessions,
    session: SessionRecord,
    instrument: InstrumentOf,
    { resumed = false }: { resumed?: boolean } = {},
  ) {
    this.#owner = owner
    this.#store = owner.store
    this.sessionId = session.id
    this.cwd = session.cwd
    this.person = session.person
    this.claudeId = session.harness_session_id!
    this.instrument = instrument
    this.translator = new Translator(session.id, (e) => this.#event(e))
    this.#started = resumed
    if (resumed && session.harness_usage) this.#usage = { ...session.harness_usage }
  }

  /** Whether a turn runs, or a message waits for Claude Code. */
  get running(): boolean {
    return this.translator.turn !== null || this.#pending.size > 0
  }

  /** Whether the session is ending or has ended. */
  get over(): boolean {
    return this.#finished || this.#ending !== null
  }

  /** Starts Claude Code, or resumes its conversation after the first start, once; a start already under way is
   *  waited on. Rejects as `ClaudeProcess.start` does, and as the checks do. */
  launch(): Promise<ClaudeProcess> {
    this.#starting ??= this.#launch().finally(() => (this.#starting = null))
    return this.#starting
  }

  async #launch(): Promise<ClaudeProcess> {
    // The one going away goes first: two of one session never run at once, nor share its temp folder.
    await this.#retired
    const prepared = await this.#owner.prepare(this, { resume: this.#started })
    if (this.over) throw new ClaudeStartError(ENDED)
    const proc = this.#owner.process(this, prepared)
    this.#launching = proc
    try {
      // An end or an office stop meanwhile kills it, and its start rejects.
      await proc.start()
    } finally {
      this.#launching = null
    }
    if (this.over) {
      await proc.kill()
      throw new ClaudeStartError(ENDED)
    }
    this.#started = true
    this.proc = proc
    this.#update()
    return proc
  }

  /** Sends `text` as `by`'s (the chat's owner when null), with `priority: "next"`: a new turn, or read in the running
   *  one once its tool calls finish. Its user message is written before Claude Code reads it. Starts Claude Code
   *  again when it isn't running. 409 for a session that ended; a message Claude Code can't take rejects with why. */
  async prompt(text: string, by: string | null): Promise<string> {
    if (this.over) throw this.#ended()
    const author = by ?? this.instrument.owner
    const steer = this.running
    this.translator.user(text, author)
    const uuid = randomUUID()
    this.#pending.add(uuid)
    this.#update()
    let proc = this.proc
    if (proc === null) {
      this.#unsent.add(uuid)
      try {
        proc = await this.launch()
      } catch (error) {
        this.#unsent.delete(uuid)
        this.#dropped.delete(uuid)
        this.#pending.delete(uuid)
        // Ended while it started: the end has ended it.
        if (this.over) throw this.#ended()
        const why = this.failure(error)
        // Nothing can take a message now.
        this.translator.error(`Claude Code couldn't resume this session: ${why}`)
        await this.finish("failed")
        throw new HarnessError(409, "not_live", why)
      }
      this.#unsent.delete(uuid)
      // Esc came while Claude Code started: the message is never written.
      if (this.#dropped.delete(uuid)) return steer ? "steer" : "turn"
    }
    try {
      await proc.send(this.instrument.wire(text, author), { priority: "next", uuid })
    } catch (error) {
      this.#pending.delete(uuid)
      this.#update()
      throw new HarnessError(409, "not_live", `Claude Code didn't take the message (${nameOf(error)}); send it again`)
    }
    return steer ? "steer" : "turn"
  }

  /** Esc: the messages waiting for Claude Code to start are dropped, unsent, and the transcript marks them; then,
   *  while a turn runs or a message sent waits for one, Claude Code is interrupted and cancels every message no turn
   *  has started (`cancel_queued`), so none of them runs after. A message sent but not yet taken up is cancelled, or
   *  its turn is stopped as it starts, as Claude Code's docs give the interrupt. The interrupt also stops the command
   *  the turn runs (a real Claude Code's was gone 17 ms after), so unlike Codex's nothing more is sent to end it; and no command runs in
   *  the background (`claudeStart`'s environment), where it would outlive the turn. */
  async interrupt(): Promise<void> {
    if (this.over) return
    if (this.#unsent.size > 0) {
      for (const uuid of this.#unsent) {
        this.#dropped.add(uuid)
        this.#pending.delete(uuid)
      }
      this.#unsent.clear()
      this.translator.dropped()
      this.#update()
    }
    const proc = this.proc
    if (proc !== null && this.running) await this.#interrupt(proc)
  }

  /** Asks `proc` to interrupt its turn and cancel what waits; what it cancelled is done with. */
  async #interrupt(proc: ClaudeProcess): Promise<void> {
    try {
      const answer = await proc.interrupt({ cancelQueued: true })
      // What it cancelled never runs, whether or not a line says so.
      for (const uuid of Array.isArray(answer.cancelled) ? answer.cancelled : []) this.#pending.delete(String(uuid))
      this.#update()
    } catch (error) {
      this.#owner.log(`claude session ${this.sessionId}: the interrupt wasn't answered (${nameOf(error)})`)
    }
  }

  /** Ends the session: a running turn is interrupted (waited on, at most `stopWaitMs`), then Claude Code closes. */
  end(): Promise<void> {
    if (this.#finished) return Promise.resolve()
    this.#ending ??= this.#end()
    return this.#ending
  }

  async #end(): Promise<void> {
    this.#clearIdle()
    this.#store.updateSession(this.sessionId, notWaiting("ending"))
    const proc = this.proc
    if (proc !== null && this.translator.turn !== null) {
      const stopped = new Promise<void>((resolve) => (this.#stopped = resolve))
      void this.#interrupt(proc)
      await Promise.race([stopped, sleep(this.#owner.stopWaitMs)])
    }
    this.proc = null
    // One starting, and one going away, go with it.
    await Promise.all([proc?.close(this.#owner.closeGraceMs), ...this.#others()])
    await this.#starting?.catch(() => {})
    this.translator.abort()
    await this.finish("ended")
  }

  /** Office stop: every Claude Code of the session is killed (the running one, one starting, one going away) and the
   *  session ends; the turn it cut off is marked interrupted, and its instrument isn't told it ended, so the record
   *  waits for the next start to continue it. */
  async shutdown(): Promise<void> {
    this.#clearIdle()
    const proc = this.proc
    this.proc = null
    this.#ending ??= Promise.resolve()
    await Promise.all([proc?.kill(), ...this.#others()])
    await this.#starting?.catch(() => {})
    this.translator.abort()
    await this.finish("ended", { tell: false })
  }

  /** Kills the Claude Code being started and the one going away; resolves once they have gone. */
  #others(): Promise<void>[] {
    return [this.#launching?.kill(), this.#retiring?.kill(), this.#retired].filter(
      (p): p is Promise<void> => p !== undefined && p !== null,
    )
  }

  /** Closes or kills `proc`, which is no longer the session's, as the one going away. */
  #retire(proc: ClaudeProcess, how: "close" | "kill"): void {
    this.#retiring = proc
    const going = how === "close" ? proc.close(this.#owner.closeGraceMs) : proc.kill()
    const retired: Promise<void> = going.finally(() => {
      if (this.#retired !== retired) return
      this.#retiring = null
      this.#retired = null
    })
    this.#retired = retired
  }

  /** The 409 for a message to a session that has ended. */
  #ended(): HarnessError {
    return new HarnessError(409, "not_live", `Claude Code session ${this.sessionId} has ended`)
  }

  /** Each line `proc` writes: how each message fares, then the line as transcript events. A turn whose tools reach
   *  beyond the office's allowlist stops the session before Claude Code acts. */
  line(proc: ClaudeProcess, msg: Msg): void {
    if (proc !== this.proc || this.#finished) return
    if (msg.type === "system" && msg.subtype === "init") {
      const beyond = toolsBeyond(msg, proc.mcpServers)
      if (beyond.length > 0) return void this.#beyond(beyond)
    }
    if (msg.type === "command_lifecycle") {
      this.#lifecycle = true
      if ((msg.state === "completed" || msg.state === "cancelled") && typeof msg.command_uuid === "string") {
        this.#pending.delete(msg.command_uuid)
      }
    } else if (msg.type === "system" && msg.subtype === "init" && Array.isArray(msg.capabilities)) {
      if (msg.capabilities.includes("msg_lifecycle_v1")) this.#lifecycle = true
    } else if (msg.type === "result") {
      const took = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : null
      for (const uuid of took ?? []) this.#pending.delete(String(uuid))
      // Nothing says which messages it took: the turn took them all.
      if (took === null && !this.#lifecycle) this.#pending.clear()
    }
    this.translator.line(msg)
    this.#update()
  }

  /** Claude Code started a turn with tools beyond the allowlist (`--tools` didn't hold, as a newer Claude Code's may
   *  not): it is stopped at once, before its first model call answers, and the session fails saying why. */
  async #beyond(tools: string[]): Promise<void> {
    if (this.#finished) return
    const named = tools.join(", ")
    this.#owner.log(`claude session ${this.sessionId}: Claude Code offered tools beyond the allowlist: ${named}`)
    // Before anything else, and at once: no SIGTERM and wait, in which its first model call could answer.
    void this.proc?.kill({ now: true })
    this.translator.abort()
    this.translator.error(
      `Claude Code started with tools OpenCorp doesn't allow (${named}): they act on your account or outside your ` +
        "employee's permission, so the session stopped before Claude Code used them. This Claude Code may be newer " +
        "than OpenCorp knows; update OpenCorp, or use Codex.",
    )
    await this.finish("failed")
  }

  /** `proc` exited. Its own exit (a crash) has its group killed, marks the turn interrupted and says the next
   *  message resumes it; an idle stop's, an end's and an earlier start's change nothing. */
  exited(proc: ClaudeProcess): void {
    if (proc !== this.proc || this.over) return
    this.proc = null
    // A dead leader leaves its group to what it started: killed now, and its record with it, before any resume.
    this.#retire(proc, "kill")
    const exit = proc.proc?.exitCode ?? proc.proc?.signalCode ?? null
    this.#owner.log(`claude session ${this.sessionId}: Claude Code exited on its own (${exit ?? "unknown"})`)
    const lost = this.#pending.size > 0
    this.#pending.clear()
    this.translator.abort()
    this.translator.error(
      `Claude Code exited on its own${exit === null ? "" : ` (${exit})`}.` +
        (lost ? " A message it hadn't finished with is lost; send it again." : "") +
        " The next message resumes this conversation.",
    )
    this.#update()
  }

  /** Why a start failed, in words the agent can act on: a start's own words, or what the checks said; anything
   *  else is logged by its name and named so. */
  failure(error: unknown): string {
    if (error instanceof HarnessError || error instanceof ClaudeStartError) return error.message
    if (error instanceof UnsafeProfile || error instanceof UnsafeWorkspace) {
      return `Claude Code can't run under @${this.person}'s permission: ${error.message}`
    }
    this.#owner.log(`claude session ${this.sessionId}: Claude Code couldn't start (${nameOf(error)})`)
    return "Claude Code couldn't start; the office log says why."
  }

  /** Ends the session as `status`: its Claude Code is stopped, its state stored, and `tell` (by default) its
   *  instrument told. */
  async finish(status: "ended" | "failed", { tell = true }: { tell?: boolean } = {}): Promise<void> {
    if (this.#finished) return
    this.#finished = true
    this.#clearIdle()
    const proc = this.proc
    this.proc = null
    await Promise.all([proc?.kill(), ...this.#others()])
    this.#pending.clear()
    this.#unsent.clear()
    try {
      this.#store.updateSession(this.sessionId, { ...notWaiting(status), harness_turn_id: null })
    } catch (failure) {
      this.#owner.log(`claude session ${this.sessionId}: its end wasn't stored (${nameOf(failure)})`)
    }
    this.#owner.dropped(this)
    if (tell) this.#tell(status)
  }

  /** The state from the turn and the messages waiting: busy while either, else idle; stored and told as it changes,
   *  and the idle stop armed once idle. */
  #update(): void {
    if (this.translator.turn === null) this.#stopped?.()
    if (this.#finished || this.#ending !== null) return
    if (this.#state === "starting" && this.proc === null) {
      // A message sent before the first start finished: the turn runs once it does.
      return
    }
    const state: ThreadState = this.running ? "busy" : "idle"
    if (state === this.#state) return
    this.#state = state
    writeState(this.#store, this.sessionId, state, [], { fromStarting: ["idle", "busy"] })
    this.#tell(state)
    if (state === "idle") this.#armIdle()
    else this.#clearIdle()
  }

  /** Once idle for `idleMs`, Claude Code closes; the next message resumes it. */
  #armIdle(): void {
    this.#clearIdle()
    if (this.proc === null) return
    this.#idle = setTimeout(() => {
      this.#idle = null
      const proc = this.proc
      if (proc === null || this.running || this.#finished || this.#ending !== null) return
      this.proc = null
      this.#retire(proc, "close")
    }, this.#owner.idleMs)
    this.#idle.unref?.()
  }

  #clearIdle(): void {
    if (this.#idle !== null) clearTimeout(this.#idle)
    this.#idle = null
  }

  /** What the translator writes: kept in the current turn, told to the instrument, and published as live events; a
   *  turn's usage and the model are stored. */
  #event(e: HarnessEvent): void {
    remember(this, e)
    if (e.type === "message" || e.type === "part" || e.type === "delta") {
      try {
        this.instrument.observer.event(e)
      } catch (error) {
        this.#owner.log(`claude session ${this.sessionId}: its instrument didn't take an event (${nameOf(error)})`)
      }
    }
    const session_id = this.sessionId
    const { bus } = this.#owner.office
    if (e.type === "message") bus.publishLive({ type: "message.updated", session_id, data: e.message })
    else if (e.type === "part") {
      bus.publishLive({ type: "part.updated", session_id, data: { message_id: e.messageId, part: e.part } })
    } else if (e.type === "turn_completed" && e.usage !== null) {
      for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"] as const) this.#usage[key] += e.usage[key]
      this.#store.updateSession(session_id, { harness_usage: { ...this.#usage } })
    } else if (e.type === "model") this.#store.updateSession(session_id, { harness_model: e.model })
  }

  /** Tells the instrument the session's state; an observer that throws never reaches the session. */
  #tell(state: ThreadState): void {
    try {
      this.instrument.observer.state(state)
    } catch (error) {
      this.#owner.log(`claude session ${this.sessionId}: its instrument didn't take its state (${nameOf(error)})`)
    }
  }
}

/** Keeps `e` in `live`'s current turn: a user message while no turn runs, after one that has ended, starts it anew. */
function remember(live: ClaudeSession, e: HarnessEvent): void {
  if (e.type === "message") {
    const message = e.message
    if (message.role === "user" && live.translator.turn === null && live.turn.some((m) => m.role === "assistant")) {
      live.turn = []
    }
    const at = live.turn.findIndex((m) => m.id === message.id)
    if (at === -1) live.turn.push(structuredClone(message))
    else live.turn[at] = structuredClone(message)
  } else if (e.type === "part") {
    const message = live.turn.find((m) => m.id === e.messageId)
    if (message === undefined) return
    const at = message.parts.findIndex((p) => p.id === e.part.id)
    if (at === -1) message.parts.push(structuredClone(e.part))
    else message.parts[at] = structuredClone(e.part)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

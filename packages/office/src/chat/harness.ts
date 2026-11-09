/** The chat harness: the office's one session harness, which checks each request, runs each yian chat through its
 *  session actor and hands a Codex session's calls to the Codex sessions. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Scheduler, realScheduler } from "@ngocbh/yian/platform"
import { type Message, OFFICE, Session, WorkItem, now } from "@opencorp/protocol"
import { loadRepo, missingPerson } from "../company/loader.ts"
import type { Office, SessionHarness } from "../daemon/office.ts"
import {
  type CodexSessions,
  checkFolder,
  checkOverlap,
  folderOf,
  notSupported,
  unsafeWorkspace,
} from "../harness/sessions.ts"
import type { Monitor } from "../perm/monitor.ts"
import { MANAGER_FLOW, profileTools } from "../profile/manager.ts"
import { GitProfileStore } from "../profile/store.ts"
import { Answers } from "../questions/ask.ts"
import type { AnswerKind } from "../questions/cards.ts"
import { Live, type LiveRun } from "../runs/records.ts"
import { SandboxPolicy, UnsafeWorkspace } from "../sandbox/policy.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store, newId } from "../store/store.ts"
import { WorkspaceTools } from "../tools/workspace.ts"
import { type JobWorker, type OfficeTool, type WorkerHandlers, errorName } from "../worker/rpc.ts"
import { RegistryClosed, type Worker, type WorkerRegistry } from "../worker/spawn.ts"
import { BadConnectionName, ConnectionGone, isFile } from "./connections.ts"
import type { Hooks } from "./hooks.ts"
import { DEADLINE_MS, ListTimeout, type ModelCache } from "./models.ts"
import { ProviderError } from "./provider.ts"
import { defaultsOf, type RunSpec, mainSpec, managerSpec, sideSpec } from "./run_spec.ts"
import { type ActorContext, KEEP_MS, SessionActor, named, ownModel } from "./session_actor.ts"
import { HarnessError, LIVE, notAnAgent } from "./state.ts"
import type { Transcript } from "./transcript.ts"

/** How long, in milliseconds, the stop waits for worker requests, office tool bodies and actor jobs still running. */
const STOP_WAIT_MS = 10_000

/** Why a chat is on `office`: the office's default can't be read. */
const UNREAD_DEFAULT = "The office's default connection can't be read"

/** The connection and model a new chat starts on (`model` null: the connection's own), and a note when it isn't what
 *  was asked for. */
export type Choice = { connection: string; model: string | null; note: string | null }

/** What the chat harness is built on. `workers` is the registry its runs' workers start in; `hooks` are shared with
 *  the Codex sessions; `log` gets its warnings (default `console.error`). A new chat's choice lists models through
 *  `models` (default `office.models`) within `chooseDeadlineMs`. A chat's worker stays parked `keepMs` between run
 *  calls (default `KEEP_MS`; 0 keeps none). */
export type ChatHarnessOptions = {
  monitor: Monitor
  hooks: Hooks
  workers: WorkerRegistry
  scheduler?: Scheduler
  log?: (line: string) => void
  models?: ModelCache
  chooseDeadlineMs?: number
  keepMs?: number
}

/**
 * The office's session harness, the one owner of the session actors: one per live yian chat, made at its start or
 * at the first call after an office restart, and dropped once its session ended with no worker left.
 *
 * A call on a Codex session goes to `office.codex`, the Codex sessions; without them it answers 409 `not_live`, a
 * cost cap or model 422 `not_supported`, and a Codex start or continuation 422 `unsupported_harness`. Every call
 * answers 503 `stopping` once `closeAll` has begun.
 */
export class ChatHarness implements SessionHarness {
  readonly office: Office
  readonly store: Store
  readonly monitor: Monitor
  readonly hooks: Hooks
  readonly registry: WorkerRegistry
  readonly answers: Answers
  readonly transcript: Transcript
  readonly scheduler: Scheduler
  readonly log: (line: string) => void
  readonly models: ModelCache
  readonly chooseDeadlineMs: number
  readonly #ctx: ActorContext
  readonly #actors = new Map<string, SessionActor>()
  #closed = false
  /** Whether the stop has begun: no spawn, and worker exits are dropped. */
  #stopping = false
  /** Whether the workers' channels are closed, so worker requests are refused. */
  #refusing = false
  #closing: Promise<void> | undefined
  /** Worker requests and office tool bodies running, for the stop to wait on. */
  #inFlight = 0
  /** Wakes the stop once `#inFlight` reaches zero. */
  #idle: (() => void) | undefined

  constructor(
    office: Office,
    {
      monitor,
      hooks,
      workers,
      scheduler = realScheduler,
      log = (line) => console.error(line),
      models = office.models,
      chooseDeadlineMs = DEADLINE_MS,
      keepMs = KEEP_MS,
    }: ChatHarnessOptions,
  ) {
    this.office = office
    this.store = office.store
    this.monitor = monitor
    this.hooks = hooks
    this.registry = workers
    this.scheduler = scheduler
    this.log = log
    this.models = models
    this.chooseDeadlineMs = chooseDeadlineMs
    this.answers = new Answers(office.store, { log })
    // The office's own: a second transcript or relay would miss the first one's state.
    if (office.transcript === undefined || office.live === undefined) {
      throw new Error("the office has no transcript or live relay")
    }
    this.transcript = office.transcript
    this.#ctx = {
      store: office.store,
      git: office.git,
      paths: office.paths,
      bus: office.bus,
      connections: office.connections,
      workers: {
        spawn: (job, dir, handlers, options) =>
          this.#stopping
            ? Promise.reject(new RegistryClosed())
            : this.registry.spawn(job, dir, this.#guard(handlers), options),
        next: (worker, job, handlers) =>
          this.#stopping
            ? Promise.reject(new RegistryClosed())
            : this.registry.next(worker as Worker, job, this.#guard(handlers)),
        park: (worker, release) => this.registry.park(worker as Worker, release),
        unpark: (worker) => this.registry.unpark(worker as Worker),
      },
      keepMs,
      hooks,
      answers: this.answers,
      transcript: this.transcript,
      live: office.live,
      spec: async (session) => {
        const spec = await this.spec(session)
        return { ...spec, groups: (ctx) => this.#counted(spec.groups(ctx)) }
      },
      scheduler,
      runIndex: office.runIndex,
      runChanged: (runId) => office.runChanged(runId),
      log,
    }
    // A finished session's actor goes once its last worker and its hard stops have; a lingering one is dropped at
    // the next call. An active actor is a reopen's new one, already in the map, never the one that finished.
    hooks.sessionEnded.push((session) => {
      const actor = this.#actors.get(session.id)
      if (actor !== undefined && !actor.active && !actor.hasWorker) this.#drop(actor)
    })
  }

  /** Drops finished `actor` once its hard stops are done: until then a new run of its session waits for them. */
  #drop(actor: SessionActor): void {
    void actor.stopped.then(() => {
      if (this.#actors.get(actor.sessionId) === actor) this.#actors.delete(actor.sessionId)
    })
  }

  /**
   * Starts `handle`'s main chat in `cwd` on `harness`: a Codex chat is the Codex sessions' start; a composer chat is
   * checked (`#open`), stored `starting` with its work item and worked folder, and started by its new actor. Any
   * other harness is 422. A composer chat that can't start is `failed`, and the start throws: a `HarnessError` as it
   * is, else 500 `start_failed` naming the session.
   */
  async startSession(
    handle: string,
    cwd: string,
    {
      harness = "composer",
      openedBy = null,
      connection = null,
      model = null,
    }: {
      harness?: SessionRecord["harness"]
      openedBy?: string | null
      connection?: string | null
      model?: string | null
    } = {},
  ): Promise<SessionRecord> {
    this.#running()
    if (harness === "codex")
      return this.#codexOrUnsupported().startSession(handle, cwd, { harness, openedBy, connection, model })
    if (harness !== "composer") throw unsupported(harness)
    const opened = await this.#open(handle, cwd, { connection, model })
    // Checked again before any write: the office may have begun stopping during the checks.
    this.#running()
    // One synchronous step from the first write to the actor, so every call on the session finds its actor.
    const t = now()
    const item = this.store.createWorkItem(
      WorkItem.parse({
        id: newId(),
        title: `Chat with ${opened.person.name} in ${path.basename(opened.cwd) || opened.cwd}`,
        kind: "task",
        status: "in_progress",
        requester: openedBy || (opened.repo.company ? opened.repo.company.ceo : handle),
        assignee: handle,
        created_at: t,
        updated_at: t,
      }),
    )
    const session = this.store.createSession(
      Session.parse({
        id: newId(),
        person: handle,
        harness: "composer",
        office: os.hostname(),
        cwd: opened.cwd,
        repo_commit: opened.head,
        status: "starting",
        kind: "main",
        work_item_id: item.id,
        opened_by: openedBy,
        connection: opened.connection,
        model: opened.model,
        model_note: opened.note,
        harness_session_id: null,
        parent_session_id: null,
        created_at: t,
        updated_at: t,
      }),
    )
    this.store.touchWorkedFolder(handle, opened.cwd)
    const actor = new SessionActor(this.#ctx, session.id)
    this.#actors.set(session.id, actor)
    await actor.start()
    return this.store.getSession(session.id)!
  }

  /**
   * Starts a new run of stored session `sessionId`, which must be `starting`: a session the cards or the profile
   * manager stored, or a side chat set back to `starting` to reopen it. Its new actor replaces any it had, and starts
   * it as `SessionActor.start` does once the replaced actor's hard stops are done; returns the new run's id. Refused
   * 404 for no session, 409 `live` for one that isn't `starting`, or that this harness already started and hasn't
   * finished (a session stays `starting` until its run first shows its turn, a question or a reply), 503 once closed.
   */
  async startRun(sessionId: string): Promise<string> {
    this.#running()
    const session = this.store.getSession(sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    if (session.status !== "starting") {
      throw new HarnessError(409, "live", `session ${sessionId} is ${session.status}`)
    }
    // Still `starting` while a start runs: a second actor would start a second run.
    if (this.#actors.get(sessionId)?.active) {
      throw new HarnessError(409, "live", `session ${sessionId} is already starting`)
    }
    const previous = this.#actors.get(sessionId)
    const actor = new SessionActor(this.#ctx, sessionId)
    this.#actors.set(sessionId, actor)
    await actor.start({ after: previous?.stopped })
    return actor.runId!
  }

  /**
   * Opens a profile-manager session over `handle`'s profile, opened by `by`, with `text` as its first message: stored
   * `starting` at the company's current commit on the office's default connection and its own model (with a note when
   * that is `office` only because the default can't be read or used), with no work item, then started by `startRun` and
   * prompted. Refused 404 `not_found` for no person, 422 `no_manager_flow` when the company has no
   * profile manager flow, 503 once closed; a start that fails is `startRun`'s.
   */
  async startManager(handle: string, text: string, { by = null }: { by?: string | null } = {}): Promise<SessionRecord> {
    this.#running()
    const { git } = this.office
    await git.commitHandEdits()
    const head = await git.head()
    const pin = await git.pin(head)
    const repo = loadRepo(pin)
    if (!repo.people.has(handle)) throw new HarnessError(404, "not_found", missingPerson(repo, handle))
    if (!isFile(path.join(pin, MANAGER_FLOW))) {
      throw new HarnessError(422, "no_manager_flow", `the company has no ${MANAGER_FLOW}`)
    }
    const [connection, broken] = await this.#default()
    const uses = broken === null ? null : await named(this.office.connections, OFFICE, null)
    const note = uses === null ? null : `${broken}; this chat uses ${uses}.`
    // Checked again before any write: the office may have begun stopping during the checks.
    this.#running()
    const t = now()
    const session = this.store.createSession(
      Session.parse({
        id: newId(),
        person: handle,
        harness: "composer",
        office: os.hostname(),
        cwd: fs.realpathSync(git.root),
        repo_commit: head,
        status: "starting",
        kind: "profile_manager",
        work_item_id: null,
        opened_by: by,
        connection,
        model: null,
        model_note: note,
        harness_session_id: null,
        parent_session_id: null,
        created_at: t,
        updated_at: t,
      }),
    )
    await this.startRun(session.id)
    await this.prompt(session.id, text, { by }) // the first turn takes it
    return this.store.getSession(session.id)!
  }

  /** Ends live session `sessionId` with its run's office end reason `why` (`SessionActor.abandon`): the fallback when
   *  End can't reach it. Refused 404 for no session, 409 `not_live` for one that isn't live, 503 once closed. */
  async abandon(sessionId: string, why: string): Promise<void> {
    return this.#actor(sessionId).abandon(why)
  }

  /**
   * The run spec of `session` at its pinned commit, by its kind. A main chat's and a side chat's workspace tools run
   * under a sandbox over the session's folder, checked again (422 when it is gone or unsafe), with a private tmp dir
   * under the session's folder: a main chat's as the person's `harness_policy` says, a side chat's read-only and
   * offline whatever it says. A side chat's runs see its question, if it has one. A profile manager has only its
   * profile tools, over the person's profile, and no workspace.
   */
  async spec(session: SessionRecord): Promise<RunSpec> {
    const { store, git } = this.office
    const repo = loadRepo(await git.pin(session.repo_commit))
    if (session.kind === "profile_manager") {
      const profile = new GitProfileStore(git, session.person)
      const tools = profileTools(store, profile, session, { maxChars: defaultsOf(repo).profile_max_chars })
      return managerSpec({ repo, tools })
    }
    const monitor = this.monitor
    if (session.kind === "side") {
      // A side chat explains, it doesn't act.
      const workspace = this.#workspace(session, { writable: false, network: false })
      const question = session.question_id === null ? undefined : store.getQuestion(session.question_id)
      return sideSpec({ store, git, repo, session, workspace, monitor, question })
    }
    const policy = repo.people.get(session.person)?.harness_policy
    const workspace = this.#workspace(session, {
      writable: policy?.sandbox === "workspace-write",
      network: policy?.network === true,
    })
    const carried = (question: QuestionRecord) => this.answers.carried(question)
    return mainSpec({ store, git, repo, session, workspace, monitor, carried })
  }

  /** The workspace tools of `session`'s folder, checked again (422 when it is gone or unsafe), under a sandbox
   *  `writable` and with `network` as given, with a private tmp dir under the session's folder. */
  #workspace(session: SessionRecord, { writable, network }: { writable: boolean; network: boolean }): WorkspaceTools {
    const { store, paths } = this.office
    const log = (line: string) => this.log(`session ${session.id}: ${line}`)
    const real = folderOf(session.cwd)
    const tmpdir = path.join(paths.sessionDir(session.id), "tmp")
    // Made before the policy, which resolves the tmp dir as an existing folder; a folder found unsafe at restore
    // therefore still leaves this office-owned dir behind.
    fs.mkdirSync(tmpdir, { recursive: true, mode: 0o700 })
    // The policy runs `checkWorkspace`, so a spec build checks the folder once; the overlap check follows it, so a
    // folder failing both keeps the workspace check's reason.
    let sandbox: SandboxPolicy
    try {
      sandbox = new SandboxPolicy({ workspace: real, writable, network, tmpdir, office: this.office.guards })
    } catch (error) {
      if (error instanceof UnsafeWorkspace) throw unsafeWorkspace(error, log)
      throw error
    }
    checkOverlap(this.office, real, log)
    return new WorkspaceTools(sandbox, { officeHome: paths.home, store })
  }

  /** Continues an ended Codex session as a new one opened by `by` (the Codex sessions' continuation). */
  async continueSession(sessionId: string, { by = null }: { by?: string | null } = {}): Promise<SessionRecord> {
    this.#running()
    const old = this.store.getSession(sessionId)
    if (old === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    if (old.harness !== "codex") throw new HarnessError(422, "not_continuable", "only a Codex session can be continued")
    return this.#codexOrUnsupported().continueSession(sessionId, { by })
  }

  async prompt(sessionId: string, text: string, { by = null }: { by?: string | null } = {}): Promise<string> {
    const codex = this.#codexFor(sessionId)
    return codex ? codex.prompt(sessionId, text, { by }) : this.#actor(sessionId).prompt(text, { by })
  }

  async steer(sessionId: string, text: string, { by = null }: { by?: string | null } = {}): Promise<string> {
    const codex = this.#codexFor(sessionId)
    return codex ? codex.steer(sessionId, text, { by }) : this.#actor(sessionId).steer(text, { by })
  }

  async end(sessionId: string): Promise<void> {
    const codex = this.#codexFor(sessionId)
    return codex ? codex.end(sessionId) : this.#actor(sessionId).end()
  }

  async interrupt(sessionId: string, options: { question?: string | null } = {}): Promise<void> {
    const codex = this.#codexFor(sessionId)
    // A Codex card has no stop, so no question reaches Codex.
    return codex ? codex.interrupt(sessionId) : this.#actor(sessionId).interrupt(options)
  }

  async setCostCap(sessionId: string, usd: number): Promise<SessionRecord> {
    const codex = this.#codexFor(sessionId, notSupported)
    return codex ? codex.setCostCap(sessionId, usd) : this.#actor(sessionId).setCostCap(usd)
  }

  /**
   * Switches the session to `connection`/`model`; its next turn runs on them in a fresh run, and a reply already
   * running finishes where it is. A model equal to the connection's own is stored as null, and the note is cleared.
   * A live chat switches through its actor (`SessionActor.setModel`); one `starting` that no start of this harness's
   * holds has the store written, which its start reads. A Codex session's model is Codex's own.
   * 409 `not_live` or `ending` for a session that ended or is ending; 422 `unknown_connection` for a connection not
   * on this office; 409 `connection_unusable` for one that can't be used now.
   */
  async setModel(sessionId: string, connection: string, model: string): Promise<SessionRecord> {
    const codex = this.#codexFor(sessionId, notSupported)
    if (codex !== undefined) return codex.setModel(sessionId, connection, model)
    const session = this.store.getSession(sessionId)!
    if (!LIVE.includes(session.status)) throw new HarnessError(409, "not_live", `session ${sessionId} has ended`)
    if (session.status === "ending") throw new HarnessError(409, "ending", `session ${sessionId} is ending`)
    // Never the requested name: a 422 echoes nothing of the request.
    const unknown = () => new HarnessError(422, "unknown_connection", "no such connection on this office")
    let own: unknown
    try {
      if (!(await this.office.connections.names()).includes(connection)) throw unknown()
      own = (await this.office.connections.resolve(connection, null)).llm_config?.model
    } catch (error) {
      if (error instanceof ConnectionGone) throw unknown()
      if (!(error instanceof ProviderError)) throw error
      // Its error may name the office's files; the log says which connection, the client gets no path.
      this.log(`connection ${connection} can't be used; session ${sessionId} stays where it is`)
      throw new HarnessError(409, "connection_unusable", `connection '${connection}' can't be used on this office now`)
    }
    const picked = model === own ? null : model
    // Read again: the session may have started, ended or begun ending during the awaits.
    const current = this.store.getSession(sessionId)
    if (current?.status === "starting" && !this.#actors.has(sessionId)) {
      return this.store.updateSession(sessionId, { connection, model: picked, model_note: null })
    }
    return this.#actor(sessionId).setModel(connection, picked)
  }

  /** The session's messages: a yian chat's from its runs' logs, with its live actor's calls in flight. The logs are
   *  read on first in slices that yield to the event loop (`Transcript.refresh`), so a long log doesn't hold it; 404
   *  `not_found` without the session. */
  async messages(sessionId: string): Promise<Message[]> {
    const codex = this.#codexFor(sessionId)
    if (codex) return codex.messages(sessionId)
    const before = this.store.getSession(sessionId)
    if (before === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    await this.transcript.refresh(before.run_ids)
    // Read again after the wait: a run may have been replaced, or the session handed on, meanwhile.
    const handed = this.#codexFor(sessionId)
    if (handed) return handed.messages(sessionId)
    const session = this.store.getSession(sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    return this.transcript.messages(sessionId, session.run_ids, this.#actors.get(sessionId))
  }

  /**
   * Answers question `questionId` as `by`: a Codex session's card goes to the Codex sessions, a live session's
   * question to its actor. Any other question is stored answered (by `by`, else its session's opener, else the
   * pinned CEO), after the `answerCheck` hooks; refused with 409 `not_open` when it isn't open.
   */
  async answer(
    questionId: string,
    value: unknown,
    kind: AnswerKind,
    { by = null }: { by?: string | null } = {},
  ): Promise<QuestionRecord> {
    this.#running()
    const question = this.store.getQuestion(questionId)
    if (question === undefined) throw new HarnessError(404, "not_found", `no question ${questionId}`)
    const sid = question.session_id
    const session = sid ? this.store.getSession(sid) : undefined
    if (session?.harness === "codex") return this.#codexFor(session.id)!.answer(questionId, value, kind, { by })
    if (session !== undefined && LIVE.includes(session.status)) {
      return this.#actor(session.id).answer(questionId, value, kind, { by })
    }
    if (question.status !== "open") {
      throw new HarnessError(409, "not_open", `question ${questionId} is ${question.status}`)
    }
    for (const refusal of this.hooks.fire("answerCheck", question, value, kind)) {
      if (refusal) throw new HarnessError(422, "invalid_answer", String(refusal))
    }
    let answerer = by
    if (answerer === null && session !== undefined) {
      answerer = session.opened_by ?? loadRepo(await this.office.git.pin(session.repo_commit)).company?.ceo ?? null
    }
    try {
      const stored = this.store.answerQuestion(questionId, value, kind, answerer)
      // Store listeners (the cards' discussion copy) may have written to it before `answerQuestion` returned;
      // not when called from a listener or inside a transaction.
      return this.store.getQuestion(questionId) ?? stored
    } catch (error) {
      if (error instanceof InvalidTransition) {
        throw new HarnessError(409, "not_open", `question ${questionId} is no longer open`)
      }
      throw error
    }
  }

  /** What its actors hold now, for Run Logs: each live actor's run with its status and nodes. Codex sessions have no
   *  yian runs, so they add none. */
  live(): Live {
    const runs = new Map<string, LiveRun>()
    for (const actor of this.#actors.values()) {
      const run = actor.liveRun()
      if (run !== null) runs.set(run.runId, { status: run.status, nodes: run.nodes })
    }
    return new Live(runs)
  }

  /** Closes each parked worker whose connection was removed, re-keyed or edited (`SessionActor.connectionsChanged`);
   *  resolves once those have exited. Never rejects. */
  async connectionsChanged(): Promise<void> {
    await Promise.all([...this.#actors.values()].map((actor) => actor.connectionsChanged()))
  }

  /**
   * At office start, after the run sweep: each live yian chat's actor restores its session from where yian's log
   * says its run stands (`SessionActor.restore`), one at a time; then the Codex sessions restore theirs. An actor
   * fails its own session when it can't restore it, so one session never stops another or the office's start: a
   * throw (503 `stopping`) is logged by its type and the next session goes on. Stops once the harness is closed.
   */
  async restore(): Promise<void> {
    for (const session of this.store.listSessions({ status: [...LIVE] })) {
      if (this.#closed) return
      if (session.harness !== "composer") continue
      try {
        await this.#actor(session.id, { restoring: true }).restore()
      } catch (error) {
        this.log(`session ${session.id} can't be restored (${errorName(error)})`)
      }
    }
    if (this.#closed) return
    await this.office.codex?.restore()
  }

  /**
   * The office's stop, in Python's order; idempotent. Every later call answers 503 `stopping`; no worker spawns and
   * worker exits are dropped, so no actor retries a death or fails a session on the stop's own exits; the Codex
   * sessions close, then the workers. Once the workers' channels are closed, worker requests are refused and every
   * actor closes (a request arriving before then is served). Then it waits, within `STOP_WAIT_MS`, for the worker
   * requests and office tool bodies still running and for the job each actor ran at its close. A step that fails is
   * logged by its error's type and the later ones still run, so the stop always resolves.
   */
  closeAll(): Promise<void> {
    this.#closed = true
    this.#closing ??= this.#stop()
    return this.#closing
  }

  async #stop(): Promise<void> {
    this.#stopping = true
    await this.#step("the codex sessions didn't close", async () => {
      await this.office.codex?.closeAll()
    })
    await this.#step("the workers didn't close", () => this.registry.closeAll())
    this.#refusing = true
    await this.#step("the sessions didn't close", () => this.#drain([...this.#actors.values()].map((a) => a.close())))
  }

  /** Runs one stop step; a failure is logged by its type only (the message may quote a reply) and the stop goes on. */
  async #step(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      this.log(`the chat harness's stop: ${what} (${errorName(error)})`)
    }
  }

  /** Waits up to `STOP_WAIT_MS` for `#inFlight` to reach zero and for `tails` to settle; logs what was left. */
  async #drain(tails: Promise<void>[]): Promise<void> {
    let running = tails.length
    const settled = tails.map((tail) => tail.finally(() => void (running -= 1)))
    const idle = this.#inFlight === 0 ? Promise.resolve() : new Promise<void>((resolve) => (this.#idle = resolve))
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), STOP_WAIT_MS)))
    const done = await Promise.race([Promise.all([idle, ...settled]).then(() => true), bound])
    clearTimeout(timer)
    if (!done) {
      const left = `${this.#inFlight} worker requests or tool calls and ${running} session jobs`
      this.log(`chat harness: ${left} still running at the stop`)
    }
  }

  /** `handlers` as the stop needs them: each call goes to `handlers`; `parked` and `exited` are dropped once the stop
   *  began, and the requests are counted in flight, and refused once the workers' channels are closed. A hard stop in
   *  flight when the office stops never sees its worker's exit (dropped), which is harmless: nothing awaits it in a
   *  queue. */
  #guard<W extends JobWorker>(handlers: WorkerHandlers<W>): WorkerHandlers<W> {
    return {
      event: (worker, frame) => handlers.event(worker, frame),
      stream: (worker, frame) => handlers.stream(worker, frame),
      deliverReply: (worker, frame) => handlers.deliverReply(worker, frame),
      result: (worker, frame) => handlers.result(worker, frame),
      error: (worker, frame) => handlers.error(worker, frame),
      parked: (worker) => {
        if (!this.#stopping) handlers.parked(worker)
      },
      released: (worker) => handlers.released(worker),
      exited: (worker, returncode) => {
        if (!this.#stopping) handlers.exited(worker, returncode)
      },
      askUser: (worker, request, callId) => this.#inCall(() => handlers.askUser(worker, request, callId)),
      toolCall: (worker, group, name, args, callId) =>
        this.#inCall(() => handlers.toolCall(worker, group, name, args, callId)),
      memory: (worker, request) => this.#inCall(() => handlers.memory(worker, request)),
    }
  }

  /** `groups` with each tool's body counted in flight: a call Esc or the stop answered keeps running, and the stop
   *  waits for it. */
  #counted(groups: Record<string, Record<string, OfficeTool>>): Record<string, Record<string, OfficeTool>> {
    return Object.fromEntries(
      Object.entries(groups).map(([group, named]) => [
        group,
        Object.fromEntries(
          Object.entries(named).map(([name, tool]) => [
            name,
            { ...tool, call: (args, options) => this.#inCall(() => tool.call(args, options)) } satisfies OfficeTool,
          ]),
        ),
      ]),
    )
  }

  /** Runs `call`, counted in flight until it settles; refused once the workers' channels are closed. */
  async #inCall<T>(call: () => T): Promise<Awaited<T>> {
    if (this.#refusing) throw new Error("the office is stopping")
    this.#inFlight += 1
    try {
      return await call()
    } finally {
      this.#inFlight -= 1
      if (this.#inFlight === 0) this.#idle?.()
    }
  }

  /** Checks `handle` and `cwd` at the company's current commit, and chooses the connection and model the chat starts
   *  on; writes nothing. */
  async #open(handle: string, cwd: string, { connection, model }: { connection: string | null; model: string | null }) {
    await this.office.git.commitHandEdits()
    const head = await this.office.git.head()
    const repo = loadRepo(await this.office.git.pin(head))
    const person = repo.people.get(handle)
    if (person === undefined) throw new HarnessError(404, "not_found", missingPerson(repo, handle))
    if (person.kind !== "agent" || !person.main) throw notAnAgent()
    // An empty list is the schema's default: the composer harness alone.
    const harnesses = person.harnesses.length ? person.harnesses : ["composer"]
    if (!harnesses.includes("composer"))
      throw new HarnessError(422, "unsupported_harness", "the person doesn't use the composer harness")
    const real = checkFolder(this.office, cwd, this.log)
    return { head, repo, person, cwd: real, ...(await this.choose(person, connection, model)) }
  }

  /**
   * The connection and model a new chat of `person` starts on, and a note when it isn't what was asked for.
   *
   * The pick (`connection` and `model`; a model alone is on the default) if its connection is on this office and can
   * be used; else the first connection that offers `person.model`, the default first and then the others by name;
   * else the default on its own model. The default is `office`, with a note, when it can't be read or used.
   * Everything is decided within one `chooseDeadlineMs`. A model equal to the chosen connection's own is null.
   */
  async choose(
    person: { handle: string; model: string | null },
    connection: string | null,
    model: string | null,
  ): Promise<Choice> {
    const end = performance.now() + this.chooseDeadlineMs
    const connections = this.office.connections
    let names: string[]
    try {
      names = await connections.names()
    } catch (error) {
      // The spawn reads the names too, and reports why they can't be read.
      if (error instanceof ProviderError) return { connection: OFFICE, model: null, note: null }
      throw error
    }
    const [fallback, broken] = await this.#default()
    const why: string[] = []
    const picked = connection ?? fallback
    if (connection !== null || model !== null) {
      if (!names.includes(picked)) {
        why.push(`Your last pick '${picked}' isn't on this office`)
      } else if (!(await this.#usable(picked, model))) {
        why.push(`Your last pick '${picked}' can't be used on this office`)
      } else {
        const own = await this.#unlessOwn(picked, model)
        // A model picked alone is on the default, which may be office only because the default can't be read or used.
        const onBroken = connection === null && broken !== null
        const note = onBroken ? `${broken}; this chat uses ${await named(connections, OFFICE, own)}.` : null
        return { connection: picked, model: own, note }
      }
    }
    let name = fallback
    let chosen: string | null = null
    if (person.model) {
      try {
        let found: string | undefined
        for (const n of [fallback, ...names.filter((n) => n !== fallback).sort()]) {
          if (await this.#offers(n, person.model, end)) {
            found = n
            break
          }
        }
        if (found === undefined) {
          why.push(`@${person.handle} asks for ${person.model}, which no connection on this office offers`)
        } else {
          name = found
          chosen = await this.#unlessOwn(found, person.model)
        }
      } catch (error) {
        if (!(error instanceof ListTimeout)) throw error
        why.push(`Couldn't check in time which connection offers ${person.model}`)
      }
    }
    if (broken !== null && name === fallback) why.push(broken)
    const note = why.length ? `${why.join(". ")}; this chat uses ${await named(connections, name, chosen)}.` : null
    return { connection: name, model: chosen, note }
  }

  /**
   * The default connection, and why it is `office` instead (null when it isn't): `_default.json` can't be read, or the
   * connection it names can't be resolved (its file is unreadable, or a subscription has no sign-in). Checked on every
   * new chat, as `_default.json` itself is read on every one; resolving reads local files only. The name logged and
   * noted has passed the connection name check, as every name `default()` returns does; the error's own text, which
   * can hold file paths, is never.
   */
  async #default(): Promise<[string, string | null]> {
    let name: string
    try {
      name = await this.office.connections.default()
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error
      // The spawn never reads _default.json, so nothing else would say why chats left the default.
      this.log("the office's default connection can't be read; new chats take office as the default")
      return [OFFICE, UNREAD_DEFAULT]
    }
    if (name === OFFICE) return [OFFICE, null]
    try {
      await this.office.connections.resolve(name, null)
    } catch (error) {
      if (!(error instanceof ProviderError || error instanceof BadConnectionName)) throw error
      this.log(`the office's default connection '${name}' can't be used; new chats take office as the default`)
      return [OFFICE, `The office's default connection '${name}' can't be used`]
    }
    return [name, null]
  }

  /** Whether a run on connection `name` and `model` can be resolved now. */
  async #usable(name: string, model: string | null): Promise<boolean> {
    try {
      await this.office.connections.resolve(name, model)
      return true
    } catch (error) {
      if (!(error instanceof ProviderError || error instanceof BadConnectionName)) throw error
      this.log(`connection ${name} can't be used; a new chat doesn't start on it`)
      return false
    }
  }

  /** Whether connection `name` offers `model`, listing it by `end` (a `performance.now()`) if need be. A connection
   *  that can't be read offers nothing; rejects with `ListTimeout` if `end` passes. */
  async #offers(name: string, model: string, end: number): Promise<boolean> {
    try {
      return (await this.models.offers([name], model, { deadlineMs: end - performance.now() })).length > 0
    } catch (error) {
      if (!(error instanceof ProviderError || error instanceof BadConnectionName)) throw error
      this.log(`connection ${name} can't be read; a new chat doesn't start on it`)
      return false
    }
  }

  /** `model`, or null when it is connection `name`'s own, so the chat follows that connection's changes. */
  async #unlessOwn(name: string, model: string | null): Promise<string | null> {
    return model !== null && model === (await ownModel(this.office.connections, name)) ? null : model
  }

  /** The actor of live session `sessionId`, made if the harness has none (after an office restart): 404 for no
   *  session, 409 `not_live` for one that isn't live, or for one `starting` that it holds no actor for (unless
   *  `restoring`), 503 once closed. */
  #actor(sessionId: string, { restoring = false }: { restoring?: boolean } = {}): SessionActor {
    this.#running()
    const session = this.store.getSession(sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    if (!LIVE.includes(session.status)) {
      const finished = this.#actors.get(sessionId)
      if (finished !== undefined) this.#drop(finished)
      throw new HarnessError(409, "not_live", `session ${sessionId} has no live run`)
    }
    let actor = this.#actors.get(sessionId)
    if (actor === undefined) {
      // Every start here holds its actor from its first write: a session `starting` with none is no start of this
      // harness's (an office stopped inside it), and an actor made now would take its last, finished run as current.
      // Only the office's restore picks it up.
      if (session.status === "starting" && !restoring) {
        throw new HarnessError(409, "not_live", `session ${sessionId} has no live run`)
      }
      actor = new SessionActor(this.#ctx, sessionId)
      this.#actors.set(sessionId, actor)
    }
    return actor
  }

  /** The Codex sessions for a call on `sessionId` if it is a Codex session, else undefined (a yian chat): 404 for no
   *  session, `without()` (409 `not_live` by default) for a Codex session with no Codex sessions, and 503 once
   *  closed. */
  #codexFor(
    sessionId: string,
    without = () => new HarnessError(409, "not_live", `session ${sessionId} has no live run`),
  ): CodexSessions | undefined {
    this.#running()
    const session = this.store.getSession(sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    if (session.harness !== "codex") return undefined
    if (this.office.codex === undefined) throw without()
    return this.office.codex
  }

  /** The Codex sessions, or 422 `unsupported_harness` without them. */
  #codexOrUnsupported(): CodexSessions {
    if (this.office.codex === undefined) throw unsupported("codex")
    return this.office.codex
  }

  /** 503 `stopping` once `closeAll` has begun. */
  #running(): void {
    if (this.#closed) throw new HarnessError(503, "stopping", "the office is stopping")
  }
}

function unsupported(harness: string): HarnessError {
  return new HarnessError(422, "unsupported_harness", `the ${harness} harness is not supported yet`)
}

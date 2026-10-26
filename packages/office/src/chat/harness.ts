/** The chat harness: the office's one session harness, which checks each request, runs each yian chat through its
 *  session actor and hands a Codex session's calls to the Codex sessions. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Scheduler, realScheduler } from "@ngocbh/yian/platform"
import { type Message, Session, WorkItem, now } from "@opencorp/protocol"
import { loadRepo } from "../company/loader.ts"
import type { Office, SessionHarness } from "../daemon/office.ts"
import { type CodexSessions, checkFolder, notSupported, startConnection } from "../harness/sessions.ts"
import type { Monitor } from "../perm/monitor.ts"
import { Answers } from "../questions/ask.ts"
import type { AnswerKind } from "../questions/cards.ts"
import { SandboxPolicy, UnsafeWorkspace } from "../sandbox/policy.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store, newId } from "../store/store.ts"
import { WorkspaceTools } from "../tools/workspace.ts"
import type { JobWorker, OfficeTool, WorkerHandlers } from "../worker/rpc.ts"
import { RegistryClosed, type WorkerRegistry } from "../worker/spawn.ts"
import type { Hooks } from "./hooks.ts"
import { ProviderError } from "./provider.ts"
import { type RunSpec, mainSpec } from "./run_spec.ts"
import { type ActorContext, SessionActor } from "./session_actor.ts"
import { HarnessError, LIVE } from "./state.ts"
import type { Transcript } from "./transcript.ts"

/** How long, in milliseconds, the stop waits for worker requests, office tool bodies and actor jobs still running. */
const STOP_WAIT_MS = 10_000

/** What the chat harness is built on. `workers` is the registry its runs' workers start in; `hooks` are shared with
 *  the Codex sessions; `log` gets its warnings (default `console.error`). */
export type ChatHarnessOptions = {
  monitor: Monitor
  hooks: Hooks
  workers: WorkerRegistry
  scheduler?: Scheduler
  log?: (line: string) => void
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
    { monitor, hooks, workers, scheduler = realScheduler, log = (line) => console.error(line) }: ChatHarnessOptions,
  ) {
    this.office = office
    this.store = office.store
    this.monitor = monitor
    this.hooks = hooks
    this.registry = workers
    this.scheduler = scheduler
    this.log = log
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
      },
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
      log,
    }
    // A finished session's actor goes once its last worker has; a lingering one is dropped at the next call.
    hooks.sessionEnded.push((session) => {
      const actor = this.#actors.get(session.id)
      if (actor !== undefined && !actor.hasWorker) this.#actors.delete(session.id)
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
        model_note: null,
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
   * The run spec of `session`, a main chat: its sandbox over the session's folder, checked again (422 when it is
   * gone or unsafe), with a private tmp dir under the session's folder, and the workspace tools under it. A side
   * chat or profile manager answers 501.
   */
  async spec(session: SessionRecord): Promise<RunSpec> {
    if (session.kind !== "main") {
      throw new HarnessError(501, "not_implemented", `the chat harness doesn't run ${session.kind} sessions yet`)
    }
    const { store, git, paths } = this.office
    const repo = loadRepo(await git.pin(session.repo_commit))
    const real = checkFolder(this.office, session.cwd)
    const tmpdir = path.join(paths.sessionDir(session.id), "tmp")
    fs.mkdirSync(tmpdir, { recursive: true, mode: 0o700 })
    const policy = repo.people.get(session.person)?.harness_policy
    let sandbox: SandboxPolicy
    try {
      sandbox = new SandboxPolicy({
        workspace: real,
        writable: policy?.sandbox === "workspace-write",
        network: policy?.network === true,
        tmpdir,
        office: this.office.guards,
      })
    } catch (error) {
      if (error instanceof UnsafeWorkspace) throw new HarnessError(422, "unsafe_workspace", error.message)
      throw error
    }
    const workspace = new WorkspaceTools(sandbox, { officeHome: paths.home, store })
    const carried = (question: QuestionRecord) => this.answers.carried(question)
    return mainSpec({ store, git, repo, session, workspace, monitor: this.monitor, carried })
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

  async interrupt(sessionId: string): Promise<void> {
    const codex = this.#codexFor(sessionId)
    return codex ? codex.interrupt(sessionId) : this.#actor(sessionId).interrupt()
  }

  async setCostCap(sessionId: string, usd: number): Promise<SessionRecord> {
    const codex = this.#codexFor(sessionId, notSupported)
    return codex ? codex.setCostCap(sessionId, usd) : this.#actor(sessionId).setCostCap(usd)
  }

  /** A Codex session's model is Codex's own; a yian chat's answers 501 until the chat harness switches models. */
  async setModel(sessionId: string, connection: string, model: string): Promise<SessionRecord> {
    const codex = this.#codexFor(sessionId, notSupported)
    if (codex === undefined) {
      throw new HarnessError(501, "not_implemented", "the chat harness doesn't switch a chat's model yet")
    }
    return codex.setModel(sessionId, connection, model)
  }

  /** The session's messages: a yian chat's from its runs' logs, with its live actor's calls in flight. */
  messages(sessionId: string): Message[] {
    const codex = this.#codexFor(sessionId)
    if (codex) return codex.messages(sessionId)
    const session = this.store.getSession(sessionId)!
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
      return this.store.answerQuestion(questionId, value, kind, answerer)
    } catch (error) {
      if (error instanceof InvalidTransition) {
        throw new HarnessError(409, "not_open", `question ${questionId} is no longer open`)
      }
      throw error
    }
  }

  /** After an office restart: the Codex sessions restore theirs. */
  async restore(): Promise<void> {
    await this.office.codex?.restore()
  }

  /**
   * The office's stop, in Python's order; idempotent. Every later call answers 503 `stopping`; no worker spawns and
   * worker exits are dropped, so no actor retries a death or fails a session on the stop's own exits; the Codex
   * sessions close, then the workers. Once the workers' channels are closed, worker requests are refused and every
   * actor closes (a request arriving before then is served). Then it waits, within `STOP_WAIT_MS`, for the worker
   * requests and office tool bodies still running and for the job each actor ran at its close; a step that throws
   * leaves the later ones to run, and the stop rejects with its error.
   */
  closeAll(): Promise<void> {
    this.#closed = true
    this.#closing ??= this.#stop()
    return this.#closing
  }

  async #stop(): Promise<void> {
    this.#stopping = true
    try {
      await this.office.codex?.closeAll()
    } finally {
      try {
        await this.registry.closeAll()
      } finally {
        this.#refusing = true
        const tails = [...this.#actors.values()].map((actor) => actor.close())
        await this.#drain(tails)
      }
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

  /** `handlers` as the stop needs them: each call goes to `handlers`; `exited` is dropped once the stop began, and
   *  the requests are counted in flight, and refused once the workers' channels are closed. A hard stop in flight
   *  when the office stops never sees its worker's exit (dropped), which is harmless: nothing awaits it in a queue. */
  #guard<W extends JobWorker>(handlers: WorkerHandlers<W>): WorkerHandlers<W> {
    return {
      event: (worker, frame) => handlers.event(worker, frame),
      stream: (worker, frame) => handlers.stream(worker, frame),
      deliverReply: (worker, frame) => handlers.deliverReply(worker, frame),
      result: (worker, frame) => handlers.result(worker, frame),
      error: (worker, frame) => handlers.error(worker, frame),
      exited: (worker, returncode) => {
        if (!this.#stopping) handlers.exited(worker, returncode)
      },
      askUser: (worker, request, callId) => this.#inCall(() => handlers.askUser(worker, request, callId)),
      toolCall: (worker, group, name, args, callId) =>
        this.#inCall(() => handlers.toolCall(worker, group, name, args, callId)),
      storeRead: (worker, store, version) => this.#inCall(() => handlers.storeRead(worker, store, version)),
      storeWrite: (worker, store, text, baseVersion, provenance) =>
        this.#inCall(() => handlers.storeWrite(worker, store, text, baseVersion, provenance)),
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
    if (person === undefined) throw new HarnessError(404, "not_found", `no person ${handle}`)
    if (person.kind !== "agent" || !person.main)
      throw new HarnessError(422, "not_an_agent", `${handle} has no main flow to chat with`)
    // An empty list is the schema's default: the composer harness alone.
    const harnesses = person.harnesses.length ? person.harnesses : ["composer"]
    if (!harnesses.includes("composer"))
      throw new HarnessError(422, "unsupported_harness", `${handle} doesn't use the composer harness`)
    const real = checkFolder(this.office, cwd)
    const chosen = await startConnection(this.office, connection, this.log)
    // The picked model goes with the picked connection (a model alone is on the default).
    const picked = connection === null || chosen === connection ? model : null
    return { head, repo, person, cwd: real, connection: chosen, model: await this.#unlessOwn(chosen, picked) }
  }

  /** `model`, or null when it is connection `name`'s own, so the chat follows that connection's changes. */
  async #unlessOwn(name: string, model: string | null): Promise<string | null> {
    if (model === null) return null
    try {
      return (await this.office.connections.get(name)).llm_config?.model === model ? null : model
    } catch (error) {
      // Resolving it at the spawn reports why it can't be read.
      if (error instanceof ProviderError) return model
      throw error
    }
  }

  /** The actor of live session `sessionId`, made if the harness has none (after an office restart): 404 for no
   *  session, 409 `not_live` for one that isn't live, 503 once closed. */
  #actor(sessionId: string): SessionActor {
    this.#running()
    const session = this.store.getSession(sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    if (!LIVE.includes(session.status)) {
      this.#actors.delete(sessionId)
      throw new HarnessError(409, "not_live", `session ${sessionId} has no live run`)
    }
    let actor = this.#actors.get(sessionId)
    if (actor === undefined) {
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

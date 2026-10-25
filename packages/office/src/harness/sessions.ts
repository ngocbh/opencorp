/** The office's live Codex sessions, each with its own app-server. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type HarnessPolicy, type Message, OFFICE, Question, Session, WorkItem, now } from "@opencorp/protocol"
import type { Hooks } from "../chat/hooks.ts"
import { ProviderError } from "../chat/provider.ts"
import { HarnessError, LIVE, notWaiting } from "../chat/state.ts"
import { loadRepo } from "../company/loader.ts"
import type { Office } from "../daemon/office.ts"
import type { AnswerKind, CardActor } from "../questions/cards.ts"
import { UnsafeWorkspace, checkWorkspace, isInside, realPath } from "../sandbox/policy.ts"
import {
  InvalidTransition,
  NotFound,
  type QuestionRecord,
  type SessionRecord,
  type Store,
  newId,
} from "../store/store.ts"
import { workerEnv } from "../worker/spawn.ts"
import type { HarnessEvent } from "./adapter.ts"
import { CLOSE_GRACE_MS, CodexProcess, CodexStartError, appServerCommand } from "./codex.ts"
import { nameOf } from "./rpc.ts"
import { CodexSession, END_WAIT_MS, REPLY_WAIT_MS, STOP_WAIT_MS } from "./session.ts"
import { TURNLESS } from "./translate.ts"

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

/** Each live Codex session of the office, with its own app-server. Until the chat harness takes over, it is also the
 *  office's card actor: an answer or Esc for a session on another harness is handled here as the chat harness
 *  handles one with no live run; the Codex calls stay here after that.
 *
 *  `hooks` are the chat harness's: Codex sessions fire `promptCheck`, `endStatus` and `sessionEnded` (never the run
 *  hooks: Codex turns are not office runs). */
export class CodexSessions implements CardActor {
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
  /** The tail of the continuations' serial section. */
  #continuing: Promise<unknown> = Promise.resolve()

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

  /** Starts `handle`'s Codex chat in `cwd`: work item, session, worked folder, then the load of its own thread.
   *
   *  `openedBy` is the human who opened it; the work item is theirs (the CEO's when null). `connection` is their
   *  pick for the session's debrief. A start that fails before anything is live leaves the session `failed` and
   *  rejects with the start's `HarnessError`, or 500 `start_failed` naming it for anything else; a load that fails
   *  later fails the session with why. */
  async startSession(
    handle: string,
    cwd: string,
    { openedBy = null, connection = null }: { openedBy?: string | null; connection?: string | null } = {},
  ): Promise<SessionRecord> {
    const session = await this.#open(handle, cwd, { openedBy, connection })
    try {
      await this.start(session)
    } catch (error) {
      await this.#failed(session.id, error, `can't start Codex session ${session.id}`)
    }
    return this.store.getSession(session.id)!
  }

  /** Continues an ended Codex session: a new session on the same Codex thread, which it resumes.
   *
   *  The new session is `by`'s, in the same person and folder, at the company's current commit, with its own work
   *  item and token counts. A resume Codex refuses fails the new session with why. */
  async continueSession(sessionId: string, { by = null }: { by?: string | null } = {}): Promise<SessionRecord> {
    const old = this.store.getSession(sessionId)
    if (old === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    if (old.harness !== "codex") throw new HarnessError(422, "not_continuable", "only a Codex session can be continued")
    // Its first load failed.
    if (!old.harness_session_id)
      throw new HarnessError(
        422,
        "not_continuable",
        "this Codex session never loaded its thread, so there is nothing to continue",
      )
    if (LIVE.includes(old.status)) throw new HarnessError(409, "live", `session ${sessionId} is still open`)
    const session = await this.#serial(async () => {
      const thread = this.store
        .listSessions()
        .filter((s) => s.harness === "codex" && s.harness_session_id === old.harness_session_id)
      const holder = thread.find((s) => LIVE.includes(s.status))
      if (holder !== undefined) throw new HarnessError(409, "live", `this Codex thread is open in session ${holder.id}`)
      // The newest stretch on the thread is the parent, whichever one was asked for: the chain stays one line, so
      // each stretch's token counts start after every earlier one's.
      const newest = thread.reduce((a, b) =>
        b.created_at > a.created_at || (b.created_at === a.created_at && b.id > a.id) ? b : a,
      )
      // The continued session's connection, so this stretch's debrief runs on the same office model.
      return this.#open(old.person, old.cwd, {
        openedBy: by,
        connection: old.connection,
        harnessSessionId: old.harness_session_id,
        parentSessionId: newest.id,
      })
    })
    try {
      await this.start(session, { resume: true })
    } catch (error) {
      await this.#failed(session.id, error, `can't continue session ${sessionId}`)
    }
    return this.store.getSession(session.id)!
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

  /** Esc. A Codex session interrupts its turn. Any other session has no live run here: a live one is left as it is
   *  (asleep, as the chat harness leaves a session with no run); one that isn't live is 409. */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (session === undefined || session.harness === "codex") return void (await this.#must(sessionId).interrupt())
    if (!LIVE.includes(session.status))
      throw new HarnessError(409, "not_live", `session ${sessionId} has no live run`)
    // Asleep, waking or finishing: nothing runs to stop.
  }

  /** Answers question `questionId` as `by` (the session's opener when null) after the `answerCheck` hooks: stores
   *  the answer (secret pages as `[secret]`), then replies if Codex still waits. The store's open → answered move
   *  picks the one answer that replies, and a second answer is 409 `not_open`; a replied card is `consumed`. A
   *  question of a session on another harness is only stored, as given.
   *
   *  An answer Codex no longer waits for, or that no reply can be made from, is returned with the card `stale` and no
   *  decision: Codex resolved the request first, its turn ended, the app-server died, the office stopped, the reply
   *  waited longer than `replyWaitMs` (Codex hears it came too late), or the answer isn't one Codex takes (Codex hears
   *  it failed). */
  async answer(
    questionId: string,
    value: unknown,
    kind: AnswerKind,
    { by = null }: { by?: string | null } = {},
  ): Promise<QuestionRecord> {
    const question = this.store.getQuestion(questionId)
    if (question === undefined) throw new HarnessError(404, "not_found", `no question ${questionId}`)
    if (question.status !== "open")
      throw new HarnessError(409, "not_open", `question ${questionId} is ${question.status}`)
    for (const refusal of this.hooks.fire("answerCheck", question, value, kind))
      if (refusal) throw new HarnessError(422, "invalid_answer", String(refusal))
    const session = this.store.getSession(question.session_id)
    if (session?.harness !== "codex") {
      // Not a Codex card: stored as the chat harness stores an answer with no live run to hand it to.
      const owner = by || (session ? await this.opener(session) : null)
      try {
        return this.store.answerQuestion(questionId, value, kind, owner)
      } catch (error) {
        if (error instanceof InvalidTransition) throw new HarnessError(409, "not_open", error.message)
        throw error
      }
    }
    const live = this.#live.get(question.session_id)
    const who = by || (live ? live.author : await this.opener(session))
    try {
      this.store.answerQuestion(questionId, masked(question, value), kind, who)
    } catch (error) {
      if (error instanceof InvalidTransition) throw new HarnessError(409, "not_open", error.message)
      throw error
    }
    // The secret itself is only ever in this call's arguments, until the reply.
    const replied = live !== undefined && (await live.reply(questionId, value, who))
    if (replied) {
      try {
        this.store.setQuestionStatus(questionId, "consumed")
      } catch (error) {
        // Codex has the reply, so the answer stands.
        this.log(`codex session ${question.session_id}: card ${questionId} wasn't marked consumed (${nameOf(error)})`)
      }
    } else this.store.loseAnswer(questionId)
    return this.store.getQuestion(questionId)!
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

  /** After an office restart, for each Codex session that was live. Idle stays idle with no app-server (its next
   *  message reloads the thread). Busy, or waiting on a turn's card, becomes idle with `[interrupted]`: Codex reports
   *  that turn interrupted on resume and never reruns it. Waiting only on turnless cards becomes idle without it.
   *  Starting fails. Ending finishes ending. Open cards go stale. */
  async restore(): Promise<void> {
    for (const session of this.store.listSessions({ status: [...LIVE] })) {
      if (this.#closed) return // the office is stopping: what is left stays as it is, for the next restore
      if (session.harness !== "codex" || this.#live.has(session.id)) continue
      try {
        await this.#restore(session) // one that can't be restored mustn't stop the others, or the office
      } catch (error) {
        this.log(`can't restore Codex session ${session.id} (${nameOf(error)})`)
      }
    }
  }

  async #restore(session: SessionRecord): Promise<void> {
    const cards = this.store.listQuestions({ sessionId: session.id, status: "open" })
    // Inside a turn, unless it waited only on turnless cards (run ids TURNLESS…): Codex reports that turn
    // interrupted.
    const inTurn =
      session.status === "busy" || (session.status === "waiting" && cards.some((q) => !q.run_id.startsWith(TURNLESS)))
    for (const q of cards) {
      try {
        this.store.setQuestionStatus(q.id, "stale")
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error // answered meanwhile: no app-server waits on it
      }
    }
    // No stored tool parts to mark: a clean stop emitted them as interrupted; after a crash they are gone with the
    // stream.
    const live = new CodexSession(this, session, { author: await this.opener(session) })
    if (this.#closed) {
      // Office stop came meanwhile.
      live.release()
      return
    }
    this.#live.set(session.id, live)
    if (session.status === "starting" || !session.harness_session_id) {
      live.translator.error("The office restarted before Codex started. Start a new chat.")
      live.release()
      await this.finished(live, "failed")
    } else if (session.status === "ending") {
      live.release()
      await this.finished(live, "ended")
    } else {
      if (inTurn) live.translator.turnCompleted("restored", "interrupted", null)
      live.idleAfterRestore()
    }
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

  /** A copy of the live session's current turn; empty when it isn't live. */
  currentTurn(sessionId: string): Message[] {
    const live = this.#live.get(sessionId)
    return live ? structuredClone(live.turn) : []
  }

  /** Handles what `live`'s translator writes: messages, parts and deltas go on the bus as live events, and are kept
   *  in the session's current turn; a request's card is stored as an open question (`questionStored` fires), and a
   *  resolved one goes stale.
   *
   *  Synchronous: it runs inside a session job, or synchronously from `prompt`. A card the store refuses throws, so
   *  the request gets a JSON-RPC error. */
  event(live: CodexSession, e: HarnessEvent): void {
    const session_id = live.sessionId
    remember(live, e)
    if (e.type === "message") this.office.bus.publishLive({ type: "message.updated", session_id, data: e.message })
    else if (e.type === "part")
      this.office.bus.publishLive({ type: "part.updated", session_id, data: { message_id: e.messageId, part: e.part } })
    else if (e.type === "delta")
      this.office.bus.publishLive({
        type: "part.delta",
        session_id,
        data: { message_id: e.messageId, part_id: e.partId, text: e.text },
      })
    else if (e.type === "request") {
      const session = this.store.getSession(session_id)!
      const t = now()
      const stored = this.store.addQuestion(
        Question.parse({
          id: e.key,
          session_id,
          run_id: e.runId,
          node_id: e.nodeId,
          source: "harness",
          asker: session.person,
          work_item_id: session.work_item_id,
          title: e.card.title,
          question: e.card.question,
          options: e.card.options,
          questions: e.card.questions,
          answer_schema: e.card.answer_schema,
          status: "open",
          created_at: t,
          updated_at: t,
        }),
      )
      void this.hooks.notify("questionStored", stored)
    } else if (e.type === "request_resolved") {
      try {
        this.store.setQuestionStatus(e.key, "stale")
      } catch (error) {
        // Answered meanwhile: its reply finds no request and loses the answer.
        if (error instanceof InvalidTransition) return
        if (!(error instanceof NotFound)) throw error
        this.log(`codex session ${session_id}: card ${e.key} is gone`)
      }
    }
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

  /** Fails session `sessionId` if it is still `starting`, then rejects: a `HarnessError` as it is, anything else
   *  logged by type as `what` and as 500 `start_failed`. */
  async #failed(sessionId: string, error: unknown, what: string): Promise<never> {
    if (this.store.getSession(sessionId)?.status === "starting") {
      const session = this.store.updateSession(sessionId, notWaiting("failed"))
      await this.hooks.notify("sessionEnded", session)
    }
    if (error instanceof HarnessError) throw error
    // The type only: the message can quote anything.
    this.log(`${what} (${nameOf(error)})`)
    throw new HarnessError(500, "start_failed", `session ${sessionId} failed to start; see the office log`)
  }

  /** Runs `body` after every earlier one has settled, so two continuations can't both find the thread free. */
  #serial<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#continuing.then(() => body())
    this.#continuing = run.catch(() => undefined)
    return run
  }

  /** Checks `handle` and `cwd` at the company's current commit, then stores the Codex session `starting` with its
   *  work item and worked folder; nothing runs yet. Every check comes before any write. */
  async #open(
    handle: string,
    cwd: string,
    {
      openedBy,
      connection,
      harnessSessionId = null,
      parentSessionId = null,
    }: {
      openedBy: string | null
      connection: string | null
      harnessSessionId?: string | null
      parentSessionId?: string | null
    },
  ): Promise<SessionRecord> {
    await this.office.git.commitHandEdits()
    const head = await this.office.git.head()
    const repo = loadRepo(await this.office.git.pin(head))
    const person = repo.people.get(handle)
    if (person === undefined) throw new HarnessError(404, "not_found", `no person ${handle}`)
    if (person.kind !== "agent") throw new HarnessError(422, "not_an_agent", `${handle} has no main flow to chat with`)
    if (!person.harnesses.includes("codex"))
      throw new HarnessError(422, "unsupported_harness", `${handle} doesn't use the codex harness`)
    // A 422 never echoes the request's path: it may not be a folder at all.
    if (!path.isAbsolute(cwd)) throw new HarnessError(422, "invalid_body", "cwd is not an absolute path")
    if (!isFolder(cwd))
      throw new HarnessError(422, "invalid_body", "cwd is not a folder")
    // Clients match folders by their resolved path (/tmp is /private/tmp on macOS).
    const real = realPath(cwd)
    try {
      checkWorkspace(real, this.office.guards)
    } catch (error) {
      if (error instanceof UnsafeWorkspace) throw new HarnessError(422, "unsafe_workspace", error.message)
      throw error
    }
    // The workspace check guards ~/.opencorp; this office's home may be elsewhere.
    for (const kept of [this.office.paths.company, this.office.paths.office]) {
      if (isInside(real, kept) || isInside(kept, real))
        throw new HarnessError(
          422,
          "unsafe_workspace",
          `workspace ${real} overlaps the office's files at ${realPath(kept)}; use a project folder`,
        )
    }
    const chosen = await this.#connection(connection)
    const t = now()
    const item = this.store.createWorkItem(
      WorkItem.parse({
        id: newId(),
        title: `Chat with ${person.name} in ${path.basename(real) || real}`,
        kind: "task",
        status: "in_progress",
        requester: openedBy || (repo.company ? repo.company.ceo : handle),
        assignee: handle,
        created_at: t,
        updated_at: t,
      }),
    )
    const session = this.store.createSession(
      Session.parse({
        id: newId(),
        person: handle,
        harness: "codex",
        office: os.hostname(),
        cwd: real,
        repo_commit: head,
        status: "starting",
        kind: "main",
        work_item_id: item.id,
        opened_by: openedBy,
        connection: chosen,
        model: null,
        model_note: null,
        harness_session_id: harnessSessionId,
        parent_session_id: parentSessionId,
        created_at: t,
        updated_at: t,
      }),
    )
    this.store.touchWorkedFolder(handle, real)
    return session
  }

  /** The connection a new Codex session's debrief runs on: `requested` if it is on this office, else the office's
   *  default (`office` when the names or the default can't be read). Nothing is probed: a Codex session runs on
   *  Codex's own login, so the connection only serves its debrief, and a probe would make a start wait on the
   *  network. */
  async #connection(requested: string | null): Promise<string> {
    let names: string[]
    try {
      names = await this.office.connections.names()
    } catch (error) {
      if (error instanceof ProviderError) return OFFICE
      throw error
    }
    let fallback: string
    try {
      fallback = await this.office.connections.default()
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error
      // Nothing else would say why chats left the default.
      this.log("the office's default connection can't be read; new chats take office as the default")
      fallback = OFFICE
    }
    return requested && names.includes(requested) ? requested : fallback
  }

  #must(sessionId: string): CodexSession {
    const live = this.#live.get(sessionId)
    if (live !== undefined) return live
    if (this.store.getSession(sessionId) === undefined)
      throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    throw new HarnessError(409, "not_live", `session ${sessionId} has no live Codex app-server`)
  }
}

/** Whether `p` is a folder; a path that can't name one (missing, below a file, a link loop, a NUL byte) is not. */
function isFolder(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch (error) {
    // As Python's `Path.is_dir()`: these mean no folder there; anything else (EACCES) is raised.
    const code = (error as NodeJS.ErrnoException).code
    if (["ENOENT", "ENOTDIR", "ELOOP", "EBADF", "ERR_INVALID_ARG_VALUE"].includes(code ?? "")) return false
    throw error
  }
}

/** Folds a message, part or delta into `live`'s current turn, as a client folds the live events: a user message that
 *  comes while no turn runs, after the assistant answered, starts a new turn. Clones, since the translator keeps
 *  changing its parts. */
function remember(live: CodexSession, e: HarnessEvent): void {
  if (e.type === "message") {
    const message = e.message
    // A message queued during a load or a steer joins the turn; a load's error or restore marker stays until then.
    if (message.role === "user" && live.turnId === null && live.turn.some((m) => m.role === "assistant"))
      live.turn = []
    const at = live.turn.findIndex((m) => m.id === message.id)
    if (at === -1) live.turn.push(structuredClone(message))
    else live.turn[at] = structuredClone(message)
  } else if (e.type === "part") {
    const message = live.turn.find((m) => m.id === e.messageId)
    if (message === undefined) return
    const at = message.parts.findIndex((p) => p.id === e.part.id)
    if (at === -1) message.parts.push(structuredClone(e.part))
    else message.parts[at] = structuredClone(e.part)
  } else if (e.type === "delta") {
    const part = live.turn.find((m) => m.id === e.messageId)?.parts.find((p) => p.id === e.partId)
    if (part?.type === "text") part.text += e.text
  }
}

/** `answer` as stored: on a card with a secret page, only the values of its other pages are kept, and anything else
 *  (a secret page's value, an unknown key, an answer that isn't a record) is `[secret]`. */
export function masked(question: QuestionRecord, answer: unknown): unknown {
  const pages = question.questions ?? []
  if (!pages.some((p) => p.secret)) return answer
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return "[secret]"
  const safe = new Set(pages.filter((p) => !p.secret).map((p) => p.header))
  return Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, safe.has(k) ? v : "[secret]"]))
}

/** The chat harness: the office's one session harness, which checks each request and hands a Codex session's calls to
 *  the Codex sessions. */
import { type Scheduler, realScheduler } from "@ngocbh/yian/platform"
import type { Message } from "@opencorp/protocol"
import { loadRepo } from "../company/loader.ts"
import type { Office, SessionHarness } from "../daemon/office.ts"
import { type CodexSessions, checkFolder, startConnection } from "../harness/sessions.ts"
import type { Monitor } from "../perm/monitor.ts"
import { Answers } from "../questions/ask.ts"
import type { AnswerKind } from "../questions/cards.ts"
import type { QuestionRecord, SessionRecord, Store } from "../store/store.ts"
import type { WorkerRegistry } from "../worker/spawn.ts"
import type { Hooks } from "./hooks.ts"
import { ProviderError } from "./provider.ts"
import { HarnessError } from "./state.ts"
import { Transcript } from "./transcript.ts"

/** What a yian chat's session calls answer until the chat harness runs them. */
const NOT_SERVED = "the chat harness doesn't serve yian chats yet"

/** What the chat harness is built on. `workers` is the registry its runs' workers start in; `hooks` are shared with the
 *  Codex sessions; `log` gets its warnings (default `console.error`). */
export type ChatHarnessOptions = {
  monitor: Monitor
  hooks: Hooks
  workers: WorkerRegistry
  scheduler?: Scheduler
  log?: (line: string) => void
}

/** The office's session harness. A call on a Codex session goes to `office.codex`, the Codex sessions; without them it
 *  answers 409 `not_live`, and a Codex start or continuation 422 `unsupported_harness`. Every call answers 503
 *  `stopping` once `closeAll` has begun. */
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
  #closed = false
  #closing: Promise<void> | undefined

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
    this.transcript = new Transcript(office.paths.runs)
  }

  /** Starts `handle`'s main chat in `cwd` on `harness`: a Codex chat is the Codex sessions' start; a composer chat is
   *  checked (`#open`), then answers 501 until the chat harness runs yian chats. Any other harness is 422. */
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
    await this.#open(handle, cwd, { connection, model })
    throw new HarnessError(501, "not_implemented", NOT_SERVED)
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
    return this.#codexFor(sessionId).prompt(sessionId, text, { by })
  }

  async steer(sessionId: string, text: string, { by = null }: { by?: string | null } = {}): Promise<string> {
    return this.#codexFor(sessionId).steer(sessionId, text, { by })
  }

  async end(sessionId: string): Promise<void> {
    return this.#codexFor(sessionId).end(sessionId)
  }

  async interrupt(sessionId: string): Promise<void> {
    return this.#codexFor(sessionId).interrupt(sessionId)
  }

  async setCostCap(sessionId: string, usd: number): Promise<SessionRecord> {
    return this.#codexFor(sessionId).setCostCap(sessionId, usd)
  }

  async setModel(sessionId: string, connection: string, model: string): Promise<SessionRecord> {
    return this.#codexFor(sessionId).setModel(sessionId, connection, model)
  }

  messages(sessionId: string): Message[] {
    return this.#codexFor(sessionId).messages(sessionId)
  }

  /** Answers question `questionId` as `by`; a Codex session's card goes to the Codex sessions. */
  async answer(
    questionId: string,
    value: unknown,
    kind: AnswerKind,
    { by = null }: { by?: string | null } = {},
  ): Promise<QuestionRecord> {
    this.#running()
    const question = this.store.getQuestion(questionId)
    if (question === undefined) throw new HarnessError(404, "not_found", `no question ${questionId}`)
    return this.#codexFor(question.session_id).answer(questionId, value, kind, { by })
  }

  /** After an office restart: the Codex sessions restore theirs. */
  async restore(): Promise<void> {
    await this.office.codex?.restore()
  }

  /** Office stop: every later call answers 503; the Codex sessions close, then the workers. Idempotent. */
  closeAll(): Promise<void> {
    this.#closed = true
    this.#closing ??= (async () => {
      await this.office.codex?.closeAll()
      await this.registry.closeAll()
    })()
    return this.#closing
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
      if (error instanceof ProviderError || error instanceof RangeError) return model
      throw error
    }
  }

  /** The Codex sessions, for a call on `sessionId`, a Codex session: 404 for no session, 501 for a yian chat, 409
   *  `not_live` for a Codex session with no Codex sessions, and 503 once closed. */
  #codexFor(sessionId: string): CodexSessions {
    this.#running()
    const session = this.store.getSession(sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    if (session.harness !== "codex") throw new HarnessError(501, "not_implemented", NOT_SERVED)
    if (this.office.codex === undefined)
      throw new HarnessError(409, "not_live", `session ${sessionId} has no live run`)
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

/** One live chat session: a serial queue that drives the session's yian run through one worker process per run
 *  call, the way `yian chat` does (deliver, then `advance`, again while the run waits). */
import path from "node:path"
import type { Scheduler } from "@ngocbh/yian/platform"
import type { Message as RunMessage } from "@ngocbh/yian/run"
import { CompanyDefaults, now } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import { loadRepo } from "../company/loader.ts"
import type { Bus } from "../daemon/bus.ts"
import type { OfficePaths } from "../daemon/office.ts"
import type { Env } from "../install/launch.ts"
import { type Answers, makeAskUser, type OnQuestion } from "../questions/ask.ts"
import type { AnswerKind } from "../questions/cards.ts"
import { formatAnswer } from "../questions/format.ts"
import { COULDNT_START, flowLabel, OFFICE as OFFICE_DRIVER } from "../runs/outcomes.ts"
import { InvalidTransition, newId, type QuestionRecord, type SessionRecord, type Store } from "../store/store.ts"
import { type Frame, FrameTooLarge } from "../worker/channel.ts"
import type { Delivery, Job } from "../worker/job.ts"
import { type AskRequest, BaseHandlers, errorName, type OfficeTool, type WorkerHandlers } from "../worker/rpc.ts"
import { RegistryClosed, type Worker } from "../worker/spawn.ts"
import { type Connections, runRecord } from "./connections.ts"
import type { Hooks } from "./hooks.ts"
import { ProviderError } from "./provider.ts"
import { chatJob, type RunSpec } from "./run_spec.ts"
import { HarnessError, LIVE, notWaiting, runState, SETTLED, writeState } from "./state.ts"
import { type LiveCalls, type Transcript, userMessage } from "./transcript.ts"
import { type ChatFlow, MAIN_CHAT } from "./turns.ts"

/** What every actor of an office shares. */
export interface ActorContext {
  readonly store: Store
  readonly git: CompanyGit
  readonly paths: OfficePaths
  readonly bus: Pick<Bus, "publishLive">
  readonly connections: Connections
  readonly workers: {
    spawn(
      job: Job,
      sessionDir: string,
      handlers: WorkerHandlers<ActorWorker>,
      options: { env: Record<string, string> },
    ): Promise<ActorWorker>
  }
  readonly hooks: Hooks
  readonly answers: Answers
  readonly transcript: Pick<Transcript, "forget">
  /** The run spec of `session` (Python's restorers); may throw a `HarnessError`. */
  spec(session: SessionRecord): RunSpec | Promise<RunSpec>
  /** The clock and sleeps of the wake-at timer (yian's `Scheduler`; `realScheduler` in the office). */
  readonly scheduler: Scheduler
  /** The office's environment, for a seed's `workerEnv` (default `process.env`). */
  readonly environ?: Env
  /** Gets log lines; never an error's message. */
  log(line: string): void
}

/** What the actor uses of a worker; `Worker` fits. */
export type ActorWorker = Pick<Worker, "job" | "pid" | "deliver" | "stop">

/** What an office tool call answers when Esc, the worker's exit or the office stop cuts it before it returns. */
export const INTERRUPTED_CALL = "interrupted; outcome unknown"

/** What a message became: the turn the run waits for, an answer to the model's open question, a steer of the running
 *  reply, or queued for a later turn. */
export type MessageReply = "turn" | "answer" | "steer" | "queued"

/** A call a waiting run waits on, as a `result` frame lists it. */
interface Wait {
  node: string
  call_id: string
  tool: string
  inbox: string | null
  deadline: string | null
  settled: boolean
}

/** What the session's pinned commit says about it, which never changes. */
interface Pins {
  defaults: z.output<typeof CompanyDefaults>
  ceo: string | null
  /** Who raises the person's cost cap: their manager, else the CEO. */
  manager: string | null
}

/** A delivery the actor sent or will send, and the caller waiting for its answer. */
class Pending {
  readonly delivery: Delivery
  /** What the caller gets once the run acknowledges the delivery. */
  readonly acked: unknown
  /** The worker's reply, recorded when its frame arrives. */
  reply: Frame | null = null
  /** Whether the reply came after its worker's `result`. */
  late = false
  /** Whether the caller has its answer. */
  done = false
  /** The question a `complete` answers, marked consumed once the run takes it. */
  readonly questionId: string | null
  /** The `send` a message's `complete` falls back on when its call settled first. */
  readonly fallback: Delivery | null
  /** Settles with the caller's answer: `acked`, or the `HarnessError` the delivery is refused with. */
  readonly answer: Promise<unknown>
  #resolve!: (value: unknown) => void
  #reject!: (error: unknown) => void

  constructor(
    delivery: Delivery,
    acked: unknown = undefined,
    { questionId = null, fallback = null }: { questionId?: string | null; fallback?: Delivery | null } = {},
  ) {
    this.delivery = delivery
    this.acked = acked
    this.questionId = questionId
    this.fallback = fallback
    this.answer = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    // Marked handled: an internal delivery has no caller to read its refusal.
    this.answer.catch(() => {})
  }

  resolve(value: unknown): void {
    if (this.done) return
    this.done = true
    this.#resolve(value)
  }

  reject(error: unknown): void {
    if (this.done) return
    this.done = true
    this.#reject(error)
  }
}

/** One worker: the deliveries it was given, and what its run call has shown so far. */
class WorkerRun {
  /** The run it runs. */
  readonly runId: string
  worker: ActorWorker | null = null
  /** Its job's deliveries, then each one sent to it. */
  readonly given: Pending[]
  /** Its `result` or `error` frame, recorded when it arrives. */
  outcome: Frame | null = null
  /** Whether its run call has sent any node event. */
  nodeEvent = false
  /** The leaf nodes that run now. */
  readonly inFlight = new Set<string>()
  /** The nodes that wait, with the calls each waits on. */
  readonly waiting = new Map<string, string[]>()
  /** Whether a message was given to it since a turn node last started waiting: the take will read it. */
  turnPending: boolean

  /** A worker of run `runId` given `given`, over a run that waits at `waits`. */
  constructor(runId: string, given: Pending[], waits: readonly Wait[]) {
    this.runId = runId
    this.given = given
    for (const wait of waits) this.waiting.set(wait.node, [...(this.waiting.get(wait.node) ?? []), wait.call_id])
    this.turnPending = given.some((p) => p.delivery.op === "send")
  }
}

/**
 * One chat session's live state: its run id, its worker, the calls its run last waited on, the nodes in flight and
 * the deliveries not yet answered.
 *
 * Every command, worker notification and timer runs as a job of one serial queue. Worker requests (`askUser`,
 * `toolCall`, `store_*`) run as their own promises. The actor never calls a yian host function itself: a running
 * worker gets a `deliver` frame, and a run at rest gets a new worker whose job lists the deliveries. A command that
 * sends something resolves once its delivery is answered, which it waits for outside the queue.
 */
export class SessionActor implements LiveCalls {
  readonly sessionId: string
  readonly #ctx: ActorContext
  #tail: Promise<unknown> = Promise.resolve()
  #runId: string | null
  #run: WorkerRun | null = null
  /** The worker being spawned, holding its job's deliveries. */
  #starting: WorkerRun | null = null
  /** The calls the run waited on at its last `waiting` result; null when this actor hasn't seen one. */
  #waits: Wait[] | null = null
  /** The deliveries the next spawn's job carries. */
  #next: Pending[] = []
  /** Whether a worker accepted a delivery after its `result`, so the run needs another `advance`. */
  #readvance = false
  #finished = false
  #closed = false
  #ending = false
  #spec: RunSpec | null = null
  #pins: Pins | null = null
  /** The office tool calls in flight, each answered `INTERRUPTED_CALL` when called. */
  readonly #calls = new Set<() => void>()

  /** The actor of stored session `sessionId`, over its current run. Throws `HarnessError` (`404`) for no such
   *  session. */
  constructor(ctx: ActorContext, sessionId: string) {
    const session = ctx.store.getSession(sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${sessionId}`)
    this.#ctx = ctx
    this.sessionId = sessionId
    this.#runId = session.run_ids.at(-1) ?? null
  }

  /** The session's current run, if it has one. */
  get runId(): string | null {
    return this.#runId
  }

  /** Whether a worker runs the session's run, or is being spawned. */
  get hasWorker(): boolean {
    return this.#run !== null || this.#starting !== null
  }

  /** The model calls in flight of `runId` (none are tracked yet): empty while a worker runs it, else null. */
  calls(runId: string): readonly [] | null {
    return this.#run !== null && !this.#closed && runId === this.#runId ? [] : null
  }

  /**
   * Starts the session's first run: stores the run and its row, then spawns its `chat` worker. A start that fails
   * fails the session and throws: a `HarnessError` as it is (the run spec couldn't be built), else `500
   * start_failed`.
   */
  start(): Promise<void> {
    return this.#command(async () => {
      const sid = this.sessionId
      if (this.#runId !== null) throw new HarnessError(409, "live", `session ${sid} already has a run`)
      const runId = newId()
      let stored = false
      try {
        const session = this.#session()
        // Built first, so a spec that can't be built records no run.
        const spec = await this.#specOf(session)
        const owner = await this.#owner(session)
        const { store } = this.#ctx
        store.transaction(() => {
          store.addSessionRun(sid, runId)
          store.addRun({
            runId,
            sessionId: sid,
            driver: owner ?? OFFICE_DRIVER,
            flow: flowLabel(session.kind),
            flowPath: path.posix.normalize(spec.flow),
            connection: null,
            model: null,
            configSha256: null,
            replacesRunId: null,
            createdAt: now(),
          })
        })
        stored = true
        this.#runId = runId
        await this.#spawn("chat")
      } catch (error) {
        this.#log(`session ${sid} can't start (${errorName(error)})`)
        // The office stops: the session stays as it was, for the next office to start.
        if (error instanceof RegistryClosed || this.#closed) throw stopping()
        this.#failStart(stored ? runId : null)
        if (error instanceof HarnessError) throw error
        // A provider error never echoes the file; anything else may hold anything, so it stays in the log.
        const why = error instanceof ProviderError ? `: ${error.message}` : "; see the office log"
        throw new HarnessError(500, "start_failed", `session ${sid} failed to start${why}`)
      }
    })
  }

  /**
   * Takes a message from `by` (the owner when null) and resolves once the run has it.
   *
   * While the model's `ask_user` question is open on the run, the message answers it (`answer`). Otherwise it goes
   * to the run's inbox, and the reply is decided when it is queued: `steer` while a reply node runs, `turn` while the
   * run waits only at its turn, else `queued`. Refused with `409 not_live` (the session finished), `503 stopping`
   * (the office stops), `409 ending`, `422 refused` (a `promptCheck` hook), `422 too_large`, or `503 cant_wake` (the
   * run could not take it).
   */
  async prompt(text: string, { by = null }: { by?: string | null } = {}): Promise<MessageReply> {
    const pending = await this.#command(async () => {
      const session = this.#live()
      for (const refusal of this.#ctx.hooks.fire("promptCheck", session, text)) {
        if (refusal) throw new HarnessError(422, "refused", String(refusal))
      }
      const { delivery, reply } = await this.#message(session, text, by)
      return (await this.#answerAsked(session, text, by, delivery)) ?? (await this.#send(delivery, reply))
    })
    const fallback = pending.fallback
    try {
      return (await pending.answer) as MessageReply
    } catch (error) {
      const refused = pending.reply?.refused
      if (fallback === null || (refused !== "call_settled" && refused !== "unknown_call")) throw error
    }
    // The call settled before the answer reached it (a card's answer came first): the text is the next message.
    const sent = await this.#command(async () => this.#send(fallback, this.#replyNow(this.#live())))
    return (await sent.answer) as MessageReply
  }

  /** Answers the run's open `ask_user` question with `text` and delivers the answer by `complete`, which falls back
   *  on `fallback`; null when none is open, or a card answered it first. */
  async #answerAsked(
    session: SessionRecord,
    text: string,
    by: string | null,
    fallback: Delivery,
  ): Promise<Pending | null> {
    const { store } = this.#ctx
    const asked = store.listQuestions({ runId: this.#runId!, status: "open", source: "ask_user" })[0]
    if (asked === undefined || asked.call_id === null) return null
    const answerer = by ?? (await this.#owner(session))
    let answered: QuestionRecord
    try {
      answered = store.answerQuestion(asked.id, text, "text", answerer)
    } catch (error) {
      if (error instanceof InvalidTransition) return null
      throw error
    }
    const p = this.#complete(answered, "answer", fallback)
    await this.#deliver(p)
    return p
  }

  /** The `send` of `text` from `by` to the run's inbox, after the `turnContext` part unless the reply runs, and the
   *  reply it gets if queued now. */
  async #message(
    session: SessionRecord,
    text: string,
    by: string | null,
  ): Promise<{ delivery: Delivery; reply: MessageReply }> {
    const spec = await this.#specOf(session)
    const author = by ?? (await this.#owner(session))
    const reply = this.#replyNow(session)
    const parts = [{ type: "text", text }]
    if (reply !== "steer") {
      const results = this.#ctx.hooks.fire("turnContext", session, text, { first: session.turns === 0 })
      const context = results.find((result) => typeof result === "string")
      if (typeof context === "string") parts.unshift({ type: "text", text: context })
    }
    const event = { role: "user", parts, ...(author ? { author } : {}) }
    return { delivery: { id: newId(), op: "send", inbox: spec.chat.inbox, event }, reply }
  }

  /** Delivers the `send` `delivery`, answering its caller with `reply` once the run has it. */
  async #send(delivery: Delivery, reply: MessageReply): Promise<Pending> {
    const p = new Pending(delivery, reply)
    await this.#deliver(p)
    return p
  }

  /** The `complete` of the answered `question`'s call, answering its caller with `acked`; a message's falls back on
   *  the `send` `fallback`. */
  #complete(question: QuestionRecord, acked: unknown, fallback: Delivery | null = null): Pending {
    const output = formatAnswer(question, this.#ctx.answers.carried(question))
    const delivery: Delivery = { id: newId(), op: "complete", call_id: question.call_id!, result: { output } }
    return new Pending(delivery, acked, { questionId: question.id, fallback })
  }

  /**
   * Answers the session's open question `questionId` as `by` (the owner when null), after the `answerCheck` hooks,
   * and returns it as stored. A question of a call of the current run goes back to the run by `complete`, which the
   * answer doesn't wait for; it is marked consumed once the run takes it. Refused with `404 not_found` (no such
   * question of this session), `409 not_open`, `422 invalid_answer` or `503 stopping`.
   */
  answer(
    questionId: string,
    value: unknown,
    kind: AnswerKind,
    { by = null }: { by?: string | null } = {},
  ): Promise<QuestionRecord> {
    return this.#command(async () => {
      const { store, hooks } = this.#ctx
      const question = store.getQuestion(questionId)
      if (question === undefined || question.session_id !== this.sessionId) {
        throw new HarnessError(404, "not_found", `no question ${questionId}`)
      }
      if (question.status !== "open") {
        throw new HarnessError(409, "not_open", `question ${questionId} is ${question.status}`)
      }
      for (const refusal of hooks.fire("answerCheck", question, value, kind)) {
        if (refusal) throw new HarnessError(422, "invalid_answer", String(refusal))
      }
      const answerer = by ?? (await this.#owner(this.#session()))
      let stored: QuestionRecord
      try {
        stored = store.answerQuestion(questionId, value, kind, answerer)
      } catch (error) {
        if (error instanceof InvalidTransition) {
          throw new HarnessError(409, "not_open", `question ${questionId} is no longer open`)
        }
        throw error
      }
      this.#trySettle("after an answer")
      if (stored.call_id !== null && stored.run_id === this.#runId && !this.#finished) {
        await this.#deliver(this.#complete(stored, undefined))
      }
      return stored
    })
  }

  /**
   * Esc: interrupts the workspace, answers the office tool calls in flight `INTERRUPTED_CALL`, and interrupts the
   * run: through its worker while one runs it, else, while the agent waits on a model question, through a worker
   * spawned for it; else nothing runs to stop. Resolves once the interrupt's reply is handled (the calls it closed
   * are answered) or it was dropped. Refused with `404 not_found`, `409 not_live`, `503 stopping` or `503
   * cant_wake`.
   */
  async interrupt(): Promise<void> {
    const pending = await this.#command(async () => {
      const session = this.#session()
      if (this.#finished || !LIVE.includes(session.status) || this.#runId === null) {
        throw new HarnessError(409, "not_live", `session ${this.sessionId} has no live run`)
      }
      this.#interruptWorkspace()
      this.#answerCalls()
      const run = this.#run
      const running = run !== null && run.worker !== null && run.outcome === null
      if (!running && !this.#agentWaits()) return null
      const spec = await this.#specOf(session)
      const p = new Pending({ id: newId(), op: "interrupt", inbox: spec.chat.inbox })
      await this.#deliver(p)
      return p
    })
    if (pending !== null) await pending.answer
  }

  /** Whether the model's question (`ask_user` or `ask_manager`) is open on the current run. */
  #agentWaits(): boolean {
    const asked = this.#ctx.store.listQuestions({ runId: this.#runId!, status: "open" })
    return asked.some((q) => q.source === "ask_user" || q.source === "ask_manager")
  }

  /** A steer is a message: the running reply reads it before its next model call, else the next turn does. */
  steer(text: string, options: { by?: string | null } = {}): Promise<MessageReply> {
    return this.prompt(text, options)
  }

  /**
   * Writes the session's run state from what its run waits in: waiting while a question is open on its current run
   * (on the `ask_manager` item's assignee, else on the owner); else busy while a worker is being spawned or is sure
   * to be (a re-advance, or a message held for the next job), or while a worker runs the run and it isn't at its
   * turn; else idle. `writeState` leaves ending and finished sessions alone.
   * Called inside queue jobs. Every command reads the pinned company first, so it throws for missing pins only
   * before any command; tests may call it directly when nothing else runs.
   */
  settle(): void {
    const { store } = this.#ctx
    store.transaction(() => {
      const session = store.getSession(this.sessionId)
      if (session === undefined || !SETTLED.includes(session.status)) return
      if (this.#pins === null) throw new Error("the pinned company isn't read yet")
      const owner = session.opened_by ?? this.#pins.ceo
      const asks = this.#runId === null ? [] : store.listQuestions({ runId: this.#runId, status: "open" })
      const who = asks.map((q) => (q.source === "ask_manager" ? this.#assignee(q) : owner))
      const run = this.#run
      const spawning = this.#starting !== null || this.#readvance || this.#next.some((p) => p.delivery.op === "send")
      const running = spawning || (run !== null && run.outcome === null && !this.#runAtTurn(run))
      writeState(store, this.sessionId, runState({ waiting: asks.length > 0, running }), who)
    })
  }

  /** Who an `ask_manager` question waits on: its work item's assignee. */
  #assignee(question: QuestionRecord): string | null {
    const item = question.work_item_id ? this.#ctx.store.getWorkItem(question.work_item_id) : undefined
    return item?.assignee ?? null
  }

  /**
   * Office stop: the workspace is interrupted and every delivery not yet answered is answered: with its recorded
   * reply when the worker sent one, else by the closing rule with `503 stopping`. Later commands are refused `503
   * stopping`, later worker frames are ignored and later `askUser` and `toolCall` requests are refused (store requests
   * still run); the office's registry stops the workers.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#interruptWorkspace()
    this.#answerCalls()
    const given = [...(this.#starting?.given ?? []), ...(this.#run?.given ?? []), ...this.#next.splice(0)]
    this.#answerRest(given, stopping())
  }

  // --- the queue ------------------------------------------------------------------------

  /** Runs `job` on the queue after every job posted before it; a job whose turn comes after `close` is skipped, and
   *  one that throws is logged by its error's type. */
  #post(label: string, job: () => unknown): void {
    this.#tail = this.#tail.then(async () => {
      if (this.#closed) return
      try {
        await job()
      } catch (error) {
        this.#log(`session ${this.sessionId}: ${label} failed (${errorName(error)})`)
      }
    })
  }

  /** Runs `job` on the queue, after reading the pinned company, and settles with what it returns or throws; refused
   *  `503 stopping` after `close`. */
  #command<T>(job: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(stopping())
    return new Promise<T>((resolve, reject) => {
      this.#tail = this.#tail.then(async () => {
        if (this.#closed) return reject(stopping())
        try {
          // Read first, so no settle after a command lacks the owner; a failure surfaces where the job reads them.
          await this.#pinsOf(this.#session())
        } catch {}
        try {
          resolve(await job())
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  // --- deliveries -----------------------------------------------------------------------

  /** Sends `p` to the worker while it hasn't sent its `result`; otherwise it goes to the next spawn's job, which
   *  starts now when no worker runs, or at the lingering worker's exit. */
  async #deliver(p: Pending): Promise<void> {
    // The office stopped while the command waited: no worker may start for it.
    if (this.#closed) return p.reject(stopping())
    const run = this.#run
    if (run !== null && run.worker !== null && run.outcome === null) {
      run.given.push(p)
      let sent: boolean
      try {
        sent = await run.worker.deliver(p.delivery)
      } catch (error) {
        run.given.splice(run.given.indexOf(p), 1)
        this.#log(`session ${this.sessionId}: a ${p.delivery.op} can't be sent (${errorName(error)})`)
        p.reject(error instanceof FrameTooLarge ? tooLarge() : this.#cantWake(errorName(error)))
        return
      }
      if (sent) {
        if (p.delivery.op === "send") run.turnPending = true
        return
      }
      // The worker read its last frame meanwhile; its exit decides the next spawn.
      run.given.splice(run.given.indexOf(p), 1)
      // The office stopped meanwhile and `close` answered it: it stays out of the next job.
      if (this.#closed) return
    }
    this.#next.push(p)
    if (this.#run === null) await this.#spawnQuietly("advance")
  }

  /** The decided reply of a message queued now. */
  #replyNow(session: SessionRecord): MessageReply {
    const run = this.#run
    if (run !== null && run.outcome === null && [...run.inFlight].some((node) => this.#chat.isReply(node))) {
      return "steer"
    }
    return this.#atTurn(session) ? "turn" : "queued"
  }

  /** Whether the run waits only at its turn: a worker's run with nothing in flight, no message pending for the
   *  take and only turn nodes waiting; with no running worker, a last result whose waits are only the turn's
   *  unsettled take (unknown waits: whether the session is idle). A message held for the next job is pending too. */
  #atTurn(session: SessionRecord): boolean {
    if (this.#next.some((p) => p.delivery.op === "send")) return false
    const run = this.#run
    if (run !== null && run.outcome === null) return this.#runAtTurn(run)
    const waits = run !== null ? waitsOf(run.outcome!) : this.#waits
    if (waits === null) return session.status === "idle"
    return waits.length > 0 && waits.every((wait) => this.#chat.isTurn(wait.node) && !wait.settled)
  }

  #runAtTurn(run: WorkerRun): boolean {
    const waiting = [...run.waiting.keys()]
    return (
      run.inFlight.size === 0 &&
      !run.turnPending &&
      waiting.length > 0 &&
      waiting.every((node) => this.#chat.isTurn(node))
    )
  }

  // --- spawning ---------------------------------------------------------------------------

  /**
   * Spawns the session's next worker, a `kind` job whose deliveries are `#next`. The provider is resolved first (a
   * removed connection moves the session to the default); a `chat` job records what its run starts on. On failure,
   * the job's deliveries are answered with the error (`503 cant_wake`, `503 stopping`, or a `HarnessError` as it
   * is) and dropped, and the error is thrown.
   */
  async #spawn(kind: "chat" | "advance"): Promise<void> {
    const { store, connections, paths } = this.#ctx
    const sid = this.sessionId
    const runId = this.#runId!
    const pendings = kind === "advance" ? [...this.#storedAnswers(this.#next), ...this.#next] : this.#next
    this.#next = []
    // This spawn is the re-advance; one that fails leaves nothing to wait for.
    this.#readvance = false
    const run = new WorkerRun(runId, pendings, kind === "advance" ? (this.#waits ?? []) : [])
    this.#starting = run
    try {
      if (this.#closed) throw stopping()
      let session = this.#session()
      const [name, model, moved] = await connections.choice(session.connection, session.model)
      if (moved) session = store.updateSession(sid, { connection: name, model })
      const provider = await connections.resolve(name, model)
      const spec = await this.#specOf(session)
      // Read now, so every settle while the worker runs has the owner.
      await this.#pinsOf(session)
      const onQuestion = this.#onQuestion
      const tools = spec.groups({ session, runId, onQuestion })
      const ask = makeAskUser(session, runId, onQuestion, {
        names: spec.names,
        carried: (question) => this.#ctx.answers.carried(question),
      })
      const job = chatJob(spec, tools, {
        kind,
        session,
        runId,
        pin: await this.#ctx.git.pin(session.repo_commit),
        log: path.join(paths.runs, runId, "log.jsonl"),
        llmConfig: provider.llm_config,
        turns: session.turns,
        deliver: pendings.map((p) => p.delivery),
      })
      if (kind === "chat") store.setRunConfig(runId, runRecord(name, model, provider))
      const handlers = this.#handlers(run, ask, tools, spec.stores)
      // The office may have stopped during the awaits above.
      if (this.#closed) throw stopping()
      run.worker = await this.#ctx.workers.spawn(job, paths.sessionDir(sid), handlers, { env: provider.env })
      this.#run = run
      this.#starting = null
      void this.#ctx.hooks.notify("runStarted", session, runId)
      // Busy before any caller hears back: the run isn't at its turn until it shows it.
      if (!this.#closed) this.#trySettle("after a spawn")
    } catch (error) {
      const refusal = this.#wakeError(error)
      for (const p of pendings) p.reject(refusal)
      throw error
    } finally {
      if (this.#starting === run) this.#starting = null
    }
  }

  /** A `complete` for each answer stored on a call of the current run that never reached it (its spawn failed, or
   *  the office stopped first) and that `next` doesn't deliver: only calls the last result waits on unsettled, or
   *  every one when those waits are unknown. */
  #storedAnswers(next: readonly Pending[]): Pending[] {
    const delivered = new Set(next.flatMap((p) => (p.delivery.op === "complete" ? [p.delivery.call_id] : [])))
    const waits = this.#waits
    return this.#ctx.store
      .listQuestions({ runId: this.#runId!, status: "answered" })
      .filter(
        (q) =>
          q.call_id !== null &&
          !delivered.has(q.call_id) &&
          (waits === null || waits.some((wait) => wait.call_id === q.call_id && !wait.settled)),
      )
      .map((q) => this.#complete(q, undefined))
  }

  /** Stores a question of the run's calls through `Answers.ask`; a newly stored one fires `questionStored` and
   *  posts a settle. */
  readonly #onQuestion: OnQuestion = (question, options) => {
    const stored = this.#ctx.answers.ask(question, options)
    if (stored.id === question.id) {
      void this.#ctx.hooks.notify("questionStored", stored)
      this.#post("settle", () => this.settle())
    }
    return stored
  }

  /** Runs the office tool call `call`, which Esc, the worker's exit or the office stop answers `INTERRUPTED_CALL` at
   *  once. */
  #cancellable(call: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const cancel = () => resolve(INTERRUPTED_CALL)
      this.#calls.add(cancel)
      call()
        .then(resolve, reject)
        .finally(() => this.#calls.delete(cancel))
    })
  }

  /** Answers every office tool call in flight `INTERRUPTED_CALL`. */
  #answerCalls(): void {
    for (const cancel of this.#calls) cancel()
    this.#calls.clear()
  }

  /** `#spawn`, logging its failure, which it already answered. */
  async #spawnQuietly(kind: "chat" | "advance"): Promise<void> {
    try {
      await this.#spawn(kind)
    } catch (error) {
      this.#log(`session ${this.sessionId}: a worker can't start (${errorName(error)})`)
    }
  }

  /** One worker's handlers: its notifications go to the queue, its requests run at once. */
  #handlers(
    run: WorkerRun,
    ask: (request: AskRequest, callId: string) => Promise<unknown>,
    tools: Record<string, Record<string, OfficeTool>>,
    stores: RunSpec["stores"],
  ): WorkerHandlers<ActorWorker> {
    const actor = this
    return new (class extends BaseHandlers {
      override event(_worker: unknown, frame: Frame): void {
        actor.#post("event", () => actor.#event(run, frame))
      }

      override deliverReply(_worker: unknown, frame: Frame): void {
        actor.#arrived(run, frame)
      }

      override result(_worker: unknown, frame: Frame): void {
        run.outcome = frame
        actor.#post("result", () => actor.#result(run, frame))
      }

      override error(_worker: unknown, frame: Frame): void {
        run.outcome = frame
        actor.#post("error", () => actor.#result(run, frame))
      }

      override exited(_worker: unknown, returncode: number | null): void {
        actor.#post("exit", () => actor.#exited(run, returncode))
      }

      override askUser(_worker: unknown, request: AskRequest, callId: string): Promise<unknown> {
        if (actor.#closed) return Promise.reject(new Error("the office is stopping"))
        return ask(request, callId)
      }

      override toolCall(
        worker: unknown,
        group: string,
        name: string,
        args: Record<string, unknown>,
        callId?: string,
      ): Promise<unknown> {
        if (actor.#closed) return Promise.reject(new Error("the office is stopping"))
        const call = () => super.toolCall(worker, group, name, args, callId)
        // The workspace kills its own calls when interrupted.
        return group === "workspace" ? call() : actor.#cancellable(call)
      }
    })({ tools, stores })
  }

  // --- worker frames ----------------------------------------------------------------------

  /** Tracks the nodes in flight and the turn; a reply node that succeeds counts a turn; a call that closed before
   *  its answer closes its question. */
  #event(run: WorkerRun, frame: Frame): void {
    if (run !== this.#run) return
    const data = (typeof frame.data === "object" && frame.data !== null ? frame.data : {}) as Record<string, unknown>
    const node = typeof data.node_id === "string" ? data.node_id : null
    switch (frame.name) {
      case "CallClosed":
        if (typeof data.call_id === "string" && typeof data.reason === "string") {
          this.#closedCall(run.runId, data.call_id, data.reason)
        }
        this.#trySettle("after a closed call")
        return
      case "NodeStarted":
      case "NodeWoken":
        if (node !== null) {
          run.inFlight.add(node)
          run.waiting.delete(node)
        }
        break
      case "NodeSucceeded":
        if (node !== null) {
          run.inFlight.delete(node)
          if (this.#chat.isReply(node)) this.#countTurn()
        }
        break
      // A container expands and never succeeds.
      case "NodeSkipped":
      case "NodeExpanded":
        if (node !== null) run.inFlight.delete(node)
        break
      case "NodeFailed": {
        const failure = data.failure as { node_id?: unknown } | null | undefined
        if (typeof failure?.node_id === "string") run.inFlight.delete(failure.node_id)
        break
      }
      case "NodeWaiting":
        if (node !== null) {
          run.inFlight.delete(node)
          run.waiting.set(node, Array.isArray(data.call_ids) ? data.call_ids.map(String) : [])
          if (this.#chat.isTurn(node)) run.turnPending = false
        }
        break
      default:
        return
    }
    run.nodeEvent = true
    this.#trySettle("after a node event")
  }

  /** Adds one finished reply to the session's turns. */
  #countTurn(): void {
    const { store } = this.#ctx
    store.transaction(() => {
      const session = store.getSession(this.sessionId)
      if (session !== undefined) store.updateSession(this.sessionId, { turns: session.turns + 1 })
    })
  }

  /** Closes the question of call `callId` of run `runId`, which closed with `reason` before its answer; a failure
   *  is logged by its type, so the step around it goes on. */
  #closedCall(runId: string, callId: string, reason: string): void {
    try {
      this.#ctx.answers.closedCall(runId, callId, reason)
    } catch (error) {
      this.#log(`session ${this.sessionId}: a closed call's question can't be closed (${errorName(error)})`)
    }
  }

  /** Marks the answered question `questionId` consumed: its run took the answer. */
  #consume(questionId: string): void {
    try {
      this.#ctx.store.setQuestionStatus(questionId, "consumed")
    } catch (error) {
      // Consumed or closed meanwhile: the run has its answer either way.
      if (!(error instanceof InvalidTransition)) {
        this.#log(`session ${this.sessionId}: an answer can't be marked consumed (${errorName(error)})`)
      }
    }
  }

  /** Records a `deliver_reply` on its delivery as it arrives, so the answer is known before its job runs. */
  #arrived(run: WorkerRun, frame: Frame): void {
    const p = run.given.find((given) => given.delivery.id === frame.id && given.reply === null)
    if (p === undefined) return
    p.reply = frame
    p.late = run.outcome !== null
    this.#post("deliver_reply", () => this.#replied(run, p))
  }

  /** Answers `p`'s caller from its reply: acknowledged (after closing the questions of the calls it closed, and
   *  marking the question a `complete` answered consumed), or refused. A `not_started` refusal, and a failure before
   *  any node event (the run may not have resumed), are held for the worker's exit. */
  #replied(run: WorkerRun, p: Pending): void {
    if (p.done) return
    const reply = p.reply!
    const op = p.delivery.op
    if (Object.hasOwn(reply, "seq")) {
      const closed = Array.isArray(reply.closed) ? reply.closed.map(String) : []
      for (const callId of closed) this.#closedCall(run.runId, callId, op === "cancel" ? "cancelled" : "interrupted")
      if (p.late && (op === "send" || op === "complete" || op === "close" || closed.length > 0)) this.#readvance = true
      if (p.questionId !== null) this.#consume(p.questionId)
      // The stored status is busy, and a message shown, before the caller hears back.
      this.#trySettle("after a reply")
      if (op === "send") this.#publishMessage(run.runId, reply.seq as number, p.delivery.event)
      p.resolve(p.acked)
    } else if (typeof reply.refused === "string") {
      // The reason only: a delivery never names the message's text.
      this.#log(`session ${this.sessionId}: a ${op} was refused (${reply.refused})`)
      if (reply.refused !== "not_started") p.reject(refusalOf(reply.refused))
    } else {
      const failed = reply.failed as string
      this.#log(`session ${this.sessionId}: a ${op} failed (${failed})`)
      if (run.nodeEvent) p.reject(this.#cantWake(failed))
    }
  }

  /** Publishes the user message of the `send` the run took at `seq`, as the transcript will show it. `sent` is the
   *  message `prompt` built. */
  #publishMessage(runId: string, seq: number, sent: unknown): void {
    const message = userMessage(this.sessionId, runId, { seq, at: now(), message: sent as RunMessage })
    try {
      this.#ctx.bus.publishLive({ type: "message.updated", session_id: this.sessionId, data: message })
    } catch (error) {
      this.#log(`session ${this.sessionId}: a message can't be shown (${errorName(error)})`)
    }
  }

  /** A `result` or `error`: a waiting run's waits become the actor's. Acted on at the worker's exit. */
  #result(run: WorkerRun, frame: Frame): void {
    if (run !== this.#run) return
    if (frame.type === "result" && frame.status === "waiting") this.#waits = waitsOf(frame)
    run.turnPending = false
    this.#trySettle("after a result")
  }

  /**
   * The worker is gone. After a `waiting` result, the deliveries it never answered (but an `interrupt`) and those
   * it refused `not_started` are carried into the next worker, which is spawned when there are any, when `#next`
   * holds some, or when a delivery came after the result; every other delivery it was given is answered.
   */
  async #exited(run: WorkerRun, returncode: number | null): Promise<void> {
    if (run !== this.#run) return
    this.#run = null
    // Read and cleared first: an outcome that spawns nothing leaves no re-advance behind.
    const readvance = this.#readvance
    this.#readvance = false
    const session = this.#ctx.store.getSession(this.sessionId)
    if (session !== undefined) void this.#ctx.hooks.notify("workerExited", session, returncode)
    this.#interruptWorkspace()
    this.#answerCalls()
    const outcome = run.outcome
    if (outcome?.type === "result" && outcome.status === "waiting") {
      const carry = run.given.filter(
        (p) => !p.done && (p.reply === null ? p.delivery.op !== "interrupt" : p.reply.refused === "not_started"),
      )
      this.#answerRest(
        run.given.filter((p) => !carry.includes(p)),
        this.#cantWake(),
      )
      this.#next = [...carry, ...this.#next]
      if (readvance || this.#next.length > 0) await this.#spawnQuietly("advance")
    } else {
      const status = outcome === null ? "no outcome" : outcome.type === "result" ? String(outcome.status) : "error"
      this.#log(`session ${this.sessionId}: its worker exited (${status})`)
      this.#answerRest([...run.given, ...this.#next.splice(0)], this.#cantWake())
    }
    this.#trySettle("after a worker exit")
  }

  /**
   * The closing rule: answers each of `pendings` that has no answer yet and isn't carried. A held `not_started` or
   * failure is `503 cant_wake`; a lost `interrupt` or `cancel`, or a dropped `complete` of a card's answer (its
   * question stays answered), is resolved; any other delivery with no reply, a message's `complete` included, gets
   * `fallback`.
   */
  #answerRest(pendings: readonly Pending[], fallback: HarnessError): void {
    for (const p of pendings) {
      if (p.done) continue
      const reply = p.reply
      const op = p.delivery.op
      if (reply === null) {
        if (op === "interrupt" || op === "cancel" || (op === "complete" && p.fallback === null)) p.resolve(undefined)
        else p.reject(fallback)
      } else if (Object.hasOwn(reply, "seq")) {
        p.resolve(p.acked)
      } else if (typeof reply.failed === "string") {
        p.reject(this.#cantWake(reply.failed))
      } else {
        p.reject(reply.refused === "not_started" ? this.#cantWake() : refusalOf(reply.refused as string))
      }
    }
  }

  // --- the session --------------------------------------------------------------------------

  /** The stored session; throws `HarnessError` (`404`) when it is gone. */
  #session(): SessionRecord {
    const session = this.#ctx.store.getSession(this.sessionId)
    if (session === undefined) throw new HarnessError(404, "not_found", `no session ${this.sessionId}`)
    return session
  }

  /** The stored session, refused for a command: `503 stopping` after `close`, `409 not_live` once it finished (or
   *  has no run), `409 ending` once End was asked. */
  #live(): SessionRecord {
    if (this.#closed) throw stopping()
    const session = this.#session()
    if (this.#finished || !LIVE.includes(session.status) || this.#runId === null) {
      throw new HarnessError(409, "not_live", `session ${this.sessionId} has no live run`)
    }
    if (this.#ending || session.status === "ending") {
      throw new HarnessError(409, "ending", `session ${this.sessionId} is ending`)
    }
    return session
  }

  /** The run spec, built once per actor. */
  async #specOf(session: SessionRecord): Promise<RunSpec> {
    this.#spec ??= await this.#ctx.spec(session)
    return this.#spec
  }

  /** The conversation shape of the session's flow. */
  get #chat(): ChatFlow {
    return this.#spec?.chat ?? MAIN_CHAT
  }

  /** The pinned facts, read once per actor. */
  async #pinsOf(session: SessionRecord): Promise<Pins> {
    if (this.#pins === null) {
      const repo = loadRepo(await this.#ctx.git.pin(session.repo_commit))
      const ceo = repo.company?.ceo ?? null
      this.#pins = {
        defaults: repo.company?.defaults ?? CompanyDefaults.parse({}),
        ceo,
        manager: repo.people.get(session.person)?.manager ?? ceo,
      }
    }
    return this.#pins
  }

  /** Who answers for the person: the session's opener, else the pinned CEO. */
  async #owner(session: SessionRecord): Promise<string | null> {
    return session.opened_by ?? (await this.#pinsOf(session)).ceo
  }

  /** Fails a session whose first run couldn't start; `runId`, when stored, ends `COULDNT_START`. */
  #failStart(runId: string | null): void {
    const { store } = this.#ctx
    this.#finished = true
    const session = store.transaction(() => {
      const failed = store.updateSession(this.sessionId, notWaiting("failed"))
      if (runId !== null) store.endRun(runId, COULDNT_START)
      return failed
    })
    void this.#ctx.hooks.notify("sessionEnded", session)
  }

  /** Interrupts the workspace's calls in flight: nobody is left to read what they return. */
  #interruptWorkspace(): void {
    try {
      this.#spec?.workspace?.interrupt()
    } catch (error) {
      this.#log(`session ${this.sessionId}: the workspace can't be interrupted (${errorName(error)})`)
    }
  }

  /** `settle`, logging a failure by its type, where the step around it must go on. */
  #trySettle(when: string): void {
    try {
      this.settle()
    } catch (error) {
      this.#log(`session ${this.sessionId}: no state ${when} (${errorName(error)})`)
    }
  }

  /** The error a delivery's caller gets when its spawn failed with `error`. */
  #wakeError(error: unknown): HarnessError {
    if (error instanceof HarnessError) return error
    if (error instanceof RegistryClosed) return stopping()
    // A provider error never echoes the file; anything else may hold anything, so it stays in the log.
    const why = error instanceof ProviderError ? `: ${error.message}` : "; see the office log"
    return new HarnessError(503, "cant_wake", `session ${this.sessionId} can't wake${why}`)
  }

  /** `503 cant_wake`, naming the error type the run failed with, if any. */
  #cantWake(type?: string): HarnessError {
    const why = type === undefined ? "; see the office log" : ` (${type})`
    return new HarnessError(503, "cant_wake", `session ${this.sessionId} can't take it now${why}`)
  }

  #log(line: string): void {
    try {
      this.#ctx.log(line)
    } catch {}
  }
}

/** The calls a `result` frame says its run waits on. */
function waitsOf(frame: Frame): Wait[] {
  return Array.isArray(frame.waits) ? (frame.waits as Wait[]) : []
}

/** The error a refused message gets: `409 ending` once the inbox closed or the run ended, `422 too_large`, or
 *  `422 refused` naming the reason. */
function refusalOf(reason: string): HarnessError {
  if (reason === "inbox_closed" || reason === "ended") return new HarnessError(409, "ending", "the session is ending")
  if (reason === "too_large") return tooLarge()
  return new HarnessError(422, "refused", `the run refused it (${reason})`)
}

function tooLarge(): HarnessError {
  return new HarnessError(422, "too_large", "the message is too large")
}

function stopping(): HarnessError {
  return new HarnessError(503, "stopping", "the office is stopping")
}

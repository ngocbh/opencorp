/** One live chat session: a serial queue that drives the session's yian run through one worker process per run
 *  call, the way `yian chat` does (deliver, then `advance`, again while the run waits). */
import fs from "node:fs"
import path from "node:path"
import { type Scheduler, SLEEP_CHUNK_MS } from "@ngocbh/yian/platform"
import type { Message as RunMessage } from "@ngocbh/yian/run"
import { CompanyDefaults, now, OFFICE, WorkItem } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import { loadRepo } from "../company/loader.ts"
import type { Bus } from "../daemon/bus.ts"
import type { OfficePaths } from "../daemon/office.ts"
import type { Env } from "../install/launch.ts"
import { redact } from "../perm/redact.ts"
import { type Answers, makeAskUser, type OnQuestion } from "../questions/ask.ts"
import type { AnswerKind } from "../questions/cards.ts"
import { formatAnswer } from "../questions/format.ts"
import {
  COULDNT_RESUME,
  COULDNT_START,
  ENDED_OVER_CAP,
  flowLabel,
  NEW_MODEL,
  OFFICE as OFFICE_DRIVER,
  WORKER_STOPPED,
} from "../runs/outcomes.ts"
import {
  InvalidTransition,
  newId,
  type QuestionRecord,
  type SessionRecord,
  type Store,
  type WorkItemRecord,
} from "../store/store.ts"
import { type Frame, FrameTooLarge } from "../worker/channel.ts"
import type { Delivery, Job, Seed } from "../worker/job.ts"
import { type AskRequest, BaseHandlers, errorName, type OfficeTool, type WorkerHandlers } from "../worker/rpc.ts"
import { RegistryClosed, type Worker, workerEnv } from "../worker/spawn.ts"
import { type Connections, runRecord } from "./connections.ts"
import { type CallUsage, callUsd, costCap, DEFAULT_PRICE, ZERO_PRICE } from "./cost.ts"
import type { Hooks } from "./hooks.ts"
import { type Price, type Provider, ProviderError } from "./provider.ts"
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

/** How the work item that asks to raise a session's cost cap is titled. */
const CAP_TITLE = "Raise the cost cap"

/** What the actor uses of a worker; `Worker` fits. */
export type ActorWorker = Pick<Worker, "job" | "pid" | "deliver" | "stop">

/** What an office tool call answers when Esc, the worker's exit or the office stop cuts it before it returns. */
export const INTERRUPTED_CALL = "interrupted; outcome unknown"

/** What a message became: the turn the run waits for, an answer to the model's open question, a steer of the running
 *  reply, or queued for a later turn. */
export type MessageReply = "turn" | "answer" | "steer" | "queued"

/** A call a waiting run waits on, as a `result` frame lists it. */
export interface Wait {
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
  /** Its job's kind. */
  readonly kind: "chat" | "advance"
  worker: ActorWorker | null = null
  /** The provider it was spawned with, whose key no hook or reason may show. */
  provider: Provider | null = null
  /** The price of a model call `provider` doesn't list. */
  defaultPrice: Price = DEFAULT_PRICE
  /** Whether the cost cap stopped it. */
  capStopped = false
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
  /** The deadline the wake-at timer spawned it for, if it did. */
  wakeAt: string | null = null
  /** The seed its `chat` job starts from, which a retry of the job reuses. */
  seed: Seed | null = null

  /** A `kind` worker of run `runId` given `given`, over a run that waits at `waits`; `sent` says a message reached
   *  the run since its turn last waited. */
  constructor(runId: string, kind: "chat" | "advance", given: Pending[], waits: readonly Wait[], sent: boolean) {
    this.runId = runId
    this.kind = kind
    this.given = given
    for (const wait of waits) this.waiting.set(wait.node, [...(this.waiting.get(wait.node) ?? []), wait.call_id])
    this.turnPending = sent || given.some((p) => p.delivery.op === "send")
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
  /** Whether the run needs an `advance` that the cost cap held back (a job over the cap only delivers). */
  #needsAdvance = false
  /** Whether a worker accepted a message after its `result`, or in a job that only delivers: the next worker's take
   *  will read it. */
  #lateSend = false
  /** The waits the last spawn started from when it was a plain re-advance for a settled wait, else null. */
  #readvancedFrom: Wait[] | null = null
  /** Whether a worker found the run held by another process (`RunBusyError`) and its one retry is under way. */
  #busyRetried = false
  /** Whether the last worker's run, busy workers aside, came back `waiting`: the timer then waits on `#waits`. */
  #rested = false
  /** The wake-at timer's sleep, aborted at finish, close, a new result or a spawn. */
  #timer: AbortController | null = null
  /** The deadline the timer last advanced the run at, which it never arms for again. */
  #spent: string | null = null
  #finished = false
  #closed = false
  #ending = false
  /** Workers that exited with no outcome, or with a `stopped` or `crashed` run, since the last `waiting` or
   *  `succeeded` result. */
  #deaths = 0
  /** The runs whose hard stop waits for the lingering worker's exit. */
  #stopAfterExit: string[] = []
  /** The runs fresh runs replaced, whose open questions go stale once a fresh worker's run starts. */
  #replaced: string[] = []
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
   * fails the session (its stored run ends `COULDNT_START`) and throws: a `HarnessError` as it is (the run spec
   * couldn't be built), else `500 start_failed`.
   */
  start(): Promise<void> {
    return this.#command(async () => {
      const sid = this.sessionId
      if (this.#runId !== null) throw new HarnessError(409, "live", `session ${sid} already has a run`)
      const runId = newId()
      try {
        const session = this.#session()
        // Built first, so a spec that can't be built records no run.
        const spec = await this.#specOf(session)
        const owner = await this.#owner(session)
        this.#ctx.store.transaction(() => this.#addRun(session, spec, owner, runId, null, now()))
        this.#runId = runId
        await this.#spawn("chat")
      } catch (error) {
        this.#log(`session ${sid} can't start (${errorName(error)})`)
        // The office stops: the session stays as it was, for the next office to start.
        if (error instanceof RegistryClosed || this.#closed) throw stopping()
        // A run stored ends `COULDNT_START`; with none, only the session fails.
        this.#finish("failed", null, COULDNT_START)
        if (error instanceof HarnessError) throw error
        // A provider error never echoes the file; anything else may hold anything, so it stays in the log.
        const why = error instanceof ProviderError ? `: ${error.message}` : "; see the office log"
        throw new HarnessError(500, "start_failed", `session ${sid} failed to start${why}`)
      }
    })
  }

  /**
   * Takes a message from `by` (the owner when null) and resolves once the run has it. The flow's exit command
   * (`/exit`) is End, and gets `turn`.
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
      if (text === (await this.#specOf(session)).chat.exit) {
        await this.#end(session)
        return null
      }
      const { delivery, reply } = await this.#message(session, text, by)
      return (await this.#answerAsked(session, text, by, delivery)) ?? (await this.#send(delivery, reply))
    })
    if (pending === null) return "turn"
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
    if (!this.#replying()) {
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
   * End: the session is `ending` at once, and its run gets an `interrupt` (while a reply runs or the agent waits on
   * a model question) and a `close` of its inbox, whose turn then reads it closed, so the run succeeds and the
   * session ends. Resolves once they are queued; a second End does nothing. A spawn for them that fails fails the
   * session, and End throws its error. Over the cost cap a waiting run is ended the same way; a reply that runs is
   * stopped, and a run stopped, crashed or unknown is cancelled, ending the session `ENDED_OVER_CAP`. Refused with
   * `404 not_found` (the session row is gone), `409 not_live` or `503 stopping`.
   */
  end(): Promise<void> {
    return this.#command(async () => {
      const session = this.#session()
      if (this.#finished || !LIVE.includes(session.status) || this.#runId === null) {
        throw new HarnessError(409, "not_live", `session ${this.sessionId} has no live run`)
      }
      if (!this.#ending) await this.#end(session)
    })
  }

  /** Marks the session ending and queues its run's `interrupt` and `close`, spawning for them when no worker runs. */
  async #end(session: SessionRecord): Promise<void> {
    this.#ending = true
    this.#ctx.store.updateSession(this.sessionId, notWaiting("ending"))
    const inbox = (await this.#specOf(session)).chat.inbox
    const run = this.#run
    const capped = this.#capped()
    const rests = this.#rested && !(this.#waits ?? []).some((wait) => wait.settled)
    if (capped && run === null && !rests) {
      // The reply was stopped at the cap, crashed or is unknown, or a settled call would wake the agent: an advance
      // would spend, so the run is cancelled and the session ends.
      this.#finish("ended", null, ENDED_OVER_CAP)
      return
    }
    const ops: Delivery[] = [{ id: newId(), op: "close", inbox }]
    if (this.#replying() || this.#agentWaits()) ops.unshift({ id: newId(), op: "interrupt", inbox })
    let spawn = false
    for (const op of ops) spawn = (await this.#give(new Pending(op))) || spawn
    // A reply running over the cap stops; its exit ends the session, as a stopped reply's does.
    if (capped && run !== null) this.#stopAtCap(run)
    if (!spawn) return
    try {
      // While ending, a waiting run gets a real advance even over the cap: its take reads the inbox closed, so no
      // model call happens.
      await this.#spawn("advance")
    } catch (error) {
      if (error instanceof RegistryClosed || this.#closed) throw stopping()
      this.#log(`session ${this.sessionId} can't end (${errorName(error)})`)
      // Left open it could never be ended.
      this.#finish("failed", null, this.#cantStartWhy())
      throw this.#wakeError(error)
    }
  }

  /** Fails the session: its run, when the run hasn't ended, ends `COULDNT_RESUME` and gets a hard stop. Refused
   *  `404 not_found` (the session row is gone) or `503 stopping` after `close`. */
  fail(): Promise<void> {
    return this.#command(async () => this.#finish("failed", null, COULDNT_RESUME))
  }

  /**
   * Sets the session's cost cap to `usd`, closes its "raise the cost cap" item and returns the stored session. With
   * no worker, an `advance` the cap held back starts now: when one was needed, deliveries wait, a settled call waits,
   * or the run's waits are unknown (with a worker, its exit decides). A spawn or settle that fails is logged, and the
   * raise stands. Refused with `422 cap_too_low` (not above the cost so far), `404 not_found` or `503 stopping`.
   */
  setCostCap(usd: number): Promise<SessionRecord> {
    return this.#command(async () => {
      const { store } = this.#ctx
      const session = this.#session()
      if (usd <= session.cost) {
        const why = `the cap must be above the cost so far ($${session.cost.toFixed(4)})`
        throw new HarnessError(422, "cap_too_low", why)
      }
      const item = this.#capItem(session)
      store.updateSession(this.sessionId, { cost_cap_usd: usd })
      if (item !== undefined) store.updateWorkItem(item.id, { status: "done" })
      const waits = this.#waits
      const held =
        this.#needsAdvance || this.#next.length > 0 || waits === null || waits.some((wait) => wait.settled)
      if (held && !this.hasWorker && !this.#finished && this.#runId !== null && LIVE.includes(session.status)) {
        try {
          await this.#spawn("advance")
        } catch (error) {
          // Its deliveries' callers have their answer; the session waits for the next message.
          this.#log(`session ${this.sessionId}: a worker can't start after its cap was raised (${errorName(error)})`)
        }
      }
      this.#trySettle("after its cap was raised")
      return this.#session()
    })
  }

  /** Acts on the cost cap, as a charge does: over it, the running reply is stopped, the manager gets an item to raise
   *  it and the session settles; under it (a check that comes after a raise), nothing happens. */
  checkCap(): Promise<void> {
    return this.#command(async () => this.#overCap())
  }

  /**
   * Writes the session's run state from what its run waits in: waiting while a question is open on its current run
   * (on the `ask_manager` item's assignee, else on the owner), or while its cost is at or over its cap (on the open
   * cap item's assignee, else the pinned manager); else busy while a worker is being spawned or is sure
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
      const held = session.cost >= costCap(session, this.#pins.defaults)
      if (held) who.push(this.#capItem(session)?.assignee ?? this.#pins.manager)
      const run = this.#run
      const spawning = this.#starting !== null || this.#readvance || this.#next.some((p) => p.delivery.op === "send")
      const running = spawning || (run !== null && run.outcome === null && !this.#runAtTurn(run))
      writeState(store, this.sessionId, runState({ waiting: asks.length > 0 || held, running }), who, { capped: held })
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
    this.#disarm()
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
    if (!(await this.#give(p))) return
    try {
      await this.#spawn("advance")
    } catch (error) {
      // Its callers have their answer; the actor stays as it was.
      this.#log(`session ${this.sessionId}: a worker can't start (${errorName(error)})`)
    }
  }

  /** Sends `p` to the worker while it hasn't sent its `result`, else adds it to `#next`; true when that leaves
   *  `#next` for a spawn now (no worker runs). */
  async #give(p: Pending): Promise<boolean> {
    // The office stopped while the command waited: no worker may start for it.
    if (this.#closed) {
      p.reject(stopping())
      return false
    }
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
        return false
      }
      // A reply means the worker took it, though the channel closed before the frame's write reported back.
      if (sent || p.reply !== null) {
        if (p.delivery.op === "send") run.turnPending = true
        return false
      }
      // The worker read its last frame meanwhile; its exit decides the next spawn.
      run.given.splice(run.given.indexOf(p), 1)
      // The office stopped meanwhile and `close` answered it: it stays out of the next job.
      if (this.#closed) return false
    }
    this.#next.push(p)
    return this.#run === null
  }

  /** The decided reply of a message queued now: `queued` over the cost cap, where no turn runs until a raise. */
  #replyNow(session: SessionRecord): MessageReply {
    if (this.#capped()) return "queued"
    if (this.#replying()) return "steer"
    return this.#atTurn(session) ? "turn" : "queued"
  }

  /** Whether a reply node runs in the current worker. */
  #replying(): boolean {
    const run = this.#run
    return run !== null && run.outcome === null && [...run.inFlight].some((node) => this.#chat.isReply(node))
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
   * Spawns the session's next worker, a `kind` job whose deliveries are `#next`. The connection and model are
   * checked first, before anything is written (a removed connection moves the session to the default). An `advance`
   * whose run's record no longer gives what the run ran on is a fresh run instead (`#recordCheck`), as is any
   * spawn given a `replace` reason, carrying what `#freshCarry` keeps; otherwise an `advance` job starts with a
   * `complete` for each stored answer that never reached the run. A `chat` job records what its run starts on, and
   * starts from `seed` (a retry's) unless it is a fresh run's. On failure, the job's deliveries are answered with the
   * error (`#wakeError`) and dropped, and the error is thrown. `plain` marks a re-advance only for a settled wait.
   * Over the cost cap, unless ending, an `advance` only delivers (`advance: false`, no record check), and none
   * starts without deliveries; the advance waits for a raise (`#needsAdvance`). Whether a worker started.
   */
  async #spawn(
    kind: "chat" | "advance",
    {
      plain = false,
      replace = null,
      seed = null,
    }: { plain?: boolean; replace?: string | null; seed?: Seed | null } = {},
  ): Promise<boolean> {
    const { store, paths } = this.#ctx
    const sid = this.sessionId
    // A job over the cap never calls the model, so no endpoint is replayed: no record check.
    const advance = kind === "chat" || this.#ending || !this.#capped()
    if (!advance) {
      this.#needsAdvance = true
      if (this.#next.length === 0) return false
    }
    let pendings = this.#next
    this.#next = []
    // This spawn is the re-advance; one that fails leaves nothing to wait for.
    this.#readvance = false
    this.#readvancedFrom = plain ? this.#waits : null
    const waits = kind === "advance" ? (this.#waits ?? []) : []
    let run = new WorkerRun(this.#runId!, kind, pendings, waits, this.#lateSend)
    this.#starting = run
    try {
      if (this.#closed) throw stopping()
      const { session, name, model, provider } = await this.#checkProvider()
      const spec = await this.#specOf(session)
      const checked = kind === "advance" && advance
      const why = replace ?? (checked ? this.#recordCheck(run.runId, name, model, provider) : null)
      if (why !== null) {
        seed = await this.#seed(session)
        await this.#replace(session, spec, why)
        pendings = this.#freshCarry(pendings)
        // Its deliveries, which `close` answers through `#starting`.
        run = new WorkerRun(this.#runId!, "chat", pendings, [], this.#lateSend)
        this.#starting = run
        // A fresh run of an ending session must close too: a close the old run took stays in the old run's log.
        if (this.#ending && !pendings.some((p) => p.delivery.op === "close")) {
          pendings.push(new Pending({ id: newId(), op: "close", inbox: spec.chat.inbox }))
        }
      } else if (kind === "advance") {
        pendings.unshift(...this.#storedAnswers(pendings))
      }
      const runId = run.runId
      // Read now, so every settle while the worker runs has the owner.
      await this.#pinsOf(session)
      const onQuestion = this.#onQuestion
      const tools = spec.groups({ session, runId, onQuestion })
      const ask = makeAskUser(session, runId, onQuestion, {
        names: spec.names,
        carried: (question) => this.#ctx.answers.carried(question),
      })
      const job = chatJob(spec, tools, {
        kind: run.kind,
        session,
        runId,
        pin: await this.#ctx.git.pin(session.repo_commit),
        log: this.#logOf(runId),
        llmConfig: provider.llm_config,
        turns: session.turns,
        seed,
        deliver: pendings.map((p) => p.delivery),
        advance,
      })
      if (run.kind === "chat") store.setRunConfig(runId, runRecord(name, model, provider))
      const defaultPrice = await this.#defaultPrice(name)
      const handlers = this.#handlers(run, ask, tools, spec.stores)
      // The office may have stopped during the awaits above.
      if (this.#closed) throw stopping()
      run.provider = provider
      run.defaultPrice = defaultPrice
      run.seed = seed
      run.worker = await this.#ctx.workers.spawn(job, paths.sessionDir(sid), handlers, { env: provider.env })
      // Only now: a spawn that fails leaves it for the next worker's take.
      this.#lateSend = false
      if (advance) this.#needsAdvance = false
      this.#run = run
      this.#starting = null
      // The worker's result arms it again.
      this.#disarm()
      void this.#ctx.hooks.notify("runStarted", session, runId)
      // Busy before any caller hears back: the run isn't at its turn until it shows it.
      if (!this.#closed) this.#trySettle("after a spawn")
      return true
    } catch (error) {
      const refusal = this.#wakeError(error)
      for (const p of pendings) p.reject(refusal)
      throw error
    } finally {
      if (this.#starting === run) this.#starting = null
    }
  }

  /** The price of a model call connection `name`'s file doesn't list: none for a subscription, which already pays
   *  for its calls. */
  async #defaultPrice(name: string): Promise<Price> {
    try {
      return (await this.#ctx.connections.get(name)).method === "subscription" ? ZERO_PRICE : DEFAULT_PRICE
    } catch (error) {
      // Removed or broken since it resolved: the run still has what it resolved.
      if (!(error instanceof ProviderError)) throw error
      return DEFAULT_PRICE
    }
  }

  /** The session, and the connection, model and provider its next run uses; a session whose connection was
   *  removed is moved to the default's own model once that resolves. Throws when they can't be resolved, having
   *  written nothing. */
  async #checkProvider(): Promise<{ session: SessionRecord; name: string; model: string | null; provider: Provider }> {
    const { store, connections } = this.#ctx
    let session = this.#session()
    const [name, model, moved] = await connections.choice(session.connection, session.model)
    const provider = await connections.resolve(name, model)
    if (moved) session = store.updateSession(this.sessionId, { connection: name, model })
    return { session, name, model, provider }
  }

  /**
   * Why run `runId` can't be advanced on connection `name` and `model`, which give `provider`, so that a fresh run
   * replaces it: `COULDNT_START` when it never started (its row has no config, or it has no log), `NEW_MODEL` when it
   * ran on another connection or model, or `provider` isn't the endpoint, key or config it had (an advance would
   * replay them with whatever it is given); null when it can be advanced.
   */
  #recordCheck(runId: string, name: string, model: string | null, provider: Provider): string | null {
    const row = this.#ctx.store.getRun(runId)
    if (row === undefined || row.configSha256 === null || !fs.existsSync(this.#logOf(runId))) return COULDNT_START
    if ((row.connection ?? OFFICE) !== name || row.model !== model) return NEW_MODEL
    // The provider in hand, not a second read: that is what the advance would be given.
    if (runRecord(name, model, provider).configSha256 !== row.configSha256) return NEW_MODEL
    return null
  }

  /** What a fresh run of `session` takes its history from: the newest of its runs that has a log, read with the
   *  office's allowed environment and that run's connection's (none when it can't be resolved now), and cancelled
   *  if it hasn't finished; null when no run has a log. */
  async #seed(session: SessionRecord): Promise<Seed | null> {
    const runId = session.run_ids.findLast((id) => fs.existsSync(this.#logOf(id)))
    if (runId === undefined) return null
    const row = this.#ctx.store.getRun(runId)
    let env: Record<string, string> = {}
    try {
      env = (await this.#ctx.connections.resolve(row?.connection ?? null, row?.model ?? null)).env
    } catch (error) {
      this.#log(`session ${this.sessionId}: its fresh run's seed has no connection env (${errorName(error)})`)
    }
    return { log: this.#logOf(runId), env: { ...workerEnv(this.#ctx.environ), ...env }, cancel: true }
  }

  /** Ends the current run with `why` and makes a new run of `session` (built from `spec`) its replacement, in one
   *  transaction; then notifies `runFinished` for the old run. The old run's open questions go stale once the fresh
   *  run starts. Throws `503 stopping` when the office stopped meanwhile, having written nothing. */
  async #replace(session: SessionRecord, spec: RunSpec, why: string): Promise<void> {
    const { store, hooks } = this.#ctx
    const old = this.#runId!
    const owner = await this.#owner(session)
    // The office may have stopped during the awaits before: no run may be created for it.
    if (this.#closed) throw stopping()
    const runId = newId()
    const at = now()
    store.transaction(() => {
      // The old run's end is the new run's launch: that is how a run page knows one replaced the other.
      store.endRun(old, why, at)
      this.#addRun(session, spec, owner, runId, old, at)
    })
    this.#log(`session ${this.sessionId} starts a fresh run (${why})`)
    this.#runId = runId
    this.#replaced.push(old)
    // What the old run waited on, and its deadlines, say nothing about the new one.
    this.#waits = null
    this.#readvancedFrom = null
    this.#disarm()
    void hooks.notify("runFinished", this.#session(), old, null)
  }

  /** Adds run `runId` of `session` (built from `spec`), launched `at`, to the session and stores its row, which
   *  replaces run `old` if given and keeps its driver and flow; else the driver is `owner` (`office` without one)
   *  and the flow the session kind's. Called inside a transaction. */
  #addRun(
    session: SessionRecord,
    spec: RunSpec,
    owner: string | null,
    runId: string,
    old: string | null,
    at: string,
  ): void {
    const { store } = this.#ctx
    const row = old === null ? undefined : store.getRun(old)
    store.addSessionRun(this.sessionId, runId)
    store.addRun({
      runId,
      sessionId: this.sessionId,
      driver: row?.driver ?? owner ?? OFFICE_DRIVER,
      flow: row?.flow ?? flowLabel(session.kind),
      flowPath: path.posix.normalize(spec.flow),
      connection: null,
      model: null,
      configSha256: null,
      replacesRunId: old,
      createdAt: at,
    })
  }

  /** What a fresh run carries of `pendings`, none of which its old run applied: the `send`s and `close`s, and a
   *  message's `complete` as the `send` it falls back on, which answers the complete's caller (the fresh run never
   *  asked the question). The rest (a card's `complete`, an `interrupt`, a `cancel`) is answered by the closing
   *  rule. */
  #freshCarry(pendings: readonly Pending[]): Pending[] {
    const carry: Pending[] = []
    for (const p of pendings) {
      const op = p.delivery.op
      if (op === "send" || op === "close") {
        carry.push(p)
      } else if (op === "complete" && p.fallback !== null) {
        const sent = new Pending(p.fallback, "queued")
        sent.answer.then(
          (value) => p.resolve(value),
          (error) => p.reject(error),
        )
        carry.push(sent)
      } else {
        this.#answerRest([p], this.#cantWake())
      }
    }
    return carry
  }

  /** Marks the open questions of the runs fresh runs replaced stale: the fresh worker cancelled those runs before
   *  its own started. */
  #staleReplaced(): void {
    const { store } = this.#ctx
    for (const runId of this.#replaced.splice(0)) {
      for (const question of store.listQuestions({ runId, status: "open" })) {
        try {
          store.setQuestionStatus(question.id, "stale")
        } catch (error) {
          // Answered or closed meanwhile: it is no longer open either way.
          if (!(error instanceof InvalidTransition)) {
            this.#log(`session ${this.sessionId}: a replaced run's question can't go stale (${errorName(error)})`)
          }
        }
      }
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

  /** `#spawn` for a step no command waits on (a worker's exit, the timer), logging its failure, which it already
   *  answered; an ending session whose spawn fails then fails (`#cantStartWhy`): left open it could never be ended.
   *  Whether a worker started. */
  async #spawnQuietly(
    kind: "chat" | "advance",
    options: { plain?: boolean; replace?: string; seed?: Seed | null } = {},
  ): Promise<boolean> {
    try {
      return await this.#spawn(kind, options)
    } catch (error) {
      this.#log(`session ${this.sessionId}: a worker can't start (${errorName(error)})`)
      if (this.#ending && !(error instanceof RegistryClosed) && !this.#closed) {
        this.#finish("failed", null, this.#cantStartWhy())
      }
      return false
    }
  }

  /** Why a session whose worker can't start fails: its run `COULDNT_START` when it has no log (a fresh run that
   *  never started), else `COULDNT_RESUME`. */
  #cantStartWhy(): string {
    return this.#runId !== null && fs.existsSync(this.#logOf(this.#runId)) ? COULDNT_RESUME : COULDNT_START
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
    if (run !== this.#run || this.#finished) return
    const data = (typeof frame.data === "object" && frame.data !== null ? frame.data : {}) as Record<string, unknown>
    const node = typeof data.node_id === "string" ? data.node_id : null
    switch (frame.name) {
      case "RunStarted":
        this.#staleReplaced()
        this.#trySettle("after a run started")
        return
      case "ModelCallFinished":
        if (typeof data.usage === "object" && data.usage !== null) this.#charge(run, data)
        return
      case "history_not_seeded":
        this.#log(`session ${this.sessionId}: its fresh run starts without history (${typeName(data.error_type)})`)
        return
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

  /** Records the price of `run`'s model call (`data`, a `ModelCallFinished` with usage) and the session's cost, then
   *  acts on the cap. */
  #charge(run: WorkerRun, data: Record<string, unknown>): void {
    const { store } = this.#ctx
    const model = typeof data.model === "string" ? data.model : null
    const usd = callUsd(run.provider?.prices ?? {}, model, data.usage as CallUsage, { default: run.defaultPrice })
    store.recordUsage({ sessionId: this.sessionId, runId: run.runId, model: model ?? "", usd })
    store.updateSession(this.sessionId, { cost: store.sessionUsageUsd(this.sessionId) })
    this.#overCap()
  }

  /** Over the cost cap: the running reply is stopped, the person's manager gets one item to raise the cap, and the
   *  session settles (waiting on that item's assignee). Under it, or once finished, nothing happens. */
  #overCap(): void {
    if (this.#finished || !this.#capped()) return
    const { store } = this.#ctx
    if (this.#run !== null) this.#stopAtCap(this.#run)
    const session = this.#session()
    // Else the manager already has one to act on.
    if (this.#capItem(session) === undefined) {
      const cap = costCap(session, this.#pins!.defaults)
      const t = now()
      store.createWorkItem(
        WorkItem.parse({
          id: newId(),
          title: `${CAP_TITLE} of @${session.person}'s session`,
          kind: "task",
          status: "open",
          requester: session.person,
          assignee: this.#pins!.manager,
          parent_id: session.work_item_id,
          summary:
            `Session ${session.id} reached its $${cap.toFixed(2)} cap (cost $${session.cost.toFixed(4)}). ` +
            "Its turns wait until the cap is raised.",
          created_at: t,
          updated_at: t,
        }),
      )
    }
    this.#trySettle("at its cap")
  }

  /** Stops `run`'s worker, once, while it runs an advance that may call the model: an interrupt would only cut the
   *  reply, and the run would go on to its next turn. */
  #stopAtCap(run: WorkerRun): void {
    const worker = run.worker
    if (worker === null || run.outcome !== null || run.capStopped || !worker.job.advance) return
    run.capStopped = true
    worker.stop().catch((error) => this.#log(`session ${this.sessionId}: a stop can't be sent (${errorName(error)})`))
  }

  /** The session's open "raise the cost cap" work item, if any. */
  #capItem(session: SessionRecord): WorkItemRecord | undefined {
    // The summary names the session, so sessions with no work item don't share one.
    const mine = `Session ${session.id} `
    return this.#ctx.store
      .listWorkItems({ status: ["open", "in_progress"] })
      .find(
        (item) =>
          item.parent_id === session.work_item_id &&
          item.title.startsWith(CAP_TITLE) &&
          (item.summary ?? "").startsWith(mine),
      )
  }

  /** Whether the session's cost is at or over its cap, as stored now. */
  #capped(): boolean {
    const session = this.#ctx.store.getSession(this.sessionId)
    return this.#pins !== null && session !== undefined && session.cost >= costCap(session, this.#pins.defaults)
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
      // A job that only delivers leaves the message for the next advance's take too.
      if (op === "send" && (p.late || run.worker?.job.advance === false)) this.#lateSend = true
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
    if (run !== this.#run || this.#finished) return
    this.#disarm()
    if (frame.type === "result" && frame.status === "waiting") this.#waits = waitsOf(frame)
    run.turnPending = false
    this.#trySettle("after a result")
  }

  /**
   * The worker is gone; its outcome decides what comes next. After a `waiting` result, see `#waited`. A succeeded
   * run ends the session; a worker gone with no outcome, or a `stopped` or `crashed` run, is replaced once
   * (`#died`), but over the cost cap a stopped or crashed run only gets its deliveries, and an ending session over
   * it ends `ENDED_OVER_CAP`; a run another process holds is tried once more (`#runBusy`); any other outcome fails
   * the session.
   * Every delivery not carried is answered. A finished actor only starts its run's hard stop that waited for this
   * exit.
   */
  async #exited(run: WorkerRun, returncode: number | null): Promise<void> {
    if (run !== this.#run) return
    this.#run = null
    const session = this.#ctx.store.getSession(this.sessionId)
    if (session !== undefined) void this.#ctx.hooks.notify("workerExited", session, returncode)
    // Nobody is left to read what these calls return, finished or not.
    this.#interruptWorkspace()
    this.#answerCalls()
    if (this.#finished) {
      if (this.#stopAfterExit.length > 0) void this.#stopJobs(this.#stopAfterExit.splice(0))
      return
    }
    // Read and cleared first: an outcome that spawns nothing leaves no re-advance behind.
    const readvance = this.#readvance
    this.#readvance = false
    const outcome = run.outcome
    let status = outcome === null ? null : outcome.type === "result" ? String(outcome.status) : "error"
    const busy = status === "error" && String(outcome!.message ?? "").startsWith("RunBusyError:")
    // A run the cap's stop cut short throws the stop's reason, which the worker reports as an error; its log says
    // the run stopped.
    if (status === "error" && !busy && run.capStopped) status = "stopped"
    if (status === "waiting" || status === "succeeded") this.#deaths = 0
    if (!busy) {
      this.#busyRetried = false
      this.#rested = status === "waiting"
    }
    const stopped = status === "stopped" || status === "crashed"
    if ((status === null || stopped) && this.#ending && this.#capped()) {
      // Over the cap an advance would resume the run and spend: it is cancelled, and the session ends.
      this.#log(`session ${this.sessionId}: ends over its cost cap`)
      this.#finish("ended", null, ENDED_OVER_CAP, run)
    } else if (stopped && this.#capped()) {
      // The cap stopped it (or it crashed over the cap): not a death. Only its deliveries go on, until a raise.
      this.#log(`session ${this.sessionId}: its run ${status} over its cost cap`)
      this.#carry(run)
      await this.#spawnQuietly("advance")
    } else if (status === null || stopped) {
      await this.#died(run, status)
    } else if (busy) {
      await this.#runBusy(run)
    } else if (status === "waiting") {
      await this.#waited(run, readvance)
    } else if (status === "succeeded") {
      this.#finish("ended", outcome, null, run)
    } else if (status === "not_resumed") {
      await this.#notResumed(run)
    } else {
      this.#log(`session ${this.sessionId}: its run ended (${status})`)
      this.#finish("failed", outcome, null, run)
    }
    this.#trySettle("after a worker exit")
  }

  /**
   * `run`'s worker ended with a `waiting` result, whose waits are `#waits`. What it never answered (but an
   * `interrupt`) and what it refused `not_started` go to the next worker, which is spawned when there is any, when
   * `#next` holds some, or when a delivery came after the result (`readvance`). A settled wait alone is advanced
   * too, but not again when the last spawn was such a plain re-advance and the run still waits on the same calls,
   * each as settled as before: it made no progress, so it waits for the next command. With no worker started, the
   * timer waits for the earliest deadline. Over the cost cap, unless ending, only deliveries are taken to the run,
   * and the advance waits for a raise; an advance the cap held back is spawned once it is raised.
   */
  async #waited(run: WorkerRun, readvance: boolean): Promise<void> {
    const waits = this.#waits ?? []
    const from = this.#readvancedFrom
    this.#carry(run)
    // Armed before the spawn, which disarms it once its worker starts: a spawn that fails leaves the timer.
    this.#arm(waits)
    if (!this.#ending && this.#capped()) {
      if (readvance || waits.some((wait) => wait.settled)) this.#needsAdvance = true
      if (this.#next.length > 0) await this.#spawnQuietly("advance")
      return
    }
    if (readvance || this.#needsAdvance || this.#next.length > 0) {
      await this.#spawnQuietly("advance")
      return
    }
    if (!waits.some((wait) => wait.settled)) return
    if (from !== null && sameWaits(from, waits)) {
      const why = "its run made no progress on a settled wait; it waits for the next command"
      this.#log(`session ${this.sessionId}: WARNING: ${why}`)
      return
    }
    await this.#spawnQuietly("advance", { plain: true })
  }

  /** `run`'s worker found the run held by another process (`RunBusyError`): the first time, the same spawn goes
   *  again with what it never applied (but an `interrupt`); the second time, every delivery left, `#next`'s
   *  included, is answered `503 run_busy`, and an ending session fails (`COULDNT_RESUME`). When no retry runs, the
   *  actor stays as it was: a later busy run gets its own retry, and a run that rested `waiting` gets its timer
   *  back. */
  async #runBusy(run: WorkerRun): Promise<void> {
    this.#log(`session ${this.sessionId}: its run is held by another process (RunBusyError)`)
    if (!this.#busyRetried) {
      this.#busyRetried = true
      this.#carry(run, { failed: true })
      // The registry reaps a leftover worker of the session before it spawns.
      if (await this.#spawnQuietly(run.kind, { seed: run.seed })) {
        this.#run!.wakeAt = run.wakeAt
        return
      }
    } else {
      this.#answerRest([...run.given, ...this.#next.splice(0)], runBusy(), runBusy())
      // Left ending it could never be ended.
      if (this.#ending) {
        this.#finish("failed", null, COULDNT_RESUME, run)
        return
      }
    }
    this.#busyRetried = false
    // The timer's advance never ran, so its deadline may wake the run again.
    if (run.wakeAt !== null && run.wakeAt === this.#spent) this.#spent = null
    if (this.#rested) this.#arm(this.#waits ?? [])
  }

  /** Moves the deliveries `run`'s worker never answered (but an `interrupt`), those it refused `not_started` and,
   *  with `failed`, those that failed (but an `interrupt`), to the front of `#next`; answers the rest it was given. */
  #carry(run: WorkerRun, { failed = false }: { failed?: boolean } = {}): void {
    const carry = run.given.filter((p) => {
      if (p.done) return false
      if (p.reply === null || (failed && typeof p.reply.failed === "string")) return p.delivery.op !== "interrupt"
      return p.reply.refused === "not_started"
    })
    this.#answerRest(
      run.given.filter((p) => !carry.includes(p)),
      this.#cantWake(),
    )
    this.#requeue(carry)
  }

  /** `run`'s advance was refused before it appended anything (`not_resumed`): a fresh run replaces the run
   *  (`COULDNT_RESUME`), carrying what `#freshCarry` keeps of the deliveries the run never applied (no reply, refused
   *  `not_started`, or failed); the sends it applied move with the seed. Every other delivery it was given is answered
   *  by the closing rule. */
  async #notResumed(run: WorkerRun): Promise<void> {
    this.#log(`session ${this.sessionId}: its run can't be resumed (${typeName(run.outcome!.error_type)})`)
    const unapplied = run.given.filter((p) => {
      const reply = p.reply
      const answered = reply !== null && reply.refused !== "not_started" && typeof reply.failed !== "string"
      return !p.done && !answered
    })
    this.#answerRest(
      run.given.filter((p) => !unapplied.includes(p)),
      this.#cantWake(),
    )
    // Filtered now, while the replies the closing rule reads are still there.
    this.#requeue(this.#freshCarry(unapplied))
    await this.#spawnQuietly("chat", { replace: COULDNT_RESUME })
  }

  /** Puts `carry` in front of `#next`, each one's reply from the worker that dropped it forgotten, so the next
   *  worker's reply is the one read. */
  #requeue(carry: Pending[]): void {
    for (const p of carry) {
      p.reply = null
      p.late = false
    }
    this.#next = [...carry, ...this.#next]
  }

  /** `run`'s worker is gone with no outcome (`status` null), or its run `stopped` or `crashed`: the first time, a
   *  plain `advance` takes over with what it carried. After a worker gone with no outcome, one that can't start fails
   *  the session (`#cantStartWhy`); after a `stopped` or `crashed` run, a failed spawn is only logged and the session
   *  waits for the next message (an ending one fails, as `#spawnQuietly` says). Again before a `waiting` or
   *  `succeeded` result, the session fails (`WORKER_STOPPED`). */
  async #died(run: WorkerRun, status: string | null): Promise<void> {
    this.#log(`session ${this.sessionId}: ${status === null ? "its worker exited (no outcome)" : `its run ${status}`}`)
    if (this.#deaths >= 1) {
      // A third try won't do better: a run that stops or crashes on every launch must not respawn forever.
      this.#finish("failed", null, WORKER_STOPPED, run)
      return
    }
    this.#deaths += 1
    this.#carry(run)
    if (status !== null) {
      await this.#spawnQuietly("advance")
      return
    }
    try {
      await this.#spawn("advance")
    } catch (error) {
      this.#log(`session ${this.sessionId}: a worker can't start (${errorName(error)})`)
      if (!(error instanceof RegistryClosed) && !this.#closed) this.#finish("failed", null, this.#cantStartWhy(), run)
    }
  }

  /**
   * Finishes the session with `status` (`ended`: the first `endStatus` result, its work item done; or `failed`) in
   * one transaction with the run's office end reason `why`, written only when no yian outcome ended the run (`outcome`,
   * else the one `run`'s worker recorded). `runFinished` (the result frame of how the run ended, key redacted, else
   * null) then `sessionEnded` are notified in order, not awaited. Every delivery not answered gets `409 not_live`. A
   * run yian may still see unfinished gets a hard stop, as does each replaced run no fresh worker cancelled. Throws
   * `HarnessError` (`404`) when the session row is gone; a store write that fails is logged by its type.
   */
  #finish(status: "ended" | "failed", outcome: Frame | null, why: string | null, run = this.#run): void {
    if (this.#finished) return
    this.#finished = true
    const { store, hooks } = this.#ctx
    this.#disarm()
    const runId = this.#runId
    const recorded = outcome ?? run?.outcome ?? null
    const ended = recorded?.type === "result" && ["succeeded", "failed", "cancelled"].includes(String(recorded.status))
    // `runFinished` gets the result that ended the run: `outcome` when the caller passes one (a `succeeded` run, or
    // a `failed`, `cancelled` or other result the session fails on, as Python's `_finish` passed it), else a
    // `succeeded`, `failed` or `cancelled` result `run`'s worker recorded. A recorded `waiting`, `stopped` or
    // `crashed` result isn't how the run ended (the office ends it here, with a hard stop): null, as Python's death
    // path passed None. An `error` frame isn't a result: null too.
    const reported = outcome ?? (ended ? recorded : null)
    try {
      const session = this.#session()
      let final: SessionRecord["status"] = status
      if (status === "ended") {
        final = hooks.fire("endStatus", session).find((result) => !!result) ?? "ended"
        // First, so no client sees an ended session with its work still open.
        if (session.work_item_id) store.updateWorkItem(session.work_item_id, { status: "done" })
      }
      const finished = store.transaction(() => {
        const updated = store.updateSession(this.sessionId, notWaiting(final))
        if (why !== null && !ended && runId !== null) store.endRun(runId, why)
        return updated
      })
      const frame = reported?.type === "result" ? (redactKey(reported, run?.provider ?? null) as Frame) : null
      // In order, outside the queue: a slow hook never holds the session's next step.
      void (async () => {
        if (runId !== null) await hooks.notify("runFinished", finished, runId, frame)
        await hooks.notify("sessionEnded", finished)
      })()
      this.#ctx.transcript.forget(finished.run_ids)
    } catch (error) {
      if (error instanceof HarnessError) throw error
      this.#log(`session ${this.sessionId}: can't store the end (${errorName(error)})`)
    } finally {
      const given = [...(run?.given ?? []), ...(this.#run?.given ?? []), ...this.#next.splice(0)]
      this.#answerRest(given, new HarnessError(409, "not_live", `session ${this.sessionId} has no live run`))
      this.#stopRuns(!ended ? runId : null, this.#replaced.splice(0))
    }
  }

  /** The hard stop of run `runId` (none when null) and of the `replaced` runs, best effort: a `cancel` of `runId`
   *  through its live worker; else one `advance: false` job per run that only cancels it, at once or after the
   *  lingering worker's exit. */
  #stopRuns(runId: string | null, replaced: string[]): void {
    const run = this.#run
    const runIds = runId === null ? replaced : [...replaced, runId]
    if (run === null || run.worker === null) {
      void this.#stopJobs(runIds)
      return
    }
    this.#stopAfterExit = runIds
    if (runId === null || run.outcome !== null) return
    run.worker.deliver({ id: newId(), op: "cancel" }).then(
      (sent) => {
        if (sent) this.#stopAfterExit = this.#stopAfterExit.filter((id) => id !== runId)
      },
      (error) => this.#log(`session ${this.sessionId}: a cancel can't be sent (${errorName(error)})`),
    )
  }

  /** `#stopJob` for each of `runIds`, one after another: a session has one worker at a time. */
  async #stopJobs(runIds: readonly string[]): Promise<void> {
    for (const runId of runIds) await this.#stopJob(runId)
  }

  /** Spawns one `advance: false` job that cancels run `runId`, whose frames nobody reads, and resolves once its
   *  worker exits; skipped when the run has no log (it never started). A failure is logged by its type. */
  async #stopJob(runId: string): Promise<void> {
    const { connections, paths } = this.#ctx
    const log = this.#logOf(runId)
    if (!fs.existsSync(log)) return
    try {
      const session = this.#session()
      const [name, model] = await connections.choice(session.connection, session.model)
      const provider = await connections.resolve(name, model)
      const job = chatJob(await this.#specOf(session), {}, {
        kind: "advance",
        session,
        runId,
        pin: await this.#ctx.git.pin(session.repo_commit),
        log,
        llmConfig: provider.llm_config,
        turns: session.turns,
        deliver: [{ id: newId(), op: "cancel" }],
        advance: false,
      })
      const note = (line: string) => this.#log(`session ${this.sessionId}: its run's cancel ${line}`)
      let exited!: () => void
      const gone = new Promise<void>((resolve) => (exited = resolve))
      // Its frames are ignored, but a cancel that didn't take is logged by its reason or error type only.
      const handlers = new (class extends BaseHandlers {
        override deliverReply(_worker: unknown, frame: Frame): void {
          if (typeof frame.refused === "string") note(`was refused (${frame.refused})`)
          else if (typeof frame.failed === "string") note(`failed (${frame.failed})`)
        }

        override error(_worker: unknown, frame: Frame): void {
          note(`ended in an error (${errorType(frame)})`)
        }

        override exited(): void {
          exited()
        }
      })()
      await this.#ctx.workers.spawn(job, paths.sessionDir(this.sessionId), handlers, { env: provider.env })
      await gone
    } catch (error) {
      this.#log(`session ${this.sessionId}: its run can't be stopped (${errorName(error)})`)
    }
  }

  /**
   * The closing rule: answers each of `pendings` that has no answer yet and isn't carried. A held `not_started` is
   * `503 cant_wake`, a held failure `failure` (by default `503 cant_wake` naming its type); a lost `interrupt` or
   * `cancel`, or a dropped `complete` of a card's answer (its question stays answered), is resolved; any other
   * delivery with no reply, a message's `complete` included, gets `fallback`.
   */
  #answerRest(pendings: readonly Pending[], fallback: HarnessError, failure?: HarnessError): void {
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
        p.reject(failure ?? this.#cantWake(reply.failed))
      } else {
        p.reject(reply.refused === "not_started" ? this.#cantWake() : refusalOf(reply.refused as string))
      }
    }
  }

  // --- the wake-at timer -------------------------------------------------------------------

  /** Arms the timer for the earliest deadline of an unsettled call in `waits`, unless it already advanced the run
   *  at that deadline or there is none; does nothing once finished or closed. */
  #arm(waits: readonly Wait[]): void {
    this.#disarm()
    const at = wakeAt(waits)
    if (at === null || at === this.#spent || this.#finished || this.#closed) return
    const timer = new AbortController()
    this.#timer = timer
    sleepUntil(this.#ctx.scheduler, Date.parse(at), timer.signal).then(
      () => this.#post("wake-at timer", () => this.#wake(timer, at)),
      () => {},
    )
  }

  /** Stops the timer's sleep, if one is armed. */
  #disarm(): void {
    this.#timer?.abort()
    this.#timer = null
  }

  /** The deadline `at` of `timer` has come: with no worker and under the cost cap, a plain `advance` times its calls
   *  out. */
  async #wake(timer: AbortController, at: string): Promise<void> {
    if (timer !== this.#timer) return
    this.#timer = null
    if (this.#finished || this.hasWorker) return
    // Over the cap the timed-out calls wait for a raise.
    if (this.#capped()) {
      this.#needsAdvance = true
      return
    }
    if (await this.#spawnQuietly("advance")) {
      this.#spent = at
      this.#run!.wakeAt = at
    }
  }

  // --- the session --------------------------------------------------------------------------

  /** Where run `runId` logs. */
  #logOf(runId: string): string {
    return path.join(this.#ctx.paths.runs, runId, "log.jsonl")
  }

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

/** The error type an `error` frame names (its message reads `<type>: <message>`), never its message. */
function errorType(frame: Frame): string {
  return typeName(String(frame.message ?? "").split(":", 1)[0])
}

/** `value` when it reads as an error type's name, else `Error`: a log line carries nothing else a worker sent. */
function typeName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z_][\w.]*$/.test(value) ? value : "Error"
}

/** `value` with `provider`'s model key replaced by `[redacted]` wherever it appears. */
function redactKey(value: unknown, provider: Pick<Provider, "llm_config"> | null): unknown {
  const key = provider?.llm_config?.api_key
  return typeof key === "string" && key !== "" ? redact(value, [], [key]) : value
}

/** The earliest deadline of an unsettled call in `waits`, or null; record times compare as text. Mirrors yian's
 *  `wakeAt` (`ts/src/runtime/waits.ts`). */
function wakeAt(waits: readonly Wait[]): string | null {
  let earliest: string | null = null
  for (const wait of waits) {
    if (!wait.settled && wait.deadline !== null && (earliest === null || wait.deadline < earliest)) {
      earliest = wait.deadline
    }
  }
  return earliest
}

/** Resolves once `scheduler`'s clock reaches `at` (epoch ms), sleeping at most `SLEEP_CHUNK_MS` at a time and
 *  reading the clock again after each, so a machine that slept still wakes on time; rejects once `signal` aborts.
 *  Copied from yian's `sleepUntil` (`ts/src/cli/chat.ts`). */
async function sleepUntil(scheduler: Scheduler, at: number, signal: AbortSignal): Promise<void> {
  for (let left = at - scheduler.now(); left > 0; left = at - scheduler.now()) {
    await scheduler.sleep(Math.min(left, SLEEP_CHUNK_MS), signal)
  }
}

/** The calls a `result` frame says its run waits on. */
function waitsOf(frame: Frame): Wait[] {
  return Array.isArray(frame.waits) ? (frame.waits as Wait[]) : []
}

/** Whether `a` and `b` wait on the same calls, each settled or not alike. */
function sameWaits(a: readonly Wait[], b: readonly Wait[]): boolean {
  const settled = new Map(a.map((wait) => [wait.call_id, wait.settled]))
  return a.length === b.length && b.every((wait) => settled.get(wait.call_id) === wait.settled)
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

function runBusy(): HarnessError {
  return new HarnessError(503, "run_busy", "another process holds the session's run; try again")
}

function stopping(): HarnessError {
  return new HarnessError(503, "stopping", "the office is stopping")
}

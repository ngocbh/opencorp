/** One live chat session: a serial queue that drives the session's yian run one worker job per run call, the way
 *  `yian chat` does (deliver, then `advance`, again while the run waits), its worker process kept between calls. */
import fs from "node:fs"
import path from "node:path"
import { type Scheduler, SLEEP_CHUNK_MS } from "@ngocbh/yian/platform"
import {
  inspectRun,
  type LiveViewCall,
  pendingCalls,
  type RunInspection,
  type Message as RunMessage,
  staticPathOf,
} from "@ngocbh/yian/run"
import { CompanyDefaults, type Message, now, OFFICE, WorkItem } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import { loadRepo } from "../company/loader.ts"
import type { Bus } from "../daemon/bus.ts"
import type { LiveRelay } from "../daemon/live.ts"
import type { OfficePaths } from "../daemon/office.ts"
import type { Env } from "../install/launch.ts"
import { redact } from "../perm/redact.ts"
import { type Answers, makeAskUser, type OnQuestion } from "../questions/ask.ts"
import type { AnswerKind } from "../questions/cards.ts"
import { formatAnswer } from "../questions/format.ts"
import type { RunIndexer } from "../runs/indexer.ts"
import { OpenNodes } from "../runs/nodes.ts"
import {
  COULDNT_RESUME,
  COULDNT_START,
  ENDED_OVER_CAP,
  flowLabel,
  NEW_MODEL,
  OFFICE as OFFICE_DRIVER,
  OFFICE_REPLACED,
  WORKER_REPLACED,
  WORKER_STOPPED,
} from "../runs/outcomes.ts"
import type { LiveRun } from "../runs/records.ts"
import {
  InvalidTransition,
  newId,
  type QuestionRecord,
  type SessionRecord,
  type Store,
  type WorkItemRecord,
} from "../store/store.ts"
import { type Frame, FrameTooLarge } from "../worker/channel.ts"
import { type Delivery, type Job, type Seed, STOP_REASON } from "../worker/job.ts"
import { type AskRequest, BaseHandlers, errorName, type OfficeTool, type WorkerHandlers } from "../worker/rpc.ts"
import { RegistryClosed, type Worker, workerEnv } from "../worker/spawn.ts"
import { BadConnectionName, type Connections, configHash, runRecord } from "./connections.ts"
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
    /** Runs `job` with `handlers` in the session's parked `worker`; false when it is gone. */
    next(worker: ActorWorker, job: Job, handlers: WorkerHandlers<ActorWorker>): Promise<boolean>
    /** Counts `worker` as parked; `release` must end it when the office keeps too many. */
    park(worker: ActorWorker, release: () => void): void
    /** No longer counts `worker` as parked. */
    unpark(worker: ActorWorker): void
  }
  /** How long, in ms, a worker stays parked after a run call that left its run waiting; 0 keeps none (default
   *  `KEEP_MS`). */
  readonly keepMs?: number
  /** How often, in ms, a parked worker's connection is read again (default `CHECK_MS`). */
  readonly checkMs?: number
  readonly hooks: Hooks
  readonly answers: Answers
  readonly transcript: Pick<Transcript, "forget">
  /** The office's live relay, fed each worker's live frames; the actor's `calls` reads it. */
  readonly live: Pick<LiveRelay, "frame" | "detach" | "calls" | "forget">
  /** The run spec of `session` (Python's restorers); may throw a `HarnessError`. */
  spec(session: SessionRecord): RunSpec | Promise<RunSpec>
  /** The clock and sleeps of the wake-at timer (yian's `Scheduler`; `realScheduler` in the office). */
  readonly scheduler: Scheduler
  /** The office's environment, for a seed's `workerEnv` (default `process.env`). */
  readonly environ?: Env
  /** The office's run index, brought up to date before an ended run is reported; the chat harness passes
   *  `office.runIndex`. */
  readonly runIndex?: Pick<RunIndexer, "update">
  /** Called when run `runId`'s status, nodes or end may have changed; the office coalesces the calls and publishes
   *  run.updated. The chat harness passes `office.runChanged`. */
  readonly runChanged?: (runId: string) => void
  /** Gets log lines; never an error's message. */
  log(line: string): void
}

/** The note of a chat that continues on a fresh run after its worker died, as its model or connection changed. */
export const FRESH_NOTE =
  "This chat continues on a fresh run because its model or connection changed. " +
  "If your last message got no reply, send it again."

/** A wake's fresh-run note: the message that woke the session is still delivered, so it needn't be sent again. */
export const WOKEN_NOTE = "This chat continues on a fresh run because its model or connection changed."

/** Connection `name`'s configured model; null without one, or if it can't be read. */
export async function ownModel(connections: Connections, name: string): Promise<string | null> {
  try {
    const model = (await connections.get(name)).llm_config?.model
    return typeof model === "string" ? model : null
  } catch (error) {
    // Resolving it at the spawn reports the error.
    if (error instanceof ProviderError || error instanceof BadConnectionName) return null
    throw error
  }
}

/** How a note names connection `name` on `model` (null: its own): `name/model`, or `name` alone. */
export async function named(connections: Connections, name: string, model: string | null): Promise<string> {
  const shown = model || (await ownModel(connections, name))
  return shown ? `${name}/${shown}` : name
}

/** How the work item that asks to raise a session's cost cap is titled. */
const CAP_TITLE = "Raise the cost cap"

/** What the actor uses of a worker; `Worker` fits. */
export type ActorWorker = Pick<Worker, "job" | "pid" | "deliver" | "stop" | "follow" | "closeChannel" | "wait">

/** How long, in ms, a session's worker stays parked between run calls before it is closed (2 hours): a message
 *  within it replays nothing. */
export const KEEP_MS = 2 * 60 * 60_000

/** How often, in ms, a parked worker's connection is read again: once it is removed, re-keyed or edited, even from
 *  outside the office (`opencorp onboard`), the worker is closed, so its old key doesn't stay in a live process. */
export const CHECK_MS = 2000

/** How long, in milliseconds, a run's end report waits for the run index; bounded, so a stuck index thread can't
 *  stall the report. */
export const INDEX_WAIT_MS = 3000

/** How many characters of why a run failed a notice or a reason keeps. */
const WHY_CHARS = 500

/** The error types of a model refusing the connection's key. */
const AUTH_CAUSES = ["AuthenticationError", "PermissionDeniedError", "AuthError"]

/** A fresh run that replaces the current one: the office end reason written on the old run (none when yian ended
 *  it), and the result frame `runFinished` gets for it (key redacted), if any. */
interface Fresh {
  why: string | null
  finished: Frame | null
}

/** The run statuses that end a run, whose report waits for the run index. */
const ENDING: readonly string[] = ["succeeded", "failed", "cancelled"]

/** What an office tool call answers when Esc, End, the worker's exit or the office stop cuts it before it returns. */
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
  /** Whether a held fresh run's message was answered `queued` before any run took it: it is still carried. */
  early = false
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
  /** The connection and model (null: the connection's own) that resolved to `provider`. */
  ranOn: { name: string; model: string | null } | null = null
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
  /** Whether its worker exited (its handler ran), maybe before the actor's exit job did. */
  exited = false
  /** Whether its worker parked after its run call (its handler ran), maybe before the actor's park job did. */
  parked = false

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
 * A run call that leaves the run waiting parks its worker process (`#parked`) for up to `keepMs`: the next run call
 * of the same run on the same provider goes to it, and replays nothing; any other closes it first. A parked worker
 * is no worker to the rest of the actor, and one that dies is no death.
 *
 * Every command, worker notification and timer runs as a job of one serial queue. Worker requests (`askUser`,
 * `toolCall`, `store_*`) run as their own promises. The actor never calls a yian host function itself (it only reads
 * its run's log at restore): a running worker gets a `deliver` frame, and a run at rest gets a new worker whose job
 * lists the deliveries. A command that sends something resolves once its delivery is answered, which it waits for
 * outside the queue.
 */
export class SessionActor implements LiveCalls {
  readonly sessionId: string
  readonly #ctx: ActorContext
  #tail: Promise<unknown> = Promise.resolve()
  #runId: string | null
  #run: WorkerRun | null = null
  /** The worker kept after the last run call, the provider env it was spawned with, and its idle timer. */
  #parked: Parked | null = null
  /** The worker being spawned, holding its job's deliveries. */
  #starting: WorkerRun | null = null
  /** The calls the run waited on at its last `waiting` result, or as restore read them; null when unknown. */
  #waits: Wait[] | null = null
  /** The deliveries the next spawn's job carries. */
  #next: Pending[] = []
  /** Whether a worker accepted a delivery after its `result`, so the run needs another `advance`. */
  #readvance = false
  /** Whether the run needs an `advance` that the cost cap held back (a job over the cap only delivers). */
  #needsAdvance = false
  /** The fresh run the cost cap holds back, which the next spawn after a raise (or at End) starts. */
  // A `chat` job can't only deliver, and its reply would call the model: over the cap the fresh run waits for a
  // raise, as Python held a capped session's turns.
  #heldFresh: Fresh | null = null
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
  /** Whether `start` has run on this actor. */
  #started = false
  #finished = false
  /** The session's runs when it finished, which the finished actor's lingering worker forgets at its exit: a run
   *  started after (a reopened session's) is a new actor's. */
  #finishedRuns: readonly string[] = []
  #closed = false
  #ending = false
  /** Workers that exited with no outcome, or with a `stopped` or `crashed` run, since the last `waiting` or
   *  `succeeded` result. */
  #deaths = 0
  /** The turn take that succeeded most recently, by run and loop iteration: a failed fold recovers only once its
   *  turn has taken its messages. */
  #took: { runId: string; iteration: number } | null = null
  /** The runs whose hard stop waits for the lingering worker's exit. */
  #stopAfterExit: string[] = []
  /** The `cancel` the finish sent through the live worker, by delivery id, and its run; null when none was sent. */
  #stopCancel: { id: string; runId: string } | null = null
  /** Settles once the hard stops this actor started have finished; settled while it has none. */
  #stopped: Promise<void> = Promise.resolve()
  /** Settles `#stopped` when it waits for the lingering worker's exit. */
  #stoppedAfterExit: () => void = () => {}
  /** Settles at `close`. */
  readonly #closing = Promise.withResolvers<void>()
  /** The runs fresh runs replaced, whose open questions go stale once a fresh worker's run starts. */
  #replaced: string[] = []
  #spec: RunSpec | null = null
  /** The run whose questions restore couldn't reconcile, its spec refused for its folder: the first spec built
   *  reconciles them. */
  #reconcileDue: string | null = null
  #pins: Pins | null = null
  /** Whether this actor has started a worker. A new actor stands for a session woken after a restart, as Python's
   *  `_resume` saw it, so only its fresh run for a changed model or connection gets `WOKEN_NOTE`; one after a switch
   *  or key change on a session this actor already ran gets no note, as Python's restart of a live worker did. */
  #startedWorker = false
  /** Whether `restore` ran. */
  #restored = false
  /** Whether restore picked the session up and no worker of this actor has started since: a run that moved is
   *  then replaced because the office stopped (`OFFICE_REPLACED`), not for a new model. */
  #sinceRestore = false
  /** The fresh run that replaces a run restore found ended in yian (no office end reason; `finished`, how yian ended
   *  it) or unreadable, which the next advance starts; null when none. */
  #unresumable: Fresh | null = null
  /** The office tool calls in flight, each answered `INTERRUPTED_CALL` when called. */
  readonly #calls = new Set<() => void>()
  /** The nodes the current worker's run executes now, from its frames. */
  readonly #nodes = new OpenNodes()

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

  /** Whether this actor has started the session and not finished it. */
  get active(): boolean {
    return this.#started && !this.#finished
  }

  /**
   * Settles (never rejects) once the hard stops of this actor's finished runs are done: the cancel jobs started at
   * once, or the lingering worker's exit and the cancel jobs queued for it. Settled when it started none. A hard stop
   * spawns under the session's id, as a new run's worker does, so a new actor's start waits for it.
   */
  get stopped(): Promise<void> {
    return this.#stopped
  }

  /** Whether a worker runs the session's run, or is being spawned. */
  get hasWorker(): boolean {
    return this.#run !== null || this.#starting !== null
  }

  /** The session's live run: its status (the stored session's `idle` or `waiting`, else `running`) and its open
   *  nodes while running, else the nodes it waits at. Null unless a worker runs the current run or is being spawned
   *  for it, and the actor is neither finished nor closed. */
  liveRun(): (LiveRun & { runId: string }) | null {
    const run = this.#starting ?? this.#run
    // While a fresh run replaces the current one, the worker being spawned is still the old run's for a moment.
    if (run === null || run.runId !== this.#runId || this.#finished || this.#closed) return null
    const stored = this.#ctx.store.getSession(this.sessionId)?.status
    const status = stored === "idle" || stored === "waiting" ? stored : "running"
    const nodes = status === "running" ? this.#nodes.current() : [...run.waiting.keys()]
    return { runId: run.runId, status, nodes }
  }

  /** The model calls in flight of `runId`, as the live relay shows them (empty while its view is being built) while a
   *  worker runs it; else null. Null too once the worker has exited or parked, before the actor handles it: the
   *  relay has already sent its cut calls as interrupted, as the transcript will show them. */
  calls(runId: string): readonly LiveViewCall[] | null {
    const run = this.#run
    return run !== null && !run.exited && !run.parked && !this.#closed && runId === this.#runId
      ? (this.#ctx.live.calls(runId) ?? [])
      : null
  }

  /**
   * Starts the session's run: stores the run and its row, then spawns its `chat` worker. A session with earlier runs
   * (a side chat that ended or failed, then was set back to `starting`) gets a fresh run, driven by its owner and
   * seeded from its newest logged run, so it continues that run's history. A start that fails fails the session (a
   * run it stored ends `COULDNT_START`) and throws: a `HarnessError` as it is (the run spec couldn't be built), else
   * `500 start_failed`. Refused `409 live` once this actor has started. The start waits for `after` (the replaced
   * actor's `stopped`) before it builds anything; the office's stop ends that wait.
   */
  start({ after }: { after?: PromiseLike<void> } = {}): Promise<void> {
    const sid = this.sessionId
    if (this.#started) return Promise.reject(new HarnessError(409, "live", `session ${sid} already has a run`))
    // Claimed before the job is queued, so `active` holds at once for a caller that checks it.
    this.#started = true
    return this.#command(async () => {
      // An earlier run isn't this start's: a failure here must not end it.
      this.#runId = null
      const runId = newId()
      try {
        // The replaced actor's hard stop spawns under the session's id: this start's worker would be refused.
        if (after !== undefined) await Promise.race([after, this.#closing.promise])
        if (this.#closed) throw stopping()
        const session = this.#session()
        // Built first, so a spec that can't be built records no run.
        const spec = await this.#specOf(session)
        const owner = await this.#owner(session)
        const seed = await this.#seed(session)
        this.#ctx.store.transaction(() => this.#addRun(session, spec, owner, runId, null, now()))
        this.#runId = runId
        await this.#spawn("chat", { seed })
      } catch (error) {
        this.#log(`session ${sid} can't start (${errorName(error)})`)
        // The office stops: the session stays as it was, for the next office to start.
        if (error instanceof RegistryClosed || this.#closed) throw stopping()
        // A run stored ends `COULDNT_START`; with none, only the session fails.
        this.#finish("failed", null, COULDNT_START)
        if (error instanceof HarnessError) throw error
        throw new HarnessError(500, "start_failed", `session ${sid} failed to start${spawnWhy(error)}`)
      }
    })
  }

  /**
   * Takes a message from `by` (the owner when null) and resolves once the run has it. The flow's exit command
   * (`/exit`) is End, and gets `turn`.
   *
   * While the model's `ask_user` question is open on the run, the message answers it (`answer`). Otherwise it goes
   * to the run's inbox, and the reply is decided when it is queued: `steer` while a reply node runs, `turn` while the
   * run waits only at its turn, else `queued` (always over the cost cap, where the manager gets an item to raise it).
   * Refused with `409 not_live` (the session finished), `503 stopping` (the office stops), `409 ending`, `422 refused`
   * (a `promptCheck` hook), `422 too_large`, or `503 cant_wake` (the run could not take it).
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
      // A session capped with no charge (a cap of 0, or a side chat reopened at its cap) has no item yet.
      if (this.#capped()) this.#ensureCapItem()
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
      // Settled once the answer is on its way: before, nothing open and nothing spawning would read idle.
      if (stored.call_id !== null && stored.run_id === this.#runId && !this.#finished) {
        await this.#deliver(this.#complete(stored, undefined))
      }
      this.#trySettle("after an answer")
      return stored
    })
  }

  /**
   * Esc: interrupts the workspace, answers the office tool calls in flight `INTERRUPTED_CALL`, and interrupts the
   * run: through its worker while one runs it (over the cost cap, unless ending, only while a reply node runs), else,
   * while the agent waits on a model question, through a worker spawned for it; else nothing runs to stop. Resolves
   * once the interrupt's reply is handled (the calls it closed are answered) or it was dropped. Refused with `404
   * not_found`, `409 not_live`, `503 stopping` or `503 cant_wake`.
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
      const live = run !== null && run.worker !== null && run.outcome === null
      // Over the cap no reply is about to start: only a reply node still in flight is stopped.
      const running = live && (this.#ending || !this.#capped() || this.#replying())
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
   * End: the session is `ending` at once, the workspace is interrupted and the office tool calls in flight are answered
   * `INTERRUPTED_CALL` (as by Esc), and its run gets an `interrupt` (while a reply or its fold runs, or the agent waits
   * on a model question) and a `close` of its inbox, whose turn then reads it closed, so the run succeeds and the
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

  /** Marks the session ending, interrupts the workspace and answers the office tool calls in flight (as Esc does),
   *  and queues its run's `interrupt` (while a reply or its fold runs, `replying`, or the agent waits) and `close`,
   *  spawning for them when no worker runs. A run restore found ended in yian ends the session at once, as that run
   *  did. */
  async #end(session: SessionRecord, replying = this.#turnWorks()): Promise<void> {
    if (this.#unresumable?.why === null) {
      // Yian ended the run: nothing is left to close, so the session ends as the run did.
      const ended = this.#unresumable.finished
      this.#finish(ended?.status === "succeeded" ? "ended" : "failed", ended, null)
      return
    }
    this.#ending = true
    this.#ctx.store.updateSession(this.sessionId, notWaiting("ending"))
    // A reply blocked on a sandboxed shell or an office tool call can't read the interrupt until the call returns;
    // and nobody will read what it returns, even when the end below fails.
    this.#interruptWorkspace()
    this.#answerCalls()
    let inbox: string
    try {
      // Restore may not have built the spec, and a folder gone or unsafe since fails its build.
      inbox = (await this.#specOf(session)).chat.inbox
    } catch (error) {
      throw this.#cantEnd(error)
    }
    const run = this.#run
    const capped = this.#capped()
    const rests = this.#rested && !this.#wakesAgent(this.#waits ?? [])
    if (capped && run === null && !rests && this.#heldFresh === null) {
      // The reply was stopped at the cap, crashed or is unknown, or a settled call would wake the agent: an advance
      // would spend, so the run is cancelled and the session ends. A settled turn take doesn't: it reads its
      // messages with the close, and the flow skips the reply once closed. Nor does a held fresh run's.
      this.#finish("ended", null, ENDED_OVER_CAP)
      return
    }
    const ops: Delivery[] = [{ id: newId(), op: "close", inbox }]
    if (replying || this.#agentWaits()) ops.unshift({ id: newId(), op: "interrupt", inbox })
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
      throw this.#cantEnd(error)
    }
  }

  /** Fails the ending session whose end can't start (`#cantStartWhy`), unless the office stops, and returns the
   *  error End throws for `error`. */
  #cantEnd(error: unknown): HarnessError {
    if (error instanceof RegistryClosed || this.#closed) return stopping()
    this.#log(`session ${this.sessionId} can't end (${errorName(error)})`)
    // Left open it could never be ended.
    this.#finish("failed", null, this.#cantStartWhy())
    return this.#wakeError(error)
  }

  /**
   * At office start: picks the session up from where yian's log says its run stands. A run yian ended
   * keeps that end: an ending session ends as the run did; any other sleeps, its questions stale, until a fresh run.
   * An unreadable log fails an ending session (`COULDNT_RESUME`), and a run that never started has an ending session
   * ended again; any other sleeps until a fresh run, one that never started recorded `COULDNT_START` at once. A
   * waiting run's questions are reconciled and it sleeps, its timer armed, unless it can wake now. Over the cost cap
   * any run sleeps. Any other run is advanced, and an ending session ended again. Until the actor's first worker, a
   * run the record check finds moved ends `OFFICE_REPLACED`. A spec refused for its folder (missing or unsafe) leaves
   * a session that isn't ending asleep, a waiting run's timer armed and its questions reconciled by the first spec
   * built; the next message checks the folder again. Any other failure is logged by its type and fails the session,
   * unless the office stops. Does nothing a second time, or once a worker runs or the session finished; `503
   * stopping` after `close`.
   */
  restore(): Promise<void> {
    return this.#command(async () => {
      if (this.#restored || this.hasWorker || this.#finished) return
      this.#restored = true
      this.#sinceRestore = true
      try {
        await this.#restore()
      } catch (error) {
        this.#log(`session ${this.sessionId} can't be restored (${errorName(error)})`)
        // The office stops: the session stays as it was, for the next office.
        const stops = error instanceof RegistryClosed || (error instanceof HarnessError && error.code === "stopping")
        if (!stops && !this.#closed) this.#finish("failed", null, this.#cantStartWhy())
      } finally {
        this.#trySettle("at restore")
      }
    })
  }

  async #restore(): Promise<void> {
    const session = this.#session()
    if (!LIVE.includes(session.status)) return
    const runId = this.#runId
    if (runId === null) {
      // The office stopped before its first run was stored.
      this.#finish("failed", null, COULDNT_START)
      return
    }
    const ending = session.status === "ending"
    if (!fs.existsSync(this.#logOf(runId))) {
      // Its worker never started it. Recorded now, so the run lists as failed from the start on, not only once the
      // next message's fresh run replaces it (that end then writes nothing).
      if (ending) await this.#end(session, false)
      else this.#ctx.store.endRun(runId, COULDNT_START)
      return
    }
    let inspection: RunInspection | null = null
    try {
      inspection = inspectRun(this.#logOf(runId))
    } catch (error) {
      this.#log(`session ${this.sessionId}: its run's log can't be read (${errorName(error)})`)
    }
    if (inspection === null) {
      if (ending) this.#finish("failed", null, COULDNT_RESUME)
      else this.#unresumable = { why: COULDNT_RESUME, finished: null }
      return
    }
    const status = inspection.status
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      // How yian ended the run, kept so no office end reason or hard stop hides it.
      this.#unresumable = { why: null, finished: endedFrame(runId, inspection, await this.#ranProvider(runId)) }
      if (ending) {
        await this.#end(session, false)
      } else {
        // Its calls can't be answered any more.
        this.#staleQuestions([runId])
      }
      return
    }
    if (status === "waiting") {
      this.#waits = inspection.waits.map((wait) => ({
        node: wait.node,
        call_id: wait.callId,
        tool: wait.tool,
        inbox: wait.inbox,
        deadline: wait.deadline,
        settled: wait.settled,
      }))
      this.#rested = true
    }
    let spec: RunSpec
    try {
      spec = await this.#specOf(session)
    } catch (error) {
      // As without a restart: the next message checks the folder again. Left open, an ending session could never
      // be ended, so it still fails.
      if (ending || !folderRefused(error)) throw error
      this.#log(`session ${this.sessionId}: its folder can't be used at restore (${errorName(error)})`)
      if (status === "waiting") {
        this.#reconcileDue = runId
        this.#arm(this.#waits ?? [])
      }
      return
    }
    const capped = this.#capped()
    if (status === "waiting") {
      await this.#reconcile(session, spec, runId)
      const unread = this.#unreadAnswers([]).length > 0
      if (!ending && (capped || (!inspection.ready && !unread))) {
        // Over the cap, the answer goes with the advance a raise starts.
        if (unread) this.#needsAdvance = true
        this.#arm(this.#waits ?? [])
        return
      }
    } else if (capped && !ending) {
      // Stopped, crashed or still held by a writer the reaper missed: a raise advances it.
      return
    }
    if (ending) {
      await this.#end(session, this.#chat.turnWorks(inspection.inFlight))
      return
    }
    try {
      await this.#spawn("advance")
    } catch (error) {
      this.#log(`session ${this.sessionId}: a worker can't start at restore (${errorName(error)})`)
      // The office stops: the session stays as it was, for the next office.
      if (!(error instanceof RegistryClosed) && !this.#closed) this.#finish("failed", null, this.#cantStartWhy())
    }
  }

  /** Settles run `runId`'s questions against yian's open calls, through the handlers a spawn of the run builds from
   *  `spec`; a failure is logged by its type. */
  async #reconcile(session: SessionRecord, spec: RunSpec, runId: string): Promise<void> {
    try {
      const tools = spec.groups({ session, runId, onQuestion: this.#onQuestion })
      const manager = tools.company?.ask_manager
      await this.#ctx.answers.reconcile(runId, pendingCalls(this.#logOf(runId)), {
        askUser: this.#askUser(session, runId, spec),
        askManager: manager && ((args, callId) => manager.call(args, { callId })),
      })
    } catch (error) {
      this.#log(`session ${this.sessionId}: its run's questions can't be reconciled (${errorName(error)})`)
    }
  }

  /** The `ask_user` handler of run `runId` of `session`, built from `spec`. */
  #askUser(
    session: SessionRecord,
    runId: string,
    spec: RunSpec,
  ): (request: AskRequest, callId: string) => Promise<unknown> {
    return makeAskUser(session, runId, this.#onQuestion, {
      names: spec.names,
      carried: (question) => this.#ctx.answers.carried(question),
    })
  }

  /** Fails the session: its run, when the run hasn't ended, ends `COULDNT_RESUME` and gets a hard stop; nothing when
   *  the actor already finished or the stored session isn't live. Refused `404 not_found` (the session row is gone)
   *  or `503 stopping` after `close`. */
  fail(): Promise<void> {
    return this.#command(async () => {
      if (this.#finished || !LIVE.includes(this.#session().status)) return
      this.#finish("failed", null, COULDNT_RESUME)
    })
  }

  /**
   * Ends the session with its run's office end reason `why`, as `#finish` ends it (deliveries answered `409
   * not_live`, the run's hard stop); nothing when the actor already finished or the stored session isn't live. A
   * finish queued or in flight before it wins, its run keeping its own end. Refused `404 not_found` (the session row
   * is gone) or `503 stopping` after `close`.
   */
  abandon(why: string): Promise<void> {
    return this.#command(async () => {
      if (this.#finished || !LIVE.includes(this.#session().status)) return
      this.#finish("ended", null, why)
    })
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
        const why = `the cap must be above the cost so far ($${costFigure(session.cost)})`
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
   * to be (a re-advance, or a message or an answer held for the next job), or while a worker runs the run and it
   * isn't at its turn; else idle. A starting session moves to busy only once its reply runs: before, a run that
   * starts is busy whether or not a turn comes. `writeState` leaves ending and finished sessions alone.
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
      const held = overCap(session, this.#pins)
      if (held) who.push(this.#capItem(session)?.assignee ?? this.#pins.manager)
      const run = this.#run
      const spawning =
        this.#starting !== null ||
        this.#readvance ||
        this.#next.some((p) => p.delivery.op === "send" || p.delivery.op === "complete")
      const running = spawning || (run !== null && run.outcome === null && !this.#runAtTurn(run))
      const fromStarting = this.#replying() ? (["idle", "busy", "waiting"] as const) : undefined
      writeState(store, this.sessionId, runState({ waiting: asks.length > 0 || held, running }), who, {
        capped: held,
        fromStarting,
      })
    })
    if (this.#runId !== null) this.#ctx.runChanged?.(this.#runId)
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
   * still run); the office's registry stops the workers, and the parked worker is closed. Returns a promise that
   * settles once the job running at the close returns.
   */
  close(): Promise<void> {
    const tail = this.#tail.then(() => {})
    if (this.#closed) return tail
    this.#closed = true
    this.#closing.resolve()
    this.#disarm()
    void this.#releaseParked()
    this.#interruptWorkspace()
    this.#answerCalls()
    const given = [...(this.#starting?.given ?? []), ...(this.#run?.given ?? []), ...this.#next.splice(0)]
    this.#answerRest(given, stopping())
    return tail
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
   *  `#next` for a spawn now (no worker runs). Over the cost cap, unless ending, a `send` or `complete` for a worker
   *  whose job may call the model waits in `#next` for a job that only delivers; otherwise nothing goes to the worker
   *  ahead of what `#next` holds. */
  async #give(p: Pending): Promise<boolean> {
    // The office stopped while the command waited: no worker may start for it.
    if (this.#closed) {
      p.reject(stopping())
      return false
    }
    const run = this.#run
    if (run !== null && run.worker !== null && run.outcome === null) {
      // Over the cap what wakes the agent never reaches a run that may reply; under it, nothing overtakes it.
      const held = !this.#ending && this.#capped() ? wakes(p) && run.worker.job.advance : this.#next.length > 0
      if (held) {
        this.#next.push(p)
        return false
      }
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

  /** Whether a reply or the turn's fold runs in the current worker: a person's turn is being worked. */
  #turnWorks(): boolean {
    const run = this.#run
    return run !== null && run.outcome === null && this.#chat.turnWorks(run.inFlight)
  }

  /** Whether the run waits only at its turn: a worker's run with no reply in flight, no message pending for the
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

  /** Whether worker run `run` waits only at its turn. Other nodes may run beside the waiting take (a flow that
   *  compacts history in parallel with it): the take reads any message sent meanwhile. */
  #runAtTurn(run: WorkerRun): boolean {
    const waiting = [...run.waiting.keys()]
    return (
      ![...run.inFlight].some((node) => this.#chat.isReply(node)) &&
      !run.turnPending &&
      waiting.length > 0 &&
      waiting.every((node) => this.#chat.isTurn(node))
    )
  }

  // --- spawning ---------------------------------------------------------------------------

  /**
   * Spawns the session's next worker, a `kind` job whose deliveries are `#next`. The connection and model are
   * checked first, before anything is written (a removed connection moves the session to the default). An `advance`
   * whose run's record no longer gives what the run ran on is a fresh run instead (`#recordCheck`; a run that moved
   * ends `moved`), as is any spawn given `replace`, carrying what `#freshCarry` keeps; otherwise an `advance` job
   * starts with a `complete` for each stored answer that never reached the run. A `chat` job records what its run
   * starts on, and starts from `seed` (a retry's) unless it is a fresh run's. A fresh run the record check asks for
   * on a changed connection or model, unless `#checkProvider` moved the chat, writes its note first: `FRESH_NOTE`
   * after a worker death (`moved` is `WORKER_REPLACED`), else `WOKEN_NOTE` when this actor never started a worker
   * (`#startedWorker`). On failure, the job's deliveries are answered with the error (`#wakeError`) and dropped, and
   * the error is thrown. `plain` marks a re-advance only for a settled wait. Over the cost cap, unless ending, an
   * `advance` only delivers (`advance: false`, no record check), and none starts without deliveries; the advance
   * waits for a raise (`#needsAdvance`). A `chat` job always advances, so over the cap its `send` and `complete`
   * deliveries stay in `#next` for the next job, which only delivers; a chat job that fails answers them too. A
   * fresh run (`replace`) over the cap, unless ending, is held instead (`#heldFresh`): every spawn until a raise or End
   * keeps `#next` for it, as the fresh run would carry it, and answers its messages `queued` at once; the first spawn
   * after starts the held fresh run, and one that fails fails the session (`COULDNT_START`), as a failed reply's fresh
   * run does. An `advance` after restore found the run ended or unreadable is that fresh run (`#unresumable`); a run
   * that moved ends `OFFICE_REPLACED` until the first advancing worker since restore (`#sinceRestore`). Whether a
   * worker started.
   */
  async #spawn(
    kind: "chat" | "advance",
    {
      plain = false,
      replace = null,
      moved,
      seed = null,
    }: { plain?: boolean; replace?: Fresh | null; moved?: string; seed?: Seed | null } = {},
  ): Promise<boolean> {
    moved ??= this.#sinceRestore ? OFFICE_REPLACED : NEW_MODEL
    // A run restore found ended or unreadable is never advanced: its fresh run goes as a `replace`, held over the cap.
    if (kind === "advance") replace ??= this.#unresumable
    const { store } = this.#ctx
    const sid = this.sessionId
    if ((replace !== null || this.#heldFresh !== null) && !this.#ending && this.#capped()) {
      // Never delivered to the old run: its reply failed, or it can't be resumed.
      this.#heldFresh ??= replace
      this.#needsAdvance = true
      this.#next = this.#freshCarry(this.#next)
      for (const p of this.#next) {
        if (p.delivery.op !== "send" || p.done) continue
        p.early = true
        p.resolve("queued")
      }
      return false
    }
    const released = this.#heldFresh
    const from = this.#runId
    if (released !== null) {
      kind = "chat"
      replace = released
      this.#heldFresh = null
    }
    // A job over the cap never calls the model, so no endpoint is replayed: no record check.
    const over = !this.#ending && this.#capped()
    const advance = kind === "chat" || !over
    if (!advance) {
      this.#needsAdvance = true
      if (this.#next.length === 0) return false
    }
    let pendings = this.#next
    // A chat job always advances: over the cap, what would wake the agent waits for the job that only delivers.
    const held = kind === "chat" && over ? pendings.filter(wakes) : []
    pendings = pendings.filter((p) => !held.includes(p))
    this.#next = held
    // This spawn is the re-advance; one that fails leaves nothing to wait for.
    this.#readvance = false
    this.#readvancedFrom = plain ? this.#waits : null
    const waits = kind === "advance" ? (this.#waits ?? []) : []
    let run = new WorkerRun(this.#runId!, kind, pendings, waits, this.#lateSend)
    this.#starting = run
    // No worker runs now: a resumed worker re-emits the starts of the nodes it re-runs, and a fresh run (`#replace`,
    // only ever called below) has run nothing yet.
    this.#nodes.clear()
    try {
      if (this.#closed) throw stopping()
      const { session, name, model, provider, moved: removed } = await this.#checkProvider()
      const spec = await this.#specOf(session)
      const checked = kind === "advance" && advance
      const why = checked ? this.#recordCheck(run.runId, name, model, provider) : null
      const fresh = replace ?? (why === null ? null : { why: why === NEW_MODEL ? moved : why, finished: null })
      if (fresh !== null) {
        // A moved chat has its removal note, which says more; a run that never started needs none.
        const note = moved === WORKER_REPLACED ? FRESH_NOTE : this.#startedWorker ? null : WOKEN_NOTE
        if (replace === null && why === NEW_MODEL && !removed && note !== null) {
          store.updateSession(sid, { model_note: note })
        }
        seed = await this.#seed(session)
        await this.#replace(session, spec, fresh.why, fresh.finished)
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
      const tools = spec.groups({ session, runId, onQuestion: this.#onQuestion })
      const ask = this.#askUser(session, runId, spec)
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
        keep: this.#keepMs() > 0,
      })
      if (run.kind === "chat") store.setRunConfig(runId, runRecord(name, model, provider))
      const defaultPrice = await this.#defaultPrice(name)
      const handlers = this.#handlers(run, ask, tools, spec.stores)
      // The office may have stopped during the awaits above.
      if (this.#closed) throw stopping()
      run.provider = provider
      run.ranOn = { name, model }
      run.defaultPrice = defaultPrice
      run.seed = seed
      run.worker = await this.#launch(job, handlers, provider.env)
      this.#startedWorker = true
      // Only now: a spawn that fails leaves it for the next worker's take.
      this.#lateSend = false
      if (advance) {
        this.#needsAdvance = false
        // A job that only delivers skips the record check, so a later advance still replaces for the restart.
        this.#sinceRestore = false
      }
      this.#run = run
      this.#starting = null
      // The worker's result arms it again.
      this.#disarm()
      void this.#ctx.hooks.notify("runStarted", session, runId)
      // Busy before any caller hears back: the run isn't at its turn until it shows it.
      if (!this.#closed) this.#trySettle("after a spawn")
      return true
    } catch (error) {
      // Its text may name a file under office/connections: the log gets it, the caller a fixed reason (`spawnWhy`).
      if (error instanceof ProviderError) this.#log(`session ${sid}: its connection can't be used (${error.message})`)
      const refusal = this.#wakeError(error)
      for (const p of [...pendings, ...held]) p.reject(refusal)
      this.#next = this.#next.filter((p) => !held.includes(p))
      if (released !== null && !(error instanceof RegistryClosed) && !this.#closed) {
        // As a failed reply's fresh run that can't start: before the fresh run was stored, the failed result is how
        // the session's run ended; after, the fresh run never started.
        const stored = this.#runId !== from
        this.#finish("failed", stored ? null : released.finished, COULDNT_START, null)
      }
      throw error
    } finally {
      if (this.#starting === run) this.#starting = null
    }
  }

  /** Starts `job` with `handlers`: in the parked worker when it ran the same run on the same provider `env`, pin and
   *  model config, else in a new worker spawned with `env` once the parked one, if any, has exited (the registry
   *  keeps one worker per session). */
  async #launch(job: Job, handlers: WorkerHandlers<ActorWorker>, env: Record<string, string>): Promise<ActorWorker> {
    const parked = this.#parked
    if (parked !== null && reusable(parked.worker.job, parked.provider?.env ?? {}, job, env)) {
      this.#parked = null
      parked.timer.abort()
      this.#ctx.workers.unpark(parked.worker)
      let sent = false
      try {
        sent = await this.#ctx.workers.next(parked.worker, job, handlers)
      } finally {
        // Gone meanwhile, or the start frame can't be sent: it must exit before another worker spawns.
        if (!sent) {
          parked.worker.closeChannel()
          await parked.worker.wait()
        }
      }
      if (sent) return parked.worker
    }
    await this.#releaseParked()
    return this.#ctx.workers.spawn(job, this.#ctx.paths.sessionDir(this.sessionId), handlers, { env })
  }

  /** How long a worker stays parked; 0 keeps none. */
  #keepMs(): number {
    return this.#ctx.keepMs ?? KEEP_MS
  }

  /** Keeps `run`'s `worker`, which parked after its run call, until the idle timer, the registry's cap, a change of
   *  its connection or the next spawn ends it. */
  #keep(run: WorkerRun, worker: ActorWorker): void {
    const parked: Parked = { worker, provider: run.provider, ranOn: run.ranOn, timer: new AbortController() }
    this.#parked = parked
    const release = () => this.#post("parked worker release", () => this.#parked === parked && this.#releaseParked())
    this.#ctx.workers.park(worker, release)
    this.#ctx.scheduler.sleep(this.#keepMs(), parked.timer.signal).then(release, () => {})
    void this.#watchConnection(parked)
  }

  /** Checks `parked`'s connection every `checkMs` until it is released or reused. Never rejects. */
  async #watchConnection(parked: Parked): Promise<void> {
    const { signal } = parked.timer
    try {
      while (!signal.aborted) {
        await this.#ctx.scheduler.sleep(this.#ctx.checkMs ?? CHECK_MS, signal)
        await this.#checkConnection(parked)
      }
    } catch {
      // Aborted: the worker was released or reused.
    }
  }

  /**
   * Closes the parked worker if its connection no longer gives the provider it was spawned with: removed, re-keyed,
   * edited or unreadable. The office calls it when a connection changes; resolves once that worker has exited, or at
   * once when it is kept. A worker that parks after this call is left to its next check. Never rejects.
   */
  connectionsChanged(): Promise<void> {
    const parked = this.#parked
    return parked === null ? Promise.resolve() : this.#checkConnection(parked)
  }

  /** Closes `parked` on the queue, as the idle timer does, if its connection changed; resolves once it has exited. */
  async #checkConnection(parked: Parked): Promise<void> {
    if (!(await this.#connectionChanged(parked))) return
    this.#post("parked worker release", () => this.#parked === parked && this.#releaseParked())
    // The job just posted: it never rejects, and is skipped once the actor is closed.
    await this.#tail
  }

  /** Whether `parked`'s connection and model resolve to another provider than the one it was spawned with, or don't
   *  resolve now. */
  async #connectionChanged(parked: Parked): Promise<boolean> {
    // A worker spawned with no provider holds no key.
    if (parked.provider === null || parked.ranOn === null) return false
    try {
      const current = await this.#ctx.connections.resolve(parked.ranOn.name, parked.ranOn.model)
      return configHash(current) !== configHash(parked.provider)
    } catch (error) {
      // Removed, broken or unreadable: the worker may hold a key that was taken back. Anything else is logged by its
      // type, so a bug that would close every parked worker shows.
      if (!(error instanceof ProviderError || error instanceof BadConnectionName)) {
        this.#log(`session ${this.sessionId}: its parked worker's connection can't be checked (${errorName(error)})`)
      }
      return true
    }
  }

  /** Closes the parked worker, if any; resolves once it has exited. Never rejects. */
  #releaseParked(): Promise<void> {
    const parked = this.#parked
    if (parked === null) return Promise.resolve()
    this.#parked = null
    parked.timer.abort()
    this.#ctx.workers.unpark(parked.worker)
    parked.worker.closeChannel()
    return parked.worker.wait().then(() => {})
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

  /** The session, the connection, model and provider its next run uses, and whether it moved: a session whose
   *  connection was removed is moved to the default's own model once that resolves, with a note. Throws when they
   *  can't be resolved, having written nothing. */
  async #checkProvider(): Promise<{
    session: SessionRecord
    name: string
    model: string | null
    provider: Provider
    moved: boolean
  }> {
    const { store, connections } = this.#ctx
    let session = this.#session()
    const [name, model, moved] = await connections.choice(session.connection, session.model)
    const provider = await connections.resolve(name, model)
    if (moved) {
      const uses = await named(connections, name, model)
      const note = `Connection '${session.connection}' was removed; this chat now uses ${uses}.`
      session = store.updateSession(this.sessionId, { connection: name, model, model_note: note })
    }
    return { session, name, model, provider, moved }
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
    const env = (await this.#ranProvider(runId))?.env ?? {}
    return { log: this.#logOf(runId), env: { ...workerEnv(this.#ctx.environ), ...env }, cancel: true }
  }

  /** The provider of the connection and model run `runId` ran on, or null (logged by its type) when it can't be
   *  resolved now. */
  async #ranProvider(runId: string): Promise<Provider | null> {
    const row = this.#ctx.store.getRun(runId)
    try {
      return await this.#ctx.connections.resolve(row?.connection ?? null, row?.model ?? null)
    } catch (error) {
      this.#log(`session ${this.sessionId}: its run's connection can't be resolved (${errorName(error)})`)
      return null
    }
  }

  /** Ends the current run with the office end reason `why` (none when null: yian ended it) and makes a new run of
   *  `session` (built from `spec`) its replacement, in one transaction; then notifies `runFinished` for the old run
   *  with `finished`, not awaited. The old run's open questions go stale once the fresh run starts. Throws `503
   *  stopping` when the office stopped meanwhile, having written nothing. */
  async #replace(session: SessionRecord, spec: RunSpec, why: string | null, finished: Frame | null): Promise<void> {
    const { store, hooks } = this.#ctx
    const old = this.#runId!
    const owner = await this.#owner(session)
    // The office may have stopped during the awaits before: no run may be created for it.
    if (this.#closed) throw stopping()
    const runId = newId()
    const at = now()
    store.transaction(() => {
      // The old run's end is the new run's launch: that is how a run page knows one replaced the other.
      if (why !== null) store.endRun(old, why, at)
      this.#addRun(session, spec, owner, runId, old, at)
    })
    this.#log(`session ${this.sessionId} starts a fresh run (${why ?? "its run ended"})`)
    this.#runId = runId
    this.#ctx.runChanged?.(old)
    this.#replaced.push(old)
    this.#unresumable = null
    // What the old run waited on, and its deadlines, say nothing about the new one.
    this.#waits = null
    this.#readvancedFrom = null
    this.#disarm()
    void hooks.notify("runFinished", this.#session(), old, finished)
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

  /** Marks the open questions of the runs fresh runs replaced stale, and has the live relay forget those runs: the
   *  fresh worker cancelled them before its own started. */
  #staleReplaced(): void {
    const replaced = this.#replaced.splice(0)
    // Their workers exited before this fresh worker spawned: no frame of theirs can show them again.
    this.#ctx.live.forget(replaced)
    this.#staleQuestions(replaced)
  }

  /** Marks the open questions of the ended or cancelled runs `runIds` stale; a failure is logged by its type. */
  #staleQuestions(runIds: readonly string[]): void {
    const { store } = this.#ctx
    for (const runId of runIds) {
      for (const question of store.listQuestions({ runId, status: "open" })) {
        try {
          store.setQuestionStatus(question.id, "stale")
        } catch (error) {
          // Answered or closed meanwhile: it is no longer open either way.
          if (!(error instanceof InvalidTransition)) {
            this.#log(`session ${this.sessionId}: a run's question can't go stale (${errorName(error)})`)
          }
        }
      }
    }
  }

  /** A `complete` for each of `#unreadAnswers(next)`. */
  #storedAnswers(next: readonly Pending[]): Pending[] {
    return this.#unreadAnswers(next).map((q) => this.#complete(q, undefined))
  }

  /** The questions answered on a call of the current run whose answer never reached it (its spawn failed, or the
   *  office stopped first) and that `next` doesn't deliver: only calls the last result waits on unsettled, or every
   *  one when those waits are unknown. */
  #unreadAnswers(next: readonly Pending[]): QuestionRecord[] {
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

  /** Runs the office tool call `call`, which Esc, End, the worker's exit or the office stop answers
   *  `INTERRUPTED_CALL` at once. */
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
    options: { plain?: boolean; replace?: Fresh | null; moved?: string; seed?: Seed | null } = {},
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

      override stream(worker: ActorWorker, frame: Frame): void {
        // Not queued: frames must reach the relay in order with each other and before the worker's exit detaches it,
        // and a queue job may wait on a spawn.
        actor.#ctx.live.frame(worker, frame.frame)
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

      override parked(worker: ActorWorker): void {
        run.parked = true
        actor.#ctx.live.detach(worker)
        actor.#post("park", () => actor.#park(run, worker))
        // The finished session's last run call: nothing can show its runs again.
        if (actor.#finished && run === actor.#run) actor.#forgetRuns(actor.#finishedRuns)
      }

      override exited(worker: ActorWorker): void {
        run.exited = true
        if (actor.#parked?.worker === worker) {
          // A parked worker that dies (killed, crashed) is no death: the next run call spawns a new one.
          actor.#parked.timer.abort()
          actor.#parked = null
        }
        if (run.parked) return
        actor.#ctx.live.detach(worker)
        actor.#post("exit", () => actor.#exited(run))
        // The finished session's last worker: nothing can show its runs again.
        if (actor.#finished && run === actor.#run) actor.#forgetRuns(actor.#finishedRuns)
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
   *  its answer closes its question; a model call is charged, even once the session finished. */
  #event(run: WorkerRun, frame: Frame): void {
    if (run !== this.#run) return
    const data = (typeof frame.data === "object" && frame.data !== null ? frame.data : {}) as Record<string, unknown>
    // Charged even once finished: the call was paid for.
    if (frame.name === "ModelCallFinished") {
      if (typeof data.usage === "object" && data.usage !== null) this.#charge(run, data)
      return
    }
    if (this.#finished) return
    if (this.#nodes.apply(String(frame.name), data)) this.#ctx.runChanged?.(run.runId)
    const node = typeof data.node_id === "string" ? data.node_id : null
    switch (frame.name) {
      case "RunStarted":
        this.#staleReplaced()
        this.#trySettle("after a run started")
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
          if (this.#chat.isTurn(node)) {
            const iteration = this.#chat.iterationOf(node)
            if (iteration !== null) this.#took = { runId: run.runId, iteration }
          }
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
   *  acts on the cap; a usage without token counts is logged unpriced. */
  #charge(run: WorkerRun, data: Record<string, unknown>): void {
    const { store } = this.#ctx
    const usage = data.usage as CallUsage
    if (!Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) {
      this.#log(`session ${this.sessionId}: a model call is unpriced (its usage has no token counts)`)
      return
    }
    const model = typeof data.model === "string" ? data.model : null
    const usd = callUsd(run.provider?.prices ?? {}, model, usage, { default: run.defaultPrice })
    store.recordUsage({ sessionId: this.sessionId, runId: run.runId, model: model ?? "", usd })
    store.updateSession(this.sessionId, { cost: store.sessionUsageUsd(this.sessionId) })
    this.#overCap()
  }

  /** Over the cost cap: the running reply is stopped, the person's manager gets one item to raise the cap, and the
   *  session settles (waiting on that item's assignee). Under it, or once finished, nothing happens. */
  #overCap(): void {
    if (this.#finished || !this.#capped()) return
    if (this.#run !== null) this.#stopAtCap(this.#run)
    this.#ensureCapItem()
    this.#trySettle("at its cap")
  }

  /** Gives the person's manager an item to raise the session's cost cap, unless one is open. */
  #ensureCapItem(): void {
    const session = this.#session()
    // Else the manager already has one to act on.
    if (this.#capItem(session) !== undefined) return
    const cap = costCap(session, this.#pins!.defaults)
    const capText = cap.toFixed(cap < 0.01 ? 4 : 2)
    const t = now()
    this.#ctx.store.createWorkItem(
      WorkItem.parse({
        id: newId(),
        title: `${CAP_TITLE} of @${session.person}'s ${session.kind === "side" ? "side chat" : "session"}`,
        kind: "task",
        status: "open",
        requester: session.person,
        assignee: this.#pins!.manager,
        parent_id: session.work_item_id,
        summary:
          `Session ${session.id} reached its $${capText} cap (cost $${costFigure(session.cost)}). ` +
          "Its turns wait until the cap is raised.",
        created_at: t,
        updated_at: t,
      }),
    )
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
    return this.#pins !== null && session !== undefined && overCap(session, this.#pins)
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
    const stop = this.#stopCancel
    if (stop !== null && frame.id === stop.id) {
      const reply = checkedReply(frame)
      if (Object.hasOwn(reply, "seq")) this.#stopAfterExit = this.#stopAfterExit.filter((id) => id !== stop.runId)
      else this.#log(`session ${this.sessionId}: a cancel didn't take (${String(reply.refused ?? reply.failed)})`)
      return
    }
    const p = run.given.find((given) => given.delivery.id === frame.id && given.reply === null)
    if (p === undefined) return
    p.reply = checkedReply(frame)
    p.late = run.outcome !== null
    this.#post("deliver_reply", () => this.#replied(run, p))
  }

  /** Answers `p`'s caller from its reply: acknowledged (after closing the questions of the calls it closed, and
   *  marking the question a `complete` answered consumed), or refused. A `not_started` refusal, and a failure before
   *  any node event (the run may not have resumed), are held for the worker's exit. A delivery already answered is
   *  acted on only when it is a message the run took, which is shown, and the session hasn't finished. */
  #replied(run: WorkerRun, p: Pending): void {
    const reply = p.reply!
    const op = p.delivery.op
    // A message a held fresh run carried was answered `queued` at once; it is still shown once taken.
    if (p.done && !(p.early && Object.hasOwn(reply, "seq") && !this.#finished)) return
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

  /** Tells the session's clients `text` as a live assistant message with one error part, which is never stored: the
   *  transcript never returns it. */
  #notice(text: string): void {
    const message: Message = {
      id: newId(),
      session_id: this.sessionId,
      role: "assistant",
      author: null,
      parts: [{ id: newId(), type: "error", message: text }],
      created_at: now(),
    }
    try {
      this.#ctx.bus.publishLive({ type: "message.updated", session_id: this.sessionId, data: message })
    } catch (error) {
      this.#log(`session ${this.sessionId}: a notice can't be shown (${errorName(error)})`)
    }
  }

  /** A `result` or `error`: a waiting run's waits become the actor's. Acted on at the worker's exit. An ending result
   *  first brings the run index up to date (bounded by `INDEX_WAIT_MS`), so the run's end, reported at the exit
   *  queued behind this job, never finds the index behind it. */
  async #result(run: WorkerRun, frame: Frame): Promise<void> {
    if (run !== this.#run || this.#finished) return
    const { runIndex } = this.#ctx
    if (runIndex !== undefined && frame.type === "result" && ENDING.includes(String(frame.status))) {
      const done = new AbortController()
      await Promise.race([runIndex.update(), this.#ctx.scheduler.sleep(INDEX_WAIT_MS, done.signal).catch(() => {})])
      done.abort()
      // A close during the wait ends the job, as `#post` skips the jobs after a close.
      if (this.#closed) return
    }
    this.#disarm()
    if (frame.type === "result" && frame.status === "waiting") this.#waits = waitsOf(frame)
    run.turnPending = false
    this.#trySettle("after a result")
  }

  /**
   * The worker is gone; its outcome decides what comes next (as after a run call whose worker parked: `#park`).
   * After a `waiting` result, see `#waited`. A succeeded run ends the session; a worker gone with no outcome, or a
   * `stopped` or `crashed` run, is replaced once (`#died`), but a run the cap stopped, a delivering job's, or one
   * stopped or crashed over the cap isn't a death: its deliveries go on, with a real advance once the cap is raised;
   * an ending session over the cap ends `ENDED_OVER_CAP`; a run another process holds is tried once more
   * (`#runBusy`); a run whose reply, or whose fold after its take, failed is replaced by a fresh run (`#replyFailed`);
   * any other outcome fails the session.
   * Every delivery not carried is answered. A finished actor only starts its run's hard stop that waited for this
   * exit.
   */
  async #exited(run: WorkerRun): Promise<void> {
    if (run !== this.#run) return
    await this.#callEnded(run)
  }

  /** `run`'s worker parked after its run call: it is kept (`#keep`) unless it exited meanwhile, and the call ends as
   *  at an exit. */
  async #park(run: WorkerRun, worker: ActorWorker): Promise<void> {
    if (run !== this.#run) {
      worker.closeChannel()
      return
    }
    if (!run.exited) this.#keep(run, worker)
    await this.#callEnded(run)
  }

  /** `run`'s run call ended, its worker gone or parked: as `#exited` says. */
  async #callEnded(run: WorkerRun): Promise<void> {
    this.#run = null
    const session = this.#ctx.store.getSession(this.sessionId)
    if (session !== undefined) void this.#ctx.hooks.notify("callEnded", session)
    // Nobody is left to read what these calls return, finished or not.
    this.#interruptWorkspace()
    this.#answerCalls()
    if (this.#finished) {
      // Its hard stop spawns under the session's id, so a parked worker goes first.
      const runIds = this.#stopAfterExit.splice(0)
      void this.#releaseParked()
        .then(() => this.#stopJobs(runIds))
        .then(this.#stoppedAfterExit)
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
    if (status === "error" && run.capStopped && String(outcome!.message ?? "").startsWith(`Error: ${STOP_REASON}`)) {
      status = "stopped"
    }
    if (status === "waiting" || status === "succeeded") this.#deaths = 0
    if (!busy) {
      this.#busyRetried = false
      this.#rested = status === "waiting"
    }
    const stopped = status === "stopped" || status === "crashed"
    // Decided by how it stopped, not only by the cap now: a raise before the exit doesn't make a cap stop a death.
    const capStop = stopped && (run.capStopped || run.worker?.job.advance === false || this.#capped())
    if ((status === null || stopped) && this.#ending && this.#capped()) {
      // Over the cap an advance would resume the run and spend: it is cancelled, and the session ends.
      this.#log(`session ${this.sessionId}: ends over its cost cap`)
      this.#finish("ended", null, ENDED_OVER_CAP, run)
    } else if (capStop) {
      // The cap stopped it (or it crashed over the cap): not a death. Only its deliveries go on until a raise; after
      // one, a real advance resumes it.
      this.#log(`session ${this.sessionId}: its run ${status} at its cost cap`)
      // A run that reached the cap made progress, as a new turn did in Python.
      this.#deaths = 0
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
    } else if (status === "failed" && this.#recovers(run, outcome!)) {
      await this.#replyFailed(run, outcome!)
    } else {
      const ended = status === "failed" ? failedAt(outcome!, run.provider) : status
      this.#log(`session ${this.sessionId}: its run ended (${ended})`)
      // An error before yian wrote a log (a flow that won't load): its worker couldn't start the run. With a log,
      // how yian recorded the run stands, which an office end reason would hide.
      const unstarted = status === "error" && run.kind === "chat" && !fs.existsSync(this.#logOf(run.runId))
      this.#finish("failed", outcome, unstarted ? COULDNT_START : null, run)
    }
    this.#trySettle("after a worker exit")
  }

  /** Whether `run`'s failed result `outcome` failed at a reply node, or inside the turn's context once that turn's
   *  take succeeded in the same run: a fold that runs before any take (a flow that folds first, or a fresh run's)
   *  would fail again in the fresh run. */
  #recovers(run: WorkerRun, outcome: Frame): boolean {
    const id = failureOf(outcome).node_id
    if (typeof id !== "string") return false
    if (this.#chat.isReply(id)) return true
    const took = this.#took
    return this.#chat.inContext(id) && took?.runId === run.runId && took.iteration === this.#chat.iterationOf(id)
  }

  /**
   * `run`'s worker ended with a `waiting` result, whose waits are `#waits`. What it never answered (but an
   * `interrupt`) and what it refused `not_started` go to the next worker, which is spawned when there is any, when
   * `#next` holds some, or when a delivery came after the result (`readvance`). A settled wait alone is advanced
   * too, but not again when the last spawn was such a plain re-advance and the run still waits on the same calls,
   * each as settled as before: it made no progress, so it waits for the next command. With no worker started, the
   * timer waits for the earliest deadline. Over the cost cap, unless ending, only deliveries are taken to the run,
   * and the advance waits for a raise; an advance the cap held back is spawned once it is raised. An ending session
   * over the cap with a settled wait other than its turn's ends `ENDED_OVER_CAP`.
   */
  async #waited(run: WorkerRun, readvance: boolean): Promise<void> {
    const waits = this.#waits ?? []
    if (this.#ending && this.#capped() && this.#wakesAgent(waits)) {
      // A settled call would wake the agent and spend, as in End's path with no worker.
      this.#log(`session ${this.sessionId}: ends over its cost cap`)
      this.#finish("ended", null, ENDED_OVER_CAP, run)
      return
    }
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

  /** Whether a call in `waits` other than a turn's take is settled: advancing would wake the agent and spend. */
  #wakesAgent(waits: readonly Wait[]): boolean {
    return waits.some((wait) => wait.settled && !this.#chat.isTurn(wait.node))
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

  /** Moves the deliveries `run`'s worker never answered (an `interrupt` only with `interrupts`), those it refused
   *  `not_started` and, with `failed`, those that failed (an `interrupt` only with `interrupts`), to the front of
   *  `#next`; answers the rest it was given. A message a held fresh run answered early counts as never answered until
   *  a run takes it. */
  #carry(
    run: WorkerRun,
    { failed = false, interrupts = false }: { failed?: boolean; interrupts?: boolean } = {},
  ): void {
    const carry = run.given.filter((p) => {
      if (p.done && !p.early) return false
      if (p.reply === null || (failed && typeof p.reply.failed === "string")) {
        return interrupts || p.delivery.op !== "interrupt"
      }
      return p.reply.refused === "not_started"
    })
    this.#answerRest(
      run.given.filter((p) => !carry.includes(p)),
      this.#cantWake(),
    )
    this.#requeue(carry)
  }

  /** `run`'s advance was refused before it appended anything (`not_resumed`): a fresh run replaces the run
   *  (`COULDNT_RESUME`), carrying what `#carryFresh` keeps. */
  async #notResumed(run: WorkerRun): Promise<void> {
    this.#log(`session ${this.sessionId}: its run can't be resumed (${typeName(run.outcome!.error_type)})`)
    this.#carryFresh(run)
    await this.#spawnQuietly("chat", { replace: { why: COULDNT_RESUME, finished: null } })
  }

  /**
   * `run`'s reply, or its turn's context after the take, failed (its `failed` result `outcome`): the session is told
   * why ("The reply failed (…). Send your message again.", or "Summarizing the older messages failed (…)" when the
   * summarizer failed, with which connection to check when the model refused its key), the death count starts over,
   * and a fresh run replaces it, carrying what `#carryFresh` keeps; yian recorded the failure, so the old run gets no
   * office end reason, and `runFinished` gets `outcome`, key redacted. A fresh run that can't start fails the session
   * (`COULDNT_START`).
   */
  async #replyFailed(run: WorkerRun, outcome: Frame): Promise<void> {
    const failure = failureOf(outcome)
    const type = typeName(redactKey(failure.cause_type, run.provider))
    const id = String(failure.node_id)
    const where = this.#chat.isReply(id) ? "its reply failed" : `its context failed at ${nodePath(id, run.provider)}`
    this.#log(`session ${this.sessionId}: ${where} (${type})`)
    const reason = whyFailed(outcome, run.provider)
    const hint = refusedKey(failure, reason)
      ? ` Check connection '${this.#ranOn(run.runId)}', or pick another model with /model.`
      : ""
    const what = staticPathOf(id) === this.#chat.summarizer ? "Summarizing the older messages" : "The reply"
    this.#notice(`${what} failed (${reason}). Send your message again.${hint}`)
    this.#deaths = 0
    this.#carryFresh(run)
    try {
      await this.#spawn("chat", { replace: { why: null, finished: redactKey(outcome, run.provider) as Frame } })
    } catch (error) {
      this.#log(`session ${this.sessionId}: a worker can't start (${errorName(error)})`)
      if (error instanceof RegistryClosed || this.#closed) return
      // Before the fresh run was stored, the failed result is how the session's run ended; after, the fresh run
      // never started.
      const stored = this.#runId !== run.runId
      this.#finish("failed", stored ? null : outcome, COULDNT_START, stored ? null : run)
    }
  }

  /** The connection run `runId` ran on, by its row; the session's when the row can't tell. */
  #ranOn(runId: string): string {
    const { store } = this.#ctx
    return store.getRun(runId)?.connection ?? store.getSession(this.sessionId)?.connection ?? OFFICE
  }

  /** Puts what a fresh run carries (`#freshCarry`) of the deliveries `run` never applied (no reply, refused
   *  `not_started`, or failed; a message answered early included) in front of `#next`; the sends it applied move
   *  with the seed. Every other delivery it was given is answered by the closing rule. */
  #carryFresh(run: WorkerRun): void {
    const unapplied = run.given.filter((p) => {
      const reply = p.reply
      const answered = reply !== null && reply.refused !== "not_started" && typeof reply.failed !== "string"
      return (!p.done || p.early) && !answered
    })
    this.#answerRest(
      run.given.filter((p) => !unapplied.includes(p)),
      this.#cantWake(),
    )
    // Filtered now, while the replies the closing rule reads are still there.
    this.#requeue(this.#freshCarry(unapplied))
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
   *  plain `advance` takes over with what it carried, an `interrupt` it never answered included (a fresh run, the old
   *  one ending `WORKER_REPLACED`, when the run's record no longer gives what it ran on). After a worker gone with no
   *  outcome, one that can't start fails the session (`#cantStartWhy`); after a `stopped` or `crashed` run, a failed
   *  spawn is only logged and the session waits for the next message (an ending one fails, as `#spawnQuietly` says).
   *  Again before a `waiting` or `succeeded` result, the session fails (`WORKER_STOPPED`). */
  async #died(run: WorkerRun, status: string | null): Promise<void> {
    this.#log(`session ${this.sessionId}: ${status === null ? "its worker exited (no outcome)" : `its run ${status}`}`)
    if (this.#deaths >= 1) {
      // A third try won't do better: a run that stops or crashes on every launch must not respawn forever.
      this.#finish("failed", null, WORKER_STOPPED, run)
      return
    }
    this.#deaths += 1
    // The advance resumes the reply the interrupt was meant to cut; yian keeps a Stop that already took, so the
    // interrupt sent again does nothing more.
    this.#carry(run, { interrupts: true })
    if (status !== null) {
      await this.#spawnQuietly("advance", { moved: WORKER_REPLACED })
      return
    }
    try {
      await this.#spawn("advance", { moved: WORKER_REPLACED })
    } catch (error) {
      this.#log(`session ${this.sessionId}: a worker can't start (${errorName(error)})`)
      if (!(error instanceof RegistryClosed) && !this.#closed) this.#finish("failed", null, this.#cantStartWhy(), run)
    }
  }

  /**
   * Finishes the session with `status` (`ended`: the first `endStatus` result, its work item done; or `failed`) in
   * one transaction with the run's office end reason `why`, written only when no yian outcome ended the run (`outcome`,
   * else the one `run`'s worker recorded, else the end restore found); its open cost cap item is cancelled first. A
   * failed session is told why ("The session failed (…). Start a new chat."). `runFinished` (the result frame of how
   * the run ended, key redacted, else null) then `sessionEnded` are notified in order, not awaited. Every delivery not
   * answered gets `409 not_live`. A run yian may still see unfinished gets a hard stop, as does each replaced run no
   * fresh worker cancelled. The live relay forgets the session's runs now with no worker alive, else at that worker's
   * exit. Throws `HarnessError` (`404`) when the session row is gone; a store write that fails is logged by its type.
   * While a fresh run is held, the run is reported with the held run's result and end reason, as the fresh run would
   * have reported it.
   */
  #finish(status: "ended" | "failed", outcome: Frame | null, why: string | null, run = this.#run): void {
    if (this.#finished) return
    this.#finished = true
    this.#reconcileDue = null
    // The failed run is reported as its held fresh run would have reported it.
    const held = this.#heldFresh
    if (held !== null) {
      outcome ??= held.finished
      why = held.why ?? why
      this.#heldFresh = null
    }
    const { store, hooks } = this.#ctx
    this.#disarm()
    const runId = this.#runId
    // A run restore found ended in yian keeps that end.
    const recorded = outcome ?? run?.outcome ?? (this.#unresumable?.why === null ? this.#unresumable.finished : null)
    const ended = recorded?.type === "result" && ENDING.includes(String(recorded.status))
    // `runFinished` gets the result that ended the run: `outcome` when the caller passes one (a `succeeded` run, or
    // a `failed`, `cancelled` or other result the session fails on, as Python's `_finish` passed it), else a
    // `succeeded`, `failed` or `cancelled` result `run`'s worker recorded. A recorded `waiting`, `stopped` or
    // `crashed` result isn't how the run ended (the office ends it here, with a hard stop): null, as Python's death
    // path passed None. An `error` frame isn't a result: null too.
    const reported = outcome ?? (ended ? recorded : null)
    try {
      const session = this.#session()
      this.#finishedRuns = session.run_ids
      try {
        // No cap is left to raise; `done` would say someone raised it.
        const cap = this.#capItem(session)
        if (cap !== undefined) store.updateWorkItem(cap.id, { status: "cancelled" })
      } catch (error) {
        this.#log(`session ${this.sessionId}: can't cancel its cap item (${errorName(error)})`)
      }
      if (status === "failed") {
        this.#notice(`The session failed (${whyFailed(reported, run?.provider ?? null)}). Start a new chat.`)
      }
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
      // With a worker alive, its last frames would show the runs again: its exit forgets them.
      if (this.#run === null || this.#run.exited || this.#run.parked) this.#forgetRuns(this.#finishedRuns)
    } catch (error) {
      if (error instanceof HarnessError) throw error
      this.#log(`session ${this.sessionId}: can't store the end (${errorName(error)})`)
    } finally {
      const given = [...(run?.given ?? []), ...(this.#run?.given ?? []), ...this.#next.splice(0)]
      this.#answerRest(given, new HarnessError(409, "not_live", `session ${this.sessionId} has no live run`))
      this.#stopRuns(!ended ? runId : null, this.#replaced.splice(0))
      // Its end is stored, or yian's index has it (the ending result's job brought it up to date); a replaced run's
      // end was told when `#replace` stored it.
      if (runId !== null) this.#ctx.runChanged?.(runId)
    }
  }

  /** Drops what the transcript cache and the live relay hold of runs `runIds`. */
  #forgetRuns(runIds: readonly string[]): void {
    this.#ctx.transcript.forget(runIds)
    this.#ctx.live.forget(runIds)
  }

  /** The hard stop of run `runId` (none when null) and of the `replaced` runs, best effort: a `cancel` of `runId`
   *  through its live worker; one `advance: false` job that only cancels it for every other run, and for `runId`
   *  unless the worker took that cancel, once the parked worker is closed, or after the lingering worker's exit. */
  #stopRuns(runId: string | null, replaced: string[]): void {
    const run = this.#run
    const runIds = runId === null ? replaced : [...replaced, runId]
    if (run === null || run.worker === null) {
      // A stop job spawns under the session's id, so a parked worker goes first.
      this.#stopped = this.#releaseParked().then(() => this.#stopJobs(runIds))
      return
    }
    this.#stopAfterExit = runIds
    this.#stopped = new Promise((resolve) => (this.#stoppedAfterExit = resolve))
    if (runId === null || run.outcome !== null) return
    // The run keeps its stop job until the worker's reply shows the cancel took (`#arrived`): a run that never
    // resumed refuses it.
    const id = newId()
    this.#stopCancel = { id, runId }
    run.worker
      .deliver({ id, op: "cancel" })
      .catch((error) => this.#log(`session ${this.sessionId}: a cancel can't be sent (${errorName(error)})`))
  }

  /** `#stopJob` for each of `runIds`, one after another: a session has one worker at a time. Never rejects. */
  async #stopJobs(runIds: readonly string[]): Promise<void> {
    for (const runId of runIds) await this.#stopJob(runId)
  }

  /** Spawns one `advance: false` job that cancels run `runId`, whose frames nobody reads, and resolves once its
   *  worker exits; skipped when the run has no log (it never started). A failure is logged by its type. */
  async #stopJob(runId: string): Promise<void> {
    const { paths } = this.#ctx
    try {
      const log = this.#logOf(runId)
      if (!fs.existsSync(log)) return
      const session = this.#session()
      // The job only cancels, so it calls no model: a connection that can't be resolved now doesn't stop it.
      const provider = await this.#ranProvider(runId)
      const job = chatJob(await this.#specOf(session), {}, {
        kind: "advance",
        session,
        runId,
        pin: await this.#ctx.git.pin(session.repo_commit),
        log,
        llmConfig: provider?.llm_config ?? null,
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
          const reply = checkedReply(frame)
          if (typeof reply.refused === "string") note(`was refused (${reply.refused})`)
          else if (typeof reply.failed === "string") note(`failed (${reply.failed})`)
        }

        override error(_worker: unknown, frame: Frame): void {
          note(`ended in an error (${errorType(frame)})`)
        }

        override exited(): void {
          exited()
        }
      })()
      await this.#ctx.workers.spawn(job, paths.sessionDir(this.sessionId), handlers, { env: provider?.env ?? {} })
      await gone
    } catch (error) {
      this.#log(`session ${this.sessionId}: its run can't be stopped (${errorName(error)})`)
    }
  }

  /**
   * The closing rule: answers each of `pendings` that has no answer yet and isn't carried. A held `not_started` is
   * `503 cant_wake`, a held failure `failure` (by default `503 cant_wake` naming its type); a lost `interrupt` or
   * `cancel` (not carried: its worker returned a result, a fresh run replaced the run, or the session finished), or
   * a dropped `complete` of a card's answer (its question stays answered), is resolved; any other delivery with no
   * reply, a message's `complete` included, gets `fallback`.
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
      this.#log(`session ${this.sessionId}: its wake-at timer waits for its cost cap to be raised`)
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

  /** The run spec, built once per actor; the first build also reconciles the questions restore left
   *  (`#reconcileDue`), unless the session finished, the actor closed or another run replaced that one. */
  async #specOf(session: SessionRecord): Promise<RunSpec> {
    if (this.#spec === null) {
      const spec = await this.#ctx.spec(session)
      this.#spec = spec
      const due = this.#reconcileDue
      this.#reconcileDue = null
      if (due !== null && due === this.#runId && !this.#finished && !this.#closed) {
        await this.#reconcile(session, spec, due)
      }
    }
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
    return new HarnessError(503, "cant_wake", `session ${this.sessionId} can't wake${spawnWhy(error)}`)
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

/** What a caller is told of a spawn that failed with `error`, after the session's id. Never the error's text: a
 *  provider error's may name a file under office/connections, and anything else may hold anything; `#spawn` logs a
 *  provider error's text. */
function spawnWhy(error: unknown): string {
  return error instanceof ProviderError ? ": its connection can't be used; see the office log" : "; see the office log"
}

/** Whether `error` is the session folder's refusal (`checkFolder`): missing, not a folder, or unsafe. */
function folderRefused(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    error.status === 422 &&
    (error.code === "invalid_body" || error.code === "unsafe_workspace")
  )
}

/** Whether `session`'s cost is at or over its cap, the pinned default if it has none of its own. */
function overCap(session: SessionRecord, pins: Pins): boolean {
  return session.cost >= costCap(session, pins.defaults)
}

/** `usd` to 4 decimals, never below it: a cap above the figure is above the cost. */
function costFigure(usd: number): string {
  let figure = Math.round(usd * 1e4) / 1e4
  if (figure < usd) figure += 1e-4
  return figure.toFixed(4)
}

/** Whether `p` wakes the agent: a message (`send`) or a call's answer (`complete`). */
function wakes(p: Pending): boolean {
  return p.delivery.op === "send" || p.delivery.op === "complete"
}

/** The error type an `error` frame names (its message reads `<type>: <message>`), never its message. */
function errorType(frame: Frame): string {
  return typeName(String(frame.message ?? "").split(":", 1)[0])
}

/** `value` when it reads as an error type's name, else `Error`: a log line carries nothing else a worker sent. */
function typeName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z_][\w.]{0,99}$/.test(value) ? value : "Error"
}

/** The static path of node id `id` when it reads as one, `provider`'s key redacted, else `a node`: a log line
 *  carries nothing else a worker sent. */
function nodePath(id: unknown, provider: Provider | null): string {
  const at = redactKey(typeof id === "string" ? staticPathOf(id) : "", provider)
  return typeof at === "string" && /^[A-Za-z_][\w./-]{0,199}$/.test(at) ? at : "a node"
}

/** Where and how the failed result `outcome` failed, for a log line: the node's static path and the error type,
 *  `provider`'s key redacted. */
function failedAt(outcome: Frame, provider: Provider | null): string {
  const failure = failureOf(outcome)
  return `failed at ${nodePath(failure.node_id, provider)}: ${typeName(redactKey(failure.cause_type, provider))}`
}

/** `frame` with its `refused` reason kept only when it reads as one (else `refused`) and its `failed` only when it
 *  reads as an error type (else `Error`): both reach logs and client errors, and a worker may write anything. */
function checkedReply(frame: Frame): Frame {
  const reason = frame.refused
  if (typeof reason === "string" && !/^[a-z_]{1,40}$/.test(reason)) return { ...frame, refused: "refused" }
  if (typeof frame.failed === "string") return { ...frame, failed: typeName(frame.failed) }
  return frame
}

/** The `failure` of a result frame, `{}` when it has none. */
function failureOf(frame: Frame): Record<string, unknown> {
  const failure = frame.failure
  return typeof failure === "object" && failure !== null ? (failure as Record<string, unknown>) : {}
}

/** Why a run failed, by its outcome (a `result` or `error` frame; null when its worker stopped or couldn't start),
 *  without `provider`'s model key and in at most `WHY_CHARS` characters. */
function whyFailed(outcome: Frame | null, provider: Pick<Provider, "llm_config"> | null): string {
  if (outcome === null) return "its worker stopped or couldn't start; see the office log"
  const failure = failureOf(outcome)
  const cause = failure.cause_type
  const message = failure.message || outcome.message || "no reason given"
  const why = redactKey(cause ? `${cause}: ${message}` : String(message), provider) as string
  const chars = [...why]
  return chars.length <= WHY_CHARS ? why : `${chars.slice(0, WHY_CHARS - 1).join("")}…`
}

/** Whether a run failed (its `failure`, and `why` as `whyFailed` says it) because the model refused the connection's
 *  key: an auth error type, a standalone 401, or yian's `auth` or `permission` provider-error kind. */
export function refusedKey(failure: Record<string, unknown>, why: string): boolean {
  const cause = typeof failure.cause_type === "string" ? failure.cause_type : ""
  return AUTH_CAUSES.some((type) => cause.endsWith(type)) || /\b401\b|\((?:auth|permission)\)/.test(why)
}

/** The result frame of run `runId`, which yian ended as `inspection` says, in a worker's result frame's form, the key
 *  of `provider` redacted. */
function endedFrame(runId: string, inspection: RunInspection, provider: Provider | null): Frame {
  const failure = inspection.failure?.toJSON() ?? null
  const frame = { type: "result", status: inspection.status, run_id: runId, output: null, failure, waits: [] }
  return redactKey(frame, provider) as Frame
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

/** A worker kept after its run call, spawned with `provider`, which connection and model `ranOn` resolved to;
 *  `timer` aborts once it is released or reused. */
type Parked = {
  worker: ActorWorker
  provider: Provider | null
  ranOn: { name: string; model: string | null } | null
  timer: AbortController
}

/** Whether a worker parked after `previous`, spawned with `before`, can run `job` with `env`: an `advance` of the same
 *  run, log and pin, with the same model config and provider env (a worker's env is fixed at its spawn). */
function reusable(previous: Job, before: Record<string, string>, job: Job, env: Record<string, string>): boolean {
  const sorted = (record: Record<string, string>) => JSON.stringify(Object.entries(record).sort())
  return (
    job.kind === "advance" &&
    job.run_id === previous.run_id &&
    job.log === previous.log &&
    job.pin === previous.pin &&
    JSON.stringify(job.llm_config) === JSON.stringify(previous.llm_config) &&
    sorted(env) === sorted(before)
  )
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

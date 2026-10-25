/** One live chat session: a serial queue that drives the session's yian run through one worker process per run
 *  call, the way `yian chat` does (deliver, then `advance`, again while the run waits). */
import path from "node:path"
import type { Scheduler } from "@ngocbh/yian/platform"
import { CompanyDefaults, now } from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import { loadRepo } from "../company/loader.ts"
import type { Bus } from "../daemon/bus.ts"
import type { OfficePaths } from "../daemon/office.ts"
import type { Env } from "../install/launch.ts"
import { type Answers, makeAskUser, type OnQuestion } from "../questions/ask.ts"
import { COULDNT_START, flowLabel, OFFICE as OFFICE_DRIVER } from "../runs/outcomes.ts"
import { newId, type SessionRecord, type Store } from "../store/store.ts"
import { type Frame, FrameTooLarge } from "../worker/channel.ts"
import type { Delivery, Job } from "../worker/job.ts"
import { type AskRequest, BaseHandlers, errorName, type OfficeTool, type WorkerHandlers } from "../worker/rpc.ts"
import { RegistryClosed, type Worker } from "../worker/spawn.ts"
import { type Connections, runRecord } from "./connections.ts"
import type { Hooks } from "./hooks.ts"
import { ProviderError } from "./provider.ts"
import { chatJob, type RunSpec } from "./run_spec.ts"
import { HarnessError, LIVE, notWaiting, runState, SETTLED, writeState } from "./state.ts"
import type { Transcript } from "./transcript.ts"
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
  /** Settles with the caller's answer: `acked`, or the `HarnessError` the delivery is refused with. */
  readonly answer: Promise<unknown>
  #resolve!: (value: unknown) => void
  #reject!: (error: unknown) => void

  constructor(delivery: Delivery, acked: unknown = undefined) {
    this.delivery = delivery
    this.acked = acked
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

  /** A worker given `given`, over a run that waits at `waits`. */
  constructor(given: Pending[], waits: readonly Wait[]) {
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
export class SessionActor {
  readonly sessionId: string
  readonly #ctx: ActorContext
  #tail: Promise<unknown> = Promise.resolve()
  #runId: string | null
  #run: WorkerRun | null = null
  #spawning = false
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
    return this.#run !== null || this.#spawning
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
        this.#failStart(stored ? runId : null)
        if (error instanceof HarnessError) throw error
        // A provider error never echoes the file; anything else may hold anything, so it stays in the log.
        const why = error instanceof ProviderError ? `: ${error.message}` : "; see the office log"
        throw new HarnessError(500, "start_failed", `session ${sid} failed to start${why}`)
      }
    })
  }

  /**
   * Takes a message from `by` (the owner when null): sends it to the run's inbox and resolves once the run has it.
   *
   * The reply is decided when the message is queued: `steer` while a reply node runs, `turn` while the run waits only
   * at its turn, else `queued`. Refused with `409 not_live` (the session finished), `503 stopping` (the office
   * stops), `409 ending`, `422 refused` (a `promptCheck` hook), `422 too_large`, or `503 cant_wake` (the run could not
   * take it).
   */
  async prompt(text: string, { by = null }: { by?: string | null } = {}): Promise<MessageReply> {
    const pending = await this.#command(async () => {
      const session = this.#live()
      for (const refusal of this.#ctx.hooks.fire("promptCheck", session, text)) {
        if (refusal) throw new HarnessError(422, "refused", String(refusal))
      }
      const spec = await this.#specOf(session)
      const author = by ?? (await this.#owner(session))
      const event = { role: "user", parts: [{ type: "text", text }], ...(author ? { author } : {}) }
      const delivery: Delivery = { id: newId(), op: "send", inbox: spec.chat.inbox, event }
      const p = new Pending(delivery, this.#replyNow(session))
      await this.#deliver(p)
      return p
    })
    return (await pending.answer) as MessageReply
  }

  /** A steer is a message: the running reply reads it before its next model call, else the next turn does. */
  steer(text: string, options: { by?: string | null } = {}): Promise<MessageReply> {
    return this.prompt(text, options)
  }

  /**
   * Writes the session's run state from what its run waits in: busy while a worker is being spawned, or while a
   * worker runs the run and it isn't at its turn; else idle. `writeState` leaves ending and finished sessions alone.
   * Called inside queue jobs.
   */
  settle(): void {
    const { store } = this.#ctx
    const session = store.getSession(this.sessionId)
    if (session === undefined || !SETTLED.includes(session.status)) return
    const run = this.#run
    const running = this.#spawning || (run !== null && run.outcome === null && !this.#runAtTurn(run))
    writeState(store, this.sessionId, runState({ waiting: false, running }), [])
  }

  /** Office stop: later commands are refused `503 stopping` and later worker frames are ignored. */
  close(): void {
    this.#closed = true
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

  /** Runs `job` on the queue and settles with what it returns or throws; refused `503 stopping` after `close`. */
  #command<T>(job: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(stopping())
    return new Promise<T>((resolve, reject) => {
      this.#tail = this.#tail.then(async () => {
        if (this.#closed) return reject(stopping())
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
    const run = this.#run
    if (run !== null && run.worker !== null && run.outcome === null) {
      run.given.push(p)
      if (p.delivery.op === "send") run.turnPending = true
      let sent: boolean
      try {
        sent = await run.worker.deliver(p.delivery)
      } catch (error) {
        run.given.splice(run.given.indexOf(p), 1)
        this.#log(`session ${this.sessionId}: a ${p.delivery.op} can't be sent (${errorName(error)})`)
        p.reject(error instanceof FrameTooLarge ? tooLarge() : this.#cantWake(errorName(error)))
        return
      }
      if (sent) return
      // The worker read its last frame meanwhile; its exit decides the next spawn.
      run.given.splice(run.given.indexOf(p), 1)
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
   *  unsettled take (unknown waits: whether the session is idle). */
  #atTurn(session: SessionRecord): boolean {
    if (this.#spawning) return false
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
    const pendings = this.#next
    this.#next = []
    this.#spawning = true
    try {
      const runId = this.#runId!
      let session = this.#session()
      const [name, model, moved] = await connections.choice(session.connection, session.model)
      if (moved) session = store.updateSession(sid, { connection: name, model })
      const provider = await connections.resolve(name, model)
      const spec = await this.#specOf(session)
      const onQuestion: OnQuestion = (question, options) => this.#ctx.answers.ask(question, options)
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
      const run = new WorkerRun(pendings, kind === "advance" ? (this.#waits ?? []) : [])
      const handlers = this.#handlers(run, ask, tools, spec.stores)
      run.worker = await this.#ctx.workers.spawn(job, paths.sessionDir(sid), handlers, { env: provider.env })
      this.#run = run
      this.#readvance = false
      void this.#ctx.hooks.notify("runStarted", session, runId)
    } catch (error) {
      this.#log(`session ${sid}: a worker can't start (${errorName(error)})`)
      const refusal = this.#wakeError(error)
      for (const p of pendings) p.reject(refusal)
      throw error
    } finally {
      this.#spawning = false
    }
  }

  /** `#spawn`, whose failure it already logged and answered. */
  async #spawnQuietly(kind: "chat" | "advance"): Promise<void> {
    try {
      await this.#spawn(kind)
    } catch {}
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
        return ask(request, callId)
      }
    })({ tools, stores })
  }

  // --- worker frames ----------------------------------------------------------------------

  /** Tracks the nodes in flight and the turn; a reply node that succeeds counts a turn. */
  #event(run: WorkerRun, frame: Frame): void {
    if (run !== this.#run) return
    const data = (typeof frame.data === "object" && frame.data !== null ? frame.data : {}) as Record<string, unknown>
    const node = typeof data.node_id === "string" ? data.node_id : null
    switch (frame.name) {
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

  /** Records a `deliver_reply` on its delivery as it arrives, so the answer is known before its job runs. */
  #arrived(run: WorkerRun, frame: Frame): void {
    const p = run.given.find((given) => given.delivery.id === frame.id && given.reply === null)
    if (p === undefined) return
    p.reply = frame
    p.late = run.outcome !== null
    this.#post("deliver_reply", () => this.#replied(run, p))
  }

  /** Answers `p`'s caller from its reply: acknowledged, or refused. A `not_started` refusal, and a failure before
   *  any node event (the run may not have resumed), are held for the worker's exit. */
  #replied(run: WorkerRun, p: Pending): void {
    if (p.done) return
    const reply = p.reply!
    const op = p.delivery.op
    if (Object.hasOwn(reply, "seq")) {
      if (p.late && (op === "send" || op === "complete" || op === "close")) this.#readvance = true
      p.resolve(p.acked)
    } else if (typeof reply.refused === "string") {
      // The reason only: a delivery never names the message's text.
      this.#log(`session ${this.sessionId}: a ${op} was refused (${reply.refused})`)
      if (reply.refused !== "not_started") p.reject(refusalOf(reply.refused))
    } else {
      this.#log(`session ${this.sessionId}: a ${op} failed (${String(reply.failed)})`)
      if (run.nodeEvent) p.reject(this.#cantWake(String(reply.failed)))
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
    const session = this.#ctx.store.getSession(this.sessionId)
    if (session !== undefined) void this.#ctx.hooks.notify("workerExited", session, returncode)
    try {
      // Nobody is left to read what its calls return.
      this.#spec?.workspace?.interrupt()
    } catch (error) {
      this.#log(`session ${this.sessionId}: the workspace can't be interrupted (${errorName(error)})`)
    }
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
      if (this.#readvance || this.#next.length > 0) await this.#spawnQuietly("advance")
    } else {
      const status = outcome === null ? "no outcome" : outcome.type === "result" ? String(outcome.status) : "error"
      this.#log(`session ${this.sessionId}: its worker exited (${status})`)
      this.#answerRest([...run.given, ...this.#next.splice(0)], this.#cantWake())
    }
    this.#trySettle("after a worker exit")
  }

  /**
   * The closing rule: answers each of `pendings` that has no answer yet and isn't carried. A held `not_started` or
   * failure is `503 cant_wake`; a lost `interrupt` or `cancel`, or a dropped `complete`, is resolved; any other
   * delivery with no reply gets `fallback`.
   */
  #answerRest(pendings: readonly Pending[], fallback: HarnessError): void {
    for (const p of pendings) {
      if (p.done) continue
      const reply = p.reply
      const op = p.delivery.op
      if (reply === null) {
        if (op === "interrupt" || op === "cancel" || op === "complete") p.resolve(undefined)
        else p.reject(fallback)
      } else if (Object.hasOwn(reply, "seq")) {
        p.resolve(p.acked)
      } else if (typeof reply.failed === "string") {
        p.reject(this.#cantWake(reply.failed))
      } else {
        p.reject(reply.refused === "not_started" ? this.#cantWake() : refusalOf(String(reply.refused)))
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

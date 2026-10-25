/** One Codex session the owner drives: its app-server, its thread, its transcript and its turns. */
import path from "node:path"
import { HarnessError, runState, writeState } from "../chat/state.ts"
import type { SessionRecord, Store } from "../store/store.ts"
import { type CodexProcess, CodexStartError, ownerLoad } from "./codex.ts"
import { RpcClosed, RpcError, nameOf } from "./rpc.ts"
import { type Issued, Translator } from "./translate.ts"
import type { CodexSessions } from "./sessions.ts"

/** Milliseconds office stop waits for the session to finish the job it is in. */
export const STOP_WAIT_MS = 10_000
/** Milliseconds an ending session waits for its interrupted turn to complete before it closes the app-server anyway. */
export const END_WAIT_MS = 10_000
/** Milliseconds an answer waits for the session to write its reply. */
export const REPLY_WAIT_MS = 30_000
/** Codex's turn/start error for a thread it has unloaded. */
const NOT_LOADED = /^thread not (found|loaded)\b/
/** Codex's thread/resume error for a thread another app-server (a Codex window, `codex exec`) has loaded. */
const WRITER_LOCK = /\balready has an active writer\b/i
export const OPEN_ELSEWHERE =
  "This Codex session is open in another Codex window or process; close it there and try again."

/** Whether `error` is a request that got no answer in time (`JsonRpc.request`'s `TimeoutError`). */
function isTimeout(error: unknown): error is Error {
  return error instanceof Error && error.name === "TimeoutError"
}

/** What an error part says about a failed load: what went wrong and what to do, never Codex's stderr. */
export function why(error: unknown): string {
  if (error instanceof CodexStartError) return error.message
  if (error instanceof RpcError && WRITER_LOCK.test(error.rpcMessage)) return OPEN_ELSEWHERE
  if (error instanceof RpcError) return `Codex refused to load the thread: ${error.rpcMessage}`
  if (isTimeout(error)) return `Codex didn't answer in time: ${error.message}`
  return "Codex couldn't start; see the office log."
}

const USAGE = ["input_tokens", "cached_input_tokens", "output_tokens"] as const

/** A thread's token counts. */
export type Usage = Record<(typeof USAGE)[number], number>

/** The thread's token counts before `session` began: every earlier stretch's own counts, summed. */
export function usageBase(store: Store, session: SessionRecord): Usage {
  const base: Usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
  let parent = session.parent_session_id ? store.getSession(session.parent_session_id) : undefined
  while (parent !== undefined) {
    for (const key of USAGE) base[key] += parent.harness_usage?.[key] ?? 0
    parent = parent.parent_session_id ? store.getSession(parent.parent_session_id) : undefined
  }
  return base
}

/** Resolves true once `promise` settles, false after `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))
  try {
    return await Promise.race([promise.then(() => true), late])
  } finally {
    clearTimeout(timer)
  }
}

/** A message as `turn/start`'s input. */
function input(text: string) {
  return [{ type: "text", text, text_elements: [] }]
}

/** A JSON object from the wire: `any`, since its shape is whatever Codex sent. */
type Obj = Record<string, any>

/** A server request Codex waits on: its JSON-RPC id and its card. */
export type Pending = { requestId: unknown; issued: Issued }

/** What `thread/start` and `thread/resume` answer, as far as a load reads it. */
type Loaded = { thread: { id: string }; model?: string | null }

/** One Codex session's app-server, thread, transcript and turns.
 *
 *  Callers (`prompt`, `end`, `shutdown`) change its fields synchronously and await Codex outside any job; loads,
 *  app-server messages and process exits run as jobs on the session's own queue, one at a time, in order. A
 *  synchronous stretch is what Python's lock was: no `await` comes between a check and the write it guards. */
export class CodexSession {
  readonly owner: CodexSessions
  readonly store: Store
  readonly sessionId: string
  readonly cwd: string
  threadId: string | null
  /** Who a message with no named sender is from. */
  readonly author: string | null
  /** The thread's token counts before this stretch. */
  readonly base: Usage
  /** The session's codex.log, where its app-servers' stderr goes. */
  readonly log: string
  readonly translator: Translator
  process: CodexProcess | null = null
  /** The app-server being started, which office stop kills too. */
  launching: CodexProcess | null = null
  /** Closing: Codex unloaded its thread; office stop kills it too. */
  retiring: CodexProcess | null = null
  loading = false
  turnId: string | null = null
  pending: string[] = []
  /** Question id -> the request Codex waits on. */
  readonly requests = new Map<string, Pending>()
  /** String(request id) -> question id. */
  readonly byRequest = new Map<string, string>()
  /** The end wait, while ending. */
  timer: ReturnType<typeof setTimeout> | null = null
  ending = false
  closed = false
  stopped = false
  #tail: Promise<void> = Promise.resolve()
  #running: Promise<void> | null = null

  constructor(owner: CodexSessions, session: SessionRecord, { author }: { author: string | null }) {
    this.owner = owner
    this.store = owner.store
    this.sessionId = session.id
    this.cwd = session.cwd
    this.threadId = session.harness_session_id
    this.author = author
    this.base = usageBase(this.store, session)
    this.log = path.join(owner.office.paths.runDir(session.id), "codex.log")
    this.translator = new Translator(session.id, session.cwd, (e) => owner.event(this, e), owner.log)
  }

  /** Whether a job of the session's queue is running now. */
  get busy(): boolean {
    return this.#running !== null
  }

  /** Loads the thread (`thread/resume` when `resume`) as a job of the session's queue. */
  start({ resume = false }: { resume?: boolean } = {}): void {
    this.loading = true
    void this.post("load", () => this.#load(resume))
  }

  /** A message from `by` (the opener when null): `turn`, `steer` (a turn was running), or `queued` (until the thread
   *  is loaded). */
  async prompt(text: string, { by = null }: { by?: string | null } = {}): Promise<"turn" | "steer" | "queued"> {
    if (this.stopped || this.closed)
      // Office stop, or a failed load not dropped yet.
      throw new HarnessError(409, "not_live", `session ${this.sessionId} has no live Codex app-server`)
    if (this.ending) throw new HarnessError(409, "ending", `session ${this.sessionId} is ending`)
    this.translator.user(text, by || this.author)
    if (this.loading || this.process === null) {
      this.pending.push(text)
      // A restarted office, a dead app-server, or an unloaded thread.
      if (!this.loading) this.start({ resume: true })
      return "queued"
    }
    const proc = this.process
    const busy = this.turnId !== null
    try {
      return await this.#send(proc, text, busy)
    } catch (error) {
      // A refused message leaves the session idle (or waiting on a card).
      if (error instanceof HarnessError && this.turnId === null) this.#settle()
      throw error
    }
  }

  /** Ends the session: interrupts a running turn, closes the app-server, then ends through the hooks. */
  async end(): Promise<void> {
    if (this.stopped) throw new HarnessError(409, "not_live", `session ${this.sessionId} has no live Codex app-server`)
    if (this.ending) return // already ending (or closing): ending it again is a no-op
    if (this.closed)
      // A failed load not dropped yet.
      throw new HarnessError(409, "not_live", `session ${this.sessionId} has no live Codex app-server`)
  }

  /** Office stop: kills the app-server (or the one still starting or closing) and skips every job after the one in
   *  progress; the stored status stays for `restore`. Text still streaming and tools still running are stored as
   *  interrupted. Answers still waiting for their reply give up at once.
   *
   *  Once it resolves the session no longer touches the store, unless its job in progress outlived `stopWaitMs`. */
  async shutdown(): Promise<void> {
    this.stopped = true
    this.#stopTimer()
    const doomed = [this.process, this.launching, this.retiring].filter((p) => p !== null)
    this.process = null
    this.#giveUpReplies()
    // A load or a turn/start waiting on Codex fails at once.
    await Promise.all(doomed.map((p) => p.kill()))
    const running = this.#running
    if (running !== null && !(await settlesWithin(running, this.owner.stopWaitMs))) {
      // It may be writing to the transcript now; abort would race it.
      this.owner.log(
        `codex session ${this.sessionId}: its queue is still busy at office stop; its open text stays as it was`,
      )
      return
    }
    this.translator.abort()
  }

  /** Skips the session's later jobs, for a session restored only to be finished (or not at all). */
  release(): void {
    this.closed = true
    this.#giveUpReplies()
  }

  /** Settles with no app-server, as a restarted office finds the session; its next message reloads the thread. */
  idleAfterRestore(): void {
    this.#settle()
  }

  /** Records `proc` as the app-server being started, so office stop kills it; false once stopped. */
  launchingAs(proc: CodexProcess): boolean {
    if (this.stopped) return false
    this.launching = proc
    return true
  }

  /** A notification from `proc`. */
  notified(proc: CodexProcess, method: string, params: unknown): void {
    void this.post("notification", () => this.#notification(proc, method, params as Obj))
  }

  /** A server request from `proc`, which waits for the reply to `id`. */
  requested(_proc: CodexProcess, _id: unknown, _method: string, _params: unknown): void {}

  /** `proc` exited. */
  exited(proc: CodexProcess): void {
    void this.post("exited", () => this.#exited(proc))
  }

  /** Runs `job` on the session's queue after every job posted before it. A job whose turn comes after office stop or
   *  the session's close is skipped; one that throws is logged by its error's type. Never rejects. */
  post(label: string, job: () => unknown): Promise<void> {
    this.#tail = this.#tail.then(async () => {
      if (this.stopped || this.closed) return // no job touches the store any more
      const running = (async () => {
        await job()
      })().catch((error) => {
        try {
          this.owner.log(`codex session ${this.sessionId}: ${label} failed (${nameOf(error)})`)
        } catch {} // a log that throws mustn't break the queue
      })
      this.#running = running
      try {
        await running
      } finally {
        this.#running = null
      }
    })
    return this.#tail
  }

  async #load(resume: boolean): Promise<void> {
    let proc: CodexProcess
    let result: Loaded
    try {
      proc = await this.owner.launch(this)
      const params = ownerLoad(this.cwd, await this.owner.policy(this.sessionId))
      // The office never reads past turns, so a resume needn't send them.
      result = (await (resume
        ? proc.rpc!.request("thread/resume", { threadId: this.threadId, excludeTurns: true, ...params })
        : proc.rpc!.request("thread/start", params))) as Loaded
    } catch (error) {
      let failure = error
      const launching = this.launching
      this.launching = null
      if (launching !== null) {
        await launching.kill()
        // It died loading the thread: its output says why.
        if (failure instanceof RpcClosed) failure = launching.startError(failure)
      }
      await this.#cantLoad(failure, launching)
      return
    }
    this.launching = null
    if (this.stopped) {
      // Office stop came during the load: write nothing, leave nothing running.
      await proc.kill()
      return
    }
    this.process = proc
    this.threadId = result.thread.id
    this.store.updateSession(this.sessionId, { harness_session_id: this.threadId, harness_model: result.model ?? null })
    await this.#flush()
  }

  async #cantLoad(error: unknown, proc: CodexProcess | null): Promise<void> {
    if (this.stopped) return // office stop: the session keeps its status for restore
    // A start error names codex.log already.
    const named = proc === null || error instanceof CodexStartError
    const where = named ? "" : `; Codex's output is in ${this.log}`
    if (error instanceof CodexStartError || error instanceof RpcError || isTimeout(error))
      this.owner.log(`codex session ${this.sessionId} can't load its thread: ${error.message}${where}`)
    else this.owner.log(`codex session ${this.sessionId} can't load its thread (${nameOf(error)})${where}`)
    this.translator.error(why(error))
    const session = this.store.getSession(this.sessionId)
    this.loading = false
    this.pending = []
    if (this.ending) return // the end posted meanwhile closes it
    if (session?.status !== "starting") {
      // A reload: say why and wait for the next message.
      this.#settle()
      return
    }
    this.closed = true
    this.#giveUpReplies()
    await this.owner.finished(this, "failed")
  }

  /** Sends what waited for the load, in order, then goes idle if nothing was sent. `loading` stays set until the
   *  queue is empty, so a message that comes meanwhile waits behind the queue instead of overtaking it. */
  async #flush(): Promise<void> {
    let sent = false
    for (;;) {
      if (this.stopped || this.ending) return
      if (this.pending.length === 0) {
        this.loading = false
        if (!sent && this.turnId === null) this.#settle()
        return
      }
      const text = this.pending.join("\n\n")
      const proc = this.process!
      this.pending = []
      try {
        // Codex had unloaded the thread: the reload sends it.
        if ((await this.#send(proc, text, sent)) === "queued") return
        sent = true
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error
        // Office stop killed the app-server: nothing refused it, and nothing is stored.
        if (this.stopped) return
        // It died: its exit says so, and the next message reloads it.
        if (!proc.alive && !proc.closing) continue
        this.translator.error(error.message)
      }
    }
  }

  /** `turn/start`: a new turn, or a steer of the running one (Codex decides; `turn/started` says which). `queued`
   *  when Codex had unloaded the thread: the message waits for the reload. */
  async #send(proc: CodexProcess, text: string, busy: boolean): Promise<"turn" | "steer" | "queued"> {
    try {
      await proc.rpc!.request("turn/start", { threadId: this.threadId, input: input(text) })
    } catch (error) {
      if (error instanceof RpcError && NOT_LOADED.test(error.rpcMessage)) {
        this.#reload(proc, text)
        return "queued"
      }
      if (error instanceof RpcError || error instanceof RpcClosed || isTimeout(error))
        throw new HarnessError(409, "codex_refused", `Codex didn't take the message: ${error.message}`)
      throw error
    }
    return busy ? "steer" : "turn"
  }

  /** Codex unloaded the thread: closes its app-server, then loads the thread again; `text` waits for it. */
  #reload(proc: CodexProcess, text: string): void {
    if (this.stopped || this.ending) return // office stop keeps the session for restore; an end closes it
    this.pending.push(text)
    if (this.process !== proc) {
      // Another message got there first, or the app-server died meanwhile; and if nothing is loading now, send it on
      // the new app-server, or load one.
      if (!this.loading) {
        this.loading = true
        if (this.process === null) void this.post("load", () => this.#load(true))
        else void this.post("flush", () => this.#flush())
      }
      return
    }
    this.process = null
    this.loading = true
    this.retiring = proc
    void this.post("reopen", () => this.#reopen(proc))
  }

  /** Closes the app-server whose thread Codex unloaded, then loads the thread in a new one. */
  async #reopen(proc: CodexProcess): Promise<void> {
    await proc.close(this.owner.closeGraceMs) // its record goes before the reload writes the new one
    if (this.retiring === proc) this.retiring = null
    if (this.stopped) return
    await this.#load(true)
  }

  async #notification(proc: CodexProcess, method: string, params: Obj): Promise<void> {
    // An app-server that died, or was closed for a reload, still being read.
    if (proc !== this.process) return
    if (this.translator.notification(method, params)) return
    if (method === "turn/started") {
      this.turnId = params.turn.id
      if (!this.ending) this.#settle()
    } else if (method === "turn/completed") {
      const turn = params.turn
      this.translator.turnCompleted(turn.id, turn.status, turn.error ?? null)
      if (turn.id === this.turnId) this.turnId = null
      this.#expireTurn(turn.id)
      if (this.ending) void this.post("close", () => this.#close())
      // Its expired cards may leave a turn that raced it running, no longer waiting.
      else if (this.turnId !== null || !this.loading) this.#settle()
    } else if (method === "serverRequest/resolved") {
      this.#resolved(params.requestId)
    } else if (method === "thread/tokenUsage/updated") {
      this.#usage(params.tokenUsage.total)
    } else if (method === "thread/closed") {
      await this.#lost(proc, null)
    }
  }

  #usage(total: Obj): void {
    // Codex counts the whole thread; a continued session keeps only its own stretch's tokens.
    const got: Usage = {
      input_tokens: total.inputTokens,
      cached_input_tokens: total.cachedInputTokens,
      output_tokens: total.outputTokens,
    }
    const usage = { ...got }
    for (const key of USAGE) usage[key] = Math.max(0, got[key] - this.base[key])
    this.store.updateSession(this.sessionId, { harness_usage: usage })
  }

  /** Codex no longer waits on `requestId`: an open card goes stale; an answer stored meanwhile is lost by `reply`
   *  resolving false. */
  #resolved(requestId: unknown): void {
    const questionId = this.byRequest.get(String(requestId))
    this.byRequest.delete(String(requestId))
    const pending = questionId !== undefined ? this.requests.get(questionId) : undefined
    if (pending === undefined) return
    this.requests.delete(questionId!)
    this.#settle()
    this.#expire(questionId!)
  }

  /** Cards of a finished turn that Codex didn't resolve go stale: it waits on them no more. Codex sends no
   *  `serverRequest/resolved` for a request an interrupt leaves waiting. */
  #expireTurn(turnId: string): void {
    for (const [questionId, pending] of [...this.requests]) {
      if (pending.issued.runId !== turnId) continue
      this.requests.delete(questionId)
      this.byRequest.delete(String(pending.requestId))
      this.#expire(questionId)
    }
  }

  /** The card `questionId` goes stale. */
  #expire(questionId: string): void {
    this.owner.event(this, { type: "request_resolved", key: questionId })
  }

  async #exited(proc: CodexProcess): Promise<void> {
    if (proc !== this.process || proc.closing) return
    const code = proc.proc?.exitCode ?? proc.proc?.signalCode
    this.owner.log(
      `codex app-server of session ${this.sessionId} exited unexpectedly (code ${code}); Codex's output is in ${this.log}`,
    )
    await this.#lost(proc, "Codex stopped unexpectedly. Send a message to start it again.")
  }

  /** The app-server died, or Codex unloaded the thread: finishes its turn as interrupted, expires its cards, and
   *  closes its group now; the next message reloads the thread. `said` is the error part; Codex's output stays in its
   *  codex.log, which the office log names. */
  async #lost(proc: CodexProcess, said: string | null): Promise<void> {
    this.process = null
    if (said === null) this.retiring = proc // office stop kills it while it is being closed
    const turn = this.turnId
    this.turnId = null
    // Codex waits on none of them any more.
    for (const questionId of [...this.requests.keys()]) {
      this.requests.delete(questionId)
      this.#expire(questionId)
    }
    this.byRequest.clear()
    // A dead leader leaves its group to whatever it started (command children): kill it now, which also removes the
    // record, so an end that comes before any reload never finds them. An app-server that only unloaded the thread is
    // alive: close it through its stdin, which kills its group after.
    if (said === null) {
      await proc.close(this.owner.closeGraceMs)
      if (this.retiring === proc) this.retiring = null
    } else {
      await proc.kill()
    }
    // Office stop came meanwhile: restore marks the turn, and nothing is written after the stop.
    if (this.stopped) return
    if (turn !== null) this.translator.turnCompleted(turn, "interrupted", null)
    if (said) this.translator.error(said)
    if (this.ending) void this.post("close", () => this.#close())
    else this.#settle()
  }

  async #close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.#giveUpReplies()
    this.#stopTimer()
    const doomed = [this.process, this.retiring].filter((p) => p !== null)
    // Stdin, grace, group kill, record removed: before endStatus.
    await Promise.all(doomed.map((p) => p.close(this.owner.closeGraceMs)))
    if (this.stopped) return // office stop came during the close: the session stays ending, for restore
    this.translator.abort()
    await this.owner.finished(this, "ended")
  }

  /** Writes the run state: waiting while Codex waits on a card (on the opener), busy while a turn runs, else idle.
   *  Nothing once the office stops or the session is ending or closed. */
  #settle(): void {
    if (this.stopped || this.ending || this.closed) return
    const waiting = this.requests.size > 0
    writeState(
      this.store,
      this.sessionId,
      runState({ waiting, running: this.turnId !== null }),
      waiting ? [this.author] : [],
      { fromStarting: ["idle", "busy", "waiting"] },
    )
  }

  /** Every answer still waiting for its reply to be written gives up at once. */
  #giveUpReplies(): void {}

  /** Cancels the end timer. */
  #stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

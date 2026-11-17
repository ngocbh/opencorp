/** A chat session's approvals: what its employee's shell may run without asking, Auto's check on the office's
 *  connection, the cards a held call waits on, what their answers do, and the rules a "don't ask again" adds. */
import path from "node:path"
import { OFFICE } from "@opencorp/protocol"
import { type Connections, isSubscription } from "../../models/connections.ts"
import { callUsd, DEFAULT_PRICE, ZERO_PRICE } from "../../models/cost.ts"
import type { Provider } from "../../models/provider.ts"
import { Check, type CheckRecord, type CheckWorkers, inWorker } from "../../runtime/permissions/classifier.ts"
import { decide, dontAskRefusal, type Permissions, RuleBook, type Where } from "../../runtime/permissions/policy.ts"
import { holdApproval, readAnswer, YES } from "../../runtime/questions/approval.ts"
import type { OnQuestion } from "../../runtime/questions/ask.ts"
import type { AnswerKind } from "../../runtime/sessions/harness.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store } from "../../runtime/store/store.ts"
import type { OfficePaths } from "../../util/home.ts"
import { DETAIL_CHARS } from "../../util/redact.ts"
import { errorName } from "../../runtime/worker/rpc.ts"
import type { RunSpec } from "./run_spec.ts"

/** The flow Auto's check runs, which its audit rows name. */
const CHECK_TOOL = "classify_command"

/** What a session's approvals need of its actor. Each is called inside the actor's serial queue, as the answer or
 *  the switch that leads to it is. */
export interface ApprovalHost {
  /** The run whose calls can still take an answer: the session's current run, or null once it finished. */
  liveRun(): string | null
  /** Completes `card`'s call with what its answer says (`approvalResult`). */
  completeWithAnswer(card: QuestionRecord): Promise<void>
  /** Completes `card`'s call with its action's `output`; the card is consumed once the run takes it. */
  completeWithOutput(card: QuestionRecord, output: string): Promise<void>
  /** Marks answered `card` stale: its answer can never reach its call. */
  loseAnswer(card: QuestionRecord): void
  /** Runs `job` on the actor's serial queue after the jobs before it; skipped once the actor closed. */
  post(label: string, job: () => unknown): void
  /** Writes the session's run state again; `when` names the step for the log. */
  settle(when: string): void
  /** The session's spec's `runApproved`, if it has one. */
  runner(): Promise<RunSpec["runApproved"]>
}

/**
 * A chat session's approvals as the office binds them: the mode from the store, the session's own rules, where its
 * workspace shell runs, Auto's check on the office's connection, cards held through the run's `onQuestion`, and what
 * an answer to a card does.
 *
 * One check per session, so the same command in the session is judged once. Each check runs as a `classify` worker
 * job on the office's connection, resolved again for each check; its run log goes to the session's `checks/` folder,
 * its verdict to an audit row (`kind` check), and what it spent to the session's cost, priced at the connection's
 * prices. The session's rules and the check's verdicts live in memory with its actor, so an office restart starts
 * them fresh: the next check asks the model again, and a "don't ask again" from before asks again.
 *
 * A Yes runs the held action with no gate, detached from the workspace's interrupt, and its output completes the
 * call. A No completes it with the approver's words, and answers the run's other open cards the same way, as one No
 * settles the reply's held calls. A "don't ask again" re-checks the run's other open cards and runs those the
 * session's mode and rules now allow.
 */
export class ChatApprovals {
  /** The session's own rules: what "don't ask again" added. */
  readonly book = new RuleBook()
  readonly #store: Store
  readonly #session: () => SessionRecord
  readonly #where: () => Where
  readonly #charge: (runId: string, model: string | null, usd: number) => void
  readonly #host: ApprovalHost
  readonly #check: Check
  /** The office connection the last check resolved, whose prices its usage is charged at. */
  #provider: Provider | null = null
  /** The approved actions the office runs now, by card id, each stopped by its controller. */
  readonly #running = new Map<string, AbortController>()

  constructor(o: {
    store: Store
    workers: CheckWorkers
    connections: Connections
    paths: OfficePaths
    /** The session, as stored now. */
    session: () => SessionRecord
    /** Where the session's workspace shell runs. */
    where: () => Where
    /** Records a check's usage as the session's: the actor's charge (`recordUsage`, the session's cost, its cap). */
    charge(runId: string, model: string | null, usd: number): void
    /** What the cards need of the session's actor. */
    host: ApprovalHost
    /** How long, in ms, a check may take before it asks (default `CHECK_TIMEOUT_MS`). */
    checkTimeoutMs?: number
  }) {
    this.#store = o.store
    this.#session = o.session
    this.#where = o.where
    this.#charge = (runId, model, usd) => o.charge(runId, model, usd)
    this.#host = o.host
    const model = async () => {
      const provider = await o.connections.resolve(OFFICE, null)
      this.#provider = provider
      return { llm_config: provider.llm_config ?? {}, env: provider.env }
    }
    const logDir = path.join(o.paths.sessionDir(o.session().id), "checks")
    this.#check = new Check({
      run: inWorker(o.workers, model, { logDir }),
      record: async (entry) => this.#record(entry),
      ...(o.checkTimeoutMs === undefined ? {} : { timeoutMs: o.checkTimeoutMs }),
    })
  }

  /** The permissions run `runId`'s tools get: its cards are held through `onQuestion`, unless the session no longer
   *  asks (`dontAsk`), when the call is refused. No always-rules are kept, so no card offers "always". */
  permissions(runId: string, onQuestion: OnQuestion): Permissions {
    return {
      mode: () => this.#session().mode,
      rules: () => this.book.list(),
      where: () => this.#where(),
      hold: (card, callId) => {
        const session = this.#session()
        if (session.mode === "dontAsk") return dontAskRefusal(card.reason)
        return holdApproval(session, runId, onQuestion, { always: false })(card, callId)
      },
      check: (input, signal) => this.#check.judge(input, signal),
    }
  }

  /** Whether card `cardId`'s approved action runs now: its own output completes its call. */
  running(cardId: string): boolean {
    return this.#running.has(cardId)
  }

  /** Whether an approved action runs now: the session reads busy. */
  get busy(): boolean {
    return this.#running.size > 0
  }

  /** Stops the approved actions running now: Esc, End and the office stop end them, as they end the workspace's own
   *  calls. */
  stop(): void {
    for (const controller of this.#running.values()) controller.abort()
  }

  /**
   * Acts on approval card `card`'s answer, stored on a call of the run that can still take it. A Yes (or don't ask
   * again, or always) runs the held action, which completes the call once it ends. Any other answer completes the
   * call now with what it says (`approvalResult`); a No answers every other open card of the run the same way, by the
   * same approver.
   */
  async answered(card: QuestionRecord): Promise<void> {
    const read = readAnswer(card)
    if (read.answer === "yes" || read.answer === "session" || read.answer === "always") {
      await this.#approve(card, card.answered_by ? `approved by @${card.answered_by}` : "approved")
      return
    }
    await this.#host.completeWithAnswer(card)
    if (read.answer === "no") await this.#answerOpen(() => card.answer, card.answer_kind ?? "text", card.answered_by)
  }

  /** A switch to `dontAsk` by `by`, which never asks: each open card of the run is answered No with "this session is
   *  now in dontAsk mode, which doesn't ask: <the card's reason>", and each call completes. Nothing runs. */
  async refuseOpen(by: string | null): Promise<void> {
    const refusal = (card: QuestionRecord) =>
      `this session is now in dontAsk mode, which doesn't ask: ${card.approval?.reason ?? ""}`
    await this.#answerOpen(refusal, "text", by)
  }

  /**
   * Runs approval card `card`'s held action, approved as `credit` says (its audit row ends with it). Its "don't ask
   * again" rules are added first, and then each other open card of the run those rules now allow runs too
   * (`#recheck`). The action runs with no gate, detached from the workspace's interrupt (no worker waits on it),
   * while the session reads busy; `stop` ends it. Once it ends, its output (or `error: <its type>`) completes the
   * held call, unless the session finished or the call is no longer of its run (its answer is then lost).
   */
  async #approve(card: QuestionRecord, credit: string): Promise<void> {
    const added = this.remember(card)
    const approval = card.approval!
    const runApproved = await this.#host.runner()
    const stop = new AbortController()
    this.#running.set(card.id, stop)
    const ran = runApproved
      ? runApproved(approval.tool, approval.args, {
          session: this.#session(),
          runId: card.run_id,
          signal: stop.signal,
          credit,
        })
      : Promise.reject(new RangeError("this chat runs no approved calls"))
    void ran
      .then(
        (output) => output,
        (error: unknown) => `error: ${errorName(error)}`,
      )
      .then((output) =>
        this.#host.post("an approved call", async () => {
          this.#running.delete(card.id)
          if (this.#host.liveRun() !== card.run_id) this.#host.loseAnswer(card)
          else await this.#host.completeWithOutput(card, output)
          this.#host.settle("after an approved call")
        }),
      )
    if (added) await this.#recheck(card.answered_by)
  }

  /** After a "don't ask again" added rules: each open card of the run that the session's mode and rules now allow is
   *  answered Yes as `by` and its action run, its audit row crediting what allows it; the others stay open. */
  async #recheck(by: string | null): Promise<void> {
    const runId = this.#host.liveRun()
    if (runId === null) return
    for (const open of this.#store.listQuestions({ runId, status: "open", source: "approval" })) {
      const allowed = open.call_id === null ? null : this.allowedBy(open)
      if (allowed === null) continue
      const answered = this.#answer(open, YES, "option", by)
      if (answered !== null) await this.#approve(answered, `by ${allowed}`)
    }
  }

  /** Answers every open card of the run with `value(card)` (of `kind`) as `by`, and completes each call with what it
   *  says. */
  async #answerOpen(value: (card: QuestionRecord) => unknown, kind: AnswerKind, by: string | null): Promise<void> {
    const runId = this.#host.liveRun()
    if (runId === null) return
    for (const open of this.#store.listQuestions({ runId, status: "open", source: "approval" })) {
      if (open.call_id === null) continue
      const answered = this.#answer(open, value(open), kind, by)
      if (answered !== null) await this.#host.completeWithAnswer(answered)
    }
  }

  /** Stores `value` as open card `card`'s answer and returns the card as stored; null when it was answered or
   *  closed meanwhile. */
  #answer(card: QuestionRecord, value: unknown, kind: AnswerKind, by: string | null): QuestionRecord | null {
    try {
      const answered = this.#store.answerQuestion(card.id, value, kind, by)
      // Store listeners may have written to it before `answerQuestion` returned.
      return this.#store.getQuestion(card.id) ?? answered
    } catch (error) {
      if (error instanceof InvalidTransition) return null
      throw error
    }
  }

  /** Adds the rules an answered card's "don't ask again" chose to the session's own. An "always" answer's rules are
   *  kept for the session too, since no always-rules are kept elsewhere. Whether it added any. */
  remember(question: QuestionRecord): boolean {
    const card = question.approval
    const read = readAnswer(question)
    if (card === null || (read.answer !== "session" && read.answer !== "always")) return false
    for (const pattern of card.rules) this.book.add({ effect: "allow", kind: card.kind, pattern })
    return card.rules.length > 0
  }

  /** What now lets open card `question`'s action run with no card ("an allow rule", "read-only", …), decided again
   *  from what the card holds with the session's mode and rules, Auto's check not asked again; null when nothing
   *  does. */
  allowedBy(question: QuestionRecord): string | null {
    const card = question.approval
    if (card === null) return null
    const into = card.into === null ? {} : { into: card.into }
    const action = { kind: card.kind, text: card.action, partial: card.partial, ...into }
    const decision = decide(action, this.#session().mode, this.book.list(), this.#where())
    return decision.verdict === "allow" ? decision.by : null
  }

  /** Records one check: its audit row, then, for a check that called the model, its cost as the session's. */
  #record(entry: CheckRecord): void {
    const session = this.#session()
    const { kind, command, profile, cwd, host } = entry.input
    this.#store.recordAudit({
      person: session.person,
      kind: "check",
      tool: CHECK_TOOL,
      args: { kind, command, profile, cwd, host, cached: entry.cached },
      outcome: entry.failed ? "failed" : entry.verdict,
      sessionId: session.id,
      runId: entry.runId,
      detail: entry.reason.slice(0, DETAIL_CHARS),
    })
    if (entry.usage === null || entry.runId === null) return
    const provider = this.#provider
    // A subscription already pays for a model its file doesn't price.
    const price = provider !== null && isSubscription(provider) ? ZERO_PRICE : DEFAULT_PRICE
    const usd = callUsd(provider?.prices ?? {}, entry.model, entry.usage, { default: price })
    this.#charge(entry.runId, entry.model, usd)
  }
}

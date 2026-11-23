/** A chat session's approvals: what its employee's shell may run without asking, what the gate lets each of its other
 *  tool calls do, Auto's check on the office's connection, the cards a held call waits on, what their answers do, and
 *  the rules a "don't ask again" or an "always" adds. */
import path from "node:path"
import type { PendingCall } from "@ngocbh/yian/run"
import type { GatedCall, GateDecision } from "@ngocbh/yian/tools"
import { OFFICE, type RemoveRuleRequest, type RuleFileError } from "@opencorp/protocol"
import { CompanyRepoBusy, type CompanyGit } from "../../company/git.ts"
import { addRules, readRules, removeRule, type Rule as SavedRule, RulesRefused } from "../../company/rules.ts"
import { type Connections, runsOnSubscription } from "../../models/connections.ts"
import { callUsd } from "../../models/cost.ts"
import { type Price, ProviderError } from "../../models/provider.ts"
import {
  Check, type CheckRecord, type CheckRunner, type CheckWorkers, inWorker,
} from "../../runtime/permissions/classifier.ts"
import type { CallPolicy } from "../../runtime/permissions/gate.ts"
import { type Permissions, type Rule, RuleBook, type Where } from "../../runtime/permissions/policy.ts"
import { holdApproval, readAnswer } from "../../runtime/questions/approval.ts"
import type { OnQuestion } from "../../runtime/questions/ask.ts"
import type { AnswerKind } from "../../runtime/sessions/harness.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store } from "../../runtime/store/store.ts"
import type { CommandPlan } from "../../tools/terminal/terminal.ts"
import type { OfficePaths } from "../../util/home.ts"
import { DETAIL_CHARS } from "../../util/redact.ts"
import { errorName } from "../../runtime/worker/rpc.ts"
import { CallGate } from "./gate.ts"

/** The flow Auto's check runs, which its audit rows name. */
const CHECK_TOOL = "classify_command"

/** What a session's approvals need of its actor. Each is called inside the actor's serial queue, as the answer or
 *  the switch that leads to it is. */
export interface ApprovalHost {
  /** The run whose calls can still take an answer: the session's current run, or null once it finished. */
  liveRun(): string | null
  /** Completes `card`'s call with what its answer says (`approvalResult`). */
  completeWithAnswer(card: QuestionRecord): Promise<void>
  /** Shows `text` in the chat as the office's notice to the people watching it. */
  notice(text: string): void
  /** Runs `job` on the actor's serial queue after the jobs before it; skipped once the actor closed. */
  post(label: string, job: () => unknown): void
  /** Writes the session's run state again; `when` names the step for the log. */
  settle(when: string): void
  /** What the session's terminal would act on for its tool `tool` (`run`, `type`) with `args`, read from its shells
   *  now (`Terminal.plan`); nothing to decide when it has no terminal or the arguments weren't recorded. */
  planCommand(tool: string, args: Readonly<Record<string, unknown>> | null): CommandPlan
  /** The terminal's audit row of a command the gate held or refused (`Terminal.audited`). */
  audited(plan: CommandPlan, outcome: "held" | "denied", reason: string): void
  /** Runs held call `callId` once (`release`), `note` kept in the run log; `card`'s answer is consumed once the run
   *  takes it. */
  release(callId: string, note: string | null, card: QuestionRecord | null): Promise<void>
  /** Completes held call `callId` with `output`, which the model reads; its tool never runs. */
  completeCall(callId: string, output: string): Promise<void>
  /** Stores a card of the run's calls (the actor's `onQuestion`). */
  onQuestion: OnQuestion
  /** Whether run `runId`'s log records that call `callId` was released. */
  released(runId: string, callId: string): boolean
  /** The secret values no model may read: run `runId`'s model key, and the company's asset secrets. Rejects when
   *  they can't be known. */
  secretValues(runId: string): Promise<string[]>
}

/**
 * A chat session's approvals as the office binds them: the mode from the store, the session's own rules with the
 * agent's and the company's, where its terminal's shells run (the actor's, which reads the terminal's), Auto's check
 * on the office's connection, cards held through the run's `onQuestion`, and what an answer to a card does.
 *
 * The agent's rules (`people/<handle>/rules.yaml`) and the company's (`rules.yaml`) are read at the company repo's
 * HEAD when a run's permissions are built and again after each change this session commits, and kept, so a committed
 * hand edit applies from the session's next run. Deny wins, then ask, then allow, whichever source a rule comes from.
 * While either file exists but doesn't load, every action of the session asks (dontAsk refuses it), its card offering
 * no rule, until a commit fixes it; deny rules from the rest still refuse first.
 *
 * One check per session, so the same command in the session is judged once. Each check runs as a `classify` worker
 * job on the office's connection, resolved again for each check; its run log goes to the session's `checks/` folder,
 * its verdict to an audit row (`kind` check), and what it spent to the session's cost, priced at the connection's
 * prices. The session's own rules and the check's verdicts live in memory with its actor, so an office restart starts
 * them fresh: the next check asks the model again, and a "don't ask again" from before asks again.
 *
 * A No completes a held call with the approver's words, and answers the run's other open cards the same way, as one
 * No settles the reply's held calls; the reply's later calls, which yian checks only once the card is answered, are
 * refused with the same words where they would ask. A "don't ask again" or an "always" decides the run's other held
 * calls again and releases those the session's mode and rules now allow. An "always" commits its rules to the
 * agent's file, as its approver's.
 *
 * Every tool call goes through the session's gate (`CallGate`), bound to the session's mode and rules, Auto's
 * check, the store's cards and the actor's deliveries. A held call is decided again after a rule is added or
 * removed, when a worker starts on the run (the rules files read again first), and at a restart.
 */
export class ChatApprovals {
  /** The session's own rules: what "don't ask again" added, and an "always" its agent's file couldn't take. */
  readonly book = new RuleBook()
  readonly #store: Store
  readonly #session: () => SessionRecord
  readonly #where: () => Where
  readonly #charge: (runId: string, model: string | null, usd: number, subscription: boolean) => void
  readonly #host: ApprovalHost
  readonly #check: Check
  readonly #git: CompanyGit
  readonly #handle: string
  readonly #log: (line: string) => void
  /** The agent's and the company's rules as last read at HEAD, and the files that didn't load; null until read. */
  #files: { rules: SavedRule[]; errors: RuleFileError[] } | null = null
  /** The commit `#files` were read at, so a run's build reads them again only once HEAD moved. */
  #readAt: string | null = null
  /** How many reads of the files have started, and which one `#files` holds: an older read that ends late never
   *  replaces a newer one. */
  #reads = 0
  #applied = 0
  /** Why each session rule an "always" couldn't save to the agent's file stays in the session, by `ruleKey`. */
  readonly #unsaved = new Map<string, string>()
  /** What the last check's usage counts at toward the cost cap: the office connection's `capPrices`. */
  #pricing: { prices: Readonly<Record<string, Price>>; subscription: boolean } = { prices: {}, subscription: false }
  readonly #gate: CallGate

  constructor(o: {
    store: Store
    workers: CheckWorkers
    connections: Connections
    paths: OfficePaths
    /** The session, as stored now. */
    session: () => SessionRecord
    /** Where a new shell of the session's terminal runs: what a card is decided again by. The terminal's own reading,
     *  through the actor; the terminal never reads it back. */
    where: () => Where
    /** Records a check's usage as the session's: the actor's charge (`recordUsage`, the session's cost, its cap);
     *  `subscription` when it ran on one. */
    charge(runId: string, model: string | null, usd: number, subscription: boolean): void
    /** What the cards need of the session's actor. */
    host: ApprovalHost
    /** The company repo the agent's and the company's rules files are read from, and the agent's go to. */
    git: CompanyGit
    /** The session's agent, whose rules file applies. */
    handle: string
    /** Gets log lines: why an "always" stayed in the session. */
    log(line: string): void
    /** How long, in ms, a check may take before it asks (default `CHECK_TIMEOUT_MS`). */
    checkTimeoutMs?: number
    /** Runs Auto's check in place of a `classify` worker job: for tests. */
    runCheck?: CheckRunner
  }) {
    this.#store = o.store
    this.#session = o.session
    this.#where = o.where
    this.#charge = (runId, model, usd, subscription) => o.charge(runId, model, usd, subscription)
    this.#host = o.host
    this.#git = o.git
    this.#handle = o.handle
    this.#log = (line) => o.log(line)
    const model = async () => {
      const provider = await o.connections.resolve(OFFICE, null)
      this.#pricing = await o.connections.capPrices(OFFICE).catch((error: unknown) => {
        // Broken since it resolved: its own list, a subscription still counted as one.
        if (!(error instanceof ProviderError)) throw error
        return { prices: provider.prices, subscription: runsOnSubscription(provider) }
      })
      return { llm_config: provider.llm_config ?? {}, env: provider.env }
    }
    const logDir = path.join(o.paths.sessionDir(o.session().id), "checks")
    this.#check = new Check({
      run: o.runCheck ?? inWorker(o.workers, model, { logDir }),
      record: async (entry) => this.#record(entry),
      ...(o.checkTimeoutMs === undefined ? {} : { timeoutMs: o.checkTimeoutMs }),
    })
    const host = o.host
    this.#gate = new CallGate({
      liveRun: () => host.liveRun(),
      policy: () => this.#policy(),
      judge: (input, signal) => this.#check.judge(input, signal),
      post: (label, job) => host.post(label, job),
      settle: (when) => host.settle(when),
      planCommand: (tool, args) => host.planCommand(tool, args),
      audited: (plan, outcome, reason) => host.audited(plan, outcome, reason),
      release: (callId, note, card) => host.release(callId, note, card),
      completeCall: (callId, output) => host.completeCall(callId, output),
      completeWithAnswer: (card) => host.completeWithAnswer(card),
      released: (runId, callId) => host.released(runId, callId),
      secretValues: (runId) => host.secretValues(runId),
      remember: (card) => this.remember(card),
      cards: {
        byCall: (callId) => this.#store.getQuestionByCall(callId),
        answer: (card, value, kind, by) => this.#answer(card, value, kind, by),
        open: (runId) => this.#store.listQuestions({ runId, status: "open", source: "approval" }),
        hold: (card, runId, callId) => {
          holdApproval(this.#session(), runId, host.onQuestion, { always: true })(card, callId)
        },
      },
      log: (line) => this.#log(`session ${this.#session().id}: ${line}`),
    })
  }

  /** The permissions run `runId`'s tools get, the rules files read again first. Its terminal decides nothing itself:
   *  each of its calls takes what the gate decided for it (`decided`). */
  async permissions(_runId: string, _onQuestion: OnQuestion): Promise<Permissions> {
    await this.reload()
    return {
      mode: () => this.#session().mode,
      rules: () => this.#rules(),
      where: () => this.#where(),
      decided: (callId) => this.#gate.take(callId),
    }
  }

  /** Reads the agent's and the company's rules files at HEAD again, unless they were read at that commit; the
   *  session's permissions decide by them from now. */
  async reload(): Promise<void> {
    const n = ++this.#reads
    const head = await this.#git.readHead().catch(() => null)
    if (head !== null && head === this.#readAt && this.#files !== null) {
      // What a read started before this one would read is no newer.
      this.#applied = Math.max(this.#applied, n)
      return
    }
    const read = await readRules(this.#git, this.#handle, head ?? "HEAD")
    if (n < this.#applied) return
    this.#files = read
    this.#readAt = head
    this.#applied = n
  }

  /** The session's rules, the agent's and the company's, each with its source, and the rules files that don't load,
   *  as the session decides by them now (read first if they weren't yet). */
  async list(): Promise<{ rules: SavedRule[]; errors: RuleFileError[] }> {
    if (this.#files === null) await this.reload()
    const own = this.book.list().map((r): SavedRule => ({
      ...r, source: "session", by: null, at: null, note: this.#unsaved.get(ruleKey(r)) ?? null,
    }))
    return { rules: [...own, ...this.#files!.rules], errors: [...this.#files!.errors] }
  }

  /** Removes `rule`, as `by`: a session rule from the session's own, an agent rule from the agent's file, committed and
   *  the files read again. Whether it was there. A company rule is refused (`RulesRefused` `company_rule`), and so is
   *  an agent's file that doesn't load or has changes nobody committed. */
  async remove(rule: RemoveRuleRequest, by: string): Promise<boolean> {
    if (rule.source === "session") {
      this.#unsaved.delete(ruleKey(rule))
      const removed = this.book.remove(rule)
      const runId = this.#host.liveRun()
      if (removed && runId !== null) await this.#gate.recheckHolds(runId, by)
      return removed
    }
    const removed = await removeRule(this.#git, this.#handle, { ...rule, source: rule.source }, by)
    if (removed) await this.reload()
    // A deny or an ask rule gone may let a held call run.
    const runId = this.#host.liveRun()
    if (removed && runId !== null) await this.#gate.recheckHolds(runId, by)
    return removed
  }

  /** Every rule the session decides by: its own, the agent's and the company's. */
  #rules(): readonly Rule[] {
    return [...this.book.list(), ...(this.#files?.rules ?? [])]
  }

  /** Why every action of the session asks now: a rules file that doesn't load; null when none. */
  #blocked(): string | null {
    // Never decided before a read; were it, no file's deny rules would be known yet.
    if (this.#files === null) return "the rules files haven't been read yet"
    const [first] = this.#files.errors
    return first === undefined ? null : `${first.path} doesn't load: ${first.message}`
  }

  /** Whether a check on a held call runs now: the session reads busy. */
  get busy(): boolean {
    return this.#gate.busy
  }

  /** Stops the checks on held calls: Esc, End and the office stop end them. */
  stop(): void {
    this.#gate.stop()
  }

  /** The gate's decision on tool call `call` of run `runId` (`CallGate.gate`). */
  gate(runId: string, call: GatedCall): GateDecision {
    return this.#gate.gate(runId, call)
  }

  /** Yian holds call `callId` of run `runId` (`CallGate.held`). */
  held(runId: string, callId: string): void {
    this.#gate.held(runId, callId)
  }

  /** Call `callId` closed (`CallGate.closed`). */
  closed(callId: string): void {
    this.#gate.closed(callId)
  }

  /** Run `runId`'s job ended (`CallGate.jobEnded`). */
  jobEnded(runId: string): void {
    this.#gate.jobEnded(runId)
  }

  /** The holds yian recorded for run `runId`, as at a restart (`CallGate.settleHolds`). */
  settleHolds(runId: string, calls: readonly PendingCall[]): void {
    this.#gate.settleHolds(runId, calls)
  }

  /** Each held call of run `runId` decided again, by the rules as read now: a worker started on the run. */
  recheckHolds(runId: string): Promise<void> {
    return this.#gate.recheckHolds(runId)
  }

  /** Acts on approval card `card`'s answer (`CallGate.answered`). */
  answered(card: QuestionRecord): Promise<void> {
    return this.#gate.answered(card)
  }

  /** A switch to `dontAsk` by `by` refuses every open card of the run (`CallGate.refuseOpen`). */
  refuseOpen(by: string | null): Promise<void> {
    return this.#gate.refuseOpen(by)
  }

  /** What the gate decides by now: the session's mode, its rules and why every call asks, if one does. */
  #policy(): CallPolicy {
    return { mode: this.#session().mode, rules: this.#rules(), blocked: this.#blocked() }
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

  /** Adds the rules an answered card's "don't ask again" chose to the session's own, and an "always" answer's to the
   *  agent's file, committed as its approver's, then reads the files again. An "always" the file can't take (it doesn't
   *  load, has changes nobody committed, or the repo is busy) keeps its rules for the session, and says why: in a
   *  notice in the chat, on the rules in `/rules`, and in the log. Whether it added any. */
  async remember(question: QuestionRecord): Promise<boolean> {
    const card = question.approval
    const read = readAnswer(question)
    if (card === null || (read.answer !== "session" && read.answer !== "always")) return false
    if (card.rules.length === 0) return false
    const rules = card.rules.map((pattern): Rule => ({ effect: "allow", kind: card.kind, pattern }))
    if (read.answer === "always" && question.answered_by !== null) {
      try {
        await addRules(this.#git, this.#handle, rules, question.answered_by)
        await this.reload()
        return true
      } catch (error) {
        // Their messages are fixed text, naming no absolute path; any other error's could quote git's output.
        const known = error instanceof RulesRefused || error instanceof CompanyRepoBusy
        const why = known ? error.message : `the company repo couldn't take the commit (${errorName(error)})`
        for (const rule of rules) this.#unsaved.set(ruleKey(rule), why)
        const shown = rules.map((rule) => JSON.stringify(rule.pattern)).join(", ")
        const later = `it isn't saved for @${this.#handle}'s later sessions`
        this.#host.notice(`${shown} applies to this session only; ${later}: ${why}`)
        this.#log(`session ${this.#session().id}: an "always" rule stays in this session only: ${why}`)
      }
    }
    for (const rule of rules) this.book.add(rule)
    return true
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
    const { prices, subscription } = this.#pricing
    this.#charge(entry.runId, entry.model, callUsd(prices, entry.model, entry.usage), subscription)
  }
}

/** What tells a rule from another: its effect, kind and pattern. */
function ruleKey(rule: Pick<Rule, "effect" | "kind" | "pattern">): string {
  return `${rule.effect}\0${rule.kind}\0${rule.pattern}`
}

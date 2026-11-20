/** A chat session's approvals: what its employee's shell may run without asking, Auto's check on the office's
 *  connection, the cards a held call waits on, what their answers do, and the rules a "don't ask again" or an "always"
 *  adds. */
import path from "node:path"
import { OFFICE, type RemoveRuleRequest, type RuleFileError } from "@opencorp/protocol"
import { CompanyRepoBusy, type CompanyGit } from "../../company/git.ts"
import { addRules, readRules, removeRule, type Rule as SavedRule, RulesRefused } from "../../company/rules.ts"
import { type Connections, isSubscription } from "../../models/connections.ts"
import { callUsd, DEFAULT_PRICE, ZERO_PRICE } from "../../models/cost.ts"
import type { Provider } from "../../models/provider.ts"
import { Check, type CheckRecord, type CheckWorkers, inWorker } from "../../runtime/permissions/classifier.ts"
import {
  decide, dontAskRefusal, type Permissions, type Rule, RuleBook, type Where,
} from "../../runtime/permissions/policy.ts"
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
  /** Shows `text` in the chat as the office's notice to the people watching it. */
  notice(text: string): void
  /** Runs `job` on the actor's serial queue after the jobs before it; skipped once the actor closed. */
  post(label: string, job: () => unknown): void
  /** Writes the session's run state again; `when` names the step for the log. */
  settle(when: string): void
  /** The session's spec's `runApproved`, if it has one. */
  runner(): Promise<RunSpec["runApproved"]>
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
 * A Yes runs the held action in the terminal with no gate, outside the terminal's waits, and its output completes the
 * call. A No completes it with the approver's words, and answers the run's other open cards the same way, as one No
 * settles the reply's held calls. A "don't ask again" or an "always" re-checks the run's other open cards and runs
 * those the session's mode and rules now allow. An "always" commits its rules to the agent's file, as its approver's.
 */
export class ChatApprovals {
  /** The session's own rules: what "don't ask again" added, and an "always" its agent's file couldn't take. */
  readonly book = new RuleBook()
  readonly #store: Store
  readonly #session: () => SessionRecord
  readonly #where: () => Where
  readonly #charge: (runId: string, model: string | null, usd: number) => void
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
    /** Where a new shell of the session's terminal runs: what a card is decided again by. The terminal's own reading,
     *  through the actor; the terminal never reads it back. */
    where: () => Where
    /** Records a check's usage as the session's: the actor's charge (`recordUsage`, the session's cost, its cap). */
    charge(runId: string, model: string | null, usd: number): void
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
  }) {
    this.#store = o.store
    this.#session = o.session
    this.#where = o.where
    this.#charge = (runId, model, usd) => o.charge(runId, model, usd)
    this.#host = o.host
    this.#git = o.git
    this.#handle = o.handle
    this.#log = (line) => o.log(line)
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

  /** The permissions run `runId`'s tools get, the rules files read again first: its cards are held through
   *  `onQuestion`, offering "always", unless the session no longer asks (`dontAsk`), when the call is refused. */
  async permissions(runId: string, onQuestion: OnQuestion): Promise<Permissions> {
    await this.reload()
    return {
      mode: () => this.#session().mode,
      rules: () => this.#rules(),
      where: () => this.#where(),
      hold: (card, callId) => {
        const session = this.#session()
        if (session.mode === "dontAsk") return dontAskRefusal(card.reason)
        return holdApproval(session, runId, onQuestion, { always: true })(card, callId)
      },
      check: (input, signal) => this.#check.judge(input, signal),
      blocked: () => this.#blocked(),
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
      return this.book.remove(rule)
    }
    const removed = await removeRule(this.#git, this.#handle, { ...rule, source: rule.source }, by)
    if (removed) await this.reload()
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

  /** Whether card `cardId`'s approved action runs now: its own output completes its call. */
  running(cardId: string): boolean {
    return this.#running.has(cardId)
  }

  /** Whether an approved action runs now: the session reads busy. */
  get busy(): boolean {
    return this.#running.size > 0
  }

  /** Stops the approved actions running now, whose commands then stop: Esc, End and the office stop end them, as they
   *  cut off the terminal's own calls. */
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
   * (`#recheck`). The action runs with no gate, outside the terminal's waits (no worker waits on it), while the
   * session reads busy; `stop` ends it. Once it ends, its output (or `error: <its type>`) completes the
   * held call, unless the session finished or the call is no longer of its run (its answer is then lost).
   */
  async #approve(card: QuestionRecord, credit: string): Promise<void> {
    const added = await this.remember(card)
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

  /** What now lets open card `question`'s action run with no card ("an allow rule", "read-only", …), decided again
   *  from what the card holds with the session's mode and rules, Auto's check not asked again; null when nothing
   *  does. */
  allowedBy(question: QuestionRecord): string | null {
    const card = question.approval
    if (card === null) return null
    const into = card.into === null ? {} : { into: card.into }
    const never = this.#blocked()
    const blocked = never === null ? {} : { never }
    const action = { kind: card.kind, text: card.action, partial: card.partial, ...into, ...blocked }
    const decision = decide(action, this.#session().mode, this.#rules(), this.#where())
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

/** What tells a rule from another: its effect, kind and pattern. */
function ruleKey(rule: Pick<Rule, "effect" | "kind" | "pattern">): string {
  return `${rule.effect}\0${rule.kind}\0${rule.pattern}`
}

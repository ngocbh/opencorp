/** A chat session's approvals: what its employee's shell may run without asking, what the gate lets each of its other
 *  tool calls do, Auto's check on the office's connection, the cards a held call waits on, what their answers do, and
 *  the rules a "don't ask again" or an "always" adds. */
import path from "node:path"
import type { PendingCall } from "@ngocbh/yian/run"
import { type GatedCall, type GateDecision, pending } from "@ngocbh/yian/tools"
import { OFFICE, type RemoveRuleRequest, type RuleFileError } from "@opencorp/protocol"
import { CompanyRepoBusy, type CompanyGit } from "../../company/git.ts"
import { addRules, readRules, removeRule, type Rule as SavedRule, RulesRefused } from "../../company/rules.ts"
import { type Connections, runsOnSubscription } from "../../models/connections.ts"
import { callUsd } from "../../models/cost.ts"
import { type Price, ProviderError } from "../../models/provider.ts"
import {
  Check, type CheckRecord, type CheckRunner, type CheckWorkers, inWorker,
} from "../../runtime/permissions/classifier.ts"
import {
  afterCheck, type CallDecision, type CallPolicy, decideCall, decideCommand, resent, type ToolCall, toolCard,
} from "../../runtime/permissions/gate.ts"
import {
  type ApprovalCard, type Basis, type CheckInput, type Decided, judged, type Permissions, type Rule, RuleBook,
  type Where,
} from "../../runtime/permissions/policy.ts"
import { approvalResult, holdApproval, readAnswer, YES } from "../../runtime/questions/approval.ts"
import type { CommandPlan } from "../../tools/terminal/terminal.ts"
import type { OnQuestion } from "../../runtime/questions/ask.ts"
import type { AnswerKind } from "../../runtime/sessions/harness.ts"
import { InvalidTransition, type QuestionRecord, type SessionRecord, type Store } from "../../runtime/store/store.ts"
import type { OfficePaths } from "../../util/home.ts"
import { DETAIL_CHARS, redact } from "../../util/redact.ts"
import { errorName } from "../../runtime/worker/rpc.ts"

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

/** A terminal command or typed line the gate decides: what the terminal would act on. */
type Planned = CommandPlan & { decide: true }

/** A call the gate held, by its call id: its run, the call as the gate decided it (and, for a terminal command or
 *  typed line, what the terminal would act on), whether yian holds it yet (`CallHeld`), and Auto's check on it while
 *  that runs. */
interface Hold {
  readonly runId: string
  readonly callId: string
  readonly call: ToolCall
  readonly command: Planned | null
  held: boolean
  check: AbortController | null
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
 * Every tool call goes through the gate (`gate`, yian's `beforeToolCall`): a terminal command or typed line by the
 * command reader (`decideCommand`, on what the terminal's plan reads from its shells), every other call by its
 * source (`decideCall`). It runs, is refused, or is held. What the gate let a terminal call do (`Decided`), the call
 * takes when it acts (`Permissions.decided`): from the gate's ledger, or, for a call its approver said Yes to, from
 * the card, as after a restart. A held call's card is made only once yian says it holds the call (`held`), since an
 * agent interrupted while the gate decided writes no hold; in `auto` a call no reader can fully judge goes to Auto's
 * check then, whose run releases it and whose ask makes its card. A Yes releases the call (`release`), noting who
 * approved it; a No completes it with the approver's words. Each held call is decided again (`#recheckHolds`) after
 * a rule is added, when a worker starts on the run (the rules files read again first), and at a restart, from the
 * holds yian recorded (`settleHolds`): one with no card is decided anew, and one whose card the session's mode and
 * rules now let run is answered Yes and released.
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
  /** What the gate let each terminal call it decided do, by call id, until the call takes it. */
  readonly #decided = new Map<string, Decided>()
  /** The approver's No to a card, by the reply whose call it held (`<run>/<node>/<n>`): yian checks that reply's later
   *  calls only once the card is answered, and one No settles all of the reply's calls that would ask. */
  readonly #refusedReplies = new Map<string, string>()
  /** The calls the gate held, by call id, until each is answered, released, completed or closed. */
  readonly #holds = new Map<string, Hold>()
  /** The calls this office released, by call id: a call yian sends again after a stop or crash runs only if it was. */
  readonly #released = new Set<string>()

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
  }

  /** The permissions run `runId`'s tools get, the rules files read again first. Its terminal decides nothing itself:
   *  each of its calls takes what the gate decided for it (`decided`). */
  async permissions(_runId: string, _onQuestion: OnQuestion): Promise<Permissions> {
    await this.reload()
    return {
      mode: () => this.#session().mode,
      rules: () => this.#rules(),
      where: () => this.#where(),
      check: (input, signal) => this.#check.judge(input, signal),
      blocked: () => this.#blocked(),
      decided: (callId) => (callId === undefined ? null : this.#take(callId)),
    }
  }

  /** What the gate let terminal call `callId` do, taken once: from the ledger, or, for a call its approver said Yes
   *  to on its card, from the card (its folder, or its line and the command typed into); null when nothing did. */
  #take(callId: string): Decided | null {
    const decided = this.#decided.get(callId)
    if (decided !== undefined) {
      this.#decided.delete(callId)
      return decided
    }
    const card = this.#store.getQuestionByCall(callId)
    const approval = card?.approval
    if (card === undefined || approval == null || approval.kind === "tool") return null
    if (card.status !== "answered" && card.status !== "consumed") return null
    const read = readAnswer(card).answer
    if (read !== "yes" && read !== "session" && read !== "always") return null
    const text = (value: unknown) => (typeof value === "string" ? value : null)
    const basis: Basis =
      approval.kind === "command"
        ? { cwd: text(approval.args.cwd) }
        : { line: text(approval.args.line) ?? "", into: text(approval.args.into) }
    const why = card.answered_by ? `approved by @${card.answered_by}` : "approved"
    return { why, basis, approved: true }
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
      if (removed && runId !== null) await this.#recheckHolds(runId, by)
      return removed
    }
    const removed = await removeRule(this.#git, this.#handle, { ...rule, source: rule.source }, by)
    if (removed) await this.reload()
    // A deny or an ask rule gone may let a held call run.
    const runId = this.#host.liveRun()
    if (removed && runId !== null) await this.#recheckHolds(runId, by)
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
    return [...this.#holds.values()].some((hold) => hold.check !== null)
  }

  /** Stops the checks on held calls: Esc, End and the office stop end them. */
  stop(): void {
    for (const hold of this.#holds.values()) hold.check?.abort()
  }

  /** The gate's decision on tool call `call` of run `runId` (`decideCall` by the session's mode and rules now), as
   *  yian takes it: a run, with its note; a refusal; or `pending()`, holding the call until it is decided again once
   *  yian holds it (`held`). */
  gate(runId: string, call: GatedCall): GateDecision {
    const { tool, source, arguments: args, attempt } = call
    const command = this.#planned(call)
    if (command === "passes") return undefined
    let decision = command === null ? decideCall(call, this.#policy()) : decideCommand(command, this.#policy())
    // Sent again after a stop or crash, which may have cut it off as the gate decided: yian can't hold it.
    if (attempt > 1) {
      const released = this.#released.has(call.callId) || this.#host.released(runId, call.callId)
      decision = resent(decision, released)
    }
    if (decision.verdict === "run") {
      if (command !== null) {
        this.#decided.set(call.callId, { why: `by ${decision.note}`, basis: command.basis, approved: false })
      }
      return decision.note === null ? undefined : { run: true, note: decision.note }
    }
    // A later call of a reply the approver said No to: the same No, where it would ask.
    const refused = this.#refusedReplies.get(replyOf(call.callId))
    if (refused !== undefined && decision.verdict !== "refuse") decision = { verdict: "refuse", reason: refused }
    if (decision.verdict === "refuse") {
      if (command !== null) this.#host.audited(command, "denied", decision.reason)
      return { refuse: decision.reason }
    }
    const held = { tool, source, arguments: args, attempt }
    this.#holds.set(call.callId, { runId, callId: call.callId, call: held, command, held: false, check: null })
    return pending()
  }

  /** For a terminal command or typed line, what the terminal would act on, or `passes` when there's nothing to decide
   *  (the call's own refusal stops it when it acts); null for any other call. */
  #planned(call: {
    source: GatedCall["source"]
    arguments: Readonly<Record<string, unknown>> | null
  }): Planned | "passes" | null {
    const { source } = call
    if (source.kind !== "host" || source.group !== "terminal" || (source.tool !== "run" && source.tool !== "type")) {
      return null
    }
    // Yian reads the model's integers as bigints; the tool gets them as numbers.
    const args = call.arguments === null ? null : (numbers(call.arguments) as Record<string, unknown>)
    const plan = this.#host.planCommand(source.tool, args)
    return plan.decide ? plan : "passes"
  }

  /** What the gate decides for `hold` by the session's mode and rules now. */
  #decide(hold: Hold): CallDecision {
    return hold.command === null ? decideCall(hold.call, this.#policy()) : decideCommand(hold.command, this.#policy())
  }

  /** Yian holds call `callId` of run `runId` (`CallHeld`): marked held at once, so the end of the job that held it
   *  doesn't forget it (`jobEnded`), then decided again and acted on, after the actor's current step. */
  held(runId: string, callId: string): void {
    const hold = this.#holds.get(callId)
    if (hold === undefined || hold.runId !== runId) {
      this.#log(`session ${this.#session().id}: yian holds a call the gate didn't hold`)
      return
    }
    hold.held = true
    this.#host.post("a held call", async () => {
      if (this.#holds.get(callId) !== hold) return
      await this.#settle(hold, null)
      this.#host.settle("after a held call")
    })
  }

  /** Call `callId` closed (Esc, End, a cancel): its hold is gone, and a check on it stops. */
  closed(callId: string): void {
    this.#holds.get(callId)?.check?.abort()
    this.#holds.delete(callId)
  }

  /** Run `runId`'s job ended: a call the gate held that yian never held (its agent was interrupted as the gate
   *  decided) has no hold to answer. */
  jobEnded(runId: string): void {
    for (const [callId, hold] of this.#holds) if (hold.runId === runId && !hold.held) this.#holds.delete(callId)
    for (const reply of this.#refusedReplies.keys()) {
      if (!reply.startsWith(`${runId}/`)) this.#refusedReplies.delete(reply)
    }
  }

  /** The holds yian recorded for run `runId` (`pendingCalls`), as at a restart: each is known again and decided again
   *  (`#recheckHolds`) once the actor's current step ends. */
  settleHolds(runId: string, calls: readonly PendingCall[]): void {
    for (const call of calls) {
      if (!call.held || call.source === null || !call.callId.startsWith(`${runId}/`)) continue
      if (this.#holds.has(call.callId)) continue
      // Arguments it didn't record are none the gate can judge: it asks.
      const known = { tool: call.tool, source: call.source, arguments: call.arguments, attempt: 1 }
      // A terminal call's plan is read from the shells as they are now.
      const planned = this.#planned({ source: call.source, arguments: call.arguments })
      const command = planned === "passes" ? null : planned
      this.#holds.set(call.callId, { runId, callId: call.callId, call: known, command, held: true, check: null })
    }
    // After the restart's own step: what it releases or completes goes to the run as any later delivery does.
    this.#host.post("the held calls", () => this.#recheckHolds(runId, null))
  }

  /** Each held call of run `runId` decided again, by the rules as read now: a worker started on the run. */
  recheckHolds(runId: string): Promise<void> {
    return this.#recheckHolds(runId, null)
  }

  /** What the gate decides by now: the session's mode, its rules and why every call asks, if one does. */
  #policy(): CallPolicy {
    return { mode: this.#session().mode, rules: this.#rules(), blocked: this.#blocked() }
  }

  /** Each held call of run `runId` that yian holds and no check is judging, decided again (`#settle`): after a rule
   *  was added (as `by`), when a worker starts on the run, at a restart. */
  async #recheckHolds(runId: string, by: string | null): Promise<void> {
    for (const hold of [...this.#holds.values()]) {
      if (hold.runId === runId && hold.held && hold.check === null) await this.#settle(hold, by)
    }
  }

  /**
   * Decides `hold` again and acts on it. A hold of a run that is no longer live, or whose card was answered or
   * closed, is forgotten: its answer, or the run's end, settles it. One whose card is open is changed only when the
   * session's mode and rules now let it run: its card is answered Yes as `by` and the call released, noting why. One
   * with no card runs (released), is refused (completed with why), gets its card, or goes to Auto's check.
   */
  async #settle(hold: Hold, by: string | null): Promise<void> {
    // A check on it decides it when it ends.
    if (hold.check !== null) return
    const card = this.#store.getQuestionByCall(hold.callId)
    if (this.#host.liveRun() !== hold.runId || (card !== undefined && card.status !== "open")) {
      this.#holds.delete(hold.callId)
      return
    }
    const decision = this.#decide(hold)
    if (card === undefined) return this.#act(hold, decision)
    if (decision.verdict !== "run") return
    const answered = this.#answer(card, YES, "option", by)
    if (answered === null) return
    this.#holds.delete(hold.callId)
    await this.#release(hold, decision.note, answered, true)
  }

  /** Releases held call `hold` (`ApprovalHost.release`), remembering that it did, `note` kept in the run log; a
   *  terminal call takes what let it run when it acts (`by <note>`, `approved` when a card's Yes stands behind it). */
  #release(hold: Hold, note: string | null, card: QuestionRecord | null, approved: boolean): Promise<void> {
    this.#released.add(hold.callId)
    if (hold.command !== null) {
      this.#decided.set(hold.callId, { why: `by ${note}`, basis: hold.command.basis, approved })
    }
    return this.#host.release(hold.callId, note, card)
  }

  /** Acts on `decision` for held call `hold`, which has no card: releases it, completes it with its refusal, makes its
   *  card (`dontAsk` by then refuses it), or starts Auto's check on it. */
  async #act(hold: Hold, decision: CallDecision): Promise<void> {
    switch (decision.verdict) {
      case "run":
        this.#holds.delete(hold.callId)
        return this.#release(hold, decision.note, null, false)
      case "refuse":
        this.#holds.delete(hold.callId)
        if (hold.command !== null) this.#host.audited(hold.command, "denied", decision.reason)
        return this.#host.completeCall(hold.callId, decision.reason)
      case "check":
        this.#judge(hold, decision.input, decision.rules)
        return
      case "ask": {
        const session = this.#session()
        try {
          const card = hold.command === null ? toolCard(hold.call, decision) : commandCard(hold.command, decision)
          holdApproval(session, hold.runId, this.#host.onQuestion, { always: true })(card, hold.callId)
          if (hold.command !== null) this.#host.audited(hold.command, "held", decision.reason)
        } catch (error) {
          // A card that can't be stored would leave the call waiting for nobody.
          this.#log(`session ${session.id}: a held call's card can't be made (${errorName(error)})`)
          this.#holds.delete(hold.callId)
          await this.#host.completeCall(hold.callId, "Not run: its approval card couldn't be made.")
        }
      }
    }
  }

  /**
   * Runs Auto's check on held call `hold` (`input`, its card offering `rules`) in the background, the secret values no
   * model may read redacted from what it reads. Once it ends, on the actor's queue, the call is decided again: a
   * mode switch, a rule or a rules file that changed meanwhile wins, and the check's verdict decides only a call still
   * for Auto's check. Nothing happens once the check was stopped, the call closed, or the run is no longer live.
   */
  #judge(hold: Hold, input: CheckInput, rules: readonly string[]): void {
    const stop = new AbortController()
    hold.check = stop
    void (async () => {
      const secrets = await this.#host.secretValues(hold.runId).catch(() => null)
      // Unable to know the secrets, nothing goes to a model: the call asks.
      const verdict = secrets === null
        ? { verdict: "ask" as const, reason: "its secrets couldn't be read", failed: true }
        : await judged((checked, signal) => this.#check.judge(checked, signal), redacted(input, secrets), stop.signal)
      hold.check = null
      if (stop.signal.aborted || this.#holds.get(hold.callId) !== hold) return
      this.#host.post("a check's verdict", async () => {
        if (this.#holds.get(hold.callId) !== hold || this.#host.liveRun() !== hold.runId) return
        const now = this.#decide(hold)
        await this.#act(hold, now.verdict === "check" ? afterCheck(verdict, rules, this.#session().mode) : now)
        this.#host.settle("after a check")
      })
    })()
  }

  /**
   * Acts on approval card `card`'s answer, stored on a call of the run that can still take it. A Yes (or don't ask
   * again, or always) releases the call where yian holds it, its rules added first, noting who approved it; a terminal
   * call then takes its approval from the card. Any other answer completes the call now with what it says
   * (`approvalResult`); a No answers every other open card of the run the same way, by the same approver.
   */
  async answered(card: QuestionRecord): Promise<void> {
    const read = readAnswer(card)
    if (read.answer === "yes" || read.answer === "session" || read.answer === "always") {
      const credit = card.answered_by ? `approved by @${card.answered_by}` : "approved"
      this.#holds.delete(card.call_id!)
      const added = await this.remember(card)
      this.#released.add(card.call_id!)
      await this.#host.release(card.call_id!, credit, card)
      if (added) await this.#recheck(card.answered_by)
      return
    }
    await this.#host.completeWithAnswer(card)
    if (read.answer !== "no") return
    this.#refusedReplies.set(replyOf(card.call_id!), approvalResult(card))
    await this.#answerOpen(() => card.answer, card.answer_kind ?? "text", card.answered_by)
  }

  /** A switch to `dontAsk` by `by`, which never asks: each open card of the run is answered No with "this session is
   *  now in dontAsk mode, which doesn't ask: <the card's reason>", and each call completes. Nothing runs. */
  async refuseOpen(by: string | null): Promise<void> {
    const refusal = (card: QuestionRecord) =>
      `this session is now in dontAsk mode, which doesn't ask: ${card.approval?.reason ?? ""}`
    await this.#answerOpen(refusal, "text", by)
  }

  /** After a "don't ask again" added rules: each held call of the run is decided again (`#recheckHolds`), and one
   *  whose card the session's mode and rules now allow is answered Yes as `by` and released. */
  async #recheck(by: string | null): Promise<void> {
    const runId = this.#host.liveRun()
    if (runId !== null) await this.#recheckHolds(runId, by)
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

/** The approval card a terminal command or typed line is held on, as the terminal's own gate made it: the command or
 *  whole line, the card's arguments (the folder, or the line and the command typed into), the agent's reason, why it
 *  asks and what "don't ask again" may add. */
function commandCard(plan: Planned, asked: { reason: string; rules: readonly string[] }): ApprovalCard {
  const { action } = plan
  return {
    kind: action.kind, tool: plan.tool, action: action.text, args: plan.args, why: plan.why, reason: asked.reason,
    rules: [...asked.rules], partial: action.partial ?? false, into: action.into ?? null,
  }
}

/** The reply a model's call `callId` (`<run>/<node>/<n>/<index>`) is a call of: `<run>/<node>/<n>`. */
function replyOf(callId: string): string {
  return callId.slice(0, callId.lastIndexOf("/"))
}

/** `value` with each bigint a number can hold as a number, as a tool's arguments reach it. */
function numbers(value: unknown): unknown {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value
  if (Array.isArray(value)) return value.map(numbers)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, numbers(v)]))
  }
  return value
}

/** `input` with each of `secrets` redacted from its command, which a model reads. */
function redacted(input: CheckInput, secrets: readonly string[]): CheckInput {
  return secrets.length === 0 ? input : { ...input, command: redact(input.command, [], secrets) }
}

/** What tells a rule from another: its effect, kind and pattern. */
function ruleKey(rule: Pick<Rule, "effect" | "kind" | "pattern">): string {
  return `${rule.effect}\0${rule.kind}\0${rule.pattern}`
}

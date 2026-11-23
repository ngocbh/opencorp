/** The gate on a session's tool calls (yian's `beforeToolCall`), as a chat session and the no-office host both bind
 *  it: what each call does by the session's mode and rules, the calls it holds until yian holds them, Auto's check on a
 *  held call, the cards a held call waits on, and what an answer to one does. The host binds where its cards live,
 *  its policy, its check and how a held call is released or completed. */
import { iterRunRecords, type PendingCall } from "@ngocbh/yian/run"
import { type GatedCall, type GateDecision, pending } from "@ngocbh/yian/tools"
import {
  afterCheck, type CallDecision, type CallPolicy, decideCall, decideCommand, resent, type ToolCall, toolCard,
} from "../../runtime/permissions/gate.ts"
import {
  type ApprovalCard, type Basis, type CheckInput, type Decided, judged, type Verdict,
} from "../../runtime/permissions/policy.ts"
import { approvalResult, type HeldCard, readAnswer, YES } from "../../runtime/questions/approval.ts"
import { LINE_CAP } from "../../runtime/runs/reader.ts"
import type { AnswerKind } from "../../runtime/sessions/harness.ts"
import type { QuestionRecord } from "../../runtime/store/store.ts"
import { errorName, type OfficeGatedCall } from "../../runtime/worker/rpc.ts"
import { type CommandPlan, decidedFor } from "../../tools/terminal/terminal.ts"
import { redact } from "../../util/redact.ts"

/** What a terminal call is refused with when the gate can't read what it would act on. */
const CANT_READ = "Not run: the shell this command was for can't be read now; run it again."

/** Where a session's approval cards live: the store for a chat, memory for the no-office host. */
export interface GateCards {
  /** The card held for call `callId`, of any source, if there is one. */
  byCall(callId: string): QuestionRecord | undefined
  /** Stores `value` (of `kind`) as open card `card`'s answer by `by` and returns the card as stored; null when it was
   *  answered or closed meanwhile. */
  answer(card: QuestionRecord, value: unknown, kind: AnswerKind, by: string | null): QuestionRecord | null
  /** Run `runId`'s open approval cards, oldest first. */
  open(runId: string): readonly QuestionRecord[]
  /** Holds call `callId` of run `runId` on approval card `card`: stored and shown, one per call id. Throws when the
   *  card can't be stored. */
  hold(card: HeldCard, runId: string, callId: string): void
}

/** What the gate needs of the session's host. Each is called on the host's serial queue, as the answer, switch or
 *  frame that leads to it is. */
export interface GateHost {
  /** The run whose calls can still take an answer: the session's current run, or null once it finished. */
  liveRun(): string | null
  /** What the gate decides by now: the session's mode, its rules and why every call asks, if one does. */
  policy(): CallPolicy
  /** Auto's check on `input`; rejects when `signal` aborts. */
  judge(input: CheckInput, signal: AbortSignal): Promise<Verdict>
  /** Runs `job` on the host's serial queue after the jobs before it; skipped once the host closed. */
  post(label: string, job: () => unknown): void
  /** Writes the session's state again; `when` names the step for the log. */
  settle(when: string): void
  /** What the session's terminal would act on for its tool `tool` (`run`, `type`) with `args`, read from its shells
   *  now (`Terminal.plan`); nothing to decide when it has no terminal or the arguments weren't recorded. */
  planCommand(tool: string, args: Readonly<Record<string, unknown>> | null): CommandPlan
  /** Runs held call `callId` once (`release`), `note` kept in the run log; `card`'s answer is consumed once the run
   *  takes it. */
  release(callId: string, note: string | null, card: QuestionRecord | null): Promise<void>
  /** Completes held call `callId` with `output`, which the model reads; its tool never runs. */
  completeCall(callId: string, output: string): Promise<void>
  /** Completes answered `card`'s call with what its answer says (`approvalResult`); its tool never runs. */
  completeWithAnswer(card: QuestionRecord): Promise<void>
  /** Whether run `runId`'s log records that call `callId` was released (`releasedIn`). */
  released(runId: string, callId: string): boolean
  /** The secret values no model may read: run `runId`'s model key, and any others the host knows. Rejects when they
   *  can't be known. */
  secretValues(runId: string): Promise<string[]>
  /** Adds the rules answered `card`'s "don't ask again" (or "always") chose; whether it added any. */
  remember(card: QuestionRecord): Promise<boolean>
  readonly cards: GateCards
  /** Gets log lines, never a call's arguments. */
  log(line: string): void
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
  /** Whether it is a terminal command or typed line, which only the command reader decides. */
  readonly terminal: boolean
  readonly command: Planned | null
  held: boolean
  check: AbortController | null
}

/**
 * The gate on one session's tool calls.
 *
 * Every tool call goes through it (`gate`, yian's `beforeToolCall`): a terminal command or typed line by the command
 * reader (`decideCommand`, on what the terminal's plan reads from its shells), every other call by its source
 * (`decideCall`). It runs, is refused, or is held. What the gate let a terminal call do (`Decided`), the call takes
 * when it acts (`take`): from the gate's ledger, or, for a call its approver said Yes to, from the card. A held
 * call's card is made only once yian says it holds the call (`held`), since an agent interrupted while the gate
 * decided writes no hold; in `auto` a call no reader can fully judge goes to Auto's check then, whose run releases it
 * and whose ask makes its card. A Yes releases the call, noting who approved it; a No completes it with the
 * approver's words, answers the run's other open cards the same way, and refuses the reply's later calls that would
 * ask. Each held call is decided again (`recheckHolds`) after a rule is added, when a worker starts on the run, and
 * at a restart, from the holds yian recorded (`settleHolds`): one with no card is decided anew, and one whose card
 * the session's mode and rules now let run is answered Yes and released.
 */
export class CallGate {
  readonly #host: GateHost
  /** What the gate let each terminal call it decided do, by call id, until the call takes it, and whether it decided
   *  it as the call was gated (then the call starts in that run's job, or never) rather than released it later. */
  readonly #decided = new Map<string, { decided: Decided; runId: string; gated: boolean }>()
  /** The approver's No to a card, by the reply whose call it held (`<run>/<node>/<n>`): yian checks that reply's later
   *  calls only once the card is answered, and one No settles all of the reply's calls that would ask. */
  readonly #refusedReplies = new Map<string, string>()
  /** The calls the gate held, by call id, until each is answered, released, completed or closed. */
  readonly #holds = new Map<string, Hold>()
  /** The calls this gate released, by call id: a call yian sends again after a stop or crash runs only if it was. */
  readonly #released = new Set<string>()

  constructor(host: GateHost) {
    this.#host = host
  }

  /** Whether a check on a held call runs now: the session reads busy. */
  get busy(): boolean {
    return [...this.#holds.values()].some((hold) => hold.check !== null)
  }

  /** Stops the checks on held calls: Esc, End and the host's stop end them. */
  stop(): void {
    for (const hold of this.#holds.values()) hold.check?.abort()
  }

  /** What the gate let terminal call `callId` do, taken once: from the ledger, or, for a call its approver said Yes
   *  to on its card, from the card (its tool, command or line, shell, and folder or command typed into); null when
   *  nothing did. Only a Yes by a person approves: one no approver stands behind approves nothing. */
  take(callId: string | undefined): Decided | null {
    if (callId === undefined) return null
    const entry = this.#decided.get(callId)
    if (entry !== undefined) {
      this.#decided.delete(callId)
      return entry.decided
    }
    const card = this.#host.cards.byCall(callId)
    const approval = card?.approval
    if (card === undefined || approval == null || approval.kind === "tool" || card.answered_by === null) return null
    if (card.source !== "approval" || (card.status !== "answered" && card.status !== "consumed")) return null
    const read = readAnswer(card).answer
    if (read !== "yes" && read !== "session" && read !== "always") return null
    if (approval.tool !== "terminal_run" && approval.tool !== "terminal_type") return null
    const text = (value: unknown) => (typeof value === "string" ? value : null)
    const basis: Basis =
      approval.kind === "command"
        ? { cwd: text(approval.args.cwd) }
        : { line: text(approval.args.line) ?? "", into: text(approval.args.into) }
    return {
      basis, approved: true, tool: approval.tool, text: approval.action, partial: approval.partial,
      shell: text(approval.args.shell),
    }
  }

  /** The gate's decision on tool call `call` of run `runId` (`decideCall` by the session's mode and rules now), as
   *  yian takes it: a run, with its note; a refusal; or `pending()`, holding the call until it is decided again once
   *  yian holds it (`held`). */
  gate(runId: string, call: OfficeGatedCall): GateDecision {
    const { tool, source, arguments: args, attempt } = call
    const command = this.#planned(call)
    if (command === "passes") return undefined
    const policy = this.#host.policy()
    let decision = command === null ? decideCall(call, policy) : decideCommand(command, policy)
    // Sent again after a stop or crash, which may have cut it off as the gate decided: yian can't hold it.
    if (attempt > 1) {
      const released = this.#released.has(call.callId) || this.#host.released(runId, call.callId)
      decision = resent(decision, released)
    }
    if (decision.verdict === "run") {
      if (command !== null) {
        this.#decided.set(call.callId, { decided: decidedFor(command, false), runId, gated: true })
      }
      return decision.note === null ? undefined : { run: true, note: decision.note }
    }
    // A later call of a reply the approver said No to: the same No, where it would ask.
    const refused = this.#refusedReplies.get(replyOf(call.callId))
    if (refused !== undefined && decision.verdict !== "refuse") decision = { verdict: "refuse", reason: refused }
    if (decision.verdict === "refuse") return { refuse: decision.reason }
    // A flow's call keeps the module tools it calls, so it is decided again by them.
    const held = { tool, source, arguments: args, attempt, ...(call.wraps === undefined ? {} : { wraps: call.wraps }) }
    const terminal = command !== null
    const hold = { runId, callId: call.callId, call: held, terminal, command, held: false, check: null }
    this.#holds.set(call.callId, hold)
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
    if (hold.command !== null) return decideCommand(hold.command, this.#host.policy())
    // A terminal call is never decided by its source: with nothing to read, it is refused.
    return hold.terminal ? { verdict: "refuse", reason: CANT_READ } : decideCall(hold.call, this.#host.policy())
  }

  /** Yian holds call `callId` of run `runId` (`CallHeld`): marked held at once, so the end of the job that held it
   *  doesn't forget it (`jobEnded`), then decided again and acted on, after the host's current step. */
  held(runId: string, callId: string): void {
    const hold = this.#holds.get(callId)
    if (hold === undefined || hold.runId !== runId) {
      this.#host.log("yian holds a call the gate didn't hold")
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
    this.#decided.delete(callId)
  }

  /** Run `runId`'s job ended: a call the gate held that yian never held (its agent was interrupted as the gate
   *  decided) has no hold to answer. */
  jobEnded(runId: string): void {
    for (const [callId, hold] of this.#holds) if (hold.runId === runId && !hold.held) this.#holds.delete(callId)
    // A call the gate let run as it was gated starts in that job, or never.
    for (const [callId, entry] of this.#decided) if (entry.runId === runId && entry.gated) this.#decided.delete(callId)
    for (const reply of this.#refusedReplies.keys()) {
      if (!reply.startsWith(`${runId}/`)) this.#refusedReplies.delete(reply)
    }
  }

  /** The holds yian recorded for run `runId` (`pendingCalls`), as at a restart: each is known again and decided again
   *  (`recheckHolds`) once the host's current step ends. */
  settleHolds(runId: string, calls: readonly PendingCall[]): void {
    for (const call of calls) {
      if (!call.held || call.source === null || !call.callId.startsWith(`${runId}/`)) continue
      if (this.#holds.has(call.callId)) continue
      // Arguments it didn't record are none the gate can judge: it asks.
      const known = { tool: call.tool, source: call.source, arguments: call.arguments, attempt: 1 }
      // A terminal call's plan is read from the shells as they are now; one that can't be read is decided by nobody.
      const planned = this.#planned({ source: call.source, arguments: call.arguments })
      const terminal = planned !== null
      const command = planned === "passes" ? null : planned
      const hold = { runId, callId: call.callId, call: known, terminal, command, held: true, check: null }
      this.#holds.set(call.callId, hold)
    }
    // After the restart's own step: what it releases or completes goes to the run as any later delivery does.
    this.#host.post("the held calls", () => this.recheckHolds(runId))
  }

  /** Each held call of run `runId` that yian holds and no check is judging, decided again (`#settle`): after a rule
   *  was added or removed (as `by`), when a worker starts on the run, at a restart. */
  async recheckHolds(runId: string, by: string | null = null): Promise<void> {
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
    const card = this.#host.cards.byCall(hold.callId)
    if (this.#host.liveRun() !== hold.runId || (card !== undefined && card.status !== "open")) {
      this.#holds.delete(hold.callId)
      return
    }
    if (hold.terminal && hold.command === null) {
      // Nothing the terminal would act on can be read now (its arguments weren't recorded, or its shell is gone): its
      // open card waits for the owner, and with none the call is refused.
      if (card !== undefined) return
      this.#holds.delete(hold.callId)
      return this.#host.completeCall(hold.callId, CANT_READ)
    }
    const decision = this.#decide(hold)
    if (card === undefined) return this.#act(hold, decision)
    if (decision.verdict !== "run") return
    const answered = this.#host.cards.answer(card, YES, "option", by)
    if (answered === null) return
    this.#holds.delete(hold.callId)
    await this.#release(hold, decision.note, answered, true)
  }

  /** Releases held call `hold` (`GateHost.release`), remembering that it did, `note` kept in the run log; a terminal
   *  call takes what was decided when it acts (`approved` when a card's Yes stands behind it). */
  #release(hold: Hold, note: string | null, card: QuestionRecord | null, approved: boolean): Promise<void> {
    this.#released.add(hold.callId)
    if (hold.command !== null) {
      this.#decided.set(hold.callId, { decided: decidedFor(hold.command, approved), runId: hold.runId, gated: false })
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
        return this.#host.completeCall(hold.callId, decision.reason)
      case "check":
        this.#judge(hold, decision.input, decision.rules)
        return
      case "ask": {
        try {
          const card = hold.command === null ? toolCard(hold.call, decision) : commandCard(hold.command, decision)
          this.#host.cards.hold(card, hold.runId, hold.callId)
        } catch (error) {
          // A card that can't be stored would leave the call waiting for nobody.
          this.#host.log(`a held call's card can't be made (${errorName(error)})`)
          this.#holds.delete(hold.callId)
          await this.#host.completeCall(hold.callId, "Not run: its approval card couldn't be made.")
        }
      }
    }
  }

  /**
   * Runs Auto's check on held call `hold` (`input`, its card offering `rules`) in the background, the secret values no
   * model may read redacted from what it reads. Once it ends, on the host's queue, the call is decided again: a mode
   * switch, a rule or a rules file that changed meanwhile wins, and the check's verdict decides only a call still for
   * Auto's check. Nothing happens once the check was stopped, the call closed, or the run is no longer live.
   */
  #judge(hold: Hold, input: CheckInput, rules: readonly string[]): void {
    const stop = new AbortController()
    hold.check = stop
    void (async () => {
      const secrets = await this.#host.secretValues(hold.runId).catch(() => null)
      // Unable to know the secrets, nothing goes to a model: the call asks.
      const verdict = secrets === null
        ? { verdict: "ask" as const, reason: "its secrets couldn't be read", failed: true }
        : await judged((checked, signal) => this.#host.judge(checked, signal), redacted(input, secrets), stop.signal)
      hold.check = null
      if (stop.signal.aborted || this.#holds.get(hold.callId) !== hold) return
      this.#host.post("a check's verdict", async () => {
        if (this.#holds.get(hold.callId) !== hold || this.#host.liveRun() !== hold.runId) return
        const now = this.#decide(hold)
        const mode = this.#host.policy().mode
        await this.#act(hold, now.verdict === "check" ? afterCheck(verdict, rules, mode) : now)
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
      const added = await this.#host.remember(card)
      this.#released.add(card.call_id!)
      await this.#host.release(card.call_id!, credit, card)
      if (added) await this.#recheck(card.answered_by)
      return
    }
    // Before the answer goes: a call of the reply gated meanwhile gets the No, not a card.
    if (read.answer === "no") this.#refusedReplies.set(replyOf(card.call_id!), approvalResult(card))
    await this.#host.completeWithAnswer(card)
    if (read.answer !== "no") return
    await this.#answerOpen(() => card.answer, card.answer_kind ?? "text", card.answered_by)
  }

  /** A switch to `dontAsk` by `by`, which never asks: each open card of the run is answered No with "this session is
   *  now in dontAsk mode, which doesn't ask: <the card's reason>", and each call completes. Nothing runs. */
  async refuseOpen(by: string | null): Promise<void> {
    const refusal = (card: QuestionRecord) =>
      `this session is now in dontAsk mode, which doesn't ask: ${card.approval?.reason ?? ""}`
    await this.#answerOpen(refusal, "text", by)
  }

  /** After a "don't ask again" added rules: each held call of the run is decided again (`recheckHolds`), and one
   *  whose card the session's mode and rules now allow is answered Yes as `by` and released. */
  async #recheck(by: string | null): Promise<void> {
    const runId = this.#host.liveRun()
    if (runId !== null) await this.recheckHolds(runId, by)
  }

  /** Answers every open card of the run with `value(card)` (of `kind`) as `by`, and completes each call with what it
   *  says. */
  async #answerOpen(value: (card: QuestionRecord) => unknown, kind: AnswerKind, by: string | null): Promise<void> {
    const runId = this.#host.liveRun()
    if (runId === null) return
    for (const open of this.#host.cards.open(runId)) {
      if (open.call_id === null) continue
      const answered = this.#host.cards.answer(open, value(open), kind, by)
      if (answered !== null) await this.#host.completeWithAnswer(answered)
    }
  }
}

/** Whether the run log `log` records that call `callId` was released (a `released` step); false when it doesn't, or
 *  can't be read. */
export function releasedIn(log: string, callId: string): boolean {
  try {
    for (const entry of iterRunRecords(log, { kinds: ["node_step"], maxLineBytes: LINE_CAP })) {
      const step = (entry.envelope?.record as { step?: Record<string, unknown> } | undefined)?.step
      if (step?.kind === "released" && step.call_id === callId) return true
    }
  } catch {
    // Unreadable: not known to be released, so the call isn't let run.
  }
  return false
}

/** The approval card a terminal command or typed line is held on: the command or whole line, the card's arguments
 *  (the folder, or the line and the command typed into), the agent's reason, why it asks and what "don't ask again"
 *  may add. */
export function commandCard(plan: Planned, asked: { reason: string; rules: readonly string[] }): ApprovalCard {
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

/** A chat session's approvals: what its employee's shell may run without asking, Auto's check on the office's
 *  connection, the cards a held call waits on, and the rules a "don't ask again" adds. */
import path from "node:path"
import { OFFICE } from "@opencorp/protocol"
import { type Connections, isSubscription } from "../../models/connections.ts"
import { callUsd, DEFAULT_PRICE, ZERO_PRICE } from "../../models/cost.ts"
import type { Provider } from "../../models/provider.ts"
import { Check, type CheckRecord, type CheckWorkers, inWorker } from "../../runtime/permissions/classifier.ts"
import { decide, type Permissions, RuleBook, type Where } from "../../runtime/permissions/policy.ts"
import { holdApproval, readAnswer } from "../../runtime/questions/approval.ts"
import type { OnQuestion } from "../../runtime/questions/ask.ts"
import type { QuestionRecord, SessionRecord, Store } from "../../runtime/store/store.ts"
import type { OfficePaths } from "../../util/home.ts"

/** The flow Auto's check runs, which its audit rows name. */
const CHECK_TOOL = "classify_command"

/**
 * A chat session's approvals as the office binds them: the mode from the store, the session's own rules, where its
 * workspace shell runs, Auto's check on the office's connection, cards held through the run's `onQuestion`, and
 * what a Yes adds before the office runs the held call.
 *
 * One check per session, kept while its actor lives, so the same command in the session is judged once. Each check
 * runs as a `classify` worker job on the office's connection, resolved again for each check; its run log goes to
 * the session's `checks/` folder, its verdict to an audit row (`kind` check), and what it spent to the session's
 * cost, priced at the connection's prices.
 */
export class ChatApprovals {
  /** The session's own rules: what "don't ask again" added. */
  readonly book = new RuleBook()
  readonly #store: Store
  readonly #session: () => SessionRecord
  readonly #where: () => Where
  readonly #charge: (runId: string, model: string | null, usd: number) => void
  readonly #check: Check
  /** The office connection the last check resolved, whose prices its usage is charged at. */
  #provider: Provider | null = null

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
    /** How long, in ms, a check may take before it asks (default `CHECK_TIMEOUT_MS`). */
    checkTimeoutMs?: number
  }) {
    this.#store = o.store
    this.#session = o.session
    this.#where = o.where
    this.#charge = (runId, model, usd) => o.charge(runId, model, usd)
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

  /** The permissions run `runId`'s tools get: its cards are held through `onQuestion`. No always-rules are kept, so
   *  no card offers "always". */
  permissions(runId: string, onQuestion: OnQuestion): Permissions {
    return {
      mode: () => this.#session().mode,
      rules: () => this.book.list(),
      where: () => this.#where(),
      hold: (card, callId) => holdApproval(this.#session(), runId, onQuestion, { always: false })(card, callId),
      check: (input, signal) => this.#check.judge(input, signal),
    }
  }

  /** Adds the rules an answered card's "don't ask again" chose to the session's own; an "always" answer's last the
   *  session too, as no always-rules are kept. Whether it added any. */
  async remember(question: QuestionRecord): Promise<boolean> {
    const card = question.approval
    const read = readAnswer(question)
    if (card === null || (read.answer !== "session" && read.answer !== "always")) return false
    for (const pattern of card.rules) this.book.add({ effect: "allow", kind: card.kind, pattern })
    return card.rules.length > 0
  }

  /** Whether the session's mode and rules now let open card `question`'s action run with no card: decided again from
   *  what the card holds, Auto's check not asked again. */
  allows(question: QuestionRecord): boolean {
    const card = question.approval
    if (card === null) return false
    const into = card.into === null ? {} : { into: card.into }
    const action = { kind: card.kind, text: card.action, partial: card.partial, ...into }
    return decide(action, this.#session().mode, this.book.list(), this.#where()).verdict === "allow"
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
      detail: entry.reason,
    })
    if (entry.usage === null || entry.runId === null) return
    const provider = this.#provider
    // A subscription already pays for a model its file doesn't price.
    const price = provider !== null && isSubscription(provider) ? ZERO_PRICE : DEFAULT_PRICE
    const usd = callUsd(provider?.prices ?? {}, entry.model, entry.usage, { default: price })
    this.#charge(entry.runId, entry.model, usd)
  }
}

/** Approval cards: an agent's call held, by its yian call id, until the session's approver picks Yes, Yes and
 *  don't ask again, or types what to do instead. Nothing here waits: yian holds the call, and the office
 *  answers it by `complete`. */
import { pending } from "@ngocbh/yian/tools"
import { type Approval, Question, now, validationMessage } from "@opencorp/protocol"
import { newId, type QuestionRecord, type SessionRecord } from "../store/store.ts"
import { strip } from "../../util/redact.ts"
import { numberedLines, shownCode } from "../../util/show.ts"
import type { OnQuestion } from "./ask.ts"
import { INTERRUPTED } from "./format.ts"

export const YES = "Yes"
export const sessionOption = (rules: readonly string[]) =>
  `Yes, and don't ask again this session for: ${rules.join(", ")}`
export const alwaysOption = (rules: readonly string[]) => `Yes, and always allow: ${rules.join(", ")}`
/** The typed row's label: a typed answer is No, and its text reaches the agent. */
export const NO_TYPED = "No, and tell the agent what to do instead"

/** What a held call returns for a Yes whose result never came back. */
const UNKNOWN_OUTCOME =
  "Not run again: the owner approved this, but the office stopped before its result came back, so it may or may not " +
  "have run."

/** The card a host holds a call on: the protocol's `Approval`, its rules read-only, so a policy's own card (whose
 *  rules are) is one as it is. */
export type HeldCard = Omit<Approval, "rules"> & { readonly rules?: readonly string[] }

export type ApprovalAnswer =
  | { readonly answer: "yes" | "session" | "always" }
  | { readonly answer: "no"; readonly say: string }
  | { readonly answer: "interrupted" }

/** A card's options: Yes; with rules to add, "don't ask again this session" for them; and "always" for them where
 *  the host keeps always-rules (`always`). */
export function approvalOptions(rules: readonly string[], always: boolean): string[] {
  if (rules.length === 0) return [YES]
  return always ? [YES, sessionOption(rules), alwaysOption(rules)] : [YES, sessionOption(rules)]
}

/** What an answered card says. An option is read against the card's own rules, so only the exact Yes labels are a
 *  yes; any other answer is No, with the approver's words when they typed some. */
export function readAnswer(question: QuestionRecord): ApprovalAnswer {
  const { answer, answer_kind: kind } = question
  if (kind === "interrupted") return { answer: "interrupted" }
  if (kind === "option" && typeof answer === "string") {
    const rules = question.approval?.rules ?? []
    if (answer === YES) return { answer: "yes" }
    if (rules.length > 0 && answer === sessionOption(rules)) return { answer: "session" }
    if (rules.length > 0 && answer === alwaysOption(rules)) return { answer: "always" }
  }
  return { answer: "no", say: kind === "text" && typeof answer === "string" ? answer : "" }
}

/** What the held call returns when it can't return the action's own output: the approver's No, an interrupt, or
 *  a Yes whose result never came back (the office stopped while it ran). Never runs anything. */
export function approvalResult(question: QuestionRecord): string {
  const read = readAnswer(question)
  if (read.answer === "interrupted") return INTERRUPTED
  if (read.answer === "no") return strip(read.say) === "" ? "The owner said no." : `The owner said no: ${read.say}`
  return UNKNOWN_OUTCOME
}

/** The action as the owner reads it: one line as `shownCode` shows it, more as numbered lines, so what they approve
 *  is what runs. */
function shown(action: string): string {
  return action.includes("\n") ? numberedLines(action).join("\n") : shownCode(action)
}

/** A `hold` for `session`'s run `runId`: stores the card through `onQuestion` (one per call id) and returns what
 *  the call returns now: `pending()` while it is open, `approvalResult` once answered, and throws for an expired
 *  card, naming only its id. A card that doesn't make a valid question throws a `TypeError` naming only the bad
 *  fields. `always` says whether the host keeps always-rules, which the card then offers. */
export function holdApproval(
  session: SessionRecord,
  runId: string,
  onQuestion: OnQuestion,
  { always }: { always: boolean },
): (card: HeldCard, callId: string) => unknown {
  return (card, callId) => {
    const t = now()
    const what = card.kind === "input" ? "type into a running command" : "run a command"
    const data = {
      id: newId(),
      session_id: session.id,
      run_id: runId,
      node_id: null,
      call_id: callId,
      source: "approval",
      asker: session.person,
      work_item_id: session.work_item_id,
      title: `@${session.person} wants to ${what}`,
      question: typeof card.action === "string" ? shown(card.action) : "",
      options: approvalOptions(Array.isArray(card.rules) ? card.rules : [], always),
      approval: card,
      status: "open",
      created_at: t,
      updated_at: t,
    }
    const parsed = Question.safeParse(data)
    // Only validationMessage's text leaves: the ZodError and its issues can quote the card's values.
    if (!parsed.success) throw new TypeError(validationMessage(Question, parsed.error, data))
    const stored = onQuestion(parsed.data)
    if (stored.status === "open") return pending()
    if (stored.status === "stale") throw new Error(`approval card ${stored.id} expired before it was answered`)
    return approvalResult(stored)
  }
}

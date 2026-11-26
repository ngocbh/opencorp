/** What every session harness offers: the card actions (`CardActor`) and what the session routes call
 *  (`SessionHarness`). The chat harness and the Codex sessions implement it; the routes and the cards call it.
 *  `approverOf` names who answers for a session. */
import type { DeliveryReply, Message, RemoveRuleRequest, RuleList } from "@opencorp/protocol"
import type { Hooks } from "./hooks.ts"
import type { Live } from "../runs/records.ts"
import type { QuestionRecord, SessionRecord } from "../store/store.ts"

/** The four ways a question is answered (`option`, `text`, `sent_back`, `interrupted`): the store's `answer_kind`. */
export type AnswerKind = NonNullable<QuestionRecord["answer_kind"]>

/** What the cards ask of the session actor: the chat harness or the Codex sessions. */
export interface CardActor {
  /** The hooks the questions extension adds the cards' checks and notifications to. */
  readonly hooks: Hooks
  /** Answer an open question as `by` after the `answerCheck` hooks and deliver it to its run; throws
   *  `HarnessError` (404 not_found, 409 not_open, 422 invalid_answer, ...). */
  answer(
    questionId: string,
    value: unknown,
    kind: AnswerKind,
    options?: { by?: string | null },
  ): Promise<QuestionRecord>
  /** Esc on a live session: its model questions are answered interrupted and the reply stops; throws
   *  `HarnessError` when the session has no run to stop. A card's stop names its `question`: refused 409
   *  `not_open` unless it is open with no other interrupt under way, and 409 `ending` while the session ends. */
  interrupt(sessionId: string, options?: { question?: string | null }): Promise<void>
}

/** The office's harness for the session routes: the card actions, plus what the session routes call. Each call
 *  throws `HarnessError` for an API error (404 not_found, 409 not_live, 422 refused, 501 not_implemented, ...). */
export interface SessionHarness extends CardActor {
  /** Starts `handle`'s main chat in `cwd` on `harness`, opened by `openedBy`; `connection` and `model` are their
   *  pick, which the harness may pass over. */
  startSession(
    handle: string,
    cwd: string,
    options: {
      harness: SessionRecord["harness"]
      openedBy: string | null
      connection: string | null
      model: string | null
    },
  ): Promise<SessionRecord>
  /** Opens a profile-manager session over `handle`'s profile, opened by `by`, with `text` as its first message.
   *  Only the chat harness runs one; Codex sessions don't. */
  startManager?(handle: string, text: string, options?: { by?: string | null }): Promise<SessionRecord>
  /** A message from `by` (the opener when null): a turn, a steer, an answer or queued. */
  prompt(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** Steers the running reply as `by`; with no reply running it is a `prompt`. */
  steer(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** A message from `by` (the opener when null) for the next turn, which the running reply never reads; anyone who may
   *  prompt may queue. The chat harness implements it, and a Codex or Claude Code session refuses it `422
   *  not_supported`. */
  queue?(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** Takes back `by`'s unread message `messageId` as `by`, who must be the session's approver (`approverOf`): 403
   *  forbidden for anyone else, 404 not_found for no such unread message of `by`'s, 409 already_read and 409
   *  already_withdrawn; the chat harness implements it. */
  withdraw?(sessionId: string, messageId: string, options: { by: string }): Promise<void>
  /** Moves `by`'s unread message `messageId` to steer the running reply (`steer`) or to wait for the next turn
   *  (`queue`), as `by`, who must be the session's approver; refused as `withdraw` is, and a send there that fails
   *  is a reply that says why, and gives the text back when the message went back nowhere. The chat harness
   *  implements it. */
  setDelivery?(
    sessionId: string,
    messageId: string,
    delivery: "steer" | "queue",
    options: { by: string },
  ): Promise<DeliveryReply>
  /** Ends the session, interrupting a busy reply first; ending one already ending is a no-op. */
  end(sessionId: string): Promise<void>
  /** Continues an ended session as a new one opened by `by`. */
  continueSession(sessionId: string, options?: { by?: string | null }): Promise<SessionRecord>
  /** Sets the session's cost cap. */
  setCostCap(sessionId: string, usd: number): Promise<SessionRecord>
  /** Switches the session's connection and model for its next turn. */
  setModel(sessionId: string, connection: string, model: string): Promise<SessionRecord>
  /** Switches the session's mode as `by`, who must be its approver (`approverOf`); throws `HarnessError` 404
   *  not_found, 409 not_live for a session whose run has ended, 403 forbidden for anyone but the approver, and 422
   *  not_supported for a Codex session, which doesn't follow the mode yet. */
  setMode(sessionId: string, mode: SessionRecord["mode"], options?: { by?: string | null }): Promise<SessionRecord>
  /** The session's rules, each with its source (the session's, its agent's or the company's), and the rules files that
   *  exist but don't load; the chat harness implements it. 404 not_found. */
  rules?(sessionId: string): Promise<RuleList>
  /** Removes a session or agent rule of the session as `by`, who must be its approver (`approverOf`): 404 not_found for
   *  no such session or rule, 403 forbidden for anyone but the approver, 409 company_rule for a company rule (only an
   *  edit of the company repo's rules.yaml changes one), 409 refused for an agent's file that doesn't load or has
   *  changes nobody committed, and company_repo_busy (409, or 503 for a stuck lock) while git can't commit; the chat
   *  harness implements it. */
  removeRule?(sessionId: string, rule: RemoveRuleRequest, options: { by: string }): Promise<void>
  /** What a client reads of the session before following its live events. */
  messages(sessionId: string): Message[] | Promise<Message[]>
  /** The newest `limit` of `messages` before the message `before` names, or the newest of all, and `next`, the id of
   *  the page's first message when older ones come before it; null when `before` names no message of the session.
   *  The chat harness implements it, reading a yian chat from its logs' ends. */
  messagesPage?(
    sessionId: string,
    limit: number,
    before: string | null,
  ): Promise<{ messages: Message[]; next: string | null } | null>
  /** What memory says about its runs, for Run Logs; the chat harness implements it. */
  live?(): Live
  /** Closes each parked worker whose connection changed; the chat harness implements it. Never rejects. */
  connectionsChanged?(): Promise<void>
}

/** Who answers for `session`: approval cards, its mode and its rules. Its opener, else the company's CEO. */
export function approverOf(session: SessionRecord, ceo: string | null): string | null {
  return session.opened_by ?? ceo
}

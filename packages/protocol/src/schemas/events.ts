// Protocol schemas: events.
import { z } from "zod"
import { Timestamp, Ulid } from "./common"

/** A metadata change, written to the outbox. */
export const Event = z.strictObject({
  id: Ulid,
  type: z.enum([
    "work_item.created", "work_item.updated", "comment.created",
    "session.created", "session.updated",
    "question.created", "question.updated",
    "feedback.created", "feedback.updated",
    "debrief.created", "debrief.updated",
    "profile.updated",
    "profile_proposal.created", "profile_proposal.updated",
    "company.updated", "run.updated",
  ]),
  at: Timestamp,
  subject_id: z.string(),
  /**
   * The entity after the change; for company.updated, `{sha}` of the new company commit; for run.updated, a
   * RunUpdated.
   */
  data: z.record(z.string(), z.unknown()),
})
export type Event = z.input<typeof Event>

/**
 * Streamed content that is never stored as metadata. For part.delta, data is {message_id, part_id, text} and
 * the text is appended.
 */
export const LiveEvent = z.strictObject({
  type: z.enum(["message.updated", "part.updated", "part.delta"]),
  session_id: Ulid,
  data: z.record(z.string(), z.unknown()),
})
export type LiveEvent = z.input<typeof LiveEvent>

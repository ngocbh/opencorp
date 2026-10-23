// Protocol schemas: profiles.
import { z } from "zod"
import { GitId, Handle, Timestamp, Ulid } from "./common"

export const Profile = z.strictObject({
  person: Handle,
  text: z.string(),
  version: GitId,
  over_budget: z.boolean().default(false),
})
export type Profile = z.input<typeof Profile>

export const ProfileProposal = z.strictObject({
  id: Ulid,
  session_id: Ulid,
  person: Handle,
  base_version: GitId,
  text: z.string(),
  diff: z.string(),
  status: z.enum(["open", "applied", "discarded", "stale"]),
  commit: GitId.nullable().default(null),
  created_at: Timestamp,
})
export type ProfileProposal = z.input<typeof ProfileProposal>

export const FollowUp = z.strictObject({
  text: z.string(),
  confirmed: z.boolean().default(false),
  work_item_id: Ulid.nullable().default(null),
})
export type FollowUp = z.input<typeof FollowUp>

export const Debrief = z.strictObject({
  session_id: Ulid,
  state: z.enum(["pending", "ready"]),
  summary: z.string().nullable().default(null),
  /** The debrief flow's own status. */
  status: z.string().nullable().default(null),
  artifacts: z.array(z.string()).default(() => []),
  decisions: z.array(z.string()).default(() => []),
  follow_ups: z.array(FollowUp).default(() => []),
  open_questions: z.array(z.string()).default(() => []),
  cost: z.number().min(0).default(0),
  updated_at: Timestamp,
})
export type Debrief = z.input<typeof Debrief>

export const Feedback = z.strictObject({
  id: Ulid,
  session_id: Ulid,
  run_id: z.string(),
  author: Handle,
  text: z.string(),
  status: z.enum(["queued", "learning", "applied", "learning_failed"]),
  attempts: z.int().min(0).default(0),
  /** The profile commit once applied. */
  commit: GitId.nullable().default(null),
  /** Why learning from it failed, when the office knows. */
  failure: z.string().nullable().default(null),
  created_at: Timestamp,
})
export type Feedback = z.input<typeof Feedback>

export const ProfileWriteRequest = z.strictObject({
  text: z.string(),
  base_version: GitId,
})
export type ProfileWriteRequest = z.input<typeof ProfileWriteRequest>

export const VersionConflict = z.strictObject({
  expected: GitId,
  current: GitId,
})
export type VersionConflict = z.input<typeof VersionConflict>

export const ProfileManagerRequest = z.strictObject({
  /** The first message. */
  text: z.string().min(1),
})
export type ProfileManagerRequest = z.input<typeof ProfileManagerRequest>

export const FeedbackRequest = z.strictObject({
  session_id: Ulid,
  /** Null means the session's latest run. */
  run_id: z.string().nullable().default(null),
  text: z.string().min(1),
})
export type FeedbackRequest = z.input<typeof FeedbackRequest>

export const ConfirmFollowUpsRequest = z.strictObject({
  indices: z.array(z.int().min(0)),
})
export type ConfirmFollowUpsRequest = z.input<typeof ConfirmFollowUpsRequest>

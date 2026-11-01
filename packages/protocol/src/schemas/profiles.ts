import { z } from "zod"
import { GitId, Handle, MessageText, Timestamp, Ulid } from "./common"

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
  text: MessageText,
})
export type ProfileManagerRequest = z.input<typeof ProfileManagerRequest>

// Runtime guards for event `data`. The protocol types it as a plain object; these check the
// fields the client keys on or reads, so a malformed event is skipped rather than corrupting
// state.
import type { Event, Message, Part } from "@agent-corp/protocol"

/** `part.updated` data: the whole part. */
export type PartUpdated = { message_id: string; part: Part }
/** `part.delta` data: text appended to a text part. */
export type PartDelta = { message_id: string; part_id: string; text: string }

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === "string"
const isPart = (v: unknown): v is Part => isObject(v) && isString(v.id) && isString(v.type)

/** `message.updated` data as a `Message`, or undefined if it isn't one. */
export function asMessage(data: unknown): Message | undefined {
  if (!isObject(data) || !isString(data.id) || !isString(data.role) || !Array.isArray(data.parts)) return
  if (!data.parts.every(isPart)) return
  return data as Message
}

export function asPartUpdated(data: unknown): PartUpdated | undefined {
  if (!isObject(data) || !isString(data.message_id) || !isPart(data.part)) return
  return data as PartUpdated
}

export function asPartDelta(data: unknown): PartDelta | undefined {
  if (!isObject(data) || !isString(data.message_id) || !isString(data.part_id) || !isString(data.text)) return
  return data as PartDelta
}

const hasStrings = (v: unknown, keys: string[]) => isObject(v) && keys.every((k) => isString(v[k]))

// The fields each metadata event's reducer keys on, sorts by, or filters by.
const META_FIELDS: Record<string, string[]> = {
  session: ["id", "person", "cwd", "kind", "status", "updated_at"],
  question: ["id", "session_id", "status", "created_at"],
  work_item: ["id"],
  profile_proposal: ["id"],
  feedback: ["id"],
  debrief: ["session_id"],
  profile: [],
  comment: ["id", "work_item_id"],
}

/** Whether a metadata event's `data` has what its reducer needs; unknown types pass. */
export function isMetaData(e: Event) {
  if (!isString(e.type)) return false
  const fields = META_FIELDS[e.type.slice(0, e.type.lastIndexOf("."))]
  return fields === undefined || hasStrings(e.data, fields)
}

// Runtime guards for live event `data`. The protocol types it as a plain object; these check
// the fields the client reads, so a malformed event is skipped rather than corrupting state.
import type { Message, Part } from "@agent-corp/protocol"

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

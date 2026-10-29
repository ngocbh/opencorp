import type { Message } from "@opencorp/protocol"

/**
 * A message the person has sent that the office hasn't published yet. The transcript is a view
 * over the run log, so the office can only publish a message once a run has taken it at a `seq`;
 * until then this is the only copy of what was typed.
 */
export type PendingMessage = {
  /** The client's own id. The office's come from the run log, so the two can't collide. */
  id: string
  text: string
  created_at: string
}

/** One transcript's pending sends, and the office's user messages they were reconciled against. */
export type Pending = {
  /** Oldest first, in the order they were sent. */
  messages: PendingMessage[]
  /** The office's user messages a reconcile has already accounted for. */
  seen: Record<string, true>
  /** The number the next pending id takes. */
  next: number
}

export function noPending(): Pending {
  return { messages: [], seen: {}, next: 1 }
}

/** Adds `text`, sent at `at`, as a pending message; `id` is what `dropped` takes to remove it again. */
export function sent(p: Pending, text: string, at: string): { pending: Pending; id: string } {
  const id = `pending:${p.next}`
  return {
    pending: { ...p, messages: [...p.messages, { id, text, created_at: at }], next: p.next + 1 },
    id,
  }
}

/** Removes the pending message `id`, for a send that failed; unknown ids leave `p` as it is. */
export function dropped(p: Pending, id: string): Pending {
  if (!p.messages.some((m) => m.id === id)) return p
  return { ...p, messages: p.messages.filter((m) => m.id !== id) }
}

/**
 * Takes the pending messages the office has published: each of `userMessageIds` that is new to this
 * transcript takes the oldest pending message, since sends go out one at a time and the office
 * publishes them in that order. The order, not the text: the office's message carries its own id,
 * the author it resolved and the parts it built, which needn't be what was typed. Called with every
 * user message the transcript holds, so a resync reconciles as a live event does.
 */
export function published(p: Pending, userMessageIds: readonly string[]): Pending {
  const fresh = userMessageIds.filter((id) => !p.seen[id])
  if (!fresh.length) return p
  const seen = { ...p.seen }
  for (const id of fresh) seen[id] = true
  return { ...p, messages: p.messages.slice(fresh.length), seen }
}

/** `m` as the transcript renders it: a user message of `sessionID` carrying the text that was typed. */
export function pendingMessage(sessionID: string, m: PendingMessage): Message {
  return {
    id: m.id,
    session_id: sessionID,
    role: "user",
    author: null,
    parts: [{ id: `${m.id}:0`, type: "text", text: m.text }],
    created_at: m.created_at,
  }
}

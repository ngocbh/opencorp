import type { Message } from "@opencorp/protocol"

/** What the office ends a reply stopped short with; mirrors opencorp.chat.transcript.INTERRUPTED_TEXT. */
export const INTERRUPTED_TEXT = "\n\n[interrupted]"

/**
 * A transcript as it was when the user pressed Esc. The office stops a reply only at its next
 * safe point, so output can arrive after Esc; the view hides it. A message sent before Esc stays
 * queued and a later turn answers it, so that turn's output shows.
 */
export type Freeze = {
  /** Until the next message the user sends, assistant messages that are new are hidden too. */
  active: boolean
  /**
   * The stopped turn's last assistant message at Esc. A new assistant message after it and a user
   * message after that answers the user message in a later turn, so it shows.
   */
  from?: string
  messages: Record<string, true>
  parts: Record<string, true>
  /** Each frozen text part's length at Esc. */
  texts: Record<string, number>
  /** Assistant messages that arrived while frozen; hidden for good. */
  hidden: Record<string, true>
}

/**
 * Freezes `messages` as they are now, keeping what an earlier freeze `prev` hid. While `prev` is
 * still active, the assistant messages that arrived since are hidden rather than frozen, unless
 * `prev` shows them as a later turn's. `turn` holds the assistant messages from before the stopped
 * turn began; without it, every new assistant message stays hidden.
 */
export function freeze(messages: Message[], prev?: Freeze, turn?: Record<string, true>): Freeze {
  const f: Freeze = { active: true, messages: {}, parts: {}, texts: {}, hidden: { ...prev?.hidden } }
  const shown = prev?.active ? revealed(prev, messages) : new Set<string>()
  for (const m of messages) {
    if (prev?.active && m.role === "assistant" && !prev.messages[m.id] && !shown.has(m.id)) f.hidden[m.id] = true
    if (f.hidden[m.id]) continue
    f.messages[m.id] = true
    for (const p of m.parts) {
      if (prev?.messages[m.id] && !prev.parts[p.id]) continue
      f.parts[p.id] = true
      if (p.type === "text") f.texts[p.id] = prev?.texts[p.id] ?? p.text.length
    }
  }
  // A hidden message is a stopped turn's, never the one this Esc stops.
  const last = messages.findLast((m) => m.role === "assistant" && f.messages[m.id])
  if (turn && last && !turn[last.id]) f.from = last.id
  return f
}

/**
 * Ends a freeze when the user sends a message: assistant messages that came in meanwhile stay
 * hidden, except a later turn's.
 */
export function unfreeze(f: Freeze, messages: Message[]): Freeze {
  const hidden = { ...f.hidden }
  const shown = revealed(f, messages)
  for (const m of messages) if (m.role === "assistant" && !f.messages[m.id] && !shown.has(m.id)) hidden[m.id] = true
  return { ...f, active: false, hidden }
}

/**
 * The ids of the assistant messages new since Esc that a later turn wrote: those after `f.from`
 * and a user message after it. The stopped turn writes nothing past a user message it didn't
 * read, and the user's own sends end the freeze first, so such a message answers a send from
 * before Esc (or another client's).
 */
function revealed(f: Freeze, messages: Message[]) {
  const ids = new Set<string>()
  if (!f.active || !f.from) return ids
  let passed = false
  let open = false
  for (const m of messages) {
    if (m.id === f.from) passed = true
    else if (passed && m.role === "user") open = true
    else if (open && m.role === "assistant" && !f.messages[m.id] && !f.hidden[m.id]) ids.add(m.id)
  }
  return ids
}

/** `messages` as the frozen view shows them. */
export function frozenList(f: Freeze | undefined, messages: Message[]): Message[] {
  const shown = f ? revealed(f, messages) : new Set<string>()
  return messages.flatMap((m) => (shown.has(m.id) ? [m] : (frozenView(f, m) ?? [])))
}

/** `m` as the frozen view shows it, or undefined if it is hidden. */
export function frozenView(f: Freeze | undefined, m: Message): Message | undefined {
  if (!f) return m
  if (f.hidden[m.id]) return undefined
  if (!f.messages[m.id]) return f.active && m.role === "assistant" ? undefined : m
  let changed = false
  // The interrupted marker shows through: it is how the stopped reply says it was stopped.
  const parts = m.parts.flatMap((p) => {
    if (!f.parts[p.id]) {
      if (p.type === "text" && p.text === INTERRUPTED_TEXT.trimStart()) return [p]
      return (changed = true), []
    }
    const len = f.texts[p.id]
    if (p.type !== "text" || len === undefined || p.text.length <= len) return [p]
    changed = true
    const marker = p.text.endsWith(INTERRUPTED_TEXT) ? INTERRUPTED_TEXT : ""
    return [{ ...p, text: p.text.slice(0, len) + marker }]
  })
  return changed ? { ...m, parts } : m
}

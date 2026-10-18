import type { Message } from "@opencorp/protocol"

/** What the office ends a reply stopped short with; mirrors opencorp.chat.transcript.INTERRUPTED_TEXT. */
export const INTERRUPTED_TEXT = "\n\n[interrupted]"

/**
 * A transcript as it was when the user pressed Esc. The office stops a reply only at its next
 * safe point, so output can arrive after Esc; the view hides it.
 */
export type Freeze = {
  /** Until the next message the user sends, assistant messages that are new are hidden too. */
  active: boolean
  messages: Record<string, true>
  parts: Record<string, true>
  /** Each frozen text part's length at Esc. */
  texts: Record<string, number>
  /** Assistant messages that arrived while frozen; hidden for good. */
  hidden: Record<string, true>
}

/**
 * Freezes `messages` as they are now, keeping what an earlier freeze `prev` hid. While `prev` is
 * still active, the assistant messages that arrived since are hidden rather than frozen.
 */
export function freeze(messages: Message[], prev?: Freeze): Freeze {
  const f: Freeze = { active: true, messages: {}, parts: {}, texts: {}, hidden: { ...prev?.hidden } }
  for (const m of messages) {
    if (prev?.active && m.role === "assistant" && !prev.messages[m.id]) f.hidden[m.id] = true
    if (f.hidden[m.id]) continue
    f.messages[m.id] = true
    for (const p of m.parts) {
      if (prev?.messages[m.id] && !prev.parts[p.id]) continue
      f.parts[p.id] = true
      if (p.type === "text") f.texts[p.id] = prev?.texts[p.id] ?? p.text.length
    }
  }
  return f
}

/** Ends a freeze when the user sends a message: assistant messages that came in meanwhile stay hidden. */
export function unfreeze(f: Freeze, messages: Message[]): Freeze {
  const hidden = { ...f.hidden }
  for (const m of messages) if (m.role === "assistant" && !f.messages[m.id]) hidden[m.id] = true
  return { ...f, active: false, hidden }
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

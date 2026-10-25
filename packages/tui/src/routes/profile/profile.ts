import type { Message, Session } from "@opencorp/protocol"

/** The first seven characters of a version id, as git shows them. */
export const shortVersion = (version: string) => version.slice(0, 7)

// An HTML comment, so a markdown preview of the file hides it.
export const CONFLICT_MARKER =
  "<!-- The profile changed as you edited. Your edit is below: merge it above. Saving drops this line and below. -->"

/** The editor text after a rejected save: the current profile, then the marker, then the rejected edit. */
export function conflictText(current: string, mine: string) {
  return `${current.endsWith("\n") ? current : current + "\n"}\n${CONFLICT_MARKER}\n${mine}`
}

// Found by its start, so an editor that wraps or trims the long line still cuts there.
const CONFLICT_START = /^<!-- The profile changed as you edited\./m

/** `text` without the conflict marker, everything after it, and the blank line before it. */
export function withoutConflict(text: string) {
  const at = text.search(CONFLICT_START)
  if (at < 0) return text
  return text.slice(0, at).replace(/\n\n$/, "\n")
}

/** The session statuses a manager chat can still take messages in. */
export const LIVE = new Set<Session["status"]>(["starting", "idle", "busy", "waiting"])

/** The person's newest profile manager session that can still take a message. */
export function managerSession(sessions: readonly Session[], person: string) {
  return sessions
    .filter((s) => s.kind === "profile_manager" && s.person === person && LIVE.has(s.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}

/** The manager chat as lines: text parts as they are, tool calls as `[tool]`. */
export function transcript(messages: readonly Message[]) {
  return messages.flatMap((m) =>
    m.parts.flatMap((p) => {
      if (p.type === "text") return p.text ? [{ role: m.role, text: p.text }] : []
      if (p.type === "tool") return [{ role: m.role, text: `[${p.tool}]` }]
      return []
    }),
  )
}

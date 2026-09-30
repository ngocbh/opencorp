import type { Message, ProfileProposal, Session } from "@agent-corp/protocol"

/** The first seven characters of a version id, as git shows them. */
export const shortVersion = (version: string) => version.slice(0, 7)

// An HTML comment, so a markdown preview of the file hides it.
export const CONFLICT_MARKER =
  "<!-- The profile changed as you edited. Your edit is below: merge it above. Saving drops this line and below. -->"

/** The editor text after a rejected save: the current profile, then the marker, then the rejected edit. */
export function conflictText(current: string, mine: string) {
  return `${current.endsWith("\n") ? current : current + "\n"}\n${CONFLICT_MARKER}\n${mine}`
}

/** `text` without the conflict marker, everything after it, and the blank line before it. */
export function withoutConflict(text: string) {
  const at = text.indexOf(CONFLICT_MARKER)
  if (at < 0) return text
  return text.slice(0, at).replace(/\n\n$/, "\n")
}

const LIVE = new Set<Session["status"]>(["starting", "idle", "busy"])

/** The person's newest profile manager session that can still take a message. */
export function managerSession(sessions: readonly Session[], person: string) {
  return sessions
    .filter((s) => s.kind === "profile_manager" && s.person === person && LIVE.has(s.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}

/** The person's newest open proposal (the office keeps one open per manager session). */
export function openProposal(proposals: readonly ProfileProposal[], person: string) {
  return proposals
    .filter((p) => p.person === person && p.status === "open")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}

/** A unified diff's lines from its first hunk on, so without the file headers. */
export function diffLines(diff: string) {
  const lines = diff.split("\n")
  // Skip only the headers before the first hunk: a removed "-- x" line reads "--- x" too.
  const start = lines.findIndex((l) => l.startsWith("@@"))
  return start < 0 ? [] : lines.slice(start).filter((l) => l)
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

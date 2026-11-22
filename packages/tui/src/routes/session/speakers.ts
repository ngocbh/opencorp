import type { Person, Session } from "@opencorp/protocol"

/**
 * The session's owner, the one person whose keys its shells take and whose word wins in it: who opened it, else the
 * CEO, the company's human at the top of the org chart; with more than one there, it isn't known.
 */
export function sessionOwner(session: Pick<Session, "opened_by"> | undefined, people: readonly Person[]) {
  if (session?.opened_by) return session.opened_by
  const top = people.filter((p) => p.kind === "human" && !p.manager)
  return top.length === 1 ? top[0]!.handle : undefined
}

/**
 * Who sent a message in a Codex or Claude Code session an employee's chat drives, as the office names its two speakers
 * to the harness: the owner by name, `<Name> (owner)`, and anyone else by handle, `@minh`. A message with no author
 * is the owner's.
 */
export function speakerLabel(author: string | null | undefined, owner: string | undefined, people: readonly Person[]) {
  if (author && author !== owner) return `@${author}`
  if (!owner) return "the owner"
  return `${people.find((p) => p.handle === owner)?.name ?? `@${owner}`} (owner)`
}

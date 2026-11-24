import type { Instrument, Person, Session } from "@opencorp/protocol"
import { display } from "./printable"
import { personLabel } from "./transcript"

type SessionNode = {
  id: string
  /** The session this one is a child of: the chat that drives it. */
  instrument_of?: string | null
}

/**
 * The children of the root of `sessionID`'s family, depth first, each with the tree prefix its row draws (`├─ `,
 * `└─ `); the root itself isn't listed. Empty when `sessions` doesn't hold `sessionID`. The upstream TUI's, with a
 * child's parent read from `instrument_of`.
 */
export function sessionFamily<T extends SessionNode>(sessions: readonly T[], sessionID: string) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const current = byID.get(sessionID)
  if (!current) return []

  const children = new Map<string, T[]>()
  sessions.forEach((session) => {
    if (!session.instrument_of) return
    const group = children.get(session.instrument_of)
    if (group) group.push(session)
    else children.set(session.instrument_of, [session])
  })

  function root(session: T): T {
    const parent = session.instrument_of ? byID.get(session.instrument_of) : undefined
    return parent ? root(parent) : session
  }

  function walk(parentID: string, ancestors: boolean[]): Array<{ session: T; prefix: string }> {
    const group = children.get(parentID) ?? []
    return group.flatMap((session, index) => {
      const last = index === group.length - 1
      const prefix =
        ancestors.length === 0
          ? ""
          : ancestors
              .slice(1)
              .map((ancestor) => (ancestor ? "   " : "│  "))
              .join("") + (last ? "└─ " : "├─ ")
      return [{ session, prefix }, ...walk(session.id, [...ancestors, last])]
    })
  }

  return walk(root(current).id, [])
}

/** What a session that isn't one of a chat's instruments is, by its kind. */
const KIND_NAME: Record<Exclude<Session["kind"], "instrument">, string> = {
  main: "chat",
  side: "side chat",
  profile_manager: "profile",
}

/**
 * What a link to each of `state`'s sessions says, in place of the upstream TUI's session title, which ours lack: its
 * person, then its name in its chat's list for a Codex or Claude Code session (`@minh · codex 1`), else its kind
 * (`@minh · chat`).
 */
export function sessionLabels(state: {
  people: readonly Pick<Person, "handle">[]
  sessions: readonly Pick<Session, "id" | "person" | "kind" | "harness" | "instrument_of">[]
  instruments: Readonly<Record<string, readonly Pick<Instrument, "id" | "name">[] | undefined>>
}) {
  return new Map(
    state.sessions.map((session) => {
      const chat = session.instrument_of
      const listed = chat ? state.instruments[chat]?.find((i) => i.id === session.id) : undefined
      // Not yet in its chat's list: its harness names it, as the picker does.
      const harness = session.harness === "claude" ? "Claude Code session" : "Codex session"
      const name =
        session.kind === "instrument" ? (listed ? display(listed.name) : harness) : KIND_NAME[session.kind]
      return [session.id, `${personLabel(state.people, session.person)} · ${name}`] as const
    }),
  )
}

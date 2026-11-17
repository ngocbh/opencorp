import { SessionMode, type Session } from "@opencorp/protocol"
import { createStore } from "solid-js/store"
import { useOffice } from "./office"
import { createSimpleContext } from "./helper"

/** The next of `SessionMode.options`: auto → default → ask → dontAsk → auto. */
export function nextMode(mode: SessionMode): SessionMode {
  const modes = SessionMode.options
  return modes[(modes.indexOf(mode) + 1) % modes.length]!
}

/** A chat's mode as the office holds it. The TUI shows it and asks the office to switch it; it never answers
 *  an approval card itself. */
export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const office = useOffice()
    // The office's replies to switches, so a second Shift+Tab reads the first one's mode before its event arrives.
    const [replies, setReplies] = createStore<Record<string, Session>>({})
    // One switch at a time per session, each from the mode the one before it left.
    const pending = new Map<string, Promise<unknown>>()

    /** The newest of the session as the office's events left it and as its last switch answered. */
    function latest(sessionID: string): Session | undefined {
      const event = office.state.sessions.find((s) => s.id === sessionID)
      const reply = replies[sessionID]
      return reply && (!event || reply.updated_at > event.updated_at) ? reply : event
    }

    /** The session's mode, or null for a Codex session (its mode isn't switchable until it follows one). */
    function mode(sessionID: string): SessionMode | null {
      const session = latest(sessionID)
      if (!session || session.harness === "codex") return null
      return session.mode ?? "auto"
    }

    async function set(sessionID: string, next: SessionMode): Promise<Session> {
      const session = await office.client.sessions.setMode(sessionID, { mode: next })
      setReplies(sessionID, session)
      return session
    }

    return {
      mode,
      set,
      /** Switches to `nextMode` of the current one. */
      cycle(sessionID: string): Promise<Session> {
        const run = (pending.get(sessionID) ?? Promise.resolve())
          .catch(() => {})
          .then(() => {
            const current = mode(sessionID)
            if (current === null) throw new Error("This chat's mode can't be switched")
            return set(sessionID, nextMode(current))
          })
        pending.set(sessionID, run)
        void run.finally(() => pending.get(sessionID) === run && pending.delete(sessionID)).catch(() => {})
        return run
      },
    }
  },
})

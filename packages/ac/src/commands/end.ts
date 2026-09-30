import { realpathSync } from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { createOfficeClient, type OfficeClient } from "@agent-corp/tui/office/client"
import { defaultSocket } from "@agent-corp/tui/office/paths"

type Session = Awaited<ReturnType<OfficeClient["sessions"]["get"]>>

// An ending session is already on its way out, and a debriefing or later one is not live.
const ENDABLE = new Set<Session["status"]>(["starting", "idle", "busy"])

/**
 * Ends session `id`, or else the most recently updated live main session in `cwd`; resolves to
 * the session. The office interrupts a busy session first, then runs its debrief.
 */
export async function endSession(opts: { client: OfficeClient; cwd: string; id?: string }): Promise<Session> {
  const { client, cwd } = opts
  const session = opts.id
    ? await client.sessions.get(opts.id)
    : (await client.sessions.list())
        .filter((s) => s.kind === "main" && s.cwd === cwd && ENDABLE.has(s.status))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  if (!session) throw new Error("no live session in this folder")
  await client.sessions.end(session.id)
  return session
}

export const run: CommandRun = async (argv) => {
  let id: string | undefined
  try {
    ;[id] = parseArgs({ args: argv, allowPositionals: true, options: {} }).positionals
  } catch (e) {
    console.error(`ac end: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const client = createOfficeClient({ socket: defaultSocket() })
  try {
    // The office keys folders by their real path.
    const session = await endSession({ client, cwd: realpathSync(process.cwd()), id })
    const person = (await client.people.list().catch(() => [])).find((p) => p.id === session.person)
    console.log(`Ending ${person ? `@${person.handle}` : session.person}'s session ${session.id}; its debrief follows.`)
    return 0
  } catch (e) {
    console.error(`ac end: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}

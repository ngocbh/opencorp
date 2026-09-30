import { realpathSync } from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import type { Session } from "@agent-corp/protocol"
import { createOfficeClient, type OfficeClient } from "@agent-corp/tui/office/client"
import { defaultSocket } from "@agent-corp/tui/office/paths"

// An ending session is already on its way out, and a debriefing or later one is not live.
const ENDABLE = new Set<Session["status"]>(["starting", "idle", "busy"])

/**
 * Ends session `id`, or else the most recently updated live main session in `cwd`; resolves to
 * the session. The office interrupts a busy session first, then runs its debrief.
 */
export async function endSession(opts: { client: OfficeClient; cwd: string; id?: string }): Promise<Session> {
  const { client, cwd } = opts
  const newest = async () =>
    // The office's largest page: newer sessions in other folders must not push this one out.
    (await client.sessions.list({ limit: 500 }))
      .filter((s) => s.kind === "main" && s.cwd === cwd && ENDABLE.has(s.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  const session = opts.id ? await client.sessions.get(opts.id) : await newest()
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
    const who = person ? `@${person.handle}` : session.person
    // Only a main session is debriefed.
    if (session.kind === "main") console.log(`Ending ${who}'s session ${session.id}; its debrief follows.`)
    else console.log(`Ending ${who}'s ${session.kind.replace("_", " ")} session ${session.id}.`)
    return 0
  } catch (e) {
    console.error(`ac end: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}

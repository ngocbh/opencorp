import { realpathSync } from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { officeClient, officeNotRunning } from "../office"
import type { Session } from "@opencorp/protocol"
import { type OfficeClient, OfficeUnavailable } from "@opencorp/client"

// An ending session is already on its way out, and a debriefing or later one is not live.
const ENDABLE = new Set<Session["status"]>(["starting", "idle", "busy", "waiting"])

/**
 * Ends session `id`, or else (no `id`) the most recently updated live main session in `cwd`; resolves
 * to the session. An empty `id` is refused. The office interrupts a busy session first.
 */
export async function endSession(opts: { client: OfficeClient; cwd: string; id?: string }): Promise<Session> {
  const { client, cwd } = opts
  // An empty id names no session; it must not end the folder's newest one instead.
  if (opts.id === "") throw new Error("the session id is empty")
  const newest = async () =>
    // This folder's main sessions, up to the office's largest page. The filter stays here too: an office from
    // before the kind and cwd parameters ignores them and lists every folder's sessions.
    (await client.sessions.list({ kind: "main", cwd, limit: 500 }))
      .filter((s) => s.kind === "main" && s.cwd === cwd && ENDABLE.has(s.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  const session = opts.id !== undefined ? await client.sessions.get(opts.id) : await newest()
  if (!session) throw new Error("no live session in this folder")
  await client.sessions.end(session.id)
  return session
}

export const run: CommandRun = async (argv) => {
  let positionals: string[]
  try {
    ;({ positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} }))
  } catch (e) {
    console.error(`opencorp end: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  if (positionals.length > 1) {
    console.error("opencorp end: give at most one session id")
    return 2
  }
  const [id] = positionals
  if (id === "") {
    console.error("opencorp end: the session id is empty")
    return 2
  }
  const client = officeClient()
  try {
    // The office keys folders by their real path.
    const session = await endSession({ client, cwd: realpathSync(process.cwd()), id })
    const who = `@${session.person}`
    if (session.kind === "main") console.log(`Ending ${who}'s session ${session.id}.`)
    else console.log(`Ending ${who}'s ${session.kind.replace("_", " ")} session ${session.id}.`)
    return 0
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    console.error(`opencorp end: ${e instanceof Error ? e.message : e}`)
    return 1
  }
}

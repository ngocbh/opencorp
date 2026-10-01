import type { Session } from "@agent-corp/protocol"
import { aboutTurn, turns, written } from "@agent-corp/tui/debrief"
import { launchEditor } from "@agent-corp/tui/editor-launch"
import type { OfficeClient } from "@agent-corp/tui/office/client"
import { OfficeError, OfficeUnavailable } from "@agent-corp/tui/office/errors"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { officeClient, officeNotRunning } from "../office"

const USAGE = "Usage: ac feedback [SESSION|RUN] [-m TEXT] [--turn N]"

/** A usage error: printed with the usage line, exit 2. */
class Usage extends Error {}

/** Statuses of a session whose latest run has finished, so feedback on it can be learned. */
const STOPPED: readonly string[] = ["ended", "failed", "debriefing"]

/**
 * The session and run feedback goes to: the session `id` names, or the session with a run `id`
 * names (that run); with no `id`, the newest stopped main session in this folder (its latest run).
 * `guessed` marks a run no session lists, sent to this folder's session for the office to check.
 */
async function target(
  client: OfficeClient,
  id: string | undefined,
): Promise<{ session: Session; run?: string; guessed?: boolean }> {
  const cwd = realpathSync(process.cwd())
  const here = (list: Session[]) => list.find((s) => s.kind === "main" && s.cwd === cwd && STOPPED.includes(s.status))
  if (id === undefined) {
    const session = here(await client.sessions.list({ limit: 500 }))
    if (!session) throw new Error(`no finished session in ${cwd}; pass a session or run ID`)
    return { session }
  }
  try {
    return { session: await client.sessions.get(id) }
  } catch (e) {
    if (!(e instanceof OfficeError && e.status === 404)) throw e
  }
  // Run IDs have no fixed shape, so an ID that isn't a session is looked up among recent runs.
  const recent = await client.sessions.list({ limit: 500 })
  const session = recent.find((s) => s.run_ids?.includes(id))
  if (session) return { session, run: id }
  // A debrief's own run is in no session's run_ids; the office accepts it for its session.
  const local = here(recent)
  if (!local) throw new Error(`no session or run ${id}`)
  return { session: local, run: id, guessed: true }
}

/** Opens $VISUAL or $EDITOR on `template`; returns what was saved, minus `#` lines, trimmed. */
async function edit(template: string) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) throw new Usage("set $EDITOR (or $VISUAL), or pass -m TEXT")
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-feedback-"))
  const file = path.join(dir, "FEEDBACK.md")
  try {
    writeFileSync(file, template)
    // The feedback goes in a file, so it never passes through argv or env.
    await launchEditor(editor, file)
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n")
      .trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `ac feedback [SESSION|RUN] [-m TEXT] [--turn N]`: queues feedback on a run for the person's
 * profile. Without `-m` it opens $EDITOR on a template listing the session's turns; `--turn N`
 * starts the text with `About turn N ("…"): `. Exits 1 on office errors, 2 on usage errors, and 3
 * when the office isn't running.
 */
export const run: CommandRun = async (argv) => {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { message: { type: "string", short: "m" }, turn: { type: "string" } },
    })
    if (positionals.length > 1) throw new Usage(`expected one SESSION or RUN, got ${positionals.join(" ")}`)
    const n = values.turn === undefined ? undefined : Number(values.turn)
    if (n !== undefined && !(Number.isInteger(n) && n >= 1)) throw new Usage("--turn takes a turn number")
    const client = officeClient()
    const { session, run, guessed } = await target(client, positionals[0])
    const list = turns(await client.sessions.messages(session.id))
    if (n !== undefined && n > list.length) throw new Usage(`there is no turn ${n}; the session has ${list.length}`)
    const prefix = n === undefined ? "" : aboutTurn(list[n - 1])
    const draft =
      values.message === undefined
        ? await edit(
            [
              prefix,
              "",
              `# Feedback for @${session.person} on session ${session.id}, ${run ? `run ${run}` : "its latest run"}.`,
              "# It is learned into their profile. Lines starting with # are dropped; an empty message sends nothing.",
              "#",
              ...list.map((t) => `# Turn ${t.n}: ${t.text}`),
              "",
            ].join("\n"),
          )
        : prefix + values.message.trim()
    const text = written(draft, prefix)
    if (!text) {
      console.error("ac feedback: no feedback written; nothing sent")
      return 1
    }
    const f = await client.feedback
      .create({ session_id: session.id, ...(run && { run_id: run }), text })
      .catch((e) => {
        const refused = guessed && e instanceof OfficeError && e.code === "invalid_body"
        throw refused ? new Error(`no session or run ${run}`) : e
      })
    console.log(`Feedback ${f.id} is queued for @${session.person} (session ${session.id}, run ${f.run_id})`)
    return 0
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    // parseArgs throws a TypeError coded ERR_PARSE_ARGS_… for an unknown flag or a missing value.
    const parse = e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE")
    const usage = e instanceof Usage || parse
    console.error(`ac feedback: ${e instanceof Error ? e.message : e}${usage ? `\n${USAGE}` : ""}`)
    return usage ? 2 : 1
  }
}

/** One learning run's state, which `learn_hq`'s `save_access` and the visit share: the visit's context, where the
 *  model's key or sign-in comes from, the session's folder, the commands the agent's shells ran, OpenCorp's
 *  connection shell and the connection `save_access` left open; and the warning when reach.sh names hq's credential
 *  files. */
import fs from "node:fs"
import path from "node:path"
import { readRecord, type RecordedCommand } from "../../tools/terminal/record.ts"
import type { Connection } from "./connect.ts"
import { CONNECTION, type ConnectionShell } from "./connection.ts"
import type { ReachPaths } from "./paths.ts"
import type { ReachContext } from "./ssh.ts"

/** A command the agent's shells ran: what, and its exit, null when it never ended in the record. */
export interface Tried {
  command: string
  code: number | null
}

/** One learning run: the reach context, where the model's key or sign-in tokens come from (never saved), the port,
 *  the session's folder, the clock, OpenCorp's connection shell once the chain test made it, and the connection
 *  `save_access` left open. */
export class Learning {
  /** The open connection `save_access` saved, which the visit then holds. */
  connection: Connection | null = null
  /** OpenCorp's connection shell, made for the first chain test; the visit closes it at its end. */
  shell: ConnectionShell | null = null
  readonly #source: () => readonly string[]
  readonly #seen = new Set<string>()

  /** `secrets` is the key or tokens, or a function that reads them as they are now: yian refreshes a subscription's
   *  tokens during the run. */
  constructor(
    readonly ctx: ReachContext,
    secrets: readonly string[] | (() => readonly string[]),
    readonly port: number,
    readonly folder: string,
    readonly now: () => Date = () => new Date(),
  ) {
    this.#source = typeof secrets === "function" ? secrets : () => secrets
    // Before the run, which may replace them.
    this.secrets()
  }

  /** The model's key or sign-in tokens as they are now, and every one seen before, which a file may still hold. */
  secrets(): string[] {
    for (const secret of this.#source()) if (secret !== "") this.#seen.add(secret)
    return [...this.#seen]
  }

  /** The commands the agent's shells ran, oldest first, from their records in the session's folder. OpenCorp's
   *  connection shell isn't the agent's, and a record that can't be read is left out. */
  tried(): Tried[] {
    const records = path.join(this.folder, "terminal")
    let names: string[]
    try {
      names = fs.readdirSync(records)
    } catch {
      return []
    }
    const commands: RecordedCommand[] = []
    for (const name of names) {
      try {
        const record = readRecord(path.join(records, name))
        if (record !== null && record.name !== CONNECTION) commands.push(...record.commands)
      } catch {}
    }
    return commands
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(({ command, exit }) => ({ command, code: exit ?? null }))
  }
}

/** Whether `text` names the hq folder or one of its files that hold the model's key or sign-in: reach.sh runs in
 *  the folder, so a bare name counts. A hint for the owner, not a guard. */
export function namesCredentials(text: string, paths: ReachPaths): boolean {
  const folder = `${path.basename(paths.home)}/hq`
  return /\b(?:auth|provider)\.json\b/.test(text) || text.includes(paths.dir) || text.includes(folder)
}

/** Said above the question when reach.sh `namesCredentials`. */
export function credentialWarning(paths: ReachPaths): string {
  return (
    `Careful: this names ${paths.dir}, provider.json or auth.json, which hold the model's key or its ChatGPT sign-in;` +
    " what reads them reaches the model."
  )
}

/** What the model is told to use instead of a character that isn't printable ASCII. */
export const ASCII_ONLY = "use only printable ASCII, tabs and newlines"

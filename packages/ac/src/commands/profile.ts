import type { Person } from "@agent-corp/protocol"
import { launchEditor } from "@agent-corp/tui/editor-launch"
import { createOfficeClient, type OfficeClient } from "@agent-corp/tui/office/client"
import { VersionConflictError } from "@agent-corp/tui/office/errors"
import { defaultSocket } from "@agent-corp/tui/office/paths"
import { conflictText, shortVersion, withoutConflict } from "@agent-corp/tui/profile"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"

const USAGE = "Usage: ac profile edit PERSON"

/** A usage error: printed with the usage line, exit 2. */
class Usage extends Error {}

/** The person `name` names: an id or a handle, with or without the `@`. */
async function person(client: OfficeClient, name: string): Promise<Person> {
  const bare = name.replace(/^@/, "")
  const found = (await client.people.list()).find((p) => p.id === bare || p.handle === bare)
  if (!found) throw new Error(`no person ${name}`)
  return found
}

/** Opens `editor` on a temp copy of `text`; resolves to what was saved. */
async function edit(editor: string, text: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ac-profile-"))
  const file = path.join(dir, "profile.md")
  try {
    writeFileSync(file, text)
    // Async, not spawnSync: the process keeps serving its event loop while the editor is open.
    await launchEditor(editor, file)
    return readFileSync(file, "utf8")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `ac profile edit PERSON`: edits a person's profile.md in $EDITOR and saves it over the
 * version it started from, which the office commits as a hand edit. If the profile changed
 * meanwhile, the editor re-opens on the new text with the rejected edit under a marker line;
 * saving drops the marker and everything below it. Exits 1 on office errors, 2 on usage errors.
 */
export const run: CommandRun = async (argv) => {
  try {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
    const [sub, name, ...rest] = positionals
    if (sub !== "edit" || name === undefined || rest.length > 0) throw new Usage("expected edit PERSON")
    const editor = process.env.VISUAL || process.env.EDITOR
    if (!editor) throw new Usage("set $EDITOR (or $VISUAL)")
    const client = createOfficeClient({ socket: defaultSocket() })
    const who = await person(client, name)
    let base = await client.profiles.get(who.id)
    let draft = base.text
    let conflicted = false
    for (;;) {
      const text = withoutConflict(await edit(editor, draft))
      if (text === base.text) {
        // After a lost race, an unchanged save means the rejected edit was left unmerged.
        if (conflicted) {
          console.error("ac profile: your edit was not saved")
          return 1
        }
        console.log("No changes")
        return 0
      }
      try {
        const saved = await client.profiles.put(who.id, { text, base_version: base.version })
        console.log(`Saved the profile of @${who.handle} (${shortVersion(saved.version)})`)
        if (saved.over_budget) console.error("ac profile: the profile is over the company's profile budget")
        return 0
      } catch (e) {
        if (!(e instanceof VersionConflictError)) throw e
        console.error("ac profile: the profile changed while you edited it; your edit is below the marker line")
        base = await client.profiles.get(who.id)
        draft = conflictText(base.text, text)
        conflicted = true
      }
    }
  } catch (e) {
    // parseArgs throws a TypeError coded ERR_PARSE_ARGS_… for an unknown flag.
    const parse = e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE")
    const usage = e instanceof Usage || parse
    console.error(`ac profile: ${e instanceof Error ? e.message : e}${usage ? `\n${USAGE}` : ""}`)
    return usage ? 2 : 1
  }
}

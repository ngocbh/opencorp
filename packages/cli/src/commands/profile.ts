import type { Person, Profile } from "@opencorp/protocol"
import { launchEditor } from "@opencorp/tui/editor-launch"
import { type OfficeClient, OfficeUnavailable, VersionConflictError } from "@opencorp/client"
import { conflictText, shortVersion, withoutConflict } from "@opencorp/tui/profile"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { officeClient, officeNotRunning } from "../office"

const USAGE = "Usage: opencorp profile edit PERSON"

/** A usage error: printed with the usage line, exit 2. */
class Usage extends Error {}

/** The person `name` names: a handle, with or without the `@`. */
async function person(client: OfficeClient, name: string): Promise<Person> {
  const bare = name.replace(/^@/, "")
  const found = (await client.people.list()).find((p) => p.handle === bare)
  if (!found) throw new Error(`no person ${name}`)
  return found
}

/** Writes `text` to `file` and opens `editor` on it; resolves to what was saved. */
async function edit(editor: string, file: string, text: string) {
  writeFileSync(file, text, { mode: 0o600 })
  // Async, not spawnSync: the process keeps serving its event loop while the editor is open.
  await launchEditor(editor, file)
  return readFileSync(file, "utf8")
}

/**
 * `opencorp profile edit PERSON`: edits a person's profile.md in $EDITOR and saves it over the
 * version it started from, which the office commits as a hand edit. If the profile changed
 * meanwhile, the editor re-opens on the new text with the rejected edit under a marker line;
 * saving drops the marker and everything below it. An empty save writes nothing. An edit that
 * ends up unsaved is kept in a file, and the path printed. Exits 1 on office errors, an empty
 * save and an unsaved edit, 2 on usage errors, 3 when the office isn't running.
 */
export const run: CommandRun = async (argv) => {
  let dir: string | undefined
  // The user's latest changed text until the office accepts it; kept if `opencorp` exits first.
  let unsaved: string | undefined
  try {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} })
    const [sub, name, ...rest] = positionals
    if (sub !== "edit" || name === undefined || rest.length > 0) throw new Usage("expected edit PERSON")
    const editor = process.env.VISUAL || process.env.EDITOR
    if (!editor) throw new Usage("set $EDITOR (or $VISUAL)")
    const client = officeClient()
    const who = await person(client, name)
    let base = await client.profiles.get(who.handle)
    // mkdtemp makes the dir private (0700), so other users can't read or swap the file.
    dir = mkdtempSync(path.join(os.tmpdir(), "opencorp-profile-"))
    const file = path.join(dir, "profile.md")
    let draft = base.text
    let conflicted = false
    for (;;) {
      const text = withoutConflict(await edit(editor, file, draft))
      if (text === base.text) {
        // After a lost race, an unchanged save means the rejected edit was left unmerged.
        if (conflicted) {
          console.error("opencorp profile: your edit was not saved")
          return 1
        }
        console.log("No changes")
        return 0
      }
      // As git aborts on an empty message: an emptied file is far likelier a mistake than intent.
      if (!text.trim()) {
        console.error("opencorp profile: the file is empty; nothing saved")
        return 1
      }
      unsaved = text
      try {
        const saved = await client.profiles.put(who.handle, { text, base_version: base.version })
        unsaved = undefined
        return reportSaved(who, saved)
      } catch (e) {
        if (!(e instanceof VersionConflictError)) throw e
        base = await client.profiles.get(who.handle)
        // The race was with the same edit (a retry, or the same change made elsewhere): it is in.
        if (base.text === text) {
          unsaved = undefined
          return reportSaved(who, base)
        }
        console.error("opencorp profile: the profile changed while you edited it; your edit is below the marker line")
        draft = conflictText(base.text, text)
        conflicted = true
      }
    }
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    // parseArgs throws a TypeError coded ERR_PARSE_ARGS_… for an unknown flag.
    const parse = e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE")
    const usage = e instanceof Usage || parse
    console.error(`opencorp profile: ${e instanceof Error ? e.message : e}${usage ? `\n${USAGE}` : ""}`)
    return usage ? 2 : 1
  } finally {
    if (dir) keepOrRemove(dir, unsaved)
  }
}

/** Says the profile of `who` is saved at `profile`, and warns if it is over budget. */
function reportSaved(who: Person, profile: Profile) {
  console.log(`Saved the profile of @${who.handle} (${shortVersion(profile.version)})`)
  if (profile.over_budget) console.error("opencorp profile: the profile is over the company's profile budget")
  return 0
}

/** Removes the temp `dir`, or, if there is an `unsaved` edit, leaves it there and says where. */
function keepOrRemove(dir: string, unsaved: string | undefined) {
  if (unsaved === undefined) return rmSync(dir, { recursive: true, force: true })
  const file = path.join(dir, "profile.md")
  writeFileSync(file, unsaved)
  // The editor may have replaced the file with one of its own permissions.
  chmodSync(file, 0o600)
  console.error(`opencorp profile: your edit is kept in ${file}`)
}

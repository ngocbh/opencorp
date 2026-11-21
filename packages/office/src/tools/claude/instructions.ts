/** The owner's and the project's instructions for Claude Code. With no settings source loaded, Claude Code reads no
 *  `CLAUDE.md`, and none of its settings loads them alone, so the office reads them (and never writes them) and passes
 *  them as appended system prompt text, from a file only the user can read or write. An `@` import in them isn't
 *  followed. */
import fs from "node:fs"
import path from "node:path"
import { readRegular } from "../../util/files.ts"

/** The most of one file passed on, in UTF-16 code units. */
export const INSTRUCTIONS_MAX_CHARS = 64 * 1024
/** The largest file read at all; a larger one is left out. */
const READ_MAX_BYTES = 1024 * 1024

/** Where Claude Code's own instructions are, for one session. */
export interface InstructionsAt {
  /** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  configDir: string
  /** The session's folder, resolved. */
  workspace: string
  /** Its repository's root, resolved, when it has one. */
  gitRoot: string | null
}

/** The instructions Claude Code would load from these places, in its order, or null when there are none: the owner's
 *  `<configDir>/CLAUDE.md`, then the project's `CLAUDE.md` at its repository's root and at its folder, or its
 *  `AGENTS.md` there when neither has a `CLAUDE.md`, as Claude Code reads it by default. Each is named and cut to
 *  `INSTRUCTIONS_MAX_CHARS`. A project file that isn't a regular file is left out, a link included: the employee may
 *  write the project, and a link would have the office read another file for them. The owner's own may be a link. */
export function claudeInstructions({ configDir, workspace, gitRoot }: InstructionsAt): string | null {
  const dirs = gitRoot !== null && gitRoot !== workspace ? [gitRoot, workspace] : [workspace]
  const project = (name: string) => dirs.map((dir) => path.join(dir, name))
  const claudeMd = project("CLAUDE.md").filter((file) => projectFile(file) !== null)
  const owner = path.join(configDir, "CLAUDE.md")
  // Only the owner's own file speaks for the owner: anyone who may write the project may have written its files.
  const files: [label: string, text: string | null][] = [
    [`The owner's instructions (from ${owner}):`, ownerFile(owner)],
    ...(claudeMd.length > 0 ? claudeMd : project("AGENTS.md")).map((file): [string, string | null] => [
      `The project's instructions (from ${file}), as anyone who may write the project left them:`,
      projectFile(file),
    ]),
  ]
  const shown = files.flatMap(([label, text]) => (text === null ? [] : [`${label}\n\n${cut(text)}`]))
  if (shown.length === 0) return null
  return (
    "Instructions from the files Claude Code reads for them (an @ import in them isn't followed).\n\n" +
    `${shown.join("\n\n")}\n`
  )
}

/** Writes `text` to `<root>/<name>.instructions.md`, made fresh and 0600 (whatever was there, a link included, is
 *  removed first, and never followed), and returns its path. `root` is the harness's private folder, which the
 *  harness's commands can't write. */
export function writeInstructions(root: string, name: string, text: string): string {
  if (name === "" || name.includes("/") || name.includes("\0") || name.startsWith(".")) {
    throw new Error(`an instructions file is named by one path segment; got ${JSON.stringify(name)}`)
  }
  const file = path.join(root, `${name}.instructions.md`)
  fs.rmSync(file, { force: true })
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
  return file
}

/** A project file's text, if it is a regular file and no link; else null. */
function projectFile(file: string): string | null {
  return readRegular(file, READ_MAX_BYTES)?.toString("utf8") ?? null
}

/** The owner's file's text, followed if it is a link, if it is then a regular file; else null. */
function ownerFile(file: string): string | null {
  let real: string
  try {
    real = fs.realpathSync(file)
  } catch {
    return null
  }
  return projectFile(real)
}

/** `text` cut to `INSTRUCTIONS_MAX_CHARS` with a marker. */
function cut(text: string): string {
  return text.length <= INSTRUCTIONS_MAX_CHARS ? text : `${text.slice(0, INSTRUCTIONS_MAX_CHARS)}\n[cut here]`
}

/** Codex as a thread's sandbox can run it. Codex runs each sandboxed command through its own binary, inside the
 *  sandbox, and its sandbox hides a denied folder whole, a read entry inside it too (on Linux its deny's mount goes
 *  over everything in the folder). A Codex installed in a folder an employee's permission denies (its standalone
 *  installer puts it in `~/.codex`) therefore runs from the office's private copy of its install, on every platform:
 *  one per Codex, shared by every session, and swept at the office's start once its Codex is gone. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  type EmployeePermission,
  type HarnessInstall,
  checkCodexInstall,
  deniedHolding,
} from "../../runtime/sandbox/harness_profile.ts"
import { freshFolder, removeFolder } from "../../runtime/sandbox/harness_temp.ts"
import { UnsafeProfile } from "../../runtime/sandbox/policy.ts"
import { isScript } from "../../tools/codex/codex.ts"

/** The file in a copy that says what it was copied from (`Source`). */
const SOURCE = "source.json"
/** A copy's name in the harness folder. */
const COPY_NAME = /^install-[0-9a-f]{16}$/

/** What a copy was copied from: the install folder, and each file copied, as a path in it with its inode, size and
 *  modification time. */
type Source = { install: string; files: [rel: string, ino: number, size: number, mtimeMs: number][] }

/** The copies this process is making, by folder, so sessions that start together make one. */
const making = new Map<string, Promise<void>>()

/**
 * Codex as a thread under `p` runs it, once checked as the owner's own (`checkCodexInstall`): `codex` itself, unless
 * its install folder lies in a folder `p` denies (`deniedHolding`). Then it is the office's copy of the install in the
 * harness folder `root`: `<root>/install-<hash>`, private, holding what Codex runs from its install (every file in
 * `bin`, the bubblewrap it bundles, `codex-path` and its package file), which the thread's profile reads in place of
 * the install. A copy is made once per Codex, and again when it was changed or half made; its folder is checked as
 * the install was. Throws `UnsafeProfile` from the checks, and for a Codex in a denied folder that isn't a native
 * binary in its install's `bin`, before anything is copied.
 */
export async function threadCodex(p: EmployeePermission, codex: HarnessInstall, root: string): Promise<HarnessInstall> {
  checkCodexInstall(p, codex)
  const held = deniedHolding(p, codex.install)
  if (held === null) return codex
  const install = fs.realpathSync(codex.install)
  const run = fs.realpathSync(codex.run)
  if (path.dirname(run) !== path.join(install, "bin") || isScript(run)) {
    throw new UnsafeProfile(
      `Codex's install folder ${JSON.stringify(codex.install)} lies in ${held}, which an employee's permission ` +
        `denies, and ${run} isn't a Codex binary in its install's bin folder that the office could copy out; install ` +
        "Codex elsewhere (npm install -g @openai/codex)",
    )
  }
  const source = sourceOf(install)
  const json = JSON.stringify(source)
  const dir = path.join(root, `install-${createHash("sha256").update(json).digest("hex").slice(0, 16)}`)
  let made = making.get(dir)
  if (made === undefined) {
    made = copyOnce(root, dir, source, json).finally(() => making.delete(dir))
    making.set(dir, made)
  }
  await made
  const copy = { run: path.join(dir, "bin", path.basename(run)), install: dir }
  checkCodexInstall(p, copy)
  return copy
}

/** Whether `<root>/<name>` is a copy (`threadCodex`'s) to remove: one whose source.json can't be read, or whose
 *  install no longer holds a file it copied as it was then (Codex was removed or updated in place). Anything else in
 *  `root` isn't. */
export function staleCopy(root: string, name: string): boolean {
  if (!COPY_NAME.test(name)) return false
  let source: Source
  try {
    source = JSON.parse(fs.readFileSync(path.join(root, name, SOURCE), "utf8")) as Source
    if (typeof source.install !== "string" || !Array.isArray(source.files)) return true
  } catch {
    return true
  }
  return source.files.some(([rel, ino, size, mtimeMs]) => {
    const stat = fs.lstatSync(path.join(source.install, rel), { throwIfNoEntry: false })
    return !stat?.isFile() || stat.ino !== ino || stat.size !== size || stat.mtimeMs !== mtimeMs
  })
}

/** What `threadCodex` copies from `install`: every file in `bin`, `codex-resources/bwrap`, every file in
 *  `codex-path`, and `codex-package.json`, those that are files (no links), sorted. */
function sourceOf(install: string): Source {
  const files = (dir: string) =>
    fs.readdirSync(path.join(install, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isFile() ? [path.join(dir, entry.name)] : [],
    )
  const present = (rel: string) => fs.lstatSync(path.join(install, rel), { throwIfNoEntry: false })?.isFile() === true
  const folder = (rel: string) => fs.lstatSync(path.join(install, rel), { throwIfNoEntry: false })?.isDirectory() === true
  const rels = [
    ...files("bin"),
    ...["codex-resources/bwrap", "codex-package.json"].filter(present),
    ...(folder("codex-path") ? files("codex-path") : []),
  ].sort()
  return {
    install,
    files: rels.map((rel) => {
      const stat = fs.lstatSync(path.join(install, rel))
      return [rel, stat.ino, stat.size, stat.mtimeMs]
    }),
  }
}

/** Makes `dir`, a copy of `source` (`json`, as source.json holds it), unless a whole one is there: it is copied into
 *  `<dir>.<pid>.part` and renamed into place, so no session sees half of one, and one another process made meanwhile
 *  is taken instead. */
async function copyOnce(root: string, dir: string, source: Source, json: string): Promise<void> {
  if (whole(dir, source, json)) return
  const name = path.basename(dir)
  removeFolder(root, name)
  const part = `${name}.${process.pid}.part`
  const into = freshFolder(root, part)
  try {
    for (const [rel] of source.files) {
      const to = path.join(into, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
      // Off the event loop: Codex's binary is hundreds of megabytes.
      await fs.promises.copyFile(path.join(source.install, rel), to, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(to, rel.endsWith(".json") ? 0o400 : 0o500)
    }
    // The umask can't widen them, but it can leave the user without write.
    for (const sub of new Set(source.files.map(([rel]) => path.dirname(rel)))) fs.chmodSync(path.join(into, sub), 0o700)
    fs.writeFileSync(path.join(into, SOURCE), json, { mode: 0o400, flag: "wx" })
    try {
      fs.renameSync(into, dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error
    }
  } finally {
    removeFolder(root, part)
  }
  if (!whole(dir, source, json)) throw new Error(`the office's copy of Codex at ${dir} isn't whole`)
}

/** Whether `dir` is a whole copy of `source`: a private folder of the user's (no link) whose source.json is `json`,
 *  holding each file copied, at its size. */
function whole(dir: string, source: Source, json: string): boolean {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    return false
  }
  try {
    if (fs.readFileSync(path.join(dir, SOURCE), "utf8") !== json) return false
  } catch {
    return false
  }
  return source.files.every(([rel, , size]) => {
    const file = fs.lstatSync(path.join(dir, rel), { throwIfNoEntry: false })
    return file?.isFile() === true && file.size === size
  })
}

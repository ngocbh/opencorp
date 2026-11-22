/** Codex as a thread's sandbox can run it. Codex runs each sandboxed command through its own binary, inside the
 *  sandbox, and its sandbox hides a denied folder whole, a read entry inside it too (on Linux its deny's mount goes
 *  over everything in the folder). A Codex installed in a folder an employee's permission denies (its standalone
 *  installer puts it in `~/.codex`) therefore runs from the office's private copy of its install in the owner's cache
 *  folder, on every platform: one per Codex, shared by every session and doctor, mended in place when a file of it
 *  goes missing, and the copies of other Codexes removed once unused for a day and no program runs from them. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  type EmployeePermission,
  type HarnessInstall,
  checkApart,
  checkCodexInstall,
  deniedHolding,
  openToOthers,
} from "../../runtime/sandbox/harness_profile.ts"
import { freshFolder, privateDir, removeFolder } from "../../runtime/sandbox/harness_temp.ts"
import { UnsafeProfile, realPath } from "../../runtime/sandbox/policy.ts"
import { runCommand } from "../../runtime/service/launch.ts"
import { which } from "../../util/env.ts"
import { noSuchProcess } from "../../util/proc.ts"
import { isScript } from "../../tools/codex/codex.ts"

/** The file in a copy that says what it was copied from (`Source`). */
const SOURCE = "source.json"
/** The file in a copy whose modification time is when a session or doctor last started from it. */
const LAST_USED = "last-used"
/** How long a copy of another Codex stays after its last use: a session that found a copy and hasn't started from it
 *  yet, which no program's arguments name, never loses it to another office's sweep. */
const KEPT_MS = 24 * 60 * 60 * 1000
/** A copy's name in the copies' folder. */
const COPY_NAME = /^install-[0-9a-f]{16}$/
/** A copy being made, or one being removed, by process `<pid>`. */
const PART = /\.(\d+)\.part$/

/** What a copy was copied from: the install folder, and each file copied, as a path in it with its inode, size and
 *  modification time. */
type Source = { install: string; files: [rel: string, ino: number, size: number, mtimeMs: number][] }

/** The copies this process is making or mending, by folder, so sessions that start together do it once. */
const making = new Map<string, Promise<void>>()

/** Where the office keeps its copies of Codex: `$XDG_CACHE_HOME/opencorp/codex` when the office's environment `environ`
 *  sets an absolute one, else `<home>/.cache/opencorp/codex` (on macOS too: `~/Library` is denied). */
export function copiesFolder(home: string, environ: Record<string, string | undefined>): string {
  const cache = environ.XDG_CACHE_HOME
  return path.join(cache && path.isAbsolute(cache) ? cache : path.join(home, ".cache"), "opencorp", "codex")
}

/**
 * Codex as a thread under `p` runs it, once checked as the owner's own (`checkCodexInstall`): `codex` itself, unless
 * its install folder lies in a folder `p` denies (`deniedHolding`). Then it is the office's copy of the install in
 * `folder` (`copiesFolder`'s): `<folder>/install-<hash>`, private, holding what Codex runs from its install (every file
 * in `bin`, the bubblewrap it bundles, `codex-path` and its package file), which the thread's profile reads in place
 * of the install.
 *
 * `folder` and the folder holding it are made private (`privateDir`), in a folder others can't write, and checked
 * apart from what the employee may touch (`checkApart`). Every file copied, and its folder, must be the user's alone
 * to write, and each file is copied only while it is still the one listed (inode and size). A copy is made once per
 * Codex and renamed into place whole; a file that went missing or changed in it is copied again beside it and renamed
 * over it, so a session running from it goes on. Each start writes its last-used time into the copy (`markUsed`). Then
 * every other copy there unused for over a day that no program runs from is removed (`sweepCopies`, which tells `log`
 * what it couldn't remove): a day after an update, none of the earlier Codex is left. Throws
 * `UnsafeProfile` from the checks, for a copy that isn't a private folder of the user's, and for a Codex in a denied
 * folder that isn't a native binary in its install's `bin`, each before anything is copied.
 */
export async function threadCodex(
  p: EmployeePermission,
  codex: HarnessInstall,
  folder: string,
  log: (line: string) => void = () => {},
): Promise<HarnessInstall> {
  const { run, install } = checkCodexInstall(p, codex)
  const held = deniedHolding(p, install)
  if (held === null) return codex
  if (path.dirname(run) !== path.join(install, "bin") || isScript(run)) {
    throw new UnsafeProfile(
      `Codex's install folder ${JSON.stringify(codex.install)} lies in ${held}, which an employee's permission ` +
        `denies, and ${run} isn't a Codex binary in its install's bin folder that the office could copy out; install ` +
        "Codex elsewhere (npm install -g @openai/codex)",
    )
  }
  const source = sourceOf(install)
  const checked = source.files.flatMap(([rel]) => [path.join(install, rel), path.dirname(path.join(install, rel))])
  const open = [install, ...new Set(checked)].find(openToOthers)
  if (open !== undefined) throw new UnsafeProfile(`Codex's install can be changed: others than the user may write ${open}`)
  const copies = ownFolder(p, folder)
  const json = JSON.stringify(source)
  const dir = path.join(copies, nameOf(json))
  let made = making.get(dir)
  if (made === undefined) {
    made = ensureCopy(copies, dir, source, json).finally(() => making.delete(dir))
    making.set(dir, made)
  }
  await made
  markUsed(dir)
  const copy = { run: path.join(dir, "bin", path.basename(run)), install: dir }
  checkCodexInstall(p, copy)
  await sweepCopies(copies, path.basename(dir), log)
  return copy
}

/**
 * Removes from the copies' folder `folder` each copy (`install-<hash>`, a folder of the user's) but `keep`, those this
 * process is making, those used within `KEPT_MS` (`lastUsed`), and those a running program's arguments name (a live
 * session's app-server, another office's, or doctor's), and each folder a process that is gone left half made or half
 * removed. A copy is renamed aside before it is removed, so nothing finds half of one. One that can't be looked at or
 * removed is passed to `log` and left; anything else (a link, a file) is never followed or removed, and nothing is when
 * `ps` can't list what runs.
 */
async function sweepCopies(folder: string, keep: string, log: (line: string) => void): Promise<void> {
  let names: string[]
  try {
    names = fs.readdirSync(folder)
  } catch {
    return // nothing was ever copied
  }
  const running = await runningArgs()
  if (running === null) {
    log("codex: the office's copies of Codex weren't swept: ps couldn't list the running programs")
    return
  }
  for (const name of names) {
    try {
      const at = path.join(folder, name)
      const stat = fs.lstatSync(at)
      if (!stat.isDirectory() || stat.uid !== process.getuid?.()) continue
      const part = PART.exec(name)
      if (part !== null) {
        if (noSuchProcess(Number(part[1]))) removeFolder(folder, name)
        continue
      }
      if (!COPY_NAME.test(name) || name === keep || making.has(at)) continue
      if (Date.now() - lastUsed(at, stat) <= KEPT_MS) continue
      if (running.some((args) => args.includes(`${at}/`))) continue
      const aside = `${name}.${process.pid}.part`
      fs.renameSync(at, path.join(folder, aside))
      removeFolder(folder, aside)
    } catch (error) {
      log(`codex: the copy of Codex ${name} wasn't swept (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

/** Writes now into the copy `dir`'s last-used file, the user's alone; its modification time is what the sweep reads. */
function markUsed(dir: string): void {
  fs.writeFileSync(path.join(dir, LAST_USED), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

/** When a session or doctor last started from the copy at `at`: its last-used file's modification time, or, for one
 *  not marked yet (its maker marks it once it is in place), when the copy, `stat`, last changed. */
function lastUsed(at: string, stat: fs.Stats): number {
  return fs.lstatSync(path.join(at, LAST_USED), { throwIfNoEntry: false })?.mtimeMs ?? stat.mtimeMs
}

/** The arguments of every running process, as `ps` shows them, or null when `ps` can't say. */
async function runningArgs(): Promise<string[] | null> {
  const ps = which("ps", "/bin:/usr/bin")
  if (ps === null) return null
  const done = await runCommand([ps, "-ww", "-A", "-o", "args="], {
    env: { PATH: "/bin:/usr/bin", LANG: "C" },
    timeoutMs: 10_000,
  })
  return done.code === 0 ? done.stdout.split("\n") : null
}

/** `folder`, checked apart from what `p` may touch (`checkApart`) before anything is made and again once it is, made,
 *  its parent and it private folders of the user's (`privateDir`) in a folder only the user may write; returns it
 *  resolved. Throws `UnsafeProfile`. */
function ownFolder(p: EmployeePermission, folder: string): string {
  const what = "the folder of the office's copies of Codex"
  checkApart(p, folder, what)
  const parent = path.dirname(folder)
  const base = path.dirname(parent)
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  if (openToOthers(base)) throw new UnsafeProfile(`${what} can be changed: others than the user may write ${realPath(base)}`)
  privateDir(parent)
  privateDir(folder)
  return checkApart(p, folder, what)
}

/** What `threadCodex` copies from `install`: every file in `bin`, `codex-resources/bwrap`, every file in
 *  `codex-path`, and `codex-package.json`, those that are files (no links), sorted. */
function sourceOf(install: string): Source {
  const files = (dir: string) =>
    fs.readdirSync(path.join(install, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isFile() ? [path.join(dir, entry.name)] : [],
    )
  const kind = (rel: string) => fs.lstatSync(path.join(install, rel), { throwIfNoEntry: false })
  const rels = [
    ...files("bin"),
    ...["codex-resources/bwrap", "codex-package.json"].filter((rel) => kind(rel)?.isFile() === true),
    ...(kind("codex-path")?.isDirectory() === true ? files("codex-path") : []),
  ].sort()
  return {
    install,
    files: rels.map((rel) => {
      const stat = fs.lstatSync(path.join(install, rel))
      return [rel, stat.ino, stat.size, stat.mtimeMs]
    }),
  }
}

/** A copy's name for `json`, its source.json. */
function nameOf(json: string): string {
  return `install-${createHash("sha256").update(json).digest("hex").slice(0, 16)}`
}

/** Makes `dir`, a copy of `source` (`json`, as source.json holds it), in `copies`, or mends it. A missing one is copied
 *  into `<dir>.<pid>.part` and renamed into place, or one another process put there meanwhile is taken; in one there,
 *  each file missing or of another size, and source.json if it differs, is copied beside itself and renamed over it.
 *  Nothing is removed from a copy in place, so no other process (doctor, say) loses a copy it uses. Throws
 *  `UnsafeProfile` for a `dir` that isn't a private folder of the user's, and when a source file changed since it was
 *  listed. */
async function ensureCopy(copies: string, dir: string, source: Source, json: string): Promise<void> {
  if (fs.lstatSync(dir, { throwIfNoEntry: false }) === undefined) {
    const part = `${path.basename(dir)}.${process.pid}.part`
    const into = freshFolder(copies, part)
    try {
      for (const file of source.files) await copyIn(source, file, path.join(into, file[0]))
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
      removeFolder(copies, part)
    }
  }
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new UnsafeProfile(`the office's copy of Codex at ${dir} isn't a private folder of yours; remove it`)
  }
  for (const file of source.files) {
    const at = path.join(dir, file[0])
    const now = fs.lstatSync(at, { throwIfNoEntry: false })
    if (now?.isFile() === true && now.size === file[2]) continue
    const beside = `${at}.${process.pid}.part`
    fs.rmSync(beside, { force: true })
    await copyIn(source, file, beside)
    fs.renameSync(beside, at)
  }
  const said = path.join(dir, SOURCE)
  if (readOr(said) !== json) {
    const beside = `${said}.${process.pid}.part`
    fs.rmSync(beside, { force: true })
    fs.writeFileSync(beside, json, { mode: 0o400, flag: "wx" })
    fs.renameSync(beside, said)
  }
}

/** Copies the source file `file` to `to`, cloned where the file system can, read-only to the user (`0500`, the package
 *  file `0400`); throws `UnsafeProfile` unless the source file is still the one listed. */
async function copyIn(source: Source, [rel, ino, size]: Source["files"][number], to: string): Promise<void> {
  const from = path.join(source.install, rel)
  const now = fs.lstatSync(from, { throwIfNoEntry: false })
  if (now?.isFile() !== true || now.ino !== ino || now.size !== size) {
    throw new UnsafeProfile(`Codex's ${from} changed while the office copied it; start the session again`)
  }
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
  // Off the event loop: Codex's binary is hundreds of megabytes.
  await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
  fs.chmodSync(to, rel.endsWith(".json") ? 0o400 : 0o500)
}

/** `file`'s text, or null when it can't be read. */
function readOr(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

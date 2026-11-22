/** Each harness's private folder under `/tmp` (`/tmp/opencorp-<uid>/<harness>`): a fresh temp folder per session,
 *  never the employee shell's, which the harness's commands may write; the fence an employee's permission names; and
 *  the sweep of what a crash left there. */
import fs from "node:fs"
import path from "node:path"
import { UnsafeProfile } from "./policy.ts"

/** The harnesses that run under an employee's permission. */
export type HarnessName = "codex" | "claude"

/** `<base>/opencorp-<uid>/<harness>`, which holds the harness's sessions' temp folders and the fence. Both levels are
 *  made 0700 when missing; `UnsafeProfile` when one isn't the user's own private folder (a link is refused). */
export function harnessRoot(harness: HarnessName, base = "/tmp"): string {
  const uid = process.getuid!()
  const top = path.join(base, `opencorp-${uid}`)
  const root = path.join(top, harness)
  for (const dir of [top, root]) privateDir(dir, uid)
  return root
}

/** Makes `dir` 0700 unless it is there; throws `UnsafeProfile` unless it is then the user's private folder. */
function privateDir(dir: string, uid: number): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeProfile(`${dir} isn't a folder (a link is refused)`)
  if (stat.uid !== uid) throw new UnsafeProfile(`${dir} isn't the user's`)
  if ((stat.mode & 0o077) !== 0) throw new UnsafeProfile(`${dir} isn't private (0700)`)
}

/** The fence in `root` (`harnessRoot`'s): an empty 0600 file, made unless something is there. The permission's check
 *  refuses anything else there. */
export function fenceIn(root: string): string {
  const fence = path.join(root, "fence")
  try {
    fs.writeFileSync(fence, "", { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  return fence
}

/** `<root>/<name>` made fresh: an empty 0700 folder, whatever an earlier session's commands left there. */
export function freshFolder(root: string, name: string): string {
  const dir = inRoot(root, name)
  removeTree(dir)
  fs.mkdirSync(dir, { mode: 0o700 })
  // The umask can't widen it, but it can leave the user without write.
  fs.chmodSync(dir, 0o700)
  return dir
}

/** `<root>/<name>` made fresh (`freshFolder`), holding a link to each of `programs` (its name, and the real file that
 *  was checked): a harness's sandbox runs them from there, where its commands can't change them, rather than from the
 *  folders they were found in, whose other programs it may not run. A link, not a copy, so a program finds what it
 *  loads beside its real file (`$ORIGIN`). */
export function programsFolder(root: string, name: string, programs: Readonly<Record<string, string>>): string {
  const dir = freshFolder(root, name)
  for (const [program, checked] of Object.entries(programs)) {
    fs.symlinkSync(checked, path.join(dir, inRoot(dir, program).slice(dir.length + 1)))
  }
  return dir
}

/** Removes `<root>/<name>` and what is in it, if it is there. */
export function removeFolder(root: string, name: string): void {
  removeTree(inRoot(root, name))
}

/** `<root>/<name>`, for a `name` that is one path segment. */
function inRoot(root: string, name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`a session's temp folder is named by one path segment; got ${JSON.stringify(name)}`)
  }
  return path.join(root, name)
}

/** Removes `dir` and what is in it, never following a link; a folder in it that a command left without write is
 *  opened first. */
function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EACCES" && code !== "EPERM") throw error
  }
  const open = (p: string): void => {
    const stat = fs.lstatSync(p, { throwIfNoEntry: false })
    if (stat === undefined || !stat.isDirectory()) return
    fs.chmodSync(p, 0o700)
    for (const name of fs.readdirSync(p)) open(path.join(p, name))
  }
  open(dir)
  fs.rmSync(dir, { recursive: true, force: true })
}

/** Removes each folder in `root` (`harnessRoot`'s) that is the user's and no link, and that `stale` names or that is a
 *  doctor probe's (`doctor-<pid>`) whose process is gone; a failure is passed to `log`, named by the harness. What
 *  another office keeps there is left alone, unless `stale` names it. */
export function sweepTemp(root: string, stale: (name: string) => boolean, log: (line: string) => void): void {
  const uid = process.getuid!()
  for (const name of fs.readdirSync(root)) {
    const probe = /^doctor-(\d+)$/.exec(name)
    if (!(probe !== null ? gone(Number(probe[1])) : stale(name))) continue
    const stat = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false })
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) continue
    try {
      removeFolder(root, name)
    } catch (error) {
      const why = error instanceof Error ? error.name : typeof error
      log(`${path.basename(root)}: the temp folder ${name} an earlier run left wasn't removed (${why})`)
    }
  }
}

/** Whether no process `pid` runs. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

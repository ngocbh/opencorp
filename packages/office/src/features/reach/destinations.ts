/** The saved destinations in `<home>/hq`: which there are, the name a first path is saved under, each folder's
 *  control-socket folder and a learning run's port, and `opencorp hq --list`, `--rename` and `--forget`. */
import fs from "node:fs"
import path from "node:path"
import { type FileLock, waitForLock } from "@ngocbh/yian/platform"
import type { Spec } from "./spec.ts"
import { clean, isTTY, type Prompter, TtyPrompter } from "../setup/prompts.ts"
import { writePrivate } from "../../util/private_files.ts"
import { claimCm, isOwnCm, isTemp, nameProblem, ReachPaths } from "./paths.ts"
import { exitAll, type ReachContext } from "./ssh.ts"
import { type Access, nextPort, readAccess, STATUS_STALE_MS, takeLock } from "./state.ts"

/** A saved destination: a folder in `hq/` with a name's name that holds reach.sh. `access` is its access.json, null
 *  when there's none yet (a reach.sh the owner wrote) or it can't be read, and `problem` says why it can't. */
export interface Saved {
  readonly paths: ReachPaths
  readonly access: Access | null
  readonly problem: string | null
}

/** The saved destinations under `home`, by name. Folders whose names aren't names (the old single path's files, a
 *  learning run's temporary folder, the control sockets') and folders without reach.sh aren't destinations. */
export async function savedDestinations(home: string): Promise<Saved[]> {
  const root = path.join(home, "hq")
  let names: string[]
  try {
    names = fs.readdirSync(root).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const saved: Saved[] = []
  for (const name of names) {
    if (nameProblem(name) !== null || !isFolder(path.join(root, name))) continue
    const paths = new ReachPaths(home, name)
    if (fs.lstatSync(paths.script, { throwIfNoEntry: false }) === undefined) continue
    try {
      saved.push({ paths, access: await readAccess(paths), problem: null })
    } catch (error) {
      saved.push({ paths, access: null, problem: (error as Error).message })
    }
  }
  return saved
}

/** The id `paths`' folder records for its control sockets, in `cm.id`, or null when it records none. */
export function readCmId(paths: ReachPaths): string | null {
  return readRecord(paths.cmRecord, /^[0-9a-f]{6}$/)
}

/** The first line of the small file `file` when it matches `pattern`, else null. */
function readRecord(file: string, pattern: RegExp): string | null {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n")[0]!
    return pattern.test(first) ? first : null
  } catch {
    return null
  }
}

/** Whether `p` is a folder, not a link; false once it's gone, as when a concurrent save renames it or a clean-up
 *  removes it. */
const isFolder = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false

/** The folders in hq: each destination's and each learning run's, links and other names left out. */
function folders(home: string): ReachPaths[] {
  const root = path.join(home, "hq")
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return names
    .filter((name) => (nameProblem(name) === null || isTemp(name)) && isFolder(path.join(root, name)))
    .map((name) => new ReachPaths(home, name))
}

/** The control-socket ids the folders in hq record, in access.json or `cm.id`, but `except`'s. */
export async function recordedIds(home: string, except?: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const paths of folders(home)) {
    if (paths.name === except) continue
    const id = readCmId(paths)
    if (id !== null) ids.add(id)
    try {
      const access = await readAccess(paths)
      if (access !== null) ids.add(access.cm)
    } catch {}
  }
  return ids
}

/** The id of `paths`' control-socket folder: the one `access` or its `cm.id` records, unless another folder in hq
 *  records it too (one copied from another); else a fresh folder, claimed (`claimCm`) and recorded in `cm.id`.
 *  `random` is `claimCm`'s draw. */
export async function socketId(paths: ReachPaths, access: Access | null, random?: () => string): Promise<string> {
  const others = await recordedIds(paths.home, paths.name)
  const mine = access?.cm ?? readCmId(paths)
  if (mine !== null && !others.has(mine)) return mine
  const id = claimCm(paths.root, others, random)
  await writePrivate(paths.cmRecord, `${id}\n`)
  return id
}

/** Deletes `paths`' control-socket folder once it is OpenCorp's own (`isOwnCm`) and no other folder in hq records
 *  its id: a link, or a folder another destination uses, stays. */
export async function removeCm(paths: ReachPaths): Promise<void> {
  if (!isOwnCm(paths) || (await recordedIds(paths.home, paths.name)).has(paths.cmId!)) return
  fs.rmSync(paths.cm, { recursive: true, force: true })
}

/** Removes each learning run's temporary folder in hq other than this visit's that was last changed before
 *  `STATUS_STALE_MS` and whose lock is free, so no run is learning there: its masters ended and its control-socket
 *  folder deleted first, only when that folder is its own (`isOwnCm`) and no other folder records it, then the folder.
 *  A run that saved renamed its folder, so what's left was abandoned. Then each empty `cm-*` folder that no folder
 *  records and that is as stale, which a run that stopped between claiming it and recording it left. */
export async function sweepTemps(ctx: ReachContext, now: number): Promise<void> {
  await sweepRuns(ctx, now)
  const recorded = await recordedIds(ctx.paths.home)
  for (const name of fs.readdirSync(ctx.paths.root)) {
    const id = /^cm-([0-9a-f]{6})$/.exec(name)?.[1]
    if (id === undefined || recorded.has(id)) continue
    const orphan = ctx.paths.withCm(id)
    const st = fs.lstatSync(orphan.cm, { throwIfNoEntry: false })
    if (st === undefined || st.mtimeMs >= now - STATUS_STALE_MS || !isOwnCm(orphan)) continue
    // Only when empty: nothing binds a socket in a folder no one recorded, so one that isn't stays.
    try {
      fs.rmdirSync(orphan.cm)
    } catch {}
  }
}

/** `sweepTemps`' learning runs. */
async function sweepRuns(ctx: ReachContext, now: number): Promise<void> {
  for (const found of folders(ctx.paths.home)) {
    if (!isTemp(found.name) || found.name === ctx.paths.name) continue
    const st = fs.lstatSync(found.dir, { throwIfNoEntry: false })
    if (st === undefined || st.mtimeMs >= now - STATUS_STALE_MS) continue
    let lock: FileLock | null
    try {
      lock = takeLock(found)
    } catch {
      // A lock file that isn't private, say: not ours to judge.
      continue
    }
    if (lock === null) continue
    try {
      const id = readCmId(found)
      const temp = id === null ? null : found.withCm(id)
      if (temp !== null && isOwnCm(temp) && !(await recordedIds(found.home, found.name)).has(id!)) {
        await exitAll({ ...ctx, paths: temp })
        fs.rmSync(temp.cm, { recursive: true, force: true })
      }
      fs.rmSync(found.dir, { recursive: true, force: true })
    } finally {
      lock.release()
    }
  }
}

/** How long a learning run waits for `hq/ports.lock`. */
const PORTS_LOCK_MS = 30_000

/** The port for learning run `paths`, a first path's temporary folder, held under `hq/ports.lock` so learning runs
 *  that overlap don't share one: `wanted` (`--port`), or the first from 49381 that no saved destination and no live
 *  learning run (its lock held) uses; written to its `port` file, which holds it until the path is saved. Resolves
 *  to the port, or to why `wanted` can't be had. */
export async function reservePort(paths: ReachPaths, wanted?: number): Promise<number | string> {
  let lock: FileLock
  try {
    lock = await waitForLock(path.join(paths.root, "ports.lock"), { private: true, timeoutMs: PORTS_LOCK_MS })
  } catch (error) {
    return `can't take ${path.join(paths.root, "ports.lock")}: ${(error as Error).message}`
  }
  try {
    const used = new Map<number, string>()
    for (const saved of await savedDestinations(paths.home)) if (saved.access !== null) used.set(saved.access.port, saved.paths.name)
    for (const run of folders(paths.home)) {
      if (!isTemp(run.name) || run.name === paths.name) continue
      const port = readRecord(run.portRecord, /^[0-9]{4,5}$/)
      if (port !== null && learning(run)) used.set(Number(port), "another learning run")
    }
    if (wanted !== undefined && used.has(wanted)) return `port ${wanted} is ${used.get(wanted)}'s; pick another with --port N`
    const port = wanted ?? nextPort(used.keys())
    await writePrivate(paths.portRecord, `${port}\n`)
    return port
  } finally {
    lock.release()
  }
}

/** Whether learning run `run` is live: another `opencorp hq` holds its lock. */
function learning(run: ReachPaths): boolean {
  let lock: FileLock | null
  try {
    lock = takeLock(run)
  } catch {
    // A lock file that isn't private: not ours to judge, so its port stays held.
    return true
  }
  lock?.release()
  return lock === null
}

/** What's said when `port`, destination `name`'s, is another saved destination's too: they share a sign-in and can't
 *  be open together. Null when none is. */
export function portShared(saved: readonly Saved[], name: string, port: number): string | null {
  const other = saved.find((s) => s.paths.name !== name && s.access?.port === port)
  if (other === undefined) return null
  return (
    `opencorp hq: port ${port} is ${other.paths.name}'s too, so the two share a browser sign-in and can't be open at ` +
    `once; move one with \`opencorp hq ${name} --port N\`.`
  )
}

/** The name a first path learned with none given is saved under: the host its spec reaches first (its first jump
 *  host, else HQ's machine, which on a cluster changes with each job), without its user and port, up to its first dot
 *  (an address keeps its dots, as dashes), lowercased, with anything a name can't hold as a dash; `-2`, `-3`, ... on
 *  a clash with one `taken` says is taken, or with a reserved word. */
export function nameAfter(spec: Pick<Spec, "host" | "jump">, taken: (name: string) => boolean): string {
  const first = (spec.jump?.[0] ?? spec.host).replace(/^.*@/, "").replace(/:[0-9]+$/, "").toLowerCase()
  const host = /^[0-9.]+$/.test(first) ? first : first.split(".")[0]!
  const base = host.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "hq"
  const free = (name: string) => nameProblem(name) === null && !taken(name)
  if (free(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const name = base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix
    if (free(name)) return name
  }
}

/** Whether anything is at `file`, a dangling link included. */
export function present(file: string): boolean {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined
  } catch {
    // A file where a folder on its path should be.
    return false
  }
}

/** `opencorp hq --list`, `--rename OLD NEW` or `--forget NAME`. */
export type Manage = { list: true } | { rename: [string, string] } | { forget: string }

/** What the commands read from and do to the machine; tests pass their own. */
export interface ManageDeps {
  home: string
  prompter: Prompter
  print(line: string): void
  error(line: string): void
}

/** The answers `--forget` asks with, Keep by default. */
export const FORGET = "Forget it"
export const KEEP = "Keep it"

/** Runs `command`; resolves to its exit code: 0, 1 when it's refused, 2 for a name that isn't one or a destination
 *  that isn't saved. */
export async function manage(command: Manage, deps: ManageDeps): Promise<number> {
  const names = "list" in command ? [] : "rename" in command ? command.rename : [command.forget]
  for (const name of names) {
    const problem = nameProblem(name)
    if (problem !== null) {
      deps.error(`opencorp hq: ${problem}`)
      return 2
    }
  }
  const saved = await savedDestinations(deps.home)
  if ("list" in command) return list(saved, deps)
  const name = "rename" in command ? command.rename[0] : command.forget
  const found = saved.find((s) => s.paths.name === name)
  if (found === undefined) {
    deps.error(unknown(name, saved))
    return 2
  }
  return "rename" in command ? rename(found, command.rename[1], deps) : forget(found, deps)
}

/** What's said for `name` when it isn't saved: the saved ones' names. */
export function unknown(name: string, saved: readonly Saved[]): string {
  const names = saved.map((s) => s.paths.name)
  return `opencorp hq: no saved destination '${name}'; saved: ${names.length === 0 ? "none" : names.join(", ")}`
}

/** Each saved destination, a line each: its name, host, local port and last use, or why its access.json can't be
 *  read. */
function list(saved: readonly Saved[], deps: ManageDeps): number {
  if (saved.length === 0) {
    deps.print("No destinations saved. `opencorp hq NAME` learns one.")
    return 0
  }
  const rows = saved.map(({ paths, access, problem }) =>
    problem !== null
      ? [paths.name, `broken: ${problem}; \`opencorp hq ${paths.name} --relearn\` learns it again`]
      : [paths.name, access?.host ?? "-", String(access?.port ?? "-"), access?.last_used_at ?? (access === null ? "not approved yet" : "never")],
  )
  const table = [["NAME", "HOST", "PORT", "LAST USED"], ...rows]
  // A column is as wide as its widest cell that isn't its row's last.
  const width = (i: number) => Math.max(...table.filter((row) => row.length > i + 1).map((row) => row[i]!.length))
  for (const row of table) deps.print(clean(row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(width(i)) : cell)).join("  ")))
  return 0
}

/** Renames `found` to `to`, under its lock: refused while it's open or when `to` is taken. Its control-socket
 *  folder stays: access.json names it, and its name isn't in it. */
function rename(found: Saved, to: string, deps: ManageDeps): number {
  const target = found.paths.renamed(to)
  if (present(target.dir)) {
    deps.error(`opencorp hq: '${to}' is taken; pick another name or forget it first`)
    return 1
  }
  const lock = takeLock(found.paths)
  if (lock === null) {
    deps.error(open(found.paths.name, "renaming"))
    return 1
  }
  try {
    fs.renameSync(found.paths.dir, target.dir)
  } finally {
    lock.release()
  }
  deps.print(`Renamed ${found.paths.name} to ${to}.`)
  return 0
}

/** Deletes `found`'s folder and its control-socket folder, after asking, under its lock: refused while it's open,
 *  and without a terminal to ask. */
async function forget(found: Saved, deps: ManageDeps): Promise<number> {
  const { paths } = found
  if (!deps.prompter.interactive) {
    deps.error(`opencorp hq: --forget asks first, and there's no terminal to ask; run it in one`)
    return 1
  }
  const lock = takeLock(paths)
  if (lock === null) {
    deps.error(open(paths.name, "forgetting"))
    return 1
  }
  try {
    const answer = await deps.prompter.choose(
      clean(`Forget ${paths.name}? This deletes ${paths.dir} and the path saved there.`),
      [FORGET, KEEP],
      KEEP,
    )
    if (answer !== FORGET) {
      deps.error(`opencorp hq: kept ${paths.name}.`)
      return 1
    }
    // Its own while the lock is held: no visit has masters there.
    const id = found.access?.cm ?? readCmId(paths)
    if (id !== null) await removeCm(paths.withCm(id))
    fs.rmSync(paths.dir, { recursive: true, force: true })
  } finally {
    lock.release()
  }
  deps.print(`Forgot ${paths.name}.`)
  return 0
}

/** Why `name` can't be renamed or forgotten now: an `opencorp hq` has it open. */
const open = (name: string, doing: string) =>
  `opencorp hq: ${name} is open in another \`opencorp hq\`; end it with Ctrl-C there before ${doing} it.`

/** This process's terminal: questions and errors on stderr, the list on stdout. */
export function realManageDeps(home: string): ManageDeps {
  return {
    home,
    prompter: new TtyPrompter({ interactive: isTTY(process.stdin), input: process.stdin, output: process.stderr, env: process.env }),
    print: (line) => void process.stdout.write(`${line}\n`),
    error: (line) => void process.stderr.write(`${line}\n`),
  }
}

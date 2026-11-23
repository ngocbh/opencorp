/** The saved destinations in `<home>/hq`: which there are, the name a first path is saved under, and
 *  `opencorp hq --list`, `--rename` and `--forget`. */
import fs from "node:fs"
import path from "node:path"
import type { Spec } from "./spec.ts"
import { clean, isTTY, type Prompter, TtyPrompter } from "../setup/prompts.ts"
import { cmIdOf, nameProblem, ReachPaths } from "./paths.ts"
import { type Access, readAccess, takeLock } from "./state.ts"

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
    if (nameProblem(name) !== null || !fs.lstatSync(path.join(root, name)).isDirectory()) continue
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

/** `opencorp hq --list`, `--rename OLD NEW` or `--forget NAME`; the CLI has checked the names. */
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

/** Runs `command`; resolves to its exit code: 0, 1 when it's refused, 2 for a destination that isn't saved. */
export async function manage(command: Manage, deps: ManageDeps): Promise<number> {
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
    const cm = paths.withCm(found.access?.cm ?? cmIdOf(paths.dir)).cm
    fs.rmSync(cm, { recursive: true, force: true })
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

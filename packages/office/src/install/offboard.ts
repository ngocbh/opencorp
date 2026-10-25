/** `opencorp offboard`: take this machine's office away again, leaving the company's history where it is safe. */
import fs from "node:fs"
import path from "node:path"
import { DeviceRefused, removeDevice } from "../auth/devices.ts"
import { type Identity, identityPath } from "../auth/identity.ts"
import { CompanyGit, CompanyGitError } from "../company/git.ts"
import { loadRepo } from "../company/loader.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import * as fallback from "./fallback.ts"
import { daemonEnv, defaultHost, type Env, type Host, type Launch, launch, ServiceError } from "./launch.ts"
import * as launchd from "./launchd.ts"
import { CLONE, knownIdentity, lexists, removePath, userGit } from "./onboard.ts"
import type { Prompter } from "./prompts.ts"
import * as service from "./service.ts"
import * as systemd from "./systemd.ts"
import { resolveTools } from "./tools.ts"

/** What the owner is asked before anything is removed, and the two answers. */
export const CONFIRM = "Remove all this?"
export const KEEP = "No, keep it all"
export const REMOVE = "Yes, remove it"

/** What an `opencorp` launcher runs, relative to the checkout: the wrapper, or the CLI's entry. */
export const LAUNCHERS: readonly string[] = [
  path.join("packages", "cli", "bin", "opencorp"),
  path.join("packages", "cli", "src", "main.ts"),
]

/** The checkout this module runs from; `/` in the compiled binary, which holds none of `LAUNCHERS`. */
export const REPO = path.resolve(import.meta.dirname, "../../../..")

/** Offboarding stopped; the message says why and what was left. */
export class OffboardError extends Error {
  override name = "OffboardError"
}

/** The answer to whether to remove it all was no. */
export class Declined extends OffboardError {
  override name = "Declined"
}

/** Whether `file` is `dir` or inside it, compared by path components. */
function inside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file)
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}

/** The `name` files on `PATH` that run the checkout at `repo`: links into it, or scripts naming one of its
 *  `entries`; in `PATH` order. */
export function launchers(
  environ: Env,
  repo: string,
  { name = "opencorp", entries = LAUNCHERS }: { name?: string; entries?: readonly string[] } = {},
): string[] {
  let realRepo: string
  try {
    realRepo = fs.realpathSync(repo)
  } catch {
    realRepo = path.resolve(repo)
  }
  const found: string[] = []
  for (const folder of (environ.PATH ?? "").split(":")) {
    if (!folder) continue
    const file = path.join(folder, name)
    let runsRepo = false
    try {
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) {
        // A dangling link throws here, so it isn't ours.
        runsRepo = inside(fs.realpathSync(file), realRepo)
      } else if (stat.isFile() && stat.size < 4096) {
        // A launcher script is small; a binary isn't read. Invalid bytes become U+FFFD.
        const text = fs.readFileSync(file, "utf8")
        runsRepo = entries.some((e) => text.includes(path.join(repo, e)) || text.includes(path.join(realRepo, e)))
      }
    } catch {
      // A file we can't read isn't ours.
    }
    if (runsRepo && !found.includes(file)) found.push(file)
  }
  return found
}

/** What offboarding found at a home: what it will remove, and whether the company repo goes too. */
export interface Plan {
  me: Identity | undefined
  listed: boolean
  service: string[]
  state: string[]
  company: string | null
  keepWhy: string | null
  lines: string[]
}

/** The subjects of this device's own commits, which removing the device makes moot. */
function ownSubjects(me: Identity | undefined): Set<string> {
  if (me === undefined) return new Set()
  return new Set(["add", "remove"].map((verb) => `devices(@${me.handle}): ${verb} ${me.device}`))
}

/**
 * Why the company repo at `repo` holds work found nowhere else, or null if all of it is pushed; git runs as the
 * user's, in `env`.
 *
 * Only what git already knows of its remotes counts (nothing is fetched). Commits whose subject is in `ours` are
 * left out.
 */
export async function unpushed(
  repo: string,
  ours: ReadonlySet<string> = new Set(),
  env: Env = process.env,
): Promise<string | null> {
  const run = (...args: string[]) => userGit(["-C", repo, ...args], { env })
  if ((await run("rev-parse", "--verify", "-q", "HEAD")).code !== 0) return "it has no commits"
  if (!(await run("remote")).stdout.trim()) return "it has no remote, so this is its only copy"
  if ((await run("status", "--porcelain", "--untracked-files=all")).stdout.trim()) return "it has uncommitted changes"
  if ((await run("stash", "list")).stdout.trim()) return "it has stashed changes"
  const refs = await run("for-each-ref", "--format=%(refname:short) %(upstream)", "refs/heads")
  for (const line of refs.stdout.split("\n")) {
    if (!line) continue
    // Refnames hold no spaces.
    const [branch, upstream = ""] = line.split(" ")
    if (!upstream) return `its branch ${branch} isn't pushed anywhere`
  }
  const log = await run("log", "--format=%s", "--branches", "--not", "--remotes")
  if (log.code !== 0) return "git can't tell what is pushed"
  // Only the trailing newline goes: a commit with an empty subject still counts.
  const lines = log.stdout ? log.stdout.replace(/\n$/, "").split("\n") : []
  const count = lines.filter((subject) => !ours.has(subject)).length
  if (count) return `it has ${count} commit${count !== 1 ? "s" : ""} not pushed to its remote`
  return null
}

/** Whether the company repo at `company` lists `me`'s device for its human. */
function listed(company: string, me: Identity | undefined): boolean {
  if (me === undefined) return false
  try {
    if (!fs.statSync(path.join(company, "company.yaml")).isFile()) return false
  } catch {
    return false
  }
  const person = loadRepo(company).people.get(me.handle)
  return person !== undefined && person.devices.some((d) => d.name === me.device)
}

/** The office's service and running daemon, as plan lines: its recorded mode (or a leftover file's), the service
 *  files there are, and the daemon's pid when it answers or its pidfile names it. */
function serviceLines(run: Launch, host: Host, running: boolean, ps: string | undefined): string[] {
  const found: string[] = []
  const mode = service.recordedMode(run)
  const files = [launchd.plistPath(run, host), systemd.unitPath(run, host)].filter((file) => fs.existsSync(file))
  if (mode || files.length) {
    found.push(`the office's ${mode ?? "leftover"} service` + (files.length ? ` (${files.join(", ")})` : ""))
  }
  if (running || fallback.daemon(run, ps)) found.push(`the running office (pid ${service.pid(run)})`)
  return found
}

/** Looks at `home` and says what offboarding would remove; nothing is changed. */
export async function plan(
  home: string,
  host: Host,
  { deleteCompany = false, environ = process.env }: { deleteCompany?: boolean; environ?: Env } = {},
): Promise<{ run: Launch; found: Plan }> {
  const run = launch(home, { environ, userHome: host.userHome })
  const company = path.join(run.home, "company")
  const me = await knownIdentity(run.home)
  const running = await host.answers(run.socket)
  // The `ps` the service's stop uses.
  const ps = resolveTools(daemonEnv(process.env)).ps
  const described = new Map([
    [run.office, "the office's store, provider.json, connections and sign-ins, logs, and worktrees"],
    [identityPath(run.home), "this device's identity and token"],
    [path.join(run.home, "tui"), "opencorp's own state"],
    [path.join(run.home, CLONE), "an unfinished clone of a company"],
  ])
  const found: Plan = {
    me,
    listed: listed(company, me),
    service: serviceLines(run, host, running, ps),
    state: [...described.keys()].filter(lexists),
    company: lexists(company) ? company : null,
    keepWhy: null,
    lines: [],
  }
  if (found.company !== null) {
    found.keepWhy = fs.existsSync(path.join(company, ".git"))
      ? await unpushed(company, ownSubjects(me), environ)
      : "it isn't a git repo"
  }
  if (found.listed && me) found.lines.push(`this device (${me.device}) from @${me.handle} in the company repo`)
  found.lines.push(...found.service)
  found.lines.push(...found.state.map((file) => `${file} (${described.get(file)})`))
  if (found.company !== null && found.keepWhy === null) {
    found.lines.push(`the company repo at ${company} (everything in it is pushed)`)
  } else if (found.company !== null && deleteCompany) {
    found.lines.push(`the company repo at ${company}, even though ${found.keepWhy}`)
  }
  return { run, found }
}

/** Removes this device through the running office, with its own token; whether the office took it. */
async function removeOnline(run: Launch, me: Identity): Promise<boolean> {
  const url = `http://office/people/${encodeURIComponent(me.handle)}/devices/${encodeURIComponent(me.device)}`
  try {
    // Bun's fetch over a unix socket.
    const res = await fetch(url, {
      method: "DELETE",
      unix: run.socket,
      headers: me.headers(),
      signal: AbortSignal.timeout(30_000),
    })
    await res.arrayBuffer()
    return res.status === 200
  } catch {
    return false
  }
}

/** Removes this device from its human in the company repo at `company` by a local commit, once the office is
 *  stopped; what to tell the owner. */
async function removeOffline(run: Launch, company: string, me: Identity): Promise<string> {
  try {
    await removeDevice(new CompanyGit(company, path.join(run.office, "worktrees")), me.handle, me.device, me.handle)
  } catch (error) {
    if (error instanceof DeviceRefused && error.status === 404) {
      return `This device (${me.device}) was already gone from @${me.handle}.`
    }
    if (!(error instanceof DeviceRefused || error instanceof CompanyGitError || strerror(error) !== undefined)) {
      throw error
    }
    return `Warning: couldn't remove this device from @${me.handle}: ${(error as Error).message}.`
  }
  return `Removed this device (${me.device}) from @${me.handle} in the company repo.`
}

/** Tells the owner which `opencorp` launchers on `PATH` run the checkout at `repo`, and that the checkout stays;
 *  nothing when `repo` isn't a checkout (the compiled binary). */
function reportLaunchers(prompter: Prompter, environ: Env, repo: string): void {
  if (!LAUNCHERS.some((entry) => lexists(path.join(repo, entry)))) return
  const found = launchers(environ, repo)
  if (!found.length) prompter.say(`No \`opencorp\` launcher from ${repo} is on your PATH.`)
  for (const file of found) {
    let how = "a wrapper script"
    try {
      if (fs.lstatSync(file).isSymbolicLink()) how = `a link to ${fs.realpathSync(file)}`
    } catch {
      // Gone since it was found: say what it was found as.
    }
    prompter.say(`\`opencorp\` is on your PATH as ${file}, ${how}; remove it with \`rm ${file}\`.`)
  }
  prompter.say(`The checkout at ${repo} stays; delete it yourself once you're done with OpenCorp.`)
}

/**
 * Removes this machine's office at `home`, after saying what goes and asking (unless `yes`).
 *
 * In order: this device from its human in the company repo (through the office while it runs, otherwise by a
 * local commit once it's stopped); the office and its service; the office state, `identity.json`, and `tui/`; the
 * company repo, only if all of it is pushed (or `deleteCompany`); and `home` itself once empty. Running it again,
 * or on a half-made office, removes only what's there. The user's git runs in `environ`, whose `PATH` is also
 * searched for the launchers of the checkout at `repo`.
 *
 * `<home>/.lock` goes once the identity is removed and the office stopped. A later identity read on a home whose
 * company was kept (the CLI, `doctor`) can leave a lone `.lock` beside `company`, which a second offboard finds
 * nothing of and leaves; it's harmless, and the next read recreates it anyway.
 *
 * Throws `OffboardError` when the answer was no, or the office wouldn't stop (only the device is gone then).
 */
export async function offboard(
  home: string,
  prompter: Prompter,
  {
    yes = false,
    deleteCompany = false,
    host = defaultHost(),
    repo = REPO,
    environ = process.env,
  }: { yes?: boolean; deleteCompany?: boolean; host?: Host; repo?: string; environ?: Env } = {},
): Promise<void> {
  const { run, found } = await plan(home, host, { deleteCompany, environ })
  const keeping =
    found.company !== null && found.keepWhy !== null && !deleteCompany
      ? `Keeping the company repo at ${found.company}: ${found.keepWhy}. Pass --delete-company to delete it anyway.`
      : null
  if (!found.lines.length) {
    prompter.say(`Nothing of this office to remove at ${run.home}.`)
    if (keeping) prompter.say(keeping)
    reportLaunchers(prompter, environ, repo)
    return
  }
  prompter.say(`Offboarding removes this office at ${run.home}:`)
  for (const line of found.lines) prompter.say(`  - ${line}`)
  if (keeping) prompter.say(keeping)
  if (!yes && (await prompter.choose(CONFIRM, [KEEP, REMOVE], KEEP)) !== REMOVE) {
    throw new Declined("nothing was removed")
  }

  const me = found.me
  let removedOnline = false
  if (found.listed && me && (await host.answers(run.socket))) {
    removedOnline = await removeOnline(run, me)
    if (removedOnline) prompter.say(`Removed this device (${me.device}) from @${me.handle} through the office.`)
  }
  let stopped: string[]
  try {
    stopped = await service.uninstall(run, host)
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    throw new OffboardError(`${error.message}; nothing else was removed`)
  }
  for (const line of stopped) prompter.say(`Stopped: ${line}`)
  const company = path.join(run.home, "company")
  if (found.listed && me && !removedOnline) prompter.say(await removeOffline(run, company, me))

  for (const file of found.state) {
    removePath(file)
    prompter.say(`Removed ${file}`)
  }
  try {
    fs.unlinkSync(path.join(run.home, ".lock"))
  } catch {
    // Gone already; anything but a file is left, and keeps the home.
  }

  if (found.company !== null) {
    // Checked again: the office, or the device's removal, may have committed since.
    const why = fs.existsSync(path.join(found.company, ".git"))
      ? await unpushed(found.company, ownSubjects(me), environ)
      : "it isn't a git repo"
    if (why === null || deleteCompany) {
      removePath(found.company)
      prompter.say(`Removed the company repo at ${found.company}`)
    } else {
      await userGit(["-C", found.company, "worktree", "prune"], { env: environ })
      prompter.say(`Kept the company repo at ${found.company}: ${why}.`)
    }
  }
  try {
    fs.rmdirSync(run.home)
    prompter.say(`Removed ${run.home}, now empty`)
  } catch {
    // Something is left in it: the kept company, or what isn't ours.
  }
  reportLaunchers(prompter, environ, repo)
}

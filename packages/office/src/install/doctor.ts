/** `opencorp doctor`: check the office home (there and private), company repo, provider and connections, service,
 *  daemon, HQ, sandbox, and Codex. */
import fs from "node:fs"
import path from "node:path"
import type { HqStatus, OfficeInfo } from "@opencorp/protocol"
import { FileLockError } from "@ngocbh/yian/platform"
import type { Identity } from "../auth/identity.ts"
import { loadProvider, Provider, ProviderError } from "../chat/provider.ts"
import { lint } from "../company/lint.ts"
import { loadRepo } from "../company/loader.ts"
import { isNew, missingFiles } from "../company_template/index.ts"
import { OfficePaths } from "../daemon/office.ts"
import { selfCommand } from "../platform.ts"
import { defaultHost, type Env, type Host, launch } from "./launch.ts"
import { checkProvider, SET_UP, setupConnectionFile, stopToTopUp, withDefaultModel } from "./onboard.ts"
import { OnboardError } from "./prompts.ts"

/** One line of the report: `fail` needs fixing, `warn` is worth knowing. */
export interface Check {
  name: string
  status: "ok" | "warn" | "fail"
  detail: string
}

/** Why the office's answer couldn't be read: it refused this device's token; no office answered, or one from before
 *  the route, in time; or its answer isn't what was asked for. */
export type Unread = "refused" | "unreachable" | "unreadable"

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === "string" ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `mode`'s permission bits as four octal digits. */
function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0")
}

/** Whether anything, even a dangling symlink, is at `file`; one that can't be looked at counts as missing (Python's
 *  `os.path.lexists`). */
function lexists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

function homeCheck(paths: OfficePaths): Check {
  let st: fs.Stats
  try {
    st = fs.statSync(paths.home)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT") return { name: "home", status: "fail", detail: `no office home at ${paths.home}; ${SET_UP}` }
    return { name: "home", status: "fail", detail: `can't read ${paths.home}: ${code ?? messageOf(error)}` }
  }
  if (!st.isDirectory()) return { name: "home", status: "fail", detail: `${paths.home} is not a directory` }
  if ((st.mode & 0o7777) !== 0o700) {
    return {
      name: "home",
      status: "warn",
      detail: `${paths.home} is mode ${octal(st.mode)}, not 0700; \`opencorp onboard\` makes it private`,
    }
  }
  return { name: "home", status: "ok", detail: paths.home }
}

async function companyCheck(paths: OfficePaths, running: boolean): Promise<Check> {
  const root = paths.company
  if (!fs.existsSync(path.join(root, ".git"))) {
    return { name: "company", status: "fail", detail: `no company repo at ${root}; ${SET_UP}` }
  }
  if (await isNew(root)) {
    return {
      name: "company",
      status: "fail",
      detail: `${root} has no company yet (no company.yaml, or no first commit); run \`opencorp init\` to finish it`,
    }
  }
  let issues: Awaited<ReturnType<typeof lint>>
  try {
    issues = await lint(loadRepo(root))
  } catch (error) {
    // A repo that won't even load is the finding.
    return { name: "company", status: "fail", detail: `${root} doesn't load: ${messageOf(error)}` }
  }
  const errors = issues.filter((i) => i.severity === "error")
  if (errors.length) {
    const detail = errors.map((i) => `${i.path}: ${i.code}: ${i.message}`).join("; ")
    return { name: "company", status: "fail", detail }
  }
  const notes = issues.length ? [`${issues.length} lint warnings`] : []
  const missing = missingFiles(root)
  if (missing.length) {
    const todo = running ? stopToTopUp(missing.length) : "`opencorp onboard` adds them"
    notes.push(`missing ${missing.join(", ")} from the template; ${todo}`)
  }
  return {
    name: "company",
    status: notes.length ? "warn" : "ok",
    detail: root + (notes.length ? ` (${notes.join("; ")})` : ""),
  }
}

async function providerCheck(paths: OfficePaths): Promise<Check> {
  const file = setupConnectionFile(paths.office)
  if (!lexists(file)) {
    return {
      name: "provider",
      status: "warn",
      detail: `no ${file}; runs use the login \`yian auth\` saved. \`opencorp onboard\` asks for one`,
    }
  }
  let saved: Provider
  try {
    // Schema errors come back as ProviderError naming the file; yian's refusals as OnboardError.
    saved = await loadProvider(
      file,
      (data) => {
        Provider.parse(data)
        return checkProvider(data)
      },
      { missingOk: false },
    )
  } catch (error) {
    // None of these messages holds a value from the file.
    if (error instanceof ProviderError) return { name: "provider", status: "fail", detail: error.message }
    if (error instanceof OnboardError) return { name: "provider", status: "fail", detail: `${file}: ${error.message}` }
    if (error instanceof FileLockError) {
      return { name: "provider", status: "fail", detail: `can't read ${file}: ${error.message}` }
    }
    const code = errnoCode(error)
    if (code === undefined) throw error
    return { name: "provider", status: "fail", detail: `can't read ${file}: ${code}` }
  }
  const llm = saved.llm_config ?? {}
  const name = (typeof llm.provider === "string" && llm.provider) || "default provider"
  const login = Object.hasOwn(llm, "api_key") ? "key saved" : "yian's own login"
  // Yian has no default model, so a key that names none fails every run; onboard saves the provider's default.
  let fixed: Provider
  try {
    fixed = withDefaultModel(saved)
  } catch (error) {
    if (!(error instanceof OnboardError)) throw error
    return { name: "provider", status: "fail", detail: `${file}: ${error.message}; run \`opencorp onboard\`` }
  }
  if (fixed !== saved) {
    return {
      name: "provider",
      status: "warn",
      detail: `${name}, ${login}, but no model, so runs fail; \`opencorp onboard\` saves ${fixed.llm_config?.model}`,
    }
  }
  return { name: "provider", status: "ok", detail: `${name}, ${login}` }
}

/** Whether office/connections and every file in it are private; null when there is no such folder. */
function connectionsCheck(paths: OfficePaths, lstat: (p: string) => fs.Stats): Check | null {
  const folder = path.join(paths.office, "connections")
  let st: fs.Stats
  try {
    st = lstat(folder)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null
    throw error
  }
  if (st.isSymbolicLink()) {
    return { name: "connections", status: "fail", detail: `${folder} must be a directory, not a symlink` }
  }
  if (!st.isDirectory()) return { name: "connections", status: "fail", detail: `${folder} is not a directory` }
  if ((st.mode & 0o7777) !== 0o700) {
    return { name: "connections", status: "fail", detail: `${folder} is mode ${octal(st.mode)}, not 0700` }
  }
  let entries: string[]
  try {
    entries = fs.readdirSync(folder).sort()
  } catch (error) {
    const why = errnoCode(error) ?? messageOf(error)
    return { name: "connections", status: "fail", detail: `can't read ${folder}: ${why}` }
  }
  const loose: string[] = []
  for (const entry of entries) {
    let m: fs.Stats
    try {
      m = lstat(path.join(folder, entry))
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue // removed while this ran
      throw error
    }
    if (!m.isFile() || m.mode & 0o077) loose.push(entry)
  }
  if (loose.length) {
    return {
      name: "connections",
      status: "fail",
      detail: `${loose.join(", ")} in ${folder} must be private to its owner (mode 0600)`,
    }
  }
  return { name: "connections", status: "ok", detail: `${folder} is private` }
}

/** What `checks` reads and runs; tests pass stand-ins. */
export interface CheckOptions {
  /** The machine (default `defaultHost()`). */
  host?: Host
  /** The argv prefix that runs the office's own code (default `selfCommand()`). */
  command?: readonly [string, ...string[]]
  /** The OpenCorp checkout the office runs from (default `hq/version.ts`'s `CHECKOUT`). */
  repo?: string
  /** Why a sandboxed command can't run for the office at the given home, or null if one does. */
  probe: (officeHome: string) => Promise<string | null>
  /** The Codex check, given the worker env, the office's env and its recorded service mode. */
  codex: (env: Record<string, string>, environ: Env, mode: string | null) => Promise<Check>
  /** The shell's environment (default `process.env`). */
  environ?: Env
  /** `GET /hq` from the office on the socket, sent with the identity's token when there is one. */
  hq: (socket: string, identity: Identity | undefined) => Promise<HqStatus | Unread>
  /** `GET /office` from the office on the socket, sent with the identity's token when there is one. */
  office: (socket: string, identity: Identity | undefined) => Promise<OfficeInfo | Unread>
  /** Looks at a path without following a symlink (default `fs.lstatSync`). */
  lstat?: (p: string) => fs.Stats
}

/** Every check for the office at `home`, in the order onboarding sets things up. */
export async function checks(home: string, options: CheckOptions): Promise<Check[]> {
  const { host = defaultHost(), command = selfCommand(), environ = process.env } = options
  const lstat = options.lstat ?? ((p: string) => fs.lstatSync(p))
  const run = launch(home, { command, environ, userHome: host.userHome })
  const paths = new OfficePaths(run.home)
  const running = await host.answers(run.socket)
  const found: Check[] = []
  found.push(homeCheck(paths))
  found.push(await companyCheck(paths, running))
  found.push(await providerCheck(paths))
  const added = connectionsCheck(paths, lstat)
  if (added !== null) found.push(added)
  return found
}

/** 1 if any check failed, else 0. */
export function exitCode(found: Iterable<Check>): number {
  for (const c of found) if (c.status === "fail") return 1
  return 0
}

/** The checks as aligned lines: status, name, detail. */
export function report(found: Iterable<Check>): string {
  let out = ""
  for (const c of found) out += `${c.status.padEnd(4)}  ${c.name.padEnd(11)}  ${c.detail}\n`
  return out
}

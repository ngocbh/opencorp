/** `opencorp doctor`: check the office home (there and private), company repo, provider and connections, the run and
 *  session folders (writable), service, daemon, HQ, sandbox, worked folders, and Codex. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HqStatus, OfficeInfo } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import { FileLockError, isLocked, openSqlite, type Sqlite, sqliteErrorCode } from "@ngocbh/yian/platform"
import { type Identity, IdentityUnreadable, identityPath, loadIdentity } from "../auth/identity.ts"
import { AuthError, AuthStore } from "@ngocbh/yian/llm_clients"
import { ConnectionFile } from "../chat/connections.ts"
import { loadProvider, type Provider, ProviderError } from "../chat/provider.ts"
import { CompanyGit, CompanyGitError } from "../company/git.ts"
import type { RepoIssue } from "../company/issues.ts"
import { lint } from "../company/lint.ts"
import { loadRepo } from "../company/loader.ts"
import { companyState, missingFiles } from "../company_template/index.ts"
import { OfficePaths } from "../daemon/office.ts"
import { CodexMissing, codexCommand } from "../harness/codex.ts"
import { otherPort } from "../hq/config.ts"
import { RETRY_MS } from "../hq/servers.ts"
import { CHECKOUT } from "../hq/version.ts"
import { selfCommand, tuiAssetRoot } from "../platform.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import {
  checkClearOf,
  checkWorkspace,
  type OfficePaths as Guards,
  SandboxPolicy,
  UnsafeWorkspace,
} from "../sandbox/policy.ts"
import { fsHelper, run } from "../sandbox/run.ts"
import { latestVersion, newerStore, userVersion } from "../store/migrate.ts"
import { storeProblem } from "../store/problem.ts"
import { StoreError } from "../store/store.ts"
import { plainAuthError } from "../worker/rpc.ts"
import { workerEnv } from "../worker/spawn.ts"
import * as fallback from "./fallback.ts"
import { readRegular } from "./files.ts"
import { defaultHost, type Env, type Host, type Launch, launch, runCommand, which } from "./launch.ts"
import * as launchd from "./launchd.ts"
import {
  checkProvider,
  checkSocket,
  damageMessage,
  isSubscription,
  lexists,
  SET_UP,
  setupConnectionFile,
  setupSignInFile,
  stopToTopUp,
  withDefaultModel,
} from "./onboard.ts"
import { OnboardError, clean } from "./prompts.ts"
import * as service from "./service.ts"
import * as systemd from "./systemd.ts"
import { installPaths, resolveTools, workspaceGuards } from "./tools.ts"

/** How `codex login status` starts the line it prints when nobody is signed in, lowercased. */
const SIGNED_OUT = "not logged in"

/** The most of a line from `codex --version` or `codex login status` the report shows. */
const LINE_CAP = 200

/** The most of a plist or unit file doctor reads: `opencorp onboard` writes about 2 KiB. */
const SERVICE_FILE_CAP = 64 * 1024

/** Seconds each sandboxed call of the sandbox probe may take. */
const PROBE_TIMEOUT = 30

/** SQLite's primary result code for a file it can't open. */
const SQLITE_CANTOPEN = 14

/** A whole CSI or OSC escape sequence, its text included: a color code Codex prints around a line, or a title. */
const ESCAPE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * How Bun words a program that never started: `<code>: <strerror>, posix_spawn '<path>'` (Node's `spawn <path> <code>`
 * differs). Bun's wording on Linux hasn't been probed here, so a plain `spawn` is accepted too.
 */
const SPAWN_ERROR = /^E[A-Z0-9]+: (.*), (?:posix_)?spawn\b/

/** One line of the report: `fail` needs fixing, `warn` is worth knowing. */
export interface Check {
  name: string
  status: "ok" | "warn" | "fail"
  detail: string
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === "string" ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** `mode`'s permission bits as four octal digits. */
function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0")
}

/** Whether the compiled binary's assets folder is there: without it `opencorp` can't load OpenTUI. */
function assetsCheck(assets: string): Check {
  let folder = false
  try {
    fs.accessSync(assets, fs.constants.R_OK | fs.constants.X_OK)
    folder = fs.statSync(assets).isDirectory()
  } catch {
    // Missing, a symlink loop, or no read or search permission: OpenTUI can't load from it either.
  }
  if (folder) return { name: "tui assets", status: "ok", detail: `found at ${assets}` }
  return {
    name: "tui assets",
    status: "fail",
    detail:
      `no readable folder at ${assets}: \`opencorp\` can't start its TUI or setup screen; reinstall opencorp, or ` +
      "keep bin/ and assets/ together",
  }
}

function homeCheck(paths: OfficePaths): Check {
  try {
    checkSocket(paths.socket)
  } catch (error) {
    if (!(error instanceof OnboardError)) throw error
    return { name: "home", status: "fail", detail: error.message }
  }
  let st: fs.Stats
  try {
    st = fs.statSync(paths.home)
  } catch (error) {
    const code = errnoCode(error)
    if (code === undefined) throw error
    if (code === "ENOENT") return { name: "home", status: "fail", detail: `no office home at ${paths.home}; ${SET_UP}` }
    return { name: "home", status: "fail", detail: `can't read ${paths.home}: ${strerror(error) ?? code}` }
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

/** What the company line says about `paths`, uncommitted changes that sessions don't run: a few named, the rest
 *  counted. */
function uncommittedNote(paths: string[]): string {
  const shown = paths.slice(0, 3).map(oneLine).join(", ") + (paths.length > 3 ? ", …" : "")
  const [s, are, them] = paths.length === 1 ? ["", "isn't", "it"] : ["s", "aren't", "them"]
  const counted = `${paths.length} uncommitted change${s} (${shown}) ${are} in the last commit`
  return `${counted}, which sessions run: commit ${them} to use ${them}`
}

/**
 * Lints the company repo's last commit, which sessions run, with the profile hand edits a new session commits first
 * laid over it, and says what uncommitted changes sessions won't see. The working tree's company, person, group and
 * asset files, which the daemon also reads live, must load too. It reads the clone without writing to it, so it can
 * run beside the daemon; missing template files are looked for in the working tree, where onboard adds them.
 */
async function companyCheck(paths: OfficePaths, running: boolean): Promise<Check> {
  const root = paths.company
  const state = await companyState(root)
  if (state.kind === "absent") {
    return { name: "company", status: "fail", detail: `no company repo at ${root}; ${SET_UP}` }
  }
  if (state.kind === "damaged") return { name: "company", status: "fail", detail: damageMessage(root, state) }
  if (state.kind === "unfinished") {
    return {
      name: "company",
      status: "fail",
      detail: `${root} has no company yet (no first commit); run \`opencorp init\` to finish it`,
    }
  }
  let tmp: string | undefined
  let issues: RepoIssue[]
  let uncommitted: string[]
  try {
    // Not `pin`: the daemon owns the pinned worktrees, and its lock doesn't reach this process.
    const git = new CompanyGit(root, paths.worktrees)
    const pending = await git.pending()
    uncommitted = pending.uncommitted
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-doctor-"))
    const tree = path.join(tmp, path.basename(root))
    fs.mkdirSync(tree)
    await git.exportTree("HEAD", tree, pending.handEdits)
    // Messages name the copy's paths; show them as the company's, and a path beside the copy as one beside it.
    const [copied, real, home] = [tmp, fs.realpathSync(tmp), path.dirname(root)]
    const shown = (text: string) => text.replaceAll(real, home).replaceAll(copied, home)
    try {
      issues = (await lint(loadRepo(tree))).map((i) => ({ ...i, message: shown(i.message) }))
      // Logins, devices, passwords and asset grants read the working tree's company, person, group and asset files
      // live, so what won't load there fails too; once, when the last commit has the same issue.
      const key = (i: RepoIssue) => `${i.path}\0${i.code}\0${i.message}`
      const linted = new Set(issues.map(key))
      issues.unshift(...loadRepo(root).errors.filter((i) => !linted.has(key(i))))
    } catch (error) {
      // A repo that won't even load is the finding.
      return { name: "company", status: "fail", detail: `${root} doesn't load: ${shown(messageOf(error))}` }
    }
  } catch (error) {
    const why = error instanceof CompanyGitError ? oneLine(error.message) : (errnoCode(error) ?? nameOf(error))
    return { name: "company", status: "fail", detail: `can't read the last commit of ${root}: ${why}` }
  } finally {
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true })
  }
  const errors = issues.filter((i) => i.severity === "error")
  if (errors.length) {
    // Some of Yian's messages run over indented lines; the report has one row per check.
    const found = errors.map((i) => `${i.path}: ${i.code}: ${oneLine(i.message)}`)
    if (uncommitted.length) found.push(uncommittedNote(uncommitted))
    return { name: "company", status: "fail", detail: found.join("; ") }
  }
  const notes = issues.length ? [`${issues.length} lint warnings`] : []
  if (uncommitted.length) notes.push(uncommittedNote(uncommitted))
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
        ConnectionFile.parseOffice(data)
        return checkProvider(data, ConnectionFile.parseOffice)
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
    return { name: "provider", status: "fail", detail: `can't read ${file}: ${strerror(error) ?? code}` }
  }
  if (isSubscription(saved)) return signInCheck(paths)
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

/** The provider check of an office connection on a ChatGPT subscription: its sign-in is there, readable, private and
 *  unexpired. Offline: an expired token is refreshed by the office's next run, not here. */
async function signInCheck(paths: OfficePaths): Promise<Check> {
  const file = setupConnectionFile(paths.office)
  const auth = setupSignInFile(paths.office)
  const fail = (problem: string): Check => ({
    name: "provider",
    status: "fail",
    detail: `${file} signs in to a ChatGPT subscription, but ${problem}; run \`opencorp onboard\` to sign in again`,
  })
  if (!lexists(auth)) return fail(`its sign-in ${auth} is missing`)
  const store = new AuthStore(auth)
  try {
    const selection = store.selection("openai")
    if (selection?.method !== "subscription") return fail(`its sign-in ${auth} holds no ChatGPT sign-in`)
    // No refresh: a token that expires soon throws instead.
    await store.credentials("openai", selection.credentialId)
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
    // yian's store says which file and how to fix it; its plain errors hold no value either.
    const why = error.message.replace(/\.$/, "")
    if (!plainAuthError(error) || !why.includes("expired")) return fail(`its sign-in can't be read: ${why}`)
    return {
      name: "provider",
      status: "warn",
      detail:
        "openai, ChatGPT subscription signed in, but its token has expired; the office's next run refreshes it, and" +
        " `opencorp onboard` signs in again if OpenAI refuses",
    }
  }
  return { name: "provider", status: "ok", detail: "openai, ChatGPT subscription signed in" }
}

/** Whether office/connections and every file in it are private; null when there is no such folder. */
function connectionsCheck(paths: OfficePaths, lstat: (p: string) => fs.Stats): Check | null {
  const folder = path.join(paths.office, "connections")
  let st: fs.Stats
  try {
    st = lstat(folder)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT") return null
    if (code === undefined) throw error
    return { name: "connections", status: "fail", detail: `can't read ${folder}: ${strerror(error) ?? code}` }
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
    const code = errnoCode(error)
    if (code === undefined) throw error
    return { name: "connections", status: "fail", detail: `can't read ${folder}: ${strerror(error) ?? code}` }
  }
  const links: string[] = []
  const odd: string[] = []
  const loose: string[] = []
  for (const entry of entries) {
    let m: fs.Stats
    try {
      m = lstat(path.join(folder, entry))
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue // removed while this ran
      throw error
    }
    if (m.isSymbolicLink()) links.push(entry)
    else if (!m.isFile()) odd.push(entry)
    else if (m.mode & 0o077) loose.push(entry)
  }
  const problems = [
    ...(links.length ? [`${links.join(", ")} in ${folder} must be a regular file, not a symlink`] : []),
    ...(odd.length ? [`${odd.join(", ")} in ${folder} must be a regular file`] : []),
    ...(loose.length ? [`${loose.join(", ")} in ${folder} must be private to its owner (mode 0600)`] : []),
  ]
  if (problems.length) return { name: "connections", status: "fail", detail: problems.join("; ") }
  return { name: "connections", status: "ok", detail: `${folder} is private` }
}

/** Whether the office can write `folder` (office/runs, office/sessions), as check `name`, or make it under its
 *  nearest folder that exists when it doesn't exist yet; null when there is no office home at `home`. */
function writableFolderCheck(name: string, folder: string, home: string): Check | null {
  if (!fs.existsSync(home)) return null
  const fail = (detail: string): Check => ({ name, status: "fail", detail })
  const access = fs.constants.W_OK | fs.constants.X_OK
  let st: fs.Stats
  try {
    st = fs.statSync(folder)
  } catch (error) {
    const code = errnoCode(error)
    if (code === undefined) throw error
    if (code !== "ENOENT") return fail(`can't read ${folder}: ${strerror(error) ?? code}`)
    // Init doesn't make it: the office does, at the first run or session.
    let parent = path.dirname(folder)
    while (parent !== home && !fs.existsSync(parent)) parent = path.dirname(parent)
    try {
      if (!fs.statSync(parent).isDirectory()) return fail(`can't make ${folder}: ${parent} is not a directory`)
      fs.accessSync(parent, access)
    } catch (error) {
      const code = errnoCode(error)
      if (code === undefined) throw error
      return fail(`can't make ${folder}: ${strerror(error) ?? code}`)
    }
    return { name, status: "ok", detail: `${folder} doesn't exist yet; the office makes it` }
  }
  if (!st.isDirectory()) return fail(`${folder} is not a directory`)
  try {
    fs.accessSync(folder, access)
  } catch (error) {
    const code = errnoCode(error)
    if (code === undefined) throw error
    return fail(`can't write ${folder}: ${strerror(error) ?? code}`)
  }
  return { name, status: "ok", detail: folder }
}

/** Whether systemd keeps this user's services running after logout; null if `loginctl` can't say. */
async function linger(host: Host): Promise<boolean | null> {
  const done = await host.run(["loginctl", "show-user", String(host.uid), "--property=Linger"])
  if (done.code !== 0) return null
  return done.stdout.trim() === "Linger=yes"
}

/**
 * What's wrong with the service file `file` (a `what`: plist or unit) of the `<mode>: <name>` service, which is
 * `state` (loaded or enabled), read with `parse`; null when every absolute path it runs before `daemon` (the program,
 * and a checkout's `main.ts`) is there. A loaded service outlives its file, so a file that's gone or can't be read
 * only warns.
 */
function serviceFileCheck(
  [mode, name, state]: [mode: string, name: string, state: string],
  what: string,
  file: string,
  parse: (text: string) => string[] | null,
): Check | null {
  const again = "`opencorp onboard` writes it again"
  const warn = (why: string): Check => ({
    name: "service",
    status: "warn",
    detail: `${mode}: ${name} is ${state}, but its ${what} ${file} ${why}; ${again}`,
  })
  let bytes: Buffer | null
  try {
    bytes = readRegular(file, SERVICE_FILE_CAP)
  } catch (error) {
    return warn(`can't be read (${errnoCode(error) ?? nameOf(error)})`)
  }
  if (bytes === null) return warn(lexists(file) ? "isn't a regular file of at most 64 KiB" : "is gone")
  const text = bytes.toString("utf8")
  const words = parse(text)
  const at = words?.indexOf("daemon") ?? -1
  if (words === null || at < 0) {
    const detail = `${mode}: ${name} is ${state}, but doctor can't read what ${file} starts; ${again}`
    return { name: "service", status: "warn", detail }
  }
  const gone = words.slice(0, at).find((word) => path.isAbsolute(word) && !fs.existsSync(word))
  if (gone === undefined) return null
  return {
    name: "service",
    status: "fail",
    detail: `${mode}: ${name} runs ${gone}, which is gone, so the office can't start; run \`opencorp onboard\``,
  }
}

async function serviceCheck(run: Launch, host: Host): Promise<Check> {
  const mode = service.recordedMode(run)
  if (mode === "launchd") {
    const name = launchd.label(run)
    const problem = await launchd.notLoaded(run, host)
    if (problem === null) {
      const file = launchd.plistPath(run, host)
      const found = serviceFileCheck([mode, name, "loaded"], "plist", file, launchd.programArguments)
      return found ?? { name: "service", status: "ok", detail: `launchd: ${name} is loaded` }
    }
    return {
      name: "service",
      status: "fail",
      detail: `launchd: ${name} is not loaded (${problem}); run \`opencorp onboard\``,
    }
  }
  if (mode === "systemd") {
    const name = systemd.unitName(run)
    const problem = await systemd.notEnabled(run, host)
    if (problem !== null) {
      return {
        name: "service",
        status: "fail",
        detail: `systemd: ${name} is not enabled (${problem}); run \`opencorp onboard\``,
      }
    }
    const found = serviceFileCheck([mode, name, "enabled"], "unit", systemd.unitPath(run, host), systemd.execStart)
    if (found !== null) return found
    if ((await linger(host)) === false) {
      return {
        name: "service",
        status: "warn",
        detail: `systemd: ${name} is enabled, but stops when you log out; \`loginctl enable-linger\` keeps it running`,
      }
    }
    return { name: "service", status: "ok", detail: `systemd: ${name} is enabled` }
  }
  if (mode === null) return { name: "service", status: "warn", detail: "not installed; run `opencorp onboard`" }
  return {
    name: "service",
    status: "warn",
    detail: `${mode}: no service manager, so the office won't start again after a reboot`,
  }
}

/** Where the office's service manager shows its status, as a sentence, or "" when none runs it. */
function serviceStatus(run: Launch, host: Host): string {
  const mode = service.recordedMode(run)
  if (mode === "launchd") {
    const name = launchd.label(run)
    return ` launchd runs it as ${name}: \`launchctl print gui/${host.uid}/${name}\` shows its status.`
  }
  if (mode === "systemd") {
    const name = systemd.unitName(run)
    return ` systemd runs it as ${name}: \`systemctl --user status ${name}\` shows its status.`
  }
  return ""
}

/** What to do about an office that isn't answering, after `failure` (its last start's, or null): fix that or
 *  `opencorp start`, and where its service's status is. */
function nextStep(run: Launch, host: Host, failure: service.Failure | null): string {
  const mode = service.recordedMode(run)
  let first: string
  if (failure === null) first = "Run `opencorp start`."
  else if (failure.foreign) {
    // A service file `opencorp restart` reuses may name a checkout that moved; only onboard writes a new one.
    first =
      mode === "launchd" || mode === "systemd"
        ? "Run `opencorp onboard` from the install you use; its service may start code that's gone."
        : "Run `opencorp start`."
  } else if (failure.text.startsWith("office crashed:")) {
    first = "Its stack is in the log; fix the cause, then run `opencorp start`."
  } else first = "Fix that, then run `opencorp start`."
  return first + serviceStatus(run, host)
}

/** The warning for an office.pid (`pidfile`, as read) that doesn't name the office's own pid `actual`. A restart
 *  rewrites a missing or wrong one, but its new daemon refuses to start over one that isn't a regular file. */
function pidfileCheck(run: Launch, actual: number, pidfile: number | "?", lstat: (p: string) => fs.Stats): Check {
  const file = path.join(run.office, "office.pid")
  const st = lstatOrNull(lstat, file)
  if (st !== null && !st.isFile()) {
    return {
      name: "pidfile",
      status: "warn",
      detail:
        `${file} is not a regular file, and the office's next start refuses it; remove it before the next` +
        ` \`opencorp restart\` (the office is pid ${actual})`,
    }
  }
  // A stop finds the daemon through GET /office only while it answers; a hung one is found by its pidfile.
  const said = pidfile === "?" ? "office.pid is missing or unreadable" : `office.pid says ${pidfile}`
  return {
    name: "pidfile",
    status: "warn",
    detail: `${said} but the office is pid ${actual}; \`opencorp restart\` rewrites it`,
  }
}

/** What is at `file`, not following a symlink, or null when nothing is or it can't be looked at. */
function lstatOrNull(lstat: (p: string) => fs.Stats, file: string): fs.Stats | null {
  try {
    return lstat(file)
  } catch {
    return null
  }
}

/** `s` as one printable line: escapes and control characters gone, whitespace collapsed. */
function oneLine(s: string): string {
  return clean(s.replace(ESCAPE, "")).replace(/\s+/g, " ").trim()
}

/** The non-empty lines of `output`, each as `oneLine` gives it. */
function lines(output: string): string[] {
  return output
    .split(/\r\n|\n|\r/)
    .map(oneLine)
    .filter((line) => line)
}

/** How a Codex install or setting made in this shell reaches an office running under `mode`. */
function codexChangeLands(mode: string | null): string {
  // launchd and systemd start the office with the environment `opencorp onboard` wrote into its service file, which
  // `opencorp restart` reuses; only a stopped office's onboard writes the file again.
  if (mode === "launchd" || mode === "systemd") {
    return "`opencorp stop` and `opencorp onboard` again from that shell"
  }
  return "`opencorp restart` from that shell"
}

/**
 * Whether the office can start Codex sessions, in the environment it gives an app-server (`env`): the binary on its
 * PATH, the version, and the sign-in. Missing, signed out, or a `login status` that fails otherwise (shown by the
 * first line it printed) is a warning, not a failure: only people with `codex` in `harnesses` need it. A `codex` that
 * won't run or doesn't answer within `timeoutMs` fails.
 *
 * `environ` is the office's environment: its `OPENCORP_CODEX_BIN` picks the binary and its `CODEX_HOME` joins `env`,
 * as they do for an app-server. `mode` is the office's recorded service mode, which decides how a fix reaches it.
 */
export async function codexCheck(
  env: Record<string, string>,
  environ: Env,
  mode: string | null = null,
  timeoutMs = 30_000,
): Promise<Check> {
  let found: string
  try {
    found = codexCommand(env, environ)[0]!
  } catch (error) {
    if (!(error instanceof CodexMissing)) throw error
    const override = environ.OPENCORP_CODEX_BIN
    const detail = override
      ? `OPENCORP_CODEX_BIN names ${override}, which isn't an executable the office can find, so Codex sessions ` +
        `can't start (fix or unset it, then ${codexChangeLands(mode)})`
      : "not on the office's PATH, so Codex sessions can't start " +
        `(npm install -g @openai/codex, then ${codexChangeLands(mode)})`
    return { name: "codex", status: "warn", detail }
  }
  const home = environ.CODEX_HOME
  if (home) env = { ...env, CODEX_HOME: home }
  /** `found <args>`, or the failed check when it timed out or never started. */
  const ask = async (...args: string[]) => {
    // In its own group, so a hung Codex and anything it started go with the timeout.
    const done = await runCommand([found, ...args], { env, timeoutMs, group: true })
    if (done.code === 124 && done.stderr === `${found} timed out`) {
      const detail = `${found} ${args.join(" ")} didn't answer in ${timeoutMs / 1000} s`
      return { name: "codex", status: "fail", detail } satisfies Check
    }
    // Any other 127 is the program's own exit (a wrapper whose inner command is missing), not a failed start.
    const unstarted = done.code === 127 ? done.stderr.match(SPAWN_ERROR) : null
    if (unstarted) {
      return { name: "codex", status: "fail", detail: `${found} can't run: ${unstarted[1]}` } satisfies Check
    }
    return done
  }
  const version = await ask("--version")
  if ("name" in version) return version
  if (version.code !== 0) {
    const why = lines(version.stderr)[0]?.slice(0, LINE_CAP) || `exit ${version.code}`
    return { name: "codex", status: "fail", detail: `${found} --version failed: ${why}` }
  }
  const login = await ask("login", "status")
  if ("name" in login) return login
  const printed = (lines(version.stdout)[0] ?? "").slice(0, LINE_CAP)
  const named = printed ? `${printed} at ${found}` : `${found} (no version printed)`
  if (login.code !== 0) {
    const said = lines(`${login.stderr}\n${login.stdout}`)
    // Codex says "Not logged in" when signed out, and exits 1 on other errors too (a bad config.toml, say),
    // possibly after a warning line.
    if (said.some((line) => line.toLowerCase().startsWith(SIGNED_OUT))) {
      return { name: "codex", status: "warn", detail: `${named} is signed out; run \`${found} login\`` }
    }
    const first = said.find((line) => line.startsWith("Error")) ?? said[0]
    const why = first ? first.slice(0, LINE_CAP) : `exit ${login.code}`
    return { name: "codex", status: "warn", detail: `${named}: \`${found} login status\` failed: ${why}` }
  }
  return { name: "codex", status: "ok", detail: `${named}, signed in` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `body`, once every part of it that `hqChecks` reads is there; undefined if one isn't. */
function readByChecks(body: unknown): HqStatus | undefined {
  if (!isRecord(body) || !isRecord(body.tcp) || !isRecord(body.health)) return undefined
  const { tcp, health } = body
  const office = health.office
  const app = health.app
  if (!("socket" in body && "url" in body)) return undefined
  if (!["enabled", "port", "listening", "error"].every((key) => key in tcp)) return undefined
  if (!isRecord(office) || !("api" in office)) return undefined
  if (app !== null && !(isRecord(app) && "api" in app)) return undefined
  const { warnings } = body
  if (warnings !== undefined && !(Array.isArray(warnings) && warnings.every((w) => typeof w === "string"))) {
    return undefined
  }
  return body as HqStatus
}

/**
 * `GET /hq` from the office on `socket`, sent with the identity's token when there is one, or why it couldn't be
 * read.
 */
export async function hqStatus(
  socket: string,
  identity: Identity | undefined,
  timeoutMs = 2000,
): Promise<HqStatus | service.Unread> {
  return service.readFromOffice(socket, identity, "/hq", timeoutMs, readByChecks)
}

/** How HQ's status starts the TCP error when the web port's server stopped after it bound, not a failed bind. */
const SERVER_ENDED = "its server ended"

/** What to do about an HQ status doctor couldn't read, by why. */
export const UNREAD: Record<service.Unread, string> = {
  refused: "the office doesn't know this device, so it won't say where HQ listens: run `opencorp login`",
  unreachable: "the office didn't say where HQ listens (an office from before HQ?): run `opencorp restart`",
  unreadable:
    "the office's answer about HQ isn't one doctor can read (an office running other code?): run `opencorp restart`",
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

/**
 * Why the socket the office says HQ listens on (`socket`) isn't there, or null.
 *
 * The office keeps an unlinked listener, so its own status can't see the file go.
 */
function socketProblem(socket: unknown, lstat: (p: string) => fs.Stats): string | null {
  if (typeof socket !== "string") return null
  let st: fs.Stats
  try {
    st = lstat(socket)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT") return "the socket file is gone; run `opencorp restart`"
    return `can't check it (${code ?? "unknown error"})`
  }
  return st.isSocket() ? null : "something else is at that path; remove it and run `opencorp restart`"
}

/** Where HQ listens (see `hqPortChecks`), whether the web app is built for this office, and HQ's own warnings. */
export function hqChecks(
  status: HqStatus | service.Unread,
  officeDir: string,
  repo: string,
  socketMissing: string | null = null,
): Check[] {
  if (typeof status === "string") return [{ name: "hq", status: "warn", detail: UNREAD[status] }]
  const found = hqPortChecks(status, officeDir, socketMissing)
  const { app, office } = status.health
  if (app === null && !isDirectory(path.join(repo, "packages", "app"))) {
    // Installed from a package, not a checkout.
    found.push({
      name: "web app",
      status: "warn",
      detail:
        "this install has no web app; it's built in a checkout of the opencorp repo. To serve one, point " +
        `"app_dir" in ${path.join(officeDir, "hq.json")} at packages/app/dist in a checkout at this version ` +
        `(v${VERSION}), built there, then run \`opencorp restart\``,
    })
  } else if (app === null) {
    found.push({ name: "web app", status: "warn", detail: `not built: run \`bun run build\` in ${repo}` })
  } else if (app.api !== office.api) {
    found.push({
      name: "web app",
      status: "warn",
      detail:
        `built for ${app.api}, which doesn't match the office's ${office.api}: run \`bun run build\` in ${repo}, ` +
        "or `opencorp restart`",
    })
  } else {
    found.push({ name: "web app", status: "ok", detail: `built for ${office.api}` })
  }
  for (const warning of status.warnings ?? []) found.push({ name: "hq warning", status: "warn", detail: warning })
  return found
}

/** Where HQ listens: on hq.sock and on its web port. `socketMissing` is why the socket isn't at its path when the
 *  office itself saw nothing wrong, with what to do about it. */
export function hqPortChecks(status: HqStatus, officeDir: string, socketMissing: string | null = null): Check[] {
  const { tcp } = status
  const error = tcp.error
  const retry = RETRY_MS / 1000
  let found: Check[]
  if (tcp.listening) {
    found = [{ name: "hq", status: "ok", detail: `web app at ${status.url}, and on ${status.socket}` }]
  } else if (!tcp.enabled) {
    found = [
      {
        name: "hq",
        status: "ok",
        detail: `on ${status.socket} only (the web port is off); \`opencorp hq\` prints the SSH forward`,
      },
    ]
  } else if (!error) {
    found = [{ name: "hq", status: "warn", detail: `port ${tcp.port} isn't listening yet (HQ is binding it)` }]
  } else if (error.startsWith(SERVER_ENDED)) {
    const why = error.slice("its ".length)
    found = [
      {
        name: "hq",
        status: "warn",
        detail: `port ${tcp.port}: ${why}; HQ binds it again in ${retry} s, or run \`opencorp restart\``,
      },
    ]
  } else {
    found = [
      {
        name: "hq",
        status: "warn",
        detail:
          `port ${tcp.port} isn't free (${error}); HQ tries it again every ${retry} s. Free it, or set another ` +
          `"port" in ${path.join(officeDir, "hq.json")} (for example {"port": ${otherPort(tcp.port)}}; create the ` +
          "file if it doesn't exist; keep any keys it already has) and run `opencorp restart`",
      },
    ]
  }
  // An office from before the field has none.
  const socketError = status.socket_error
    ? `${status.socket_error}; run \`opencorp restart\` once that's fixed`
    : socketMissing
  if (socketError) {
    // The web port keeps a line of its own, so what's wrong with it isn't lost under the socket's problem.
    const port: Check = tcp.listening
      ? { name: "hq port", status: "ok", detail: `web app at ${status.url}` }
      : { ...found[0]!, name: "hq port" }
    found = [
      {
        name: "hq",
        status: "warn",
        detail: `not listening on ${status.socket}: ${socketError}`,
      },
      ...(tcp.enabled ? [port] : []),
    ]
  }
  return found
}

/** What to do about an office that wouldn't say what code it runs, by why. */
export const VERSION_UNREAD: Record<service.Unread, string> = {
  refused: "the office doesn't know this device, so it won't say what it runs: run `opencorp login`",
  unreachable: "the office didn't say what code it runs: run `opencorp restart`",
  unreadable:
    "the office's answer about its code isn't one doctor can read (an office running other code?): " +
    "run `opencorp restart`",
}

/** The newest modification time (ms) of the regular files under `dir`, at any depth; 0 when there are none. What
 *  can't be read is skipped. */
function newestUnder(dir: string): number {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let newest = 0
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestUnder(file))
    else if (entry.isFile()) {
      try {
        newest = Math.max(newest, fs.statSync(file).mtimeMs)
      } catch {
        // removed while this ran, or unreadable
      }
    }
  }
  return newest
}

/** The source folders of the code the office runs from `checkout`: the office, protocol, CLI and Yian sources. */
export function sourceRoots(checkout: string): string[] {
  return ["office", "protocol", "cli", "yian"].map((pkg) => path.join(checkout, "packages", pkg, "src"))
}

/**
 * The newest modification time (ms) of the code the office runs from a checkout command
 * (`[bun, ...flags, <checkout>/packages/cli/src/main.ts]`): the files under `sourceRoots`. 0 for a compiled binary,
 * or when nothing is found.
 */
export function newestSource(command: readonly [string, ...string[]]): number {
  // npm installs date every file 1985, so a binary's dates say nothing; VERSION catches an upgrade.
  if (command.length < 2) return 0
  return Math.max(0, ...sourceRoots(installPaths(command)[0]!).map(newestUnder))
}

/** How to make an office running under the recorded service `mode` run this install's code. */
function restartHere(mode: string | null): string {
  // launchd and systemd start the program their service file names, which `opencorp restart` reuses.
  if (mode === "launchd" || mode === "systemd") return "stop the office and run `opencorp onboard` from this install"
  return "run `opencorp restart` from this install"
}

/**
 * Whether `info` is this office's daemon (`launch`'s home), runs from this install (`here`, the first of its
 * `installPaths`), runs this install's version, and started after its code last changed (`newest`, ms). `mode` is the
 * office's recorded service mode, which decides how it picks up this install. An office from an install that's gone
 * fails: it starts each session's worker from there.
 */
export function versionCheck(
  launch: Launch,
  info: OfficeInfo,
  newest: number,
  here: string,
  mode: string | null,
): Check {
  if (info.home !== launch.home) {
    const detail = `pid ${info.pid} is not this office's daemon: it serves ${info.home}`
    return { name: "version", status: "warn", detail }
  }
  // The daemon's guards start with its own `installPaths`, as realpaths; a tool's install folder may follow them.
  const install = info.guards.install
  if (install.length && !install.includes(here)) {
    const there = install[0]!
    if (!fs.existsSync(there)) {
      const detail = `the office runs from ${there}, which is gone, so sessions can't start; ${restartHere(mode)}`
      return { name: "version", status: "fail", detail }
    }
    const detail = `the office runs from ${there}, not this install (${here}); to run this install's code, `
    return { name: "version", status: "warn", detail: detail + restartHere(mode) }
  }
  if (info.version !== VERSION) {
    return {
      name: "version",
      status: "warn",
      detail: `the office runs ${info.version} and this install is ${VERSION}; restart it to run the new code`,
    }
  }
  if (Date.parse(info.started_at) < newest) {
    return {
      name: "version",
      status: "warn",
      detail: "the office started before its code last changed; restart it to run the new code",
    }
  }
  return { name: "version", status: "ok", detail: `pid ${info.pid} runs the current code` }
}

/** Whether every program the office pinned at start (`info.tools`) is still a runnable file. A missing `git` fails:
 *  the office can't serve without it. */
export function toolsCheck(info: OfficeInfo): Check {
  // Each pinned path is absolute, so `which` only checks it is a runnable file; it searches nothing.
  const gone = Object.entries(info.tools).filter(([, found]) => which(found, undefined) === null)
  if (!gone.length) {
    return { name: "tools", status: "ok", detail: "every program the office runs is where it found it at start" }
  }
  const lost = gone.map(([name, found]) => `\`${name}\` at ${found} is gone, so the office can't run it`).join("; ")
  return {
    name: "tools",
    status: gone.some(([name]) => name === "git") ? "fail" : "warn",
    detail: `${lost}; restart the office (\`opencorp restart\`) so it looks for them on its PATH again`,
  }
}

/**
 * Why a sandboxed command or the file helper can't run for the office at `officeHome`, or null if both do. The helper
 * is built first (one with a file inside the office home is refused); then, in a fresh temp folder, `/bin/sh -c
 * "exit 0"` runs under a read-only policy, and the helper lists that folder under the same policy with the helper.
 */
export async function sandboxProblem(officeHome: string): Promise<string | null> {
  let root: string | undefined
  try {
    const { argv, helper } = fsHelper(officeHome)
    root = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-doctor-"))
    const workspace = path.join(root, "ws")
    const tmpdir = path.join(root, "tmp")
    fs.mkdirSync(workspace)
    fs.mkdirSync(tmpdir)
    const policy = new SandboxPolicy({ workspace, writable: false, network: false, tmpdir })
    const shell = await run(policy, ["/bin/sh", "-c", "exit 0"], { timeout: PROBE_TIMEOUT })
    if (shell.timedOut) return `a sandboxed command didn't finish in ${PROBE_TIMEOUT} s`
    if (shell.exit !== 0) {
      return oneLine(shell.stderr.toString("utf8")).slice(0, LINE_CAP) || `exit ${shell.exit}`
    }
    const listed = await run(new SandboxPolicy({ ...policy, helper }), argv, {
      stdin: JSON.stringify({ op: "list", path: "." }),
      timeout: PROBE_TIMEOUT,
    })
    if (listed.timedOut) return `the file helper didn't finish in ${PROBE_TIMEOUT} s`
    let reply: unknown
    try {
      reply = JSON.parse(listed.stdout.toString("utf8"))
    } catch {
      reply = undefined
    }
    if (isRecord(reply) && reply.ok === true && typeof reply.output === "string") return null
    const error = isRecord(reply) && typeof reply.error === "string" ? reply.error : ""
    const stderr = oneLine(listed.stderr.toString("utf8")).slice(0, LINE_CAP)
    return `the file helper failed: ${error || stderr || `exit ${listed.exit}`}`
  } catch (error) {
    return messageOf(error)
  } finally {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true })
  }
}

/**
 * `read` on the store at `store`, opened without migrating it: read-only, or read-write when that can't open it. A
 * WAL store can't be opened read-only without its -wal and -shm files, which SQLite deletes when the office closes
 * it; the read-write open makes them again, private like the store. `read` only reads, and the store is never
 * migrated: a doctor newer than the daemon must not change its schema under it.
 */
function readStore<T>(store: string, read: (db: Sqlite) => T): T {
  const open = (readonly: boolean) => {
    const db = openSqlite(store, { readonly })
    try {
      return read(db)
    } finally {
      db.close()
    }
  }
  const old = process.umask(0o077)
  try {
    try {
      return open(true)
    } catch (error) {
      if (((sqliteErrorCode(error) ?? 0) & 0xff) !== SQLITE_CANTOPEN) throw error
      return open(false)
    }
  } finally {
    process.umask(old)
  }
}

/** Every folder in the `worked_folders` table of the store at `store`, sorted, read without writing. */
function workedFolders(store: string): string[] {
  return readStore(store, (db) =>
    db
      .prepare("SELECT DISTINCT cwd FROM worked_folders ORDER BY cwd")
      .all()
      .map((row) => String(row.cwd)),
  )
}

/**
 * Whether the store at `store` opens and reads as this code's (`storeProblem` says why not, as the daemon's start
 * would); null when there is no store yet. The path is looked at without following a symlink, and only the schema
 * is read: no integrity check, which would read the whole file.
 */
export function storeCheck(store: string, lstat: (p: string) => fs.Stats): Check | null {
  let st: fs.Stats
  try {
    st = lstat(store)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT") return null
    if (code === undefined) throw error
    return { name: "store", status: "fail", detail: `can't read ${store}: ${strerror(error) ?? code}` }
  }
  let version: number
  try {
    if (!st.isFile()) throw new StoreError(`store file ${store} is not a regular file`)
    version = readStore(store, (db) => {
      db.prepare("SELECT count(*) FROM sqlite_master").get()
      return userVersion(db)
    })
    if (version > latestVersion()) throw newerStore(version, latestVersion())
  } catch (error) {
    const problem = storeProblem(store, error)
    const detail = problem ?? `can't read ${store}: ${errnoCode(error) ?? nameOf(error)}`
    return { name: "store", status: "fail", detail }
  }
  return { name: "store", status: "ok", detail: `${store} (schema version ${version})` }
}

/**
 * Whether any folder someone worked in (the store's `worked_folders`) is one the daemon refuses: one `checkWorkspace`
 * refuses with `guards` and the user's `home` (one holding the office install, a program it runs or a folder on its
 * PATH, one holding the home directory, or one inside a sensitive home path), or one that overlaps `kept`, the
 * office's own files (its company repo and office folder). Sessions there are refused until the install, the program
 * or the folder moves. Null when the office has no store, or a store without the table; a folder that no longer
 * exists is skipped.
 */
export function foldersCheck(store: string, guards: Guards, home: string, kept: readonly string[]): Check | null {
  if (!fs.existsSync(store)) return null
  let cwds: string[]
  try {
    cwds = workedFolders(store)
  } catch (error) {
    // A store from before the table.
    if (messageOf(error).includes("no such table")) return null
    const why = errnoCode(error) ?? nameOf(error)
    return { name: "folders", status: "warn", detail: `can't read the worked folders in ${store}: ${why}` }
  }
  const refused: string[] = []
  for (const cwd of cwds) {
    if (!fs.existsSync(cwd)) continue
    try {
      checkWorkspace(cwd, { ...guards, home })
      checkClearOf(cwd, kept)
    } catch (error) {
      const why = errnoCode(error) ?? nameOf(error)
      refused.push(error instanceof UnsafeWorkspace ? error.message : `${cwd}: can't be checked (${why})`)
    }
  }
  if (refused.length) return { name: "folders", status: "fail", detail: refused.join("; ") }
  return {
    name: "folders",
    status: "ok",
    detail:
      "no worked folder holds the office install, a program it runs, a folder on its PATH, or the office's own files",
  }
}

// Logging in again wouldn't help: the identity line says what to fix.
const IDENTITY_UNREAD = "identity.json can't be read (see the identity line), so the office doesn't know this device"

/** What `checks` reads and runs; tests pass stand-ins. */
export interface CheckOptions {
  /** The machine (default `defaultHost()`). */
  host?: Host
  /** The argv prefix that runs the office's own code (default `selfCommand()`). */
  command?: readonly [string, ...string[]]
  /** The OpenCorp checkout the office runs from (default `hq/version.ts`'s `CHECKOUT`). */
  repo?: string
  /** Why a sandboxed command can't run for the office at the given home, or null if one does (default
   *  `sandboxProblem`). */
  probe?: (officeHome: string) => Promise<string | null>
  /** The Codex check, given the worker env, the office's env and its recorded service mode (default
   *  `codexCheck`). */
  codex?: (env: Record<string, string>, environ: Env, mode: string | null) => Promise<Check>
  /** The shell's environment (default `process.env`). */
  environ?: Env
  /** `GET /hq` from the office on the socket, sent with the identity's token when there is one (default
   *  `hqStatus`). */
  hq?: (socket: string, identity: Identity | undefined) => Promise<HqStatus | service.Unread>
  /** `GET /office` from the office on the socket, sent with the identity's token when there is one (default
   *  `service.officeInfo`). */
  office?: (socket: string, identity: Identity | undefined) => Promise<OfficeInfo | service.Unread>
  /** Looks at a path without following a symlink (default `fs.lstatSync`). */
  lstat?: (p: string) => fs.Stats
  /** Reads this device's identity, rejecting with `IdentityUnreadable` when it can't be used (default
   *  `loadIdentity`). */
  loadIdentity?: (file: string) => Promise<Identity | undefined>
  /** The binary's TUI assets folder, or null in a checkout (default `tuiAssetRoot()`). */
  assets?: string | null
}

/** Whether another process holds the office's lock (`host.locked`, else yian's `isLocked`); false when it can't be
 *  checked, which only changes the company check's advice. */
function lockHeld(paths: OfficePaths, host: Host): boolean {
  try {
    return (host.locked ?? isLocked)(paths.lock)
  } catch {
    return false
  }
}

/**
 * Every check for the office at `home`, in the order onboarding sets things up. A running office is asked what it
 * runs and where HQ listens with this device's identity, read once; that read can wait on a busy `<home>/.lock`. An
 * identity file that can't be used gets its own line, which the version and HQ lines point at when the office
 * refuses them.
 *
 * Worked folders are checked against the guards the running daemon pinned (`GET /office`); when the office wasn't
 * read, against the ones an office started from this shell with `command` would pin, which can differ from a running
 * daemon's.
 */
export async function checks(home: string, options: CheckOptions): Promise<Check[]> {
  const { host = defaultHost(), command = selfCommand(), repo = CHECKOUT, environ = process.env } = options
  const { codex = codexCheck, hq = hqStatus, office = service.officeInfo, probe = sandboxProblem } = options
  const load = options.loadIdentity ?? loadIdentity
  const lstat = options.lstat ?? ((p: string) => fs.lstatSync(p))
  const run = launch(home, { command, environ, userHome: host.userHome })
  const paths = new OfficePaths(run.home)
  const running = await host.answers(run.socket)
  const found: Check[] = []
  let guards: Guards | undefined
  const homeLine = homeCheck(paths)
  found.push(homeLine)
  const assets = options.assets === undefined ? tuiAssetRoot() : options.assets
  if (assets !== null) found.push(assetsCheck(assets))
  // A daemon that holds the lock without answering (starting, stopping, hung) is running for the top-up advice; the
  // checks below ask the office, so they need it to answer.
  found.push(await companyCheck(paths, running || lockHeld(paths, host)))
  found.push(await providerCheck(paths))
  const added = connectionsCheck(paths, lstat)
  if (added !== null) found.push(added)
  for (const [name, folder] of [
    ["runs", paths.runs],
    ["sessions", paths.sessions],
  ] as const) {
    const writable = writableFolderCheck(name, folder, paths.home)
    if (writable !== null) found.push(writable)
  }
  found.push(await serviceCheck(run, host))
  const sock = lstatOrNull(lstat, run.socket)
  if (sock !== null && !sock.isSocket()) {
    // Nothing is asked over it: a symlink could lead the device's token to another office.
    found.push({
      name: "office",
      status: "fail",
      detail: `${run.socket} is not a socket; remove it, then run \`opencorp start\``,
    })
  } else if (running) {
    const file = identityPath(run.home)
    let identity: Identity | undefined
    let bad: IdentityUnreadable | undefined
    try {
      identity = await load(file)
    } catch (error) {
      if (!(error instanceof IdentityUnreadable)) throw error
      bad = error
    }
    const info = await office(run.socket, identity)
    const ours = typeof info !== "string" && info.home === run.home ? info : null
    const pidfile = service.pid(run)
    found.push({ name: "office", status: "ok", detail: `answering on ${run.socket} (pid ${ours?.pid ?? pidfile})` })
    if (ours !== null && pidfile !== ours.pid) found.push(pidfileCheck(run, ours.pid, pidfile, lstat))
    if (bad) {
      // The home line already says how to make the home private.
      const detail =
        bad.reason === "folder" && homeLine.status !== "ok"
          ? `${file} can't be read while the home isn't private; see the home line`
          : bad.message
      found.push({ name: "identity", status: "warn", detail })
    }
    if (info === "refused" && bad) {
      found.push({ name: "version", status: "warn", detail: `${IDENTITY_UNREAD}, so it won't say what it runs` })
    } else if (typeof info === "string") found.push({ name: "version", status: "warn", detail: VERSION_UNREAD[info] })
    else {
      const here = installPaths(command)[0]!
      found.push(versionCheck(run, info, newestSource(command), here, service.recordedMode(run)), toolsCheck(info))
      guards = info.guards
    }
    const hqAnswer = await hq(run.socket, identity)
    if (hqAnswer === "refused" && bad) {
      found.push({ name: "hq", status: "warn", detail: `${IDENTITY_UNREAD}, so it won't say where HQ listens` })
    } else {
      const missing =
        typeof hqAnswer === "string" || hqAnswer.socket_error ? null : socketProblem(hqAnswer.socket, lstat)
      found.push(...hqChecks(hqAnswer, paths.office, repo, missing))
    }
  } else {
    const hung = fallback.daemon(run, resolveTools(run.env).ps)
    if (hung !== null) {
      found.push({
        name: "office",
        status: "warn",
        detail:
          `pid ${hung.pid} is running but doesn't answer on ${run.socket} (still starting, or hung); if it stays` +
          ` that way, run \`opencorp restart\` (log: ${run.log}).${serviceStatus(run, host)}`,
      })
    } else {
      const error = service.lastFailure(service.readLog(run.log))
      // The log is read without following a link (the daemon never writes through one), so say why it wasn't read.
      const linked = lstatOrNull(lstat, run.log)?.isSymbolicLink()
        ? `; ${run.log} is a symlink, which doctor doesn't read`
        : ""
      const why = (error === null ? "" : `; its last start failed: ${error.text}`) + linked
      found.push({
        name: "office",
        status: error === null ? "warn" : "fail",
        detail: `not answering on ${run.socket}${why} (log: ${run.log}). ${nextStep(run, host, error)}`,
      })
    }
  }
  const store = storeCheck(paths.store, lstat)
  if (store !== null) found.push(store)
  const problem = await probe(paths.home)
  found.push({ name: "sandbox", status: problem ? "fail" : "ok", detail: problem || "sandboxed commands run" })
  // A store that failed its own check has no worked folders to read.
  const folders =
    store?.status === "fail"
      ? null
      : foldersCheck(
          paths.store,
          guards ?? workspaceGuards(resolveTools(run.env), run.env, command, [host.userHome, paths.home, os.tmpdir()]),
          host.userHome,
          [paths.company, paths.office],
        )
  if (folders !== null) found.push(folders)
  // run.env is the environment an office set up or started from this shell gets, which can differ from the running
  // daemon's (a launchd or systemd office keeps the one `opencorp onboard` wrote into its service file).
  found.push(await codex(workerEnv(run.env), run.env, service.recordedMode(run)))
  return found
}

/** 1 if any check failed, else 0. */
export function exitCode(found: Iterable<Check>): number {
  for (const c of found) if (c.status === "fail") return 1
  return 0
}

/** The checks as aligned lines: status, name, detail. Each check stays one row, whatever its detail holds. */
export function report(found: Iterable<Check>): string {
  let out = ""
  // Spaces are kept (a path may hold two in a row); only escapes and control characters go.
  for (const c of found) out += `${c.status.padEnd(4)}  ${c.name.padEnd(11)}  ${clean(c.detail.replace(ESCAPE, ""))}\n`
  return out
}

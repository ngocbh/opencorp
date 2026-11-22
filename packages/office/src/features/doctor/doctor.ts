/** `opencorp doctor`: check the office home (there and private), company repo, provider and connections, the run and
 *  session folders (writable), service, daemon, HQ, sandbox and its terminals, worked folders, Codex and Claude
 *  Code, and the MCP servers employees may use. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HqStatus, OfficeInfo } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import { FileLockError, isLocked, openSqlite, type Sqlite, sqliteErrorCode } from "@ngocbh/yian/platform"
import { type Identity, IdentityUnreadable, identityPath, loadIdentity } from "../../runtime/auth/identity.ts"
import { AuthError, AuthStore } from "@ngocbh/yian/llm_clients"
import { ConnectionFile, Connections, isSubscription } from "../../models/connections.ts"
import { DEFAULT_PRICE } from "../../models/cost.ts"
import { loadProvider, type Provider, ProviderError } from "../../models/provider.ts"
import { CompanyGit, CompanyGitError } from "../../company/git.ts"
import type { RepoIssue } from "../../company/issues.ts"
import { lint } from "../../company/lint.ts"
import { type CompanyRepo, loadRepo } from "../../company/loader.ts"
import { MCP_SERVER_NAME } from "../../company/naming.ts"
import { companyState, missingFiles } from "../../company/template.ts"
import { CodexMissing, codexCommand, nativeCodex } from "../../tools/codex/codex.ts"
import {
  CLAUDE_FLOOR,
  ClaudeMissing,
  ClaudeSandboxUnavailable,
  ClaudeSignedOut,
  ClaudeStartError,
  READ_ONLY_FIX,
  SOCAT_MISSING,
  claudeCommand,
  nativeClaude,
  olderThan,
  readOnlyFails,
  socatNeeded,
} from "../../tools/claude/claude.ts"
import { claudeJson, ownerMcpServers } from "../../tools/claude/mcp.ts"
import { probeStart } from "../../tools/claude/probe.ts"
import { SocatUnusable } from "../../tools/claude/socat.ts"
import { type Probed, threadProbe } from "../codex/thread.ts"
import { writableFolders } from "../../runtime/sessions/permission.ts"
import { type HarnessInstall, checkHarnessBinary } from "../../runtime/sandbox/harness_profile.ts"
import { SANDBOX_FIX } from "../../tools/terminal/terminal.ts"
import { selfCommand, tuiAssetRoot } from "../../platform.ts"
import {
  checkClearOf,
  checkWorkspace,
  type OfficePaths as Guards,
  SandboxPolicy,
  UnsafeProfile,
  UnsafeWorkspace,
} from "../../runtime/sandbox/policy.ts"
import { fsHelper, run, startOnTerminal } from "../../runtime/sandbox/run.ts"
import { latestVersion, newerStore, userVersion } from "../../runtime/store/migrate.ts"
import { storeProblem } from "../../runtime/store/problem.ts"
import { LIVE, StoreError } from "../../runtime/store/store.ts"
import { CHECKOUT } from "../../util/checkout.ts"
import { type Env, which } from "../../util/env.ts"
import { strerror } from "../../util/errors.ts"
import { OfficePaths } from "../../util/home.ts"
import { plainAuthError } from "../../runtime/worker/rpc.ts"
import { workerEnv } from "../../runtime/worker/spawn.ts"
import * as fallback from "../../runtime/service/fallback.ts"
import { readRegular } from "../../util/files.ts"
import { defaultHost, type Host, type Launch, launch, runCommand } from "../../runtime/service/launch.ts"
import * as launchd from "../../runtime/service/launchd.ts"
import {
  checkProvider,
  checkSocket,
  damageMessage,
  lexists,
  SET_UP,
  setupConnectionFile,
  setupSignInFile,
  stopToTopUp,
  withDefaultModel,
} from "../setup/onboard.ts"
import { OnboardError, clean } from "../setup/prompts.ts"
import * as service from "../../runtime/service/service.ts"
import * as systemd from "../../runtime/service/systemd.ts"
import { installPaths, resolveTools, workspaceGuards } from "../../runtime/service/programs.ts"

/** How `codex login status` starts the line it prints when nobody is signed in, lowercased. */
const SIGNED_OUT = "not logged in"

/** The most of a line from `codex --version` or `codex login status` the report shows. */
const LINE_CAP = 200

/** The oldest Codex the office runs: its threads take an employee's permission profile in the form the office sends. */
const CODEX_FLOOR = [0, 167, 0] as const
/** How to update Codex past the floor. */
const UPDATE_CODEX =
  "update Codex: `npm install -g @openai/codex@latest` (or `brew upgrade codex`), then `opencorp doctor`"
/** How to update Claude Code past its floor (`CLAUDE_FLOOR`). */
const UPDATE_CLAUDE =
  "update Claude Code: `claude update` (or `brew upgrade claude-code`, or " +
  "`npm install -g @anthropic-ai/claude-code@latest`), then `opencorp doctor`"

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

/** The Codex check's line, and the MCP servers the owner's Codex config defines, by name, when its probe read them. */
export type CodexCheck = Check & { mcpServers?: string[] }

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
      `no readable folder at ${assets}: \`opencorp\` can't start its TUI; reinstall opencorp, or keep bin/ and ` +
      "assets/ together",
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

/** A warning naming each subscription connection whose model no connection's price list prices: a chat on it counts
 *  toward its cost cap at the default price, so the cap may trip far sooner or later than the API's price would make
 *  it. Null when there is none, or the connections can't be read (the provider and connections lines say why). */
async function pricesCheck(paths: OfficePaths): Promise<Check | null> {
  const connections = new Connections(paths.office, { log: () => {} })
  const unpriced: string[] = []
  try {
    for (const name of await connections.names()) {
      let conn: ConnectionFile
      try {
        conn = await connections.get(name)
      } catch (error) {
        if (error instanceof ProviderError) continue
        throw error
      }
      const model = conn.llm_config?.model
      if (conn.method !== "subscription" || typeof model !== "string") continue
      if (!Object.hasOwn((await connections.capPrices(name)).prices, model)) unpriced.push(`${name}'s ${model}`)
    }
  } catch (error) {
    if (error instanceof ProviderError || error instanceof FileLockError || errnoCode(error) !== undefined) return null
    throw error
  }
  if (unpriced.length === 0) return null
  const { input, output } = DEFAULT_PRICE
  return {
    name: "prices",
    status: "warn",
    detail:
      `no connection lists a price for ${unpriced.join(", ")}, so a chat on it counts toward its cost cap at ` +
      `$${input} in and $${output} out per million tokens; add its API price to a connection's prices`,
  }
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

/** How a harness install or setting made in this shell reaches an office running under `mode`. */
function changeLands(mode: string | null): string {
  // launchd and systemd start the office with the environment `opencorp onboard` wrote into its service file, which
  // `opencorp restart` reuses; only a stopped office's onboard writes the file again.
  if (mode === "launchd" || mode === "systemd") {
    return "`opencorp stop` and `opencorp onboard` again from that shell"
  }
  return "`opencorp restart` from that shell"
}

/** The owner's home and `<OPENCORP_HOME>`, which the Codex check's thread and the Claude Code check's start deny by
 *  name as an employee's do. */
export interface CodexOffice {
  home: string
  officeHome: string
  /** Folders others may write (every person's writable listed folders, and live sessions' folders): no harness doctor
   *  runs, nor a link that leads to it, may be in one. */
  othersWritable?: readonly string[]
}

/**
 * Whether the office can start Codex sessions, in the environment it gives an app-server (`env`): the binary on its
 * PATH, the version (0.167.0 or later), the sign-in, and, given `office`, a thread under an employee's permission that
 * can be used (`threadProbe`, under `base`'s harness temp folder: a thread that starts but whose config no turn could
 * load fails, and so does one whose sandbox can't run a command, with no model turn run), and a warning for each
 * trusted project whose own config Codex would load.
 * Missing, signed out, or a `login status` that fails otherwise (shown by the first line it printed) is a warning, not
 * a failure: only people with `codex` in `harnesses` need it. A `codex` that won't run, doesn't answer within
 * `timeoutMs`, is older than the floor or whose version can't be read fails.
 *
 * `environ` is the office's environment: its `OPENCORP_CODEX_BIN` picks the binary and its `CODEX_HOME` joins `env`,
 * as they do for an app-server. `mode` is the office's recorded service mode, which decides how a fix reaches it.
 * A thread that runs also names the MCP servers the owner's Codex config defines (`mcpServers`), for the MCP line.
 */
export async function codexCheck(
  env: Record<string, string>,
  environ: Env,
  mode: string | null = null,
  { timeoutMs = 30_000, office, base }: { timeoutMs?: number; office?: CodexOffice; base?: string } = {},
): Promise<CodexCheck> {
  let found: string
  try {
    found = codexCommand(env, environ)[0]!
  } catch (error) {
    if (!(error instanceof CodexMissing)) throw error
    const override = environ.OPENCORP_CODEX_BIN
    const detail = override
      ? `OPENCORP_CODEX_BIN names ${override}, which isn't an executable the office can find, so Codex sessions ` +
        `can't start (fix or unset it, then ${changeLands(mode)})`
      : "not on the office's PATH, so Codex sessions can't start " +
        `(npm install -g @openai/codex, then ${changeLands(mode)})`
    return { name: "codex", status: "warn", detail }
  }
  // Codex runs as the owner: one others could change is refused before doctor runs it at all.
  const codex = { ...nativeCodex(found), found }
  try {
    checkHarnessBinary("codex", codex, office?.othersWritable ?? [])
  } catch (error) {
    if (!(error instanceof UnsafeProfile)) throw error
    return { name: "codex", status: "fail", detail: `${found} wasn't run: ${error.message}` }
  }
  const home = environ.CODEX_HOME
  if (home) env = { ...env, CODEX_HOME: home }
  /** Codex as the office runs it, with `args`, or the failed check when it timed out or never started. */
  const ask = async (...args: string[]) => {
    // In its own group, so a hung Codex and anything it started go with the timeout.
    const done = await runCommand([codex.run, ...args], { env, timeoutMs, group: true })
    if (done.code === 124 && done.stderr === `${codex.run} timed out`) {
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
  const first = lines(version.stdout)[0] ?? ""
  const printed = first.slice(0, LINE_CAP)
  const named = printed ? `${printed} at ${found}` : `${found} (no version printed)`
  // `codex-cli X.Y.Z`, perhaps with a pre-release after.
  const at = first.match(/(\d+)\.(\d+)\.(\d+)/)
  if (at === null) {
    const detail = `${named}: OpenCorp needs Codex 0.167.0 or later and can't read this one's version; ${UPDATE_CODEX}`
    return { name: "codex", status: "fail", detail }
  }
  if (older(at.slice(1).map(Number), CODEX_FLOOR)) {
    return { name: "codex", status: "fail", detail: `${named} is older than 0.167.0, which OpenCorp needs; ${UPDATE_CODEX}` }
  }
  const login = await ask("login", "status")
  if ("name" in login) return login
  if (login.code !== 0) {
    const said = lines(`${login.stderr}\n${login.stdout}`)
    // Codex says "Not logged in" when signed out, and exits 1 on other errors too (a bad config.toml, say),
    // possibly after a warning line.
    if (said.some((line) => line.toLowerCase().startsWith(SIGNED_OUT))) {
      return { name: "codex", status: "warn", detail: `${named} is signed out; run \`${found} login\`` }
    }
    const error = said.find((line) => line.startsWith("Error")) ?? said[0]
    const why = error ? error.slice(0, LINE_CAP) : `exit ${login.code}`
    return { name: "codex", status: "warn", detail: `${named}: \`${found} login status\` failed: ${why}` }
  }
  if (office === undefined) return { name: "codex", status: "ok", detail: `${named}, signed in` }
  let probed: Probed
  try {
    probed = await threadProbe({ codex, env, environ, ...office, base, timeoutMs })
  } catch (error) {
    // Its folders under /tmp couldn't be made or removed, or the binary is gone.
    const detail = `${named} is signed in, but doctor can't try a thread under an employee's permission: ${messageOf(error)}`
    return { name: "codex", status: "fail", detail }
  }
  const { failed, projectConfigs, mcpServers } = probed
  if (failed !== null) {
    const detail =
      `${named} is signed in, but a thread under an employee's permission can't be used: ` +
      `${failed.why.slice(0, LINE_CAP)}; Codex's output is in ${failed.log}`
    return { name: "codex", status: "fail", detail }
  }
  const runs = `${named}, signed in, and a thread under an employee's permission runs`
  if (projectConfigs.length === 0) return { name: "codex", status: "ok", detail: runs, mcpServers }
  const files = projectConfigs.map((dir) => path.join(dir, "config.toml"))
  const shown = files.length > 3 ? [...files.slice(0, 3), `${files.length - 3} more`] : files
  const detail =
    `${runs}, but your Codex config trusts projects whose own config it would load, as you, so employees' Codex ` +
    `sessions there are refused (${shown.join(", ")}); untrust those projects in your Codex config.toml, or remove ` +
    "those files"
  return { name: "codex", status: "warn", detail, mcpServers }
}

/**
 * The employees in `repo` the owner allows MCP servers (each plain name in their `harness_policy.mcp_servers`, as
 * their harness takes it), each server with whether `defined` says the owner's Codex config and Claude Code's
 * user-scope servers define it (null: unknown there, the harness's own line saying why); names only, never a
 * definition. A warning when a server isn't defined for a harness its employee uses, where it then doesn't load;
 * null when nobody is allowed one.
 */
export function mcpCheck(
  repo: Pick<CompanyRepo, "people">,
  defined: { codex: readonly string[] | null; claude: readonly string[] | null },
): Check | null {
  const state = (names: readonly string[] | null, name: string) =>
    names === null ? "unknown" : names.includes(name) ? "defined" : "not defined"
  let missing = false
  const lines: string[] = []
  for (const [handle, person] of [...repo.people].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const allowed = [...new Set((person.harness_policy?.mcp_servers ?? []).filter((n) => MCP_SERVER_NAME.test(n)))]
    if (allowed.length === 0) continue
    const servers = allowed.map((name) => {
      for (const [harness, names] of [["codex", defined.codex], ["claude", defined.claude]] as const) {
        if (person.harnesses.includes(harness) && names !== null && !names.includes(name)) missing = true
      }
      return `${name} (Codex: ${state(defined.codex, name)}, Claude Code: ${state(defined.claude, name)})`
    })
    lines.push(`@${handle}: ${servers.join(", ")}`)
  }
  if (lines.length === 0) return null
  const listed = `each runs as you, outside the employee's folder fence: ${lines.join("; ")}`
  if (!missing) return { name: "mcp", status: "ok", detail: listed }
  const fix =
    "an allowed server that isn't defined for a harness its employee uses doesn't load there: define it in your " +
    "Codex config.toml ([mcp_servers.<name>]) or with `claude mcp add --scope user`"
  return { name: "mcp", status: "warn", detail: `${listed}; ${fix}` }
}

/**
 * Whether employees can drive Claude Code, in the environment the office gives it (`env`): the binary on its PATH,
 * refused before it runs if others could change it (`checkHarnessBinary`, with `office`'s others' folders), the
 * version (2.1.325 or later), and, given `office`, a start under an employee's permission (`probeStart`, under
 * `base`'s harness folder), which reads the sign-in from `initialize` and sends no message, so no model call runs and
 * no command runs in its sandbox: a sandbox that starts but fails on its first command isn't seen.
 * Missing or signed out is a warning, not a failure: only employees who drive Claude Code need it. A `claude` that
 * won't run, doesn't answer within `timeoutMs`, is older than the floor or whose version can't be read fails, and so
 * does one that can't start under an employee's permission (its sandbox can't start, or others could change it).
 *
 * `environ` is the office's environment: its `OPENCORP_CLAUDE_BIN` picks the binary and its `CLAUDE_CONFIG_DIR` joins
 * `env`, as they do for a session. `mode` is the office's recorded service mode, which decides how a fix reaches it.
 * On a `platform` where Claude Code can't run in a read-only folder, the line names the employees in `readOnly`
 * (`readOnlyClaude`), whose sessions are refused: a start that works warns, and one that fails says so too. Where its sandbox needs socat (Linux), the start runs
 * with the one the office finds (`OPENCORP_SOCAT_BIN` in `environ`, else `socat` on `env`'s PATH), and none fails.
 */
export async function claudeCheck(
  env: Record<string, string>,
  environ: Env,
  mode: string | null = null,
  {
    timeoutMs = 30_000,
    office,
    base,
    readOnly = [],
    platform = process.platform,
  }: {
    timeoutMs?: number
    office?: CodexOffice
    base?: string
    readOnly?: readonly string[]
    platform?: NodeJS.Platform
  } = {},
): Promise<Check> {
  let found: string
  try {
    found = claudeCommand(env, environ)
  } catch (error) {
    if (!(error instanceof ClaudeMissing)) throw error
    const override = environ.OPENCORP_CLAUDE_BIN
    const detail = override
      ? `OPENCORP_CLAUDE_BIN names ${override}, which isn't an executable the office can find, so employees can't ` +
        `drive Claude Code (fix or unset it, then ${changeLands(mode)})`
      : "not on the office's PATH, so employees can't drive Claude Code " +
        `(install it from https://code.claude.com/docs/en/setup, then ${changeLands(mode)})`
    return { name: "claude", status: "warn", detail }
  }
  // Claude Code runs as the owner: one others could change is refused before doctor runs it at all.
  const claude = { ...nativeClaude(found), found }
  try {
    checkHarnessBinary("claude", claude, office?.othersWritable ?? [])
  } catch (error) {
    if (!(error instanceof UnsafeProfile)) throw error
    return { name: "claude", status: "fail", detail: `${found} wasn't run: ${error.message}` }
  }
  const config = environ.CLAUDE_CONFIG_DIR
  const ran = config ? { ...env, CLAUDE_CONFIG_DIR: config } : env
  // In its own group, so a hung Claude Code and anything it started go with the timeout.
  const version = await runCommand([claude.run, "--version"], { env: ran, timeoutMs, group: true })
  if (version.code === 124 && version.stderr === `${claude.run} timed out`) {
    return { name: "claude", status: "fail", detail: `${found} --version didn't answer in ${timeoutMs / 1000} s` }
  }
  const unstarted = version.code === 127 ? version.stderr.match(SPAWN_ERROR) : null
  if (unstarted) return { name: "claude", status: "fail", detail: `${found} can't run: ${unstarted[1]}` }
  if (version.code !== 0) {
    const why = lines(version.stderr)[0]?.slice(0, LINE_CAP) || `exit ${version.code}`
    return { name: "claude", status: "fail", detail: `${found} --version failed: ${why}` }
  }
  const printed = (lines(version.stdout)[0] ?? "").slice(0, LINE_CAP)
  const named = printed ? `${printed} at ${found}` : `${found} (no version printed)`
  // `X.Y.Z (Claude Code)`.
  const at = printed.match(/\d+\.\d+\.\d+/)
  if (at === null) {
    const detail =
      `${named}: OpenCorp needs Claude Code ${CLAUDE_FLOOR} or later and can't read this one's version; ` +
      UPDATE_CLAUDE
    return { name: "claude", status: "fail", detail }
  }
  if (olderThan(at[0])) {
    const detail = `${named} is older than ${CLAUDE_FLOOR}, which OpenCorp needs; ${UPDATE_CLAUDE}`
    return { name: "claude", status: "fail", detail }
  }
  if (office === undefined) return { name: "claude", status: "ok", detail: named }
  const started = await claudeStarts(named, env, environ, mode, { claude, office, base, platform })
  if (readOnly.length === 0 || !readOnlyFails(platform)) return started
  const whose = readOnly.map((handle) => `@${handle}'s`)
  const names = whose.length === 1 ? whose[0] : `${whose.slice(0, -1).join(", ")} and ${whose.at(-1)}`
  const refused = `${names} Claude Code sessions are refused: ${READ_ONLY_FIX}`
  if (started.status === "ok") return { name: "claude", status: "warn", detail: `${started.detail}, but ${refused}` }
  return { ...started, detail: `${started.detail}; and ${refused}` }
}

/** The part of `claudeCheck` that starts Claude Code, `named` (its version and path), under an employee's permission,
 *  with the office's socat where its sandbox needs one. */
async function claudeStarts(
  named: string,
  env: Record<string, string>,
  environ: Env,
  mode: string | null,
  {
    claude,
    office,
    base,
    platform,
  }: { claude: HarnessInstall; office: CodexOffice; base?: string; platform: NodeJS.Platform },
): Promise<Check> {
  const cant = `${named} can't start under an employee's permission`
  let socat: string | undefined
  if (socatNeeded(platform)) {
    const override = environ.OPENCORP_SOCAT_BIN
    socat = which(override || "socat", env.PATH) ?? undefined
    if (socat === undefined) {
      const detail = override
        ? `${cant}: OPENCORP_SOCAT_BIN names ${override}, which isn't an executable the office can find; fix or unset ` +
          `it, then ${changeLands(mode)}`
        : `${cant}: ${SOCAT_MISSING.replace("restart the office and run `opencorp doctor`", changeLands(mode))}`
      return { name: "claude", status: "fail", detail }
    }
  }
  let probed: { error: Error | null; log: string }
  try {
    probed = await probeStart({ claude, env, environ, ...office, base, ...(socat === undefined ? {} : { socat }) })
  } catch (error) {
    // Its folders under /tmp couldn't be made or removed, or the binary is gone.
    return { name: "claude", status: "fail", detail: `${cant}: doctor can't try one: ${messageOf(error)}` }
  }
  const { error, log } = probed
  if (error === null) {
    // No command ran: a sandbox that fails only on its first command shows only in a session.
    const detail =
      `${named}, signed in, and starts with its sandbox required under an employee's permission ` +
      "(no command tried in it)"
    return { name: "claude", status: "ok", detail }
  }
  if (error instanceof ClaudeSignedOut) {
    const detail = `${named} is signed out; run \`claude\` in a terminal and sign in with /login`
    return { name: "claude", status: "warn", detail }
  }
  if (error instanceof SocatUnusable) return { name: "claude", status: "fail", detail: `${cant}: ${error.message}` }
  if (error instanceof ClaudeSandboxUnavailable) {
    const detail =
      `${cant}: its sandbox can't start here (on Linux, install bubblewrap and socat, and allow unprivileged user ` +
      `namespaces); Claude Code's output is in ${log}`
    return { name: "claude", status: "fail", detail }
  }
  if (!(error instanceof ClaudeStartError)) {
    // The permission or the install, refused before Claude Code ran.
    return { name: "claude", status: "fail", detail: `${cant}: ${error.message.slice(0, LINE_CAP)}` }
  }
  const why = error.cause instanceof Error ? error.cause.message : error.message
  const detail = `${cant}: ${why.slice(0, LINE_CAP)}; Claude Code's output is in ${log}`
  return { name: "claude", status: "fail", detail }
}

/** Whether version `got` comes before `floor`. */
function older(got: readonly number[], floor: readonly number[]): boolean {
  const at = got.findIndex((n, i) => n !== floor[i])
  return at !== -1 && got[at]! < floor[at]!
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

/** Why a sandboxed program can't run on a terminal of its own, or null when one does: in a fresh temp folder, under a
 *  read-only policy as the sandbox probe's, `/bin/sh -c 'test -t 0'` must find its input a terminal. */
export async function terminalProblem(): Promise<string | null> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-doctor-"))
  try {
    const workspace = path.join(root, "ws")
    const tmpdir = path.join(root, "tmp")
    fs.mkdirSync(workspace)
    fs.mkdirSync(tmpdir)
    const policy = new SandboxPolicy({ workspace, writable: false, network: false, tmpdir })
    let output = ""
    const decoder = new TextDecoder()
    const pty = startOnTerminal(policy, ["/bin/sh", "-c", "test -t 0"], {
      cols: 80,
      rows: 24,
      onData: (chunk) => void (output += decoder.decode(chunk, { stream: true })),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), PROBE_TIMEOUT * 1000)))
    const code = await Promise.race([pty.exited, late])
    clearTimeout(timer)
    if (code === "late") {
      pty.kill("SIGKILL")
      pty.close()
      await pty.exited
      return `a sandboxed program on a terminal didn't finish in ${PROBE_TIMEOUT} s`
    }
    if (code === 0) return null
    return lines(output).at(-1)?.slice(0, LINE_CAP) || (code === null ? "it was ended by a signal" : `exit ${code}`)
  } catch (error) {
    return messageOf(error)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
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
  /** The OpenCorp checkout the office runs from (default `CHECKOUT`). */
  repo?: string
  /** Why a sandboxed command can't run for the office at the given home, or null if one does (default
   *  `sandboxProblem`). */
  probe?: (officeHome: string) => Promise<string | null>
  /** Why a sandboxed program can't run on a terminal, or null if one does (default `terminalProblem`). */
  terminal?: () => Promise<string | null>
  /** The Codex check, given the worker env, the office's env, its recorded service mode, and the owner's and the
   *  office's homes (default `codexCheck`); the MCP servers it names go to the MCP line, not its own. */
  codex?: (
    env: Record<string, string>,
    environ: Env,
    mode: string | null,
    options: { office: CodexOffice },
  ) => Promise<CodexCheck>
  /** The Claude Code check, given the same and the employees who use it with a read-only folder (default
   *  `claudeCheck`). */
  claude?: (
    env: Record<string, string>,
    environ: Env,
    mode: string | null,
    options: { office: CodexOffice; readOnly: readonly string[] },
  ) => Promise<Check>
  /** The shell's environment (default `process.env`). */
  environ?: Env
  /** `GET /hq` from the office on the socket, sent with the identity's token when there is one
   *  (`server/hq/checks.ts`'s `hqStatus`). */
  hq: (socket: string, identity: Identity | undefined) => Promise<HqStatus | service.Unread>
  /** HQ's lines for its status (`server/hq/checks.ts`'s `hqChecks`): `status`, the office dir, the checkout, and
   *  why the socket isn't at its path, if it isn't. */
  hqChecks: (status: HqStatus | service.Unread, officeDir: string, repo: string, socketMissing: string | null) => Check[]
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
  const { codex = codexCheck, claude = claudeCheck, office = service.officeInfo, probe = sandboxProblem } = options
  const { terminal = terminalProblem } = options
  const { hq, hqChecks } = options
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
  const prices = await pricesCheck(paths)
  if (prices !== null) found.push(prices)
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
  const onTerminal = await terminal()
  found.push(
    onTerminal
      ? { name: "terminal", status: "fail", detail: `${onTerminal}; ${SANDBOX_FIX}` }
      : { name: "terminal", status: "ok", detail: "sandboxed programs run on a terminal" },
  )
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
  // A store that failed its own check isn't opened again (it may be a FIFO).
  const others = othersWritable(paths, host.userHome, store?.status !== "fail")
  const homes = { home: host.userHome, officeHome: paths.home, othersWritable: others }
  const { mcpServers: codexMcp, ...codexLine } = await codex(workerEnv(run.env), run.env, service.recordedMode(run), {
    office: homes,
  })
  found.push(codexLine)
  let company: CompanyRepo | null = null
  try {
    if (fs.existsSync(paths.company)) company = loadRepo(paths.company)
  } catch {
    // The company check says why it doesn't load.
  }
  const readOnly = company === null ? [] : readOnlyClaude(company)
  found.push(await claude(workerEnv(run.env), run.env, service.recordedMode(run), { office: homes, readOnly }))
  if (company !== null) {
    // Claude Code's user-scope servers as a session reads them: in the owner's .claude.json, or CLAUDE_CONFIG_DIR's.
    const claudeMcp = ownerMcpServers(claudeJson(run.env, host.userHome))
    const claudeNames = claudeMcp === null ? null : Object.keys(claudeMcp)
    const line = mcpCheck(company, { codex: codexMcp ?? null, claude: claudeNames })
    if (line !== null) found.push(line)
  }
  return found
}

/** The employees in `repo` who use Claude Code with a folder they may only read (no `harness_policy`, or its sandbox
 *  not `workspace-write`), by handle. */
export function readOnlyClaude(repo: Pick<CompanyRepo, "people">): string[] {
  return [...repo.people]
    .filter(([, person]) => person.harnesses.includes("claude") && person.harness_policy?.sandbox !== "workspace-write")
    .map(([handle]) => handle)
    .sort()
}

/** Every person's writable listed folders in the company's working tree, and, when `storeReadable`, the folders of
 *  the office's live sessions: where no harness doctor runs may be. What can't be read adds nothing. */
function othersWritable(paths: OfficePaths, home: string, storeReadable: boolean): string[] {
  const found: string[] = []
  try {
    if (fs.existsSync(paths.company)) found.push(...writableFolders(loadRepo(paths.company), home))
  } catch {
    // The company check says why it doesn't load.
  }
  try {
    if (storeReadable && fs.lstatSync(paths.store, { throwIfNoEntry: false })?.isFile()) {
      const sql = `SELECT DISTINCT cwd FROM sessions WHERE status IN (${LIVE.map(() => "?").join(", ")})`
      found.push(...readStore(paths.store, (db) => db.prepare(sql).all(...LIVE).map((row) => String(row.cwd))))
    }
  } catch {
    // The store check says why it can't be read.
  }
  return [...new Set(found)]
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

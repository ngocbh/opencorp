/** `opencorp doctor`: check the office home (there and private), company repo, provider and connections, service,
 *  daemon, HQ, sandbox, worked folders, and Codex. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type HqStatus, OfficeInfo } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import { FileLockError, openSqlite, sqliteErrorCode } from "@ngocbh/yian/platform"
import { type Identity, identityPath, readIdentity } from "../auth/identity.ts"
import { loadProvider, Provider, ProviderError } from "../chat/provider.ts"
import type { RepoIssue } from "../company/issues.ts"
import { lint } from "../company/lint.ts"
import { loadRepo } from "../company/loader.ts"
import { isNew, missingFiles } from "../company_template/index.ts"
import { OfficePaths } from "../daemon/office.ts"
import { CodexMissing, codexCommand } from "../harness/codex.ts"
import { RETRY_MS } from "../hq/servers.ts"
import { CHECKOUT } from "../hq/version.ts"
import { selfCommand } from "../platform.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import { checkWorkspace, type OfficePaths as Guards, SandboxPolicy, UnsafeWorkspace } from "../sandbox/policy.ts"
import { fsHelper, run } from "../sandbox/run.ts"
import { workerEnv } from "../worker/spawn.ts"
import { defaultHost, type Env, type Host, type Launch, launch, runCommand, which } from "./launch.ts"
import * as launchd from "./launchd.ts"
import { checkProvider, SET_UP, setupConnectionFile, stopToTopUp, withDefaultModel } from "./onboard.ts"
import { OnboardError } from "./prompts.ts"
import * as service from "./service.ts"
import * as systemd from "./systemd.ts"
import { installPaths, resolveTools, workspaceGuards } from "./tools.ts"

/** How the daemon prefixes the one line it prints when it can't start. */
const START_ERROR = "opencorp office: "

/**
 * The crash marker's line (`logLine` from the daemon's `crashReport`), capturing `office crashed: <type>`. The type
 * may be empty (an anonymous class); a marker with anything after the type doesn't match, so no message shows.
 */
const CRASH_MARKER = /^\S+ ERROR opencorp\.daemon\.main: (office crashed: \S*)$/

/** The end of the office log that `crash` looks at: far more than 40 lines. */
const LOG_TAIL_BYTES = 64 * 1024

/** A stack frame line under the crash marker. */
const FRAME = /^\s+at /

/** How `codex login status` starts the line it prints when nobody is signed in, lowercased. */
const SIGNED_OUT = "not logged in"

/** The most of a line from `codex --version` or `codex login status` the report shows. */
const LINE_CAP = 200

/** Seconds each sandboxed call of the sandbox probe may take. */
const PROBE_TIMEOUT = 30

/** SQLite's primary result code for a file it can't open. */
const SQLITE_CANTOPEN = 14

/** An ANSI color code, which Codex may print around a line. */
const COLOR = /\x1b\[[0-9;]*m/g

/**
 * How Bun words a program that never started: `<code>: <strerror>, posix_spawn '<path>'` (Node's `spawn <path> <code>`
 * differs).
 */
// Bun's wording on Linux hasn't been probed here, so a plain `spawn` is accepted too.
const SPAWN_ERROR = /^E[A-Z0-9]+: (.*), (?:posix_)?spawn\b/

/** One line of the report: `fail` needs fixing, `warn` is worth knowing. */
export interface Check {
  name: string
  status: "ok" | "warn" | "fail"
  detail: string
}

/** Why the office's answer couldn't be read: it refused this device's token; no office answered in time (or one too
 *  old to have the route); or its answer isn't what was asked for. */
export type Unread = "refused" | "unreachable" | "unreadable"

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
  let issues: RepoIssue[]
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
    return { name: "provider", status: "fail", detail: `can't read ${file}: ${strerror(error) ?? code}` }
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

/** Whether systemd keeps this user's services running after logout; null if `loginctl` can't say. */
async function linger(host: Host): Promise<boolean | null> {
  const done = await host.run(["loginctl", "show-user", String(host.uid), "--property=Linger"])
  if (done.code !== 0) return null
  return done.stdout.trim() === "Linger=yes"
}

async function serviceCheck(run: Launch, host: Host): Promise<Check> {
  const mode = service.recordedMode(run)
  if (mode === "launchd") {
    const name = launchd.label(run)
    const problem = await launchd.notLoaded(run, host)
    if (problem === null) return { name: "service", status: "ok", detail: `launchd: ${name} is loaded` }
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

/** What to do about an office that isn't answering: `opencorp start`, and where its service's status is. */
function nextStep(run: Launch, host: Host): string {
  const mode = service.recordedMode(run)
  if (mode === "launchd") {
    const name = launchd.label(run)
    return (
      `Run \`opencorp start\`. launchd runs it as ${name}: ` +
      `\`launchctl print gui/${host.uid}/${name}\` shows its status.`
    )
  }
  if (mode === "systemd") {
    const name = systemd.unitName(run)
    return `Run \`opencorp start\`. systemd runs it as ${name}: \`systemctl --user status ${name}\` shows its status.`
  }
  return "Run `opencorp start`."
}

/**
 * The last `LOG_TAIL_BYTES` of `file`, without the partial first line when it is cut; empty when `file` isn't a
 * regular file.
 */
function tail(file: string): string {
  // Non-blocking so a FIFO at the log's path can't hang the open.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return ""
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES)
    const buf = Buffer.alloc(LOG_TAIL_BYTES)
    const text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start)).toString("utf8")
    if (start === 0) return text
    // A window that falls inside one long line holds only part of it.
    const nl = text.indexOf("\n")
    return nl < 0 ? "" : text.slice(nl + 1)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Why the daemon's last start failed, from the office log, or null if it didn't: the line it printed when it
 * couldn't start, or `office crashed: <type>` when the log ends with the crash marker and its frames (the frames
 * stay in the log). A marker with other lines after it belongs to an earlier start.
 */
function crash(log: string): string | null {
  let text: string
  try {
    text = tail(log)
  } catch (error) {
    if (errnoCode(error) === undefined) throw error
    return null
  }
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-40)
  const last = lines.at(-1)
  if (last === undefined) return null
  // A duplicate start exits 0 and is no crash.
  if (last.startsWith(START_ERROR) && !last.includes("office already running")) return last
  const marker = lines.findLast((line) => !FRAME.test(line))
  return marker?.match(CRASH_MARKER)?.[1] ?? null
}

/** The non-empty lines of `output`, trimmed and without color codes. */
function lines(output: string): string[] {
  return output
    .split(/\r\n|\n|\r/)
    .map((raw) => raw.replace(COLOR, "").trim())
    .filter((line) => line)
}

/** How a Codex install or setting made in this shell reaches an office running under `mode`. */
function codexChangeLands(mode: string | null): string {
  // launchd and systemd start the office with the environment `opencorp onboard` wrote into its service file, which
  // `opencorp restart` reuses; only a stopped office's onboard writes the file again.
  if (mode === "launchd" || mode === "systemd") {
    return "stop the office and run `opencorp onboard` again from that shell"
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
    const done = await runCommand([found, ...args], { env, timeoutMs })
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
    const why = version.stderr.replace(COLOR, "").trim().slice(0, LINE_CAP) || `exit ${version.code}`
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

/**
 * `GET <target>` from the office on `socket`, sent with the identity's token when there is one: the status and body
 * text, or `unreachable` when nothing answered within `timeoutMs`.
 */
export async function getJson(
  socket: string,
  identity: Identity | undefined,
  target: string,
  timeoutMs: number,
): Promise<{ status: number; text: string } | "unreachable"> {
  try {
    // Bun's fetch over a unix socket.
    const res = await fetch(`http://office${target}`, {
      unix: socket,
      headers: identity?.headers(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, text: await res.text() }
  } catch {
    return "unreachable"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * `GET target` from the office on `socket`, sent with the identity's token when there is one, and its JSON body as
 * `read` takes it, or why it couldn't be read (`read` returning undefined makes it unreadable).
 */
async function readFromOffice<T>(
  socket: string,
  identity: Identity | undefined,
  target: string,
  timeoutMs: number,
  read: (body: unknown) => T | undefined,
): Promise<T | Unread> {
  const got = await getJson(socket, identity, target, timeoutMs)
  if (got === "unreachable") return got
  if (got.status === 401) return "refused"
  // 404 from an office before the route; for /hq, 501 from one without HQ attached
  if (got.status !== 200) return "unreachable"
  let body: unknown
  try {
    body = JSON.parse(got.text)
  } catch {
    return "unreadable"
  }
  return read(body) ?? "unreadable"
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
): Promise<HqStatus | Unread> {
  return readFromOffice(socket, identity, "/hq", timeoutMs, readByChecks)
}

/** How HQ's status starts the TCP error when the web port's server stopped after it bound, not a failed bind. */
const SERVER_ENDED = "its server ended"

/** What to do about an HQ status doctor couldn't read, by why. */
export const UNREAD: Record<Unread, string> = {
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

/** Where HQ listens, whether the web app is built for this office, and HQ's own warnings. */
export function hqChecks(status: HqStatus | Unread, officeDir: string, repo: string): Check[] {
  if (typeof status === "string") return [{ name: "hq", status: "warn", detail: UNREAD[status] }]
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
        detail: `on ${status.socket} only (the web port is off); \`opencorp pair\` prints the SSH forward`,
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
          `"port" in ${path.join(officeDir, "hq.json")} and run \`opencorp restart\``,
      },
    ]
  }
  const socketError = status.socket_error // an office from before the field has none
  if (socketError) {
    // The web port keeps a line of its own, so what's wrong with it isn't lost under the socket's problem.
    const port: Check = tcp.listening
      ? { name: "hq port", status: "ok", detail: `web app at ${status.url}` }
      : { ...found[0]!, name: "hq port" }
    found = [
      {
        name: "hq",
        status: "warn",
        detail: `not listening on ${status.socket}: ${socketError}; run \`opencorp restart\` once that's fixed`,
      },
      ...(tcp.enabled ? [port] : []),
    ]
  }
  const { app, office } = status.health
  if (app === null && !isDirectory(path.join(repo, "packages", "app"))) {
    // Installed from a package, not a checkout.
    found.push({
      name: "web app",
      status: "warn",
      detail: "this install has no web app; it's built in a checkout of the opencorp repo",
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

/**
 * `GET /office` from the office on `socket`, sent with the identity's token when there is one: its pid, home, start
 * time, version and pinned tools, or why it couldn't be read.
 */
export async function officeInfo(
  socket: string,
  identity: Identity | undefined,
  timeoutMs = 2000,
): Promise<OfficeInfo | Unread> {
  return readFromOffice(socket, identity, "/office", timeoutMs, (body) => OfficeInfo.safeParse(body).data)
}

/** What to do about an office that wouldn't say what code it runs, by why. */
export const VERSION_UNREAD: Record<Unread, string> = {
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

/**
 * The newest modification time (ms) of the code the office runs from a checkout command
 * (`[bun, ...flags, <checkout>/packages/cli/src/main.ts]`): the office, protocol and CLI sources and Yian's. 0 for a
 * compiled binary, or when nothing is found.
 */
export function newestSource(command: readonly [string, ...string[]]): number {
  // npm installs date every file 1985, so a binary's dates say nothing; VERSION catches an upgrade.
  if (command.length < 2) return 0
  const checkout = installPaths(command)[0]!
  const roots = ["office", "protocol", "cli"].map((pkg) => path.join(checkout, "packages", pkg, "src"))
  roots.push(path.join(checkout, "packages", "yian", "ts", "src"))
  return Math.max(0, ...roots.map(newestUnder))
}

/** Whether `info` is this office's daemon (`launch`'s home), runs this install's version, and started after its code
 *  last changed (`newest`, ms). */
export function versionCheck(launch: Launch, info: OfficeInfo, newest: number): Check {
  if (info.home !== launch.home) {
    const detail = `pid ${info.pid} is not this office's daemon: it serves ${info.home}`
    return { name: "version", status: "warn", detail }
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
      return shell.stderr.toString("utf8").replace(COLOR, "").trim().slice(0, LINE_CAP) || `exit ${shell.exit}`
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
    const stderr = listed.stderr.toString("utf8").replace(COLOR, "").trim().slice(0, LINE_CAP)
    return `the file helper failed: ${error || stderr || `exit ${listed.exit}`}`
  } catch (error) {
    return messageOf(error)
  } finally {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Every folder in the `worked_folders` table of the store at `store`, sorted, read without writing. */
function workedFolders(store: string): string[] {
  const read = (readonly: boolean) => {
    const db = openSqlite(store, { readonly })
    try {
      return db
        .prepare("SELECT DISTINCT cwd FROM worked_folders ORDER BY cwd")
        .all()
        .map((row) => String(row.cwd))
    } finally {
      db.close()
    }
  }
  try {
    return read(true)
  } catch (error) {
    if (((sqliteErrorCode(error) ?? 0) & 0xff) !== SQLITE_CANTOPEN) throw error
    // A WAL store can't be read read-only without its -wal and -shm files, which SQLite deletes when the office
    // closes it. A read-write open on the existing file makes them again; the query still only reads, and the store
    // is never migrated: a doctor newer than the daemon must not change its schema under it.
    return read(false)
  }
}

/**
 * Whether any folder someone worked in (the store's `worked_folders`) is one `checkWorkspace` refuses with `guards`
 * and the user's `home`: one holding the office install, a program it runs or a folder on its PATH, one holding the
 * home directory, or one inside a sensitive home path. Sessions there are refused until the install, the program or
 * the folder moves. Null when the office has no store, or a store without the table; a folder that no longer exists is
 * skipped.
 */
export function foldersCheck(store: string, guards: Guards, home: string): Check | null {
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
    } catch (error) {
      const why = errnoCode(error) ?? nameOf(error)
      refused.push(error instanceof UnsafeWorkspace ? error.message : `${cwd}: can't be checked (${why})`)
    }
  }
  if (refused.length) return { name: "folders", status: "fail", detail: refused.join("; ") }
  return {
    name: "folders",
    status: "ok",
    detail: "no worked folder holds the office install, a program it runs or a folder on its PATH",
  }
}

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
  hq?: (socket: string, identity: Identity | undefined) => Promise<HqStatus | Unread>
  /** `GET /office` from the office on the socket, sent with the identity's token when there is one (default
   *  `officeInfo`). */
  office?: (socket: string, identity: Identity | undefined) => Promise<OfficeInfo | Unread>
  /** Looks at a path without following a symlink (default `fs.lstatSync`). */
  lstat?: (p: string) => fs.Stats
}

/**
 * Every check for the office at `home`, in the order onboarding sets things up. A running office is asked what it
 * runs and where HQ listens with this device's identity, read once; that read can wait on a busy `<home>/.lock`.
 *
 * Worked folders are checked against the guards the running daemon pinned (`GET /office`); when the office wasn't
 * read, against the ones an office started from this shell with `command` would pin, which can differ from a running
 * daemon's.
 */
export async function checks(home: string, options: CheckOptions): Promise<Check[]> {
  const { host = defaultHost(), command = selfCommand(), repo = CHECKOUT, environ = process.env } = options
  const { codex = codexCheck, hq = hqStatus, office = officeInfo, probe = sandboxProblem } = options
  const lstat = options.lstat ?? ((p: string) => fs.lstatSync(p))
  const run = launch(home, { command, environ, userHome: host.userHome })
  const paths = new OfficePaths(run.home)
  const running = await host.answers(run.socket)
  const found: Check[] = []
  let guards: Guards | undefined
  found.push(homeCheck(paths))
  found.push(await companyCheck(paths, running))
  found.push(await providerCheck(paths))
  const added = connectionsCheck(paths, lstat)
  if (added !== null) found.push(added)
  found.push(await serviceCheck(run, host))
  if (running) {
    found.push({ name: "office", status: "ok", detail: `answering on ${run.socket} (pid ${service.pid(run)})` })
    const identity = await readIdentity(identityPath(run.home))
    const info = await office(run.socket, identity)
    if (typeof info === "string") found.push({ name: "version", status: "warn", detail: VERSION_UNREAD[info] })
    else {
      found.push(versionCheck(run, info, newestSource(command)), toolsCheck(info))
      guards = info.guards
    }
    found.push(...hqChecks(await hq(run.socket, identity), paths.office, repo))
  } else {
    const error = crash(run.log)
    const why = error === null ? "" : `; its last start failed: ${error}`
    found.push({
      name: "office",
      status: error === null ? "warn" : "fail",
      detail: `not answering on ${run.socket}${why} (log: ${run.log}). ${nextStep(run, host)}`,
    })
  }
  const problem = await probe(paths.home)
  found.push({ name: "sandbox", status: problem ? "fail" : "ok", detail: problem || "sandboxed commands run" })
  const folders = foldersCheck(
    paths.store,
    guards ?? workspaceGuards(resolveTools(run.env), run.env, command),
    host.userHome,
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

/** The checks as aligned lines: status, name, detail. */
export function report(found: Iterable<Check>): string {
  let out = ""
  for (const c of found) out += `${c.status.padEnd(4)}  ${c.name.padEnd(11)}  ${c.detail}\n`
  return out
}

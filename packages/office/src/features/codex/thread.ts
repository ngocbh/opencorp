/** What a Codex thread runs under beside its employee's permission: the private folder under `/tmp` holding each
 *  thread's temp folder and the fence, the git root Codex keys trust by, the app-server's PATH and TMPDIR, and the load
 *  that turns the owner's MCP servers off. Also doctor's probe of a thread that starts but can't be used. */
import fs from "node:fs"
import path from "node:path"
import { type EmployeePermission, codexThread, harnessPath } from "../../runtime/sandbox/harness_profile.ts"
import { UnsafeProfile, UnsafeWorkspace } from "../../runtime/sandbox/policy.ts"
import { APP_SERVER_ARGS, CodexProcess, CodexStartError, threadLoad } from "../../tools/codex/codex.ts"
import { type JsonRpc, RpcClosed, RpcError, nameOf } from "../../tools/codex/rpc.ts"

/** Milliseconds `config/read` has to answer. */
const CONFIG_READ_MS = 30_000
/** Milliseconds the probe's app-server has to exit once its stdin closes. */
const PROBE_GRACE_MS = 2_000

/** `<base>/opencorp-<uid>/codex`, which holds each Codex thread's temp folder and the fence. Both levels are made 0700
 *  when missing; `UnsafeProfile` when one isn't the user's own private folder (a link is refused). */
export function harnessTemp(base = "/tmp"): string {
  const uid = process.getuid!()
  const top = path.join(base, `opencorp-${uid}`)
  const codex = path.join(top, "codex")
  for (const dir of [top, codex]) privateDir(dir, uid)
  return codex
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

/** The fence in `root` (`harnessTemp`'s): an empty 0600 file, made unless something is there. The permission's check
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

/** `<root>/<name>` made fresh: an empty 0700 folder, whatever an earlier thread's commands left there. */
export function freshFolder(root: string, name: string): string {
  const dir = inRoot(root, name)
  removeTree(dir)
  fs.mkdirSync(dir, { mode: 0o700 })
  // The umask can't widen it, but it can leave the user without write.
  fs.chmodSync(dir, 0o700)
  return dir
}

/** Removes `<root>/<name>` and what is in it, if it is there. */
export function removeFolder(root: string, name: string): void {
  removeTree(inRoot(root, name))
}

/** `<root>/<name>`, for a `name` that is one path segment. */
function inRoot(root: string, name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`a thread's temp folder is named by one path segment; got ${JSON.stringify(name)}`)
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

/** The git root of `dir`, a resolved folder: the nearest folder at or above it holding `.git` (a folder, a worktree's
 *  file, or a link), as `git rev-parse --show-toplevel` finds it, or null. Nothing is run. */
export function gitRootOf(dir: string): string | null {
  for (let at = dir; ; at = path.dirname(at)) {
    if (fs.lstatSync(path.join(at, ".git"), { throwIfNoEntry: false }) !== undefined) return at
    if (at === path.dirname(at)) return null
  }
}

/** The app-server's environment for a thread under `p`: `base` with the harness PATH and `p`'s temp folder as TMPDIR.
 *  Throws as `harnessPath` does. */
export function threadEnv(base: Record<string, string>, p: EmployeePermission): Record<string, string> {
  return { ...base, PATH: harnessPath(p), TMPDIR: p.tmpdir }
}

/** The MCP servers the owner's Codex config defines, as the app-server reads it (`config/read`, the user's and the
 *  system's layers, no project's); nothing is written. Rejects as the request does. */
export async function mcpServerNames(rpc: JsonRpc): Promise<string[]> {
  const read = (await rpc.request("config/read", {}, { timeout: CONFIG_READ_MS })) as {
    config?: { mcp_servers?: unknown }
  } | null
  const servers = read?.config?.mcp_servers
  return servers !== null && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers) : []
}

/** The `thread/start` (or `thread/resume`) params of a thread in `p.workspace` under `p`, with profile `id`: every MCP
 *  server the owner's config defines turned off (`mcpServerNames`), and `install` read (`codexThread`). Rejects when the
 *  config can't be read, since a server left on would run as the owner, and throws as `codexThread` does. */
export async function employeeLoad(rpc: JsonRpc, p: EmployeePermission, id: string, install: string) {
  const mcpServers = await mcpServerNames(rpc)
  return threadLoad(p.workspace, codexThread(p, id, { install, mcpServers }))
}

/** What `threadProbe` runs. */
export type ProbeOptions = {
  /** What runs Codex, and its install folder (`nativeCodex`). */
  codex: { run: string; install: string }
  /** The app-server's environment, as the office gives one (the worker environment). */
  env: Record<string, string>
  /** The office's environment: its `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. */
  environ: Record<string, string | undefined>
  /** The owner's home and `<OPENCORP_HOME>`, denied by name. */
  home: string
  officeHome: string
  /** Where `harnessTemp` is (default `/tmp`). */
  base?: string
  /** Milliseconds each request has to answer. */
  timeoutMs: number
}

/** Null if a Codex thread under an employee's permission can be used; else what failed, and the log holding Codex's
 *  output (`doctor-codex.log` beside the fence). It starts Codex as a session does, loads an ephemeral thread in a
 *  fresh read-only folder with no network, then lists the thread's MCP servers, which reloads its config as each turn
 *  does: a thread can start under a config no turn could load. No model turn runs, and the probe's folders are
 *  removed. */
export async function threadProbe(options: ProbeOptions): Promise<{ why: string; log: string } | null> {
  const root = harnessTemp(options.base)
  const name = `doctor-${process.pid}`
  const dir = freshFolder(root, name)
  const ws = path.join(dir, "ws")
  const tmpdir = path.join(dir, "tmp")
  fs.mkdirSync(ws, { mode: 0o700 })
  fs.mkdirSync(tmpdir, { mode: 0o700 })
  const log = path.join(root, "doctor-codex.log")
  fs.rmSync(log, { force: true })
  let proc: CodexProcess | null = null
  let step = ""
  try {
    const p: EmployeePermission = {
      workspace: ws,
      gitRoot: null,
      writable: false,
      network: false,
      tmpdir,
      fence: fenceIn(root),
      folders: [],
      home: options.home,
      officeHome: options.officeHome,
      harnessHomes: harnessHomes(options.environ),
    }
    const started: CodexProcess = (proc = new CodexProcess({
      command: [options.codex.run, ...APP_SERVER_ARGS],
      cwd: ws,
      env: threadEnv(options.env, p),
      log,
      onNotification() {},
      // Doctor serves nothing; Codex takes the error as a refusal.
      onRequest: (id) => void started.rpc?.replyError(id, -32601, "opencorp doctor answers no request").catch(() => {}),
      onExit() {},
      environ: options.environ,
      logLine() {},
    }))
    await started.start()
    const rpc = started.rpc!
    const timeout = options.timeoutMs
    step = "config/read"
    const params = await employeeLoad(rpc, p, "opencorp-doctor", options.codex.install)
    step = "thread/start"
    const thread = (await rpc.request("thread/start", { ...params, ephemeral: true }, { timeout })) as {
      thread: { id: string }
    }
    step = "mcpServerStatus/list"
    await rpc.request("mcpServerStatus/list", { threadId: thread.thread.id, detail: "toolsAndAuthOnly" }, { timeout })
    return null
  } catch (error) {
    return { why: probeFailure(error, step), log }
  } finally {
    await proc?.close(PROBE_GRACE_MS)
    removeFolder(root, name)
  }
}

/** The harnesses' own config folders the office's environment sets apart from the home (`CODEX_HOME`,
 *  `CLAUDE_CONFIG_DIR`), denied by name; a relative one is kept, so the permission's check refuses it. */
export function harnessHomes(environ: Record<string, string | undefined>): string[] {
  return [environ.CODEX_HOME, environ.CLAUDE_CONFIG_DIR].filter((dir): dir is string => Boolean(dir))
}

/** Why the probe failed at `step` (empty before Codex started). */
function probeFailure(error: unknown, step: string): string {
  if (error instanceof UnsafeProfile || error instanceof UnsafeWorkspace) {
    return `an employee's permission can't be built here: ${error.message}`
  }
  if (step === "") return `Codex didn't start: ${failure(error instanceof CodexStartError ? error.cause : error)}`
  return `${step} failed: ${failure(error)}`
}

/** What went wrong, in words: Codex's own message, or the error's. */
function failure(error: unknown): string {
  if (error instanceof RpcError) return error.rpcMessage
  if (error instanceof RpcClosed || error instanceof Error) return error.message
  return nameOf(error)
}

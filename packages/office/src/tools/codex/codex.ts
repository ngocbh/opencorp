/** One `codex app-server --listen stdio://`: its command, owner-load params, process group and its tracking. */
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { VERSION } from "@opencorp/protocol/version"
import { killGroup } from "../../util/proc.ts"
import { which } from "../../util/env.ts"
import { JsonRpc, nameOf } from "./rpc.ts"

export const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const
/** Milliseconds an app-server has to exit after stdin closes, before its group is killed. */
export const CLOSE_GRACE_MS = 5_000
/** Milliseconds each start request (`initialize`, `account/read`) has to answer. */
export const START_TIMEOUT_MS = 30_000
/** Milliseconds a killed or closed app-server has to be seen exiting. */
const EXIT_WAIT_MS = 5_000
const STOPPED = "Codex was stopped before it started."

/** Codex couldn't be run, didn't start, refused the handshake, or died loading the thread. The message says what
 *  went wrong and what to do; it never holds Codex's stderr, which stays in the session's codex.log. */
export class CodexStartError extends Error {
  override name = "CodexStartError"
}

/** No `codex` on the office's PATH. */
export class CodexMissing extends CodexStartError {
  override name = "CodexMissing"
}

/** Codex runs but has no account signed in. */
export class CodexSignedOut extends CodexStartError {
  override name = "CodexSignedOut"
}

/** `codex app-server --listen stdio://` run by `codex`, or `CodexMissing` when there is none.
 *
 *  The daemon passes `office.tools.codex` and its (pinned) `process.env.OPENCORP_CODEX_BIN` as `override`, which
 *  only words the error. */
export function appServerCommand(codex: string | undefined, override?: string): string[] {
  if (codex === undefined && override)
    throw new CodexMissing(
      `OPENCORP_CODEX_BIN names ${override}, which isn't an executable the office can find; ` +
        "fix or unset it, then run `opencorp doctor`.",
    )
  if (codex === undefined)
    throw new CodexMissing(
      "Codex isn't installed where the office can find it (on its PATH). Install it " +
        "(npm install -g @openai/codex), sign in with `codex login`, then run `opencorp doctor`.",
    )
  return [codex, ...APP_SERVER_ARGS]
}

/** `codex app-server --listen stdio://` with `codex` found on the absolute entries of `env`'s PATH (the office's
 *  own), as the daemon's tools are.
 *
 *  `OPENCORP_CODEX_BIN` in the office's `environ` names another binary (an absolute path, or a name on that PATH). */
export function codexCommand(
  env: Record<string, string | undefined>,
  environ: Record<string, string | undefined> = process.env,
): string[] {
  const override = environ.OPENCORP_CODEX_BIN
  // `||`, as Python's `or`: an empty override means `codex`.
  return appServerCommand(which(override || "codex", env.PATH) ?? undefined, override)
}

/** The params of every thread load (thread/start, thread/resume): the thread's permission profile and config override
 *  (`codexThread`), and no approval asked, since the profile is the fence. No `sandbox`: Codex refuses one beside a
 *  profile.
 *
 *  `config` values are nested objects, never dotted keys: Codex splits override keys on every dot. */
export function threadLoad(cwd: string, thread: { permissions: string; config: Record<string, unknown> }) {
  return { cwd, approvalPolicy: "never", permissions: thread.permissions, config: thread.config }
}

/** What runs `codex` (found on a PATH, links not yet followed) and the folder it is installed in: the one holding
 *  the `bin` of its native binary, which Codex's sandboxed commands run.
 *
 *  A native binary runs as itself. npm's launcher (`@openai/codex/bin/codex.js`) runs as the native binary it would
 *  start, from its platform package inside its own (as `npm install -g` lays it out) or beside it, since it needs
 *  `node` on a PATH a harness's needn't hold. Any other
 *  script runs as itself, and is installed where its native binary is when a `node_modules` beside it holds exactly
 *  one, else in the folder holding its own folder. */
export function nativeCodex(codex: string): { run: string; install: string } {
  const real = fs.realpathSync(codex)
  const installOf = (binary: string) => path.dirname(path.dirname(binary))
  if (!isScript(real)) return { run: real, install: installOf(real) }
  // npm's launcher is <node_modules>/@openai/codex/bin/codex.js. `npm install -g` puts its platform package inside
  // its own package; a project's `npm install` beside it.
  const pkg = path.dirname(path.dirname(real))
  const launcher = path.basename(real) === "codex.js" && path.basename(pkg) === "codex"
  const scopes = launcher
    ? [path.join(pkg, "node_modules/@openai"), path.dirname(pkg)]
    : [path.join(path.dirname(real), "node_modules/@openai")]
  for (const scope of scopes) {
    const found = nativesIn(scope)
    if (found.length === 1) return { run: launcher ? found[0]! : real, install: installOf(found[0]!) }
  }
  return { run: real, install: installOf(real) }
}

/** Whether `file` starts with `#!`. */
function isScript(file: string): boolean {
  const fd = fs.openSync(file, "r")
  try {
    const head = Buffer.alloc(2)
    return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString() === "#!"
  } finally {
    fs.closeSync(fd)
  }
}

/** The native Codex binaries in `scope` (an `@openai` folder): `codex-<platform>/vendor/<target>/bin/codex`, resolved. */
function nativesIn(scope: string): string[] {
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  }
  return list(scope)
    .filter((pkg) => pkg.startsWith("codex-"))
    .flatMap((pkg) => list(path.join(scope, pkg, "vendor")).map((t) => path.join(scope, pkg, "vendor", t, "bin/codex")))
    .filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile())
    .map((p) => fs.realpathSync(p))
}

/** What `account/read` answers, as far as the sign-in check reads it. */
type Account = { account?: unknown; requiresOpenaiAuth?: unknown } | null

/** What a `CodexProcess` runs and calls. */
export type CodexProcessOptions = {
  command: readonly string[]
  cwd: string
  env: Record<string, string>
  /** The app-server's stderr goes here (codex.log). */
  log: string
  onNotification(method: string, params: unknown): void
  onRequest(id: unknown, method: string, params: unknown): void
  onExit(process: CodexProcess): void
  /** The office's environment (default `process.env`); only `CODEX_HOME` is read. */
  environ?: Record<string, string | undefined>
  /** Where warnings go (default `console.error`); also the `JsonRpc`'s log. Must not throw: `kill()` never rejects
   *  and logs through it. */
  logLine?: (line: string) => void
  /** Records the app-server for the start-up reaper, as `run`'s `track` does: called right after the spawn with the
   *  leader's pid (its group id); the cleanup it returns runs once its exit is seen, or 5 s passed. A `track` that
   *  throws has the group killed, and `start` rejects with its error. */
  track?: (pid: number) => () => void
}

/** One app-server in its own process group, recorded for the start-up reaper through `track`.
 *
 *  `onExit(process)` runs once after its stdout ends, whoever ended it, once the process has exited (or 5 s passed).
 *  The app-server runs with `env` and the office's `CODEX_HOME` (from `environ`) when it is set. */
export class CodexProcess {
  /** The app-server's environment: the given `env`, plus `CODEX_HOME` when the office's environ has it. */
  readonly env: Record<string, string>
  /** Set when the spawn succeeds; null if killed first or never started. */
  proc: ChildProcess | null = null
  rpc: JsonRpc | null = null
  closing = false
  readonly #options: CodexProcessOptions
  readonly #log: (line: string) => void
  #exited: Promise<void> = Promise.resolve()
  #untrack: (() => void) | null = null
  #killed = false
  #killing: Promise<void> | null = null

  constructor(options: CodexProcessOptions) {
    this.#options = options
    this.#log = options.logLine ?? ((line) => console.error(line))
    // Codex finds its config and sign-in through CODEX_HOME when the owner sets one, and ~/.codex otherwise.
    const home = (options.environ ?? process.env).CODEX_HOME
    this.env = home ? { ...options.env, CODEX_HOME: home } : { ...options.env }
  }

  /** The app-server's pid (its group id too); throws before a spawn. */
  get pid(): number {
    const pid = this.proc?.pid
    if (pid === undefined) throw new Error("the app-server hasn't been spawned")
    return pid
  }

  /** Whether it was spawned and its exit hasn't been seen. */
  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null
  }

  /** Spawns, tracks, initializes with `experimentalApi`, and checks the sign-in; resolves with initialize's result.
   *
   *  Rejects with `CodexStartError` (or `CodexSignedOut`): a command that can't be run says to run `opencorp doctor`,
   *  and a failed handshake also names the log, where Codex's output is; an error from `track` is rethrown as is,
   *  after the group is killed. Nothing is left running or tracked.
   *  A process already killed never spawns. */
  async start(): Promise<unknown> {
    const { command, cwd, log } = this.#options
    fs.mkdirSync(path.dirname(log), { recursive: true })
    if (this.closing) throw new CodexStartError(STOPPED)
    let fd: number | undefined
    let proc: ChildProcess
    try {
      const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants
      fd = fs.openSync(log, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
      proc = spawn(command[0]!, command.slice(1), { cwd, env: this.env, detached: true, stdio: ["pipe", "pipe", fd] })
    } catch (error) {
      throw this.#cantStart(error)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
    // Attached in the spawn's tick: a failed spawn reports itself only through this event.
    const failed = new Promise<unknown>((resolve) => proc.once("error", resolve))
    const pid = proc.pid
    if (pid === undefined) throw this.#cantStart(await failed)
    // Everything up to rpc.start() stays in this tick, so a kill sees the process and stdin has its error listener
    // before any write can fail.
    this.proc = proc
    this.#exited = new Promise((resolve) => proc.once("exit", () => resolve()))
    try {
      this.#untrack = this.#options.track?.(pid) ?? null
    } catch (error) {
      // Nothing was tracked, so there is nothing to untrack; only the process must not outlive the failed start.
      this.#signal()
      proc.stdout?.destroy()
      throw error
    }
    const options = this.#options
    const rpc = (this.rpc = new JsonRpc(proc.stdin!, proc.stdout!, {
      onNotification: (method, params) => options.onNotification(method, params),
      onRequest: (id, method, params) => options.onRequest(id, method, params),
      onClosed: () => void this.#closed(),
      kill: () => this.#signal(),
      log: this.#log,
    }))
    rpc.start()
    let result: unknown
    let account: Account
    try {
      result = await rpc.request(
        "initialize",
        {
          clientInfo: { name: "opencorp", title: "OpenCorp", version: VERSION },
          capabilities: { experimentalApi: true },
        },
        { timeout: START_TIMEOUT_MS },
      )
      await rpc.notify("initialized")
      account = (await rpc.request("account/read", { refreshToken: false }, { timeout: START_TIMEOUT_MS })) as Account
    } catch (error) {
      // The rpc rejects only with RpcError, RpcClosed or a TimeoutError.
      const stopped = this.closing // an office stop killed it mid-handshake
      await this.kill()
      if (stopped) throw new CodexStartError(STOPPED, { cause: error })
      throw this.startError(error as Error)
    }
    if (account?.account == null && account?.requiresOpenaiAuth) {
      await this.kill()
      throw new CodexSignedOut("Codex is signed out. Run `codex login` in a terminal, then send your message again.")
    }
    return result
  }

  /** Closes stdin, gives it `graceMs`, then kills the group (its command children too) and untracks it. */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.closing = true
    const stdin = this.proc?.stdin
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end()
    if (this.proc) await this.#waitExit(graceMs)
    await this.kill()
  }

  /** Kills the group now (the app-server may leave command children) and runs its own `track` cleanup.
   *
   *  Safe more than once and before `start`: a process killed first never spawns. Every call resolves when the first
   *  one's work is done (the exit seen, or 5 s passed, then the cleanup run); it never rejects. */
  kill(): Promise<void> {
    this.closing = true
    return (this.#killing ??= this.#killOnce())
  }

  /** The error for an app-server that failed or died while starting: what went wrong, to run `opencorp doctor`, and
   *  where Codex's output (its stderr, with the reason) is. */
  startError(error: Error): CodexStartError {
    return new CodexStartError(
      `Codex didn't start: ${error.message}. Run \`opencorp doctor\` to check it; Codex's output is in ` +
        `${this.#options.log}.`,
      { cause: error },
    )
  }

  #cantStart(error: unknown): CodexStartError {
    const message = error instanceof Error ? error.message : String(error)
    return new CodexStartError(`Codex couldn't start: ${message}. Run \`opencorp doctor\` to check it.`, {
      cause: error,
    })
  }

  /** SIGKILLs the group and destroys stdin, once. Synchronous and never throws, as the rpc's `kill`; leaves `closing`
   *  alone, since a line over the cap is a protocol failure, not an office stop. */
  #signal(): void {
    const proc = this.proc
    if (proc?.pid === undefined || this.#killed) return
    // Only the first kill signals the group: once it is gone its id can belong to another group.
    this.#killed = true
    killGroup(proc.pid)
    proc.stdin?.destroy()
  }

  async #killOnce(): Promise<void> {
    const untrack = this.#untrack
    this.#untrack = null
    const proc = this.proc
    this.#signal()
    if (proc?.pid === undefined) return
    const pid = proc.pid
    if (!(await this.#waitExit(EXIT_WAIT_MS))) this.#log(`codex app-server ${pid} outlived SIGKILL`)
    if (untrack === null) return
    try {
      untrack()
    } catch (error) {
      this.#log(`codex: couldn't forget app-server ${pid}'s record (${nameOf(error)})`)
    }
  }

  /** Resolves true once the process has exited, false after `ms`. */
  async #waitExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))
    try {
      return await Promise.race([this.#exited.then(() => true), late])
    } finally {
      clearTimeout(timer)
    }
  }

  async #closed(): Promise<void> {
    this.proc?.stdout?.destroy() // the reader has finished with it
    await this.#waitExit(EXIT_WAIT_MS)
    try {
      this.#options.onExit(this)
    } catch (error) {
      this.#log(`codex: the exit handler failed (${nameOf(error)})`)
    }
  }
}

/** One `codex app-server --listen stdio://`: its command, owner-load params, process group and worker record. */
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { HarnessPolicy } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import { which } from "../install/launch.ts"
import { killGroup, startTime } from "../install/proc.ts"
import type { Store } from "../store/store.ts"
import { JsonRpc, RpcClosed, RpcError } from "./rpc.ts"

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

/** The params of every owner load (thread/start, thread/resume): the person's sandbox and network, and approvals
 *  that always come to the office's cards whatever the owner's config.toml says.
 *
 *  `config` values are nested objects, never dotted keys: Codex splits override keys on every dot. */
export function ownerLoad(cwd: string, policy: HarnessPolicy | null) {
  return {
    cwd,
    sandbox: policy?.sandbox ?? "read-only",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    config: { sandbox_workspace_write: { network_access: Boolean(policy?.network) } },
  }
}

/** `error`'s `name`: what a log line says of a failure, since its message can quote a secret. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

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
  /** Where warnings go (default `console.error`); also the `JsonRpc`'s log. */
  logLine?: (line: string) => void
}

/** One app-server in its own process group, recorded in the store's workers under `key` for `reap`.
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
  readonly #store: Store
  readonly #key: string
  readonly #options: CodexProcessOptions
  readonly #log: (line: string) => void
  #exited: Promise<void> = Promise.resolve()
  #recorded = false
  #killed = false
  #killing: Promise<void> | null = null

  constructor(store: Store, key: string, options: CodexProcessOptions) {
    this.#store = store
    this.#key = key
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

  /** Spawns, records, initializes with `experimentalApi`, and checks the sign-in; resolves with initialize's result.
   *
   *  Rejects with `CodexStartError` (or `CodexSignedOut`): a command that can't be run says to run `opencorp doctor`,
   *  and a failed handshake also names the log, where Codex's output is. Nothing is left running or recorded.
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
    // A 0 start time never matches a process, so the reaper never signals such a row.
    this.#store.recordWorker(this.#key, { pid, pgid: pid, startTime: startTime(pid) ?? 0 })
    this.#recorded = true
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
    let account: { account?: unknown; requiresOpenaiAuth?: unknown } | null | undefined
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
      const read = await rpc.request("account/read", { refreshToken: false }, { timeout: START_TIMEOUT_MS })
      account = read as typeof account
    } catch (error) {
      const known =
        error instanceof RpcError || error instanceof RpcClosed || (error as Error | null)?.name === "TimeoutError"
      const stopped = this.closing // an office stop killed it mid-handshake
      await this.kill()
      if (!known) throw error
      if (stopped) throw new CodexStartError(STOPPED, { cause: error })
      throw this.startError(error as Error)
    }
    if (account?.account == null && account?.requiresOpenaiAuth) {
      await this.kill()
      throw new CodexSignedOut("Codex is signed out. Run `codex login` in a terminal, then send your message again.")
    }
    return result
  }

  /** Closes stdin, gives it `graceMs`, then kills the group (its command children too) and forgets the record. */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.closing = true
    const stdin = this.proc?.stdin
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end()
    if (this.proc) await this.#waitExit(graceMs)
    await this.kill()
  }

  /** Kills the group now (the app-server may leave command children) and forgets its own record.
   *
   *  Safe more than once and before `start`: a process killed first never spawns. Every call resolves when the first
   *  one's work is done (the exit seen, or 5 s passed, then the record removed); it never rejects. */
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
    try {
      proc.stdin?.destroy()
    } catch {}
  }

  async #killOnce(): Promise<void> {
    const recorded = this.#recorded
    this.#recorded = false
    const proc = this.proc
    this.#signal()
    if (proc?.pid === undefined) return
    const pid = proc.pid
    if (!(await this.#waitExit(EXIT_WAIT_MS))) this.#log(`codex app-server ${pid} outlived SIGKILL`)
    if (!recorded) return
    // Only its own record: a later app-server of the same session has the same key.
    try {
      this.#store.removeWorker(this.#key, pid)
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

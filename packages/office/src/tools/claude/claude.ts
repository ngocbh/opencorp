/** One Claude Code CLI over its stream-json stdio (`claude --input-format stream-json --output-format stream-json`),
 *  as the Agent SDK runs it but driven directly: its command line, its start, the version and sign-in checks of its
 *  `initialize`, messages, interrupts, the requests it sends, and its process group.
 *
 *  **Claude Code just runs as Claude Code**, as the owner, with its own login (`~/.claude`, or the Keychain on macOS)
 *  and no sandbox of the office's around it. The employee's permission reaches it as its own settings
 *  (`claudeStart`), which its sandbox enforces on its commands, and its permission rules on its own file tools. What
 *  it would otherwise run as the owner outside that sandbox is off: no settings file loads (`--setting-sources=`, so
 *  no hooks, plugins, MCP servers, skills or CLAUDE.md from the owner's or the project's settings), no MCP server but
 *  the ones the command line names (`--strict-mcp-config`, and it names none), no plugin directory, and hooks off in
 *  the flag settings. Only the tools the office allows are on (`--tools`, `CLAUDE_TOOLS`). It asks nothing
 *  (`--permission-mode=acceptEdits` with the sandbox's auto-allow, and `--permission-prompts=none`): what would ask
 *  is refused, and so is any request it sends the office. */
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type EmployeePermission, claudeStart } from "../../runtime/sandbox/harness_profile.ts"
import { which } from "../../util/env.ts"
import { killGroup } from "../../util/proc.ts"
import { claudeInstructions, writeInstructions } from "./instructions.ts"
import { type Msg, StreamJson, isObj, nameOf } from "./stream.ts"

/** The oldest Claude Code the office runs. 2.1.323 stops a start whose sandbox settings don't validate, rather than
 *  running unsandboxed, and 2.1.325 fixed a Linux `bwrap: Can't create file` failure when the working folder lies
 *  under an `allowRead` inside a `denyRead`, as an employee's permission lays it out. */
export const CLAUDE_FLOOR = "2.1.325"

/** The only tools Claude Code has in an employee's session (`--tools`): its file tools, Bash, and TaskStop and
 *  ToolSearch, which act on nothing outside it. The rest are off: they act on the owner's claude.ai account
 *  (RemoteTrigger, DesignSync, PushNotification, and the skills that drive them), reach outside the sandbox (Monitor's
 *  WebSocket), or keep running after the turn (Task, Workflow, the Cron tools, ScheduleWakeup). */
export const CLAUDE_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
  "TaskStop",
  "ToolSearch",
] as const

/** Whether Claude Code can't run commands in a folder its employee may only read on `platform`: on Linux its sandbox
 *  makes a `.gitconfig` in the working folder for each command, which a read-only folder refuses, so every Bash
 *  command fails (`bwrap: Can't create file at <folder>/.gitconfig: Read-only file system`, O5). macOS's isn't known
 *  to. */
export function readOnlyFails(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux"
}

/** What to do about it, for an employee who uses Claude Code with a folder they may only read. */
export const READ_ONLY_FIX =
  "on Linux Claude Code's sandbox fails every command in a folder its employee may only read; the owner makes their " +
  "harness_policy sandbox workspace-write, or they use Codex for read-only work"

/** How the office talks to Claude Code: stream-json both ways, every message written out. */
export const STREAM_ARGS = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"] as const

/** Milliseconds `initialize` has to answer. */
export const START_TIMEOUT_MS = 30_000
/** Milliseconds Claude Code has to exit after stdin closes, before it is stopped. */
export const CLOSE_GRACE_MS = 5_000
/** Milliseconds an `interrupt` has to answer. */
const CONTROL_TIMEOUT_MS = 30_000
/** Milliseconds Claude Code has, after SIGTERM, to stop its commands' process trees and exit, before its group is
 *  killed. */
const TERM_WAIT_MS = 3_000
/** Milliseconds a killed Claude Code has to be seen exiting. */
const EXIT_WAIT_MS = 5_000
/** The `startup_failure_reason` of the `result` Claude Code writes in place of `initialize`'s answer when its sandbox
 *  can't run and `failIfUnavailable` stops the start (O5); it then waits on stdin, answering nothing. */
const SANDBOX_UNAVAILABLE = "sandbox_required_unavailable"
const STOPPED = "Claude Code was stopped before it started."
const UPDATE =
  "update it with `claude update` (or `brew upgrade claude-code`, or " +
  "`npm install -g @anthropic-ai/claude-code@latest`), then run `opencorp doctor`"
/** What a tool's permission request is told: nobody answers here. */
const DENIED =
  "Nobody can approve this here: this session runs only what the employee's permission allows. Don't ask again."

/** Claude Code stopped its own start, as a `result` naming `startup_failure_reason` says. */
class StartupFailure extends Error {
  override name = "StartupFailure"

  constructor(readonly reason: string) {
    // The reason is Claude Code's identifier: only its word characters are kept.
    super(`it stopped its start (${reason.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "no reason given"})`)
  }
}

/** Claude Code couldn't be run, didn't start, or refused the start. The message says what went wrong and what to
 *  do; it never holds Claude Code's own output, which stays in the session's log. */
export class ClaudeStartError extends Error {
  override name = "ClaudeStartError"
}

/** No `claude` on the office's PATH, or `OPENCORP_CLAUDE_BIN` names none. */
export class ClaudeMissing extends ClaudeStartError {
  override name = "ClaudeMissing"
}

/** Claude Code runs, but nobody is signed in. */
export class ClaudeSignedOut extends ClaudeStartError {
  override name = "ClaudeSignedOut"
}

/** Claude Code is older than `CLAUDE_FLOOR`, or doesn't say its version. */
export class ClaudeTooOld extends ClaudeStartError {
  override name = "ClaudeTooOld"
}

/** Claude Code's sandbox can't start on this machine, so it refused to start (`sandbox.failIfUnavailable`): what
 *  holds an employee's commands to their permission isn't there. */
export class ClaudeSandboxUnavailable extends ClaudeStartError {
  override name = "ClaudeSandboxUnavailable"
}

/** The `claude` the office runs: `OPENCORP_CLAUDE_BIN` in the office's `environ` when set (an absolute path, or a name
 *  on `env.PATH`), else `claude` on the absolute entries of `env.PATH`; `ClaudeMissing` when there is none. An empty
 *  override means `claude`; a missing one never falls back to it. */
export function claudeCommand(
  env: Record<string, string | undefined>,
  environ: Record<string, string | undefined> = process.env,
): string {
  const override = environ.OPENCORP_CLAUDE_BIN
  const found = which(override || "claude", env.PATH)
  if (found !== null) return found
  if (override) {
    throw new ClaudeMissing(
      `OPENCORP_CLAUDE_BIN names ${override}, which isn't an executable the office can find; ` +
        "fix or unset it, then run `opencorp doctor`.",
    )
  }
  throw new ClaudeMissing(
    "Claude Code isn't installed where the office can find it (on its PATH). Install it " +
      "(https://code.claude.com/docs/en/setup), sign in by running `claude`, then run `opencorp doctor`.",
  )
}

/** What runs `claude` (found on a PATH, links not yet followed), and the folder it is installed in: its real file, and
 *  that file's folder. The native installer's `~/.local/bin/claude` links to `~/.local/share/claude/versions/<v>`,
 *  and npm links the same native binary into its package, so neither needs `node` on the harness PATH; a script runs
 *  as itself. */
export function nativeClaude(claude: string): { run: string; install: string } {
  const real = fs.realpathSync(claude)
  return { run: real, install: path.dirname(real) }
}

/** Claude Code's arguments for one session under an employee's permission (`claudeStart`'s `settings` and
 *  `addDirs`): no settings file, no MCP server but none, edits accepted with nothing asked, and the settings inline
 *  (a settings file would sit where its commands could change it, and Claude Code applies a changed file at once).
 *  `sessionId` starts a session with that id, `resume` goes on with one; `model` overrides Claude Code's default;
 *  `persist: false` keeps no session on disk; `instructions` is a file of system prompt text to append
 *  (`writeInstructions`), the CLAUDE.md files no settings source loads. */
export function claudeArgs(
  start: { settings: Record<string, unknown>; addDirs: readonly string[] },
  {
    sessionId,
    resume,
    model,
    persist = true,
    instructions,
  }: { sessionId?: string; resume?: string; model?: string; persist?: boolean; instructions?: string } = {},
): string[] {
  if (sessionId !== undefined && resume !== undefined) {
    throw new Error("a Claude Code session is either new or resumed")
  }
  return [
    ...STREAM_ARGS,
    "--setting-sources=",
    "--strict-mcp-config",
    "--permission-mode=acceptEdits",
    "--permission-prompts=none",
    `--tools=${CLAUDE_TOOLS.join(",")}`,
    "--settings",
    JSON.stringify(start.settings),
    ...start.addDirs.map((dir) => `--add-dir=${dir}`),
    ...(sessionId === undefined ? [] : [`--session-id=${sessionId}`]),
    ...(resume === undefined ? [] : [`--resume=${resume}`]),
    ...(model === undefined ? [] : [`--model=${model}`]),
    ...(persist ? [] : ["--no-session-persistence"]),
    ...(instructions === undefined ? [] : [`--append-system-prompt-file=${instructions}`]),
  ]
}

/** What a session under employee permission `p` runs: `claude`, with `claudeArgs` of `claudeStart(p)` and, when
 *  there are any, the office's own words for the session (`prompt`) and then the owner's and the project's
 *  instructions (`claudeInstructions`, from `configDir`, Claude Code's config folder), written to
 *  `opencorp.instructions.md` in the session's own temp folder (fresh, private and the user's, as `claudeStart`
 *  checked it; the file 0600) for `--append-system-prompt-file`; and its environment. The file goes when the temp
 *  folder does, and the process removes it once Claude Code exits (`instructions`). Throws as `claudeStart` does. */
export function claudeSession(
  p: EmployeePermission,
  {
    claude,
    configDir,
    prompt,
    ...rest
  }: { claude: string; configDir: string; prompt?: string; sessionId?: string; resume?: string; model?: string },
): { command: string[]; env: Record<string, string>; instructions: string | null } {
  const start = claudeStart(p)
  const found = claudeInstructions({ configDir, workspace: p.workspace, gitRoot: p.gitRoot })
  const parts = [prompt === undefined ? null : `${prompt.trim()}\n`, found].filter((t): t is string => t !== null)
  const text = parts.length === 0 ? null : parts.join("\n")
  const instructions = text === null ? null : writeInstructions(start.env.TMPDIR!, "opencorp", text)
  const args = claudeArgs(start, { ...rest, ...(instructions === null ? {} : { instructions }) })
  return { command: [claude, ...args], env: start.env, instructions }
}

/** The tools a turn's `system`/`init` line lists beyond `CLAUDE_TOOLS`, MCP tools among them; a list that isn't
 *  one counts as one such tool, since what it holds can't be checked. Empty when the session has only those. */
export function toolsBeyond(init: Msg): string[] {
  if (!Array.isArray(init.tools)) return ["(its tools, which it didn't list)"]
  const allowed = new Set<unknown>(CLAUDE_TOOLS)
  return init.tools.filter((tool) => !allowed.has(tool)).map((tool) => String(tool).slice(0, 100))
}

/** Whether `initialize`'s `account` (Claude Code's `AccountInfo`) has a sign-in: a token from a login, or an API
 *  key. Signed out, Claude Code reports `tokenSource: "none"` and no key source. */
export function signedIn(account: unknown): boolean {
  if (!isObj(account)) return false
  return account.tokenSource !== "none" || account.apiKeySource !== undefined
}

/** What the office answers a control request Claude Code sends it: a tool's permission is denied, since nobody
 *  answers here (decided by the settings and the mode, which ask nothing), and any other request (a hook callback, an
 *  MCP message, an elicitation), which the office never registered for, is refused. */
export function refusal(request: Msg): { response: Msg } | { error: string } {
  if (request.subtype === "can_use_tool") return { response: { behavior: "deny", message: DENIED } }
  return { error: `the office serves no ${String(request.subtype).slice(0, 100)} request` }
}

/** Whether `version` (`X.Y.Z`, perhaps with more after) comes before `floor`; true when it can't be read. */
export function olderThan(version: string, floor: string = CLAUDE_FLOOR): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null
  const got = parse(version)
  const want = parse(floor)!
  if (got === null) return true
  const at = got.findIndex((n, i) => n !== want[i])
  return at !== -1 && got[at]! < want[at]!
}

/** What a `ClaudeProcess` runs and calls. */
export type ClaudeProcessOptions = {
  /** `claude` and its arguments (`claudeArgs`). */
  command: readonly string[]
  /** The session's folder, Claude Code's working folder. */
  cwd: string
  /** Its environment: the worker's, with `claudeStart`'s fixed variables. */
  env: Record<string, string>
  /** Claude Code's stderr goes here (opened without following a link, 0600). */
  log: string
  /** The office's environment (default `process.env`); only `CLAUDE_CONFIG_DIR` is read. */
  environ?: Record<string, string | undefined>
  /** Every line Claude Code writes but the control messages, in order. Must hand work off rather than block. */
  onMessage(msg: Msg): void
  onExit(process: ClaudeProcess): void
  /** Where warnings go (default `console.error`). Must not throw. */
  logLine?: (line: string) => void
  /** Records the process for the start-up reaper: called right after the spawn with the leader's pid (its group
   *  id); the cleanup it returns runs once its exit is seen, or 5 s passed. A `track` that throws has the group
   *  killed, and `start` rejects with its error. */
  track?: (pid: number) => () => void
  /** The instructions file its start wrote (`claudeSession`), removed once it exits, or when it never starts. */
  instructions?: string | null
}

/** One Claude Code in its own process group, recorded for the start-up reaper through `track`.
 *
 *  `onExit(process)` runs once after its stdout ends, whoever ended it, once the process has exited (or 5 s passed). */
export class ClaudeProcess {
  /** Its environment: the given `env`, plus `CLAUDE_CONFIG_DIR` when the office's environ has it. */
  readonly env: Record<string, string>
  /** Set when the spawn succeeds; null if killed first or never started. */
  proc: ChildProcess | null = null
  stream: StreamJson | null = null
  closing = false
  readonly #options: ClaudeProcessOptions
  readonly #log: (line: string) => void
  #exited: Promise<void> = Promise.resolve()
  #untrack: (() => void) | null = null
  #killed = false
  #killing: Promise<void> | null = null
  /** Rejects the start with the reason a `result` gave for stopping it, until `initialize` is answered. */
  #stopsStart: ((reason: string) => void) | null = null

  constructor(options: ClaudeProcessOptions) {
    this.#options = options
    this.#log = options.logLine ?? ((line) => console.error(line))
    // Claude Code finds its config and sign-in through CLAUDE_CONFIG_DIR when the owner sets one, else ~/.claude.
    const config = (options.environ ?? process.env).CLAUDE_CONFIG_DIR
    this.env = config ? { ...options.env, CLAUDE_CONFIG_DIR: config } : { ...options.env }
  }

  /** Its pid (its group id too); throws before a spawn. */
  get pid(): number {
    const pid = this.proc?.pid
    if (pid === undefined) throw new Error("Claude Code hasn't been spawned")
    return pid
  }

  /** Whether it was spawned and its exit hasn't been seen. */
  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null
  }

  /** Spawns, tracks, and sends `initialize` (registering no hook, and sending no message, so no model call runs);
   *  resolves with its answer once Claude Code is at least `CLAUDE_FLOOR` and signed in.
   *
   *  Rejects with `ClaudeStartError`: `ClaudeTooOld`, `ClaudeSignedOut`, `ClaudeSandboxUnavailable` at once when a
   *  `result` in place of `initialize`'s answer says its sandbox stops the start (`startup_failure_reason`), and
   *  otherwise words that say to run `opencorp doctor` and name the log; an error from `track` is rethrown as is. Nothing is left running or tracked. A process killed first never spawns. */
  async start(): Promise<Msg> {
    const { command, cwd, log } = this.#options
    fs.mkdirSync(path.dirname(log), { recursive: true })
    if (this.closing) throw new ClaudeStartError(STOPPED)
    let fd: number | undefined
    let proc: ChildProcess
    try {
      const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants
      fd = fs.openSync(log, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
      proc = spawn(command[0]!, command.slice(1), { cwd, env: this.env, detached: true, stdio: ["pipe", "pipe", fd] })
    } catch (error) {
      this.#forget()
      throw this.#cantStart(error)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
    // Attached in the spawn's tick: a failed spawn reports itself only through this event.
    const failed = new Promise<unknown>((resolve) => proc.once("error", resolve))
    const pid = proc.pid
    if (pid === undefined) {
      this.#forget()
      throw this.#cantStart(await failed)
    }
    this.proc = proc
    this.#exited = new Promise((resolve) => proc.once("exit", () => resolve()))
    try {
      this.#untrack = this.#options.track?.(pid) ?? null
    } catch (error) {
      this.#signal()
      proc.stdout?.destroy()
      throw error
    }
    const options = this.#options
    const stopped = new Promise<never>((_, reject) => {
      this.#stopsStart = (reason) => reject(new StartupFailure(reason))
    })
    stopped.catch(() => {}) // rejected only while the start waits on it
    const stream = (this.stream = new StreamJson(proc.stdin!, proc.stdout!, {
      onMessage: (msg) => {
        if (this.#stopsStart !== null && msg.type === "result" && typeof msg.startup_failure_reason === "string") {
          return this.#stopsStart(msg.startup_failure_reason)
        }
        options.onMessage(msg)
      },
      onRequest: (id, request) => this.#refuse(id, request),
      onClosed: () => void this.#closed(),
      kill: () => this.#signal(),
      log: this.#log,
    }))
    stream.start()
    let init: Msg
    try {
      init = await Promise.race([stream.request("initialize", {}, { timeout: START_TIMEOUT_MS }), stopped])
    } catch (error) {
      const killed = this.closing // an office stop killed it mid-start
      await this.kill()
      if (killed) throw new ClaudeStartError(STOPPED, { cause: error })
      throw this.#startError(error as Error)
    } finally {
      this.#stopsStart = null
    }
    const version = typeof init.claude_code_version === "string" ? init.claude_code_version : null
    if (version === null || olderThan(version)) {
      await this.kill()
      const which = version === null ? "doesn't say its version" : `is ${JSON.stringify(version).slice(0, 40)}`
      throw new ClaudeTooOld(`Claude Code ${which}, and OpenCorp needs ${CLAUDE_FLOOR} or later; ${UPDATE}.`)
    }
    if (!signedIn(init.account)) {
      await this.kill()
      throw new ClaudeSignedOut(
        "Claude Code is signed out. Run `claude` in a terminal and sign in with `/login`, then send your message " +
          "again.",
      )
    }
    return init
  }

  /** Sends `text` as a user message, delivered as written: no `/command` runs and no `@path` is read from it
   *  (`client_composed`). `priority` says when a message sent mid-turn reaches Claude; `uuid` is its id (a fresh one
   *  by default), which a sender names to follow its lifecycle from before it is written. Resolves with its uuid once
   *  written. */
  async send(
    text: string,
    { priority, uuid = randomUUID() }: { priority?: "now" | "next" | "later"; uuid?: string } = {},
  ): Promise<string> {
    await this.#stream().send({
      type: "user",
      uuid,
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      client_composed: true,
      ...(priority === undefined ? {} : { priority }),
    })
    return uuid
  }

  /** Stops the running turn; resolves with Claude Code's answer (`still_queued`, the messages that wait). With
   *  `cancelQueued` (Claude Code 2.1.219 and later, `interrupt_cancel_queued_v1`), the messages sent that no turn has
   *  started are cancelled too, none of them runs, and the answer lists them under `cancelled`. */
  interrupt({ cancelQueued = false }: { cancelQueued?: boolean } = {}): Promise<Msg> {
    const body = cancelQueued ? { cancel_queued: true } : {}
    return this.#stream().request("interrupt", body, { timeout: CONTROL_TIMEOUT_MS })
  }

  /** Closes stdin, gives it `graceMs`, then stops it (`kill`). */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.closing = true
    const stdin = this.proc?.stdin
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end()
    if (this.proc) await this.#waitExit(graceMs)
    await this.kill()
  }

  /** Stops it: SIGTERM first, on which Claude Code ends its running commands' process trees and exits, then the
   *  whole group killed, and its own `track` cleanup run.
   *
   *  Safe more than once and before `start`: a process killed first never spawns. Every call resolves when the first
   *  one's work is done; it never rejects. */
  kill(): Promise<void> {
    this.closing = true
    return (this.#killing ??= this.#killOnce())
  }

  #stream(): StreamJson {
    if (this.stream === null) throw new ClaudeStartError("Claude Code hasn't started")
    return this.stream
  }

  /** Answers Claude Code's own control request at once (`refusal`), and logs which it was. */
  #refuse(id: string, request: Msg): void {
    const answer = refusal(request)
    this.#log(`claude: refused Claude Code's ${String(request.subtype).slice(0, 100)} request`)
    const sent = "response" in answer ? this.stream!.answer(id, answer.response) : this.stream!.refuse(id, answer.error)
    sent.catch(() => this.#log("claude: couldn't answer a request: Claude Code's stdin is closed"))
  }

  /** The error for a Claude Code that failed or died while starting: its sandbox, when its result's
   *  `startup_failure_reason` says so, another reason named, or else what went wrong; each says to run `opencorp
   *  doctor` and where its output is. */
  #startError(error: Error): ClaudeStartError {
    const { log } = this.#options
    if (error instanceof StartupFailure && error.reason === SANDBOX_UNAVAILABLE) {
      return new ClaudeSandboxUnavailable(
        "Claude Code's sandbox can't start on this machine, and Claude Code runs here only inside it, since it holds " +
          "your employee's commands to their permission. On Linux, install bubblewrap and socat (for example " +
          "`sudo apt-get install bubblewrap socat`, or `sudo dnf install bubblewrap socat`) and allow unprivileged " +
          `user namespaces; then run \`opencorp doctor\`. Claude Code's output is in ${log}.`,
        { cause: error },
      )
    }
    return new ClaudeStartError(
      `Claude Code didn't start: ${error.message}. Run \`opencorp doctor\` to check it; Claude Code's output is in ` +
        `${log}.`,
      { cause: error },
    )
  }

  #cantStart(error: unknown): ClaudeStartError {
    const message = error instanceof Error ? error.message : String(error)
    return new ClaudeStartError(`Claude Code couldn't start: ${message}. Run \`opencorp doctor\` to check it.`, {
      cause: error,
    })
  }

  /** SIGKILLs the group and destroys stdin, once. Synchronous and never throws. */
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
    if (proc?.pid === undefined) return
    const pid = proc.pid
    if (this.alive && !this.#killed) {
      try {
        proc.kill("SIGTERM")
      } catch {
        // It exited already.
      }
      await this.#waitExit(TERM_WAIT_MS)
    }
    this.#signal()
    if (!(await this.#waitExit(EXIT_WAIT_MS))) this.#log(`claude: Claude Code ${pid} outlived SIGKILL`)
    this.#forget()
    if (untrack === null) return
    try {
      untrack()
    } catch (error) {
      this.#log(`claude: couldn't forget Claude Code ${pid}'s record (${nameOf(error)})`)
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

  /** Removes the instructions file, if this start had one. */
  #forget(): void {
    const file = this.#options.instructions
    if (file === null || file === undefined) return
    try {
      fs.rmSync(file, { force: true })
    } catch (error) {
      this.#log(`claude: the instructions file wasn't removed (${nameOf(error)})`)
    }
  }

  async #closed(): Promise<void> {
    this.proc?.stdout?.destroy() // the reader has finished with it
    await this.#waitExit(EXIT_WAIT_MS)
    this.#forget()
    try {
      this.#options.onExit(this)
    } catch (error) {
      this.#log(`claude: the exit handler failed (${nameOf(error)})`)
    }
  }
}

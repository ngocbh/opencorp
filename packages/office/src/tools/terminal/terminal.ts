/** The terminal tool group: one session's shells, by name, as its host binds them. The agent runs commands, types
 *  into a running one, reads, interrupts its own command and closes a shell; it sets none of the shells' trust.
 *
 *  **The host binds the trust**: the shells' sandbox, the session's permissions and who drives. The gate reads the
 *  profile the shells run in from their sandbox, never from the model or the host's `where()`: `workspace` only for
 *  shells in a workspace's sandbox, with its folder and what it may write; `ssh` for the SSH-only profile, with the
 *  credentials it binds marked, and for shells with no sandbox, so that nothing about them is taken on trust. A PTY
 *  shell's folder is where its last command left it, as the shell reports it (`PtyShell.cwd`), a home as `~`, or
 *  unknown; a pipes shell's is always the workspace, since each command starts there.
 *
 *  **Every command and every typed line goes through the session's permissions** (`gate`): the mode, the rules, the
 *  reader and Auto's check, as the workspace's shell does. A typed line is decided whole: the shell's unfinished line
 *  with the new text, `partial` without Enter, `into` the command it is typed into. So `sca` then `ncel 42` is
 *  decided as `scancel 42`, never as two harmless pieces. What asks is held on the host's card (its `pending()`), and
 *  the host runs it once the owner says Yes (`runApproved`). The tools' own refusals come first and hold nothing: a
 *  command or line a shell can't take, a shell not ready for it, a secret prompt, the owner part-way through a line,
 *  and typed text in a pipes shell.
 *
 *  **No authority from the agent.** No argument approves a call or widens what it may do; only the host's
 *  `runApproved` runs a held call, and the agent's `why` reaches the card, never Auto's check.
 *
 *  **Waits.** A reply waits at most two minutes; a held call waits for its card instead. Each call's wait and gate
 *  end with the call's signal and with `interruptWaits`, and a call stopped in its gate types nothing. Calls on one
 *  shell queue; calls on different shells run together. */
import {
  type Action, type CheckInput, type Gate, gate, type Permissions, type Where,
} from "../../runtime/permissions/policy.ts"
import fs from "node:fs"
import { SandboxPolicy } from "../../runtime/sandbox/policy.ts"
import { type Result, type RunOptions, SandboxUnavailable } from "../../runtime/sandbox/run.ts"
import { SshPolicy } from "../../runtime/sandbox/ssh_policy.ts"
import { PipeShell } from "./pipes.ts"
import { PtyShell, type Reply, type ShellHost, shellKind, type ShellState } from "./shell.ts"
import { cardArgs, type Parsed, parseArgs, refusalText, replyText, type ToolName, TOOLS, toolSpecs } from "./tools.ts"

/** How a terminal's shells run: on PTYs, in `sandbox` (null: none, which only the owner allows); or as the
 *  workspace's pipes, each command its own call in the workspace's sandbox. The sandbox is the one the host starts
 *  them in, and it decides the profile the gate reads. */
export type TerminalShells =
  | {
      readonly kind: "pty"
      readonly sandbox: SandboxPolicy | SshPolicy | null
      /** Starts argv on a PTY in `sandbox`: `startOnTerminal`, or `spawnPty` when there is none. */
      readonly start: ShellHost["start"]
      /** A shell's environment (`ShellHost.env`). */
      readonly env: Record<string, string>
      /** Which shell; by default bash where `/bin/bash` exists. */
      readonly shell?: "bash" | "sh"
    }
  | {
      readonly kind: "pipes"
      readonly sandbox: SandboxPolicy
      /** Runs one command's argv in `sandbox`: `run` from runtime/sandbox, with the host's tracking. */
      run(argv: readonly string[], options: RunOptions): Promise<Result>
    }

/** The sandbox a terminal's shells run in, as an instrument and its record name it. */
export type TerminalProfile = "workspace" | "ssh" | "none"

/** What the host binds for one new shell: its id, its record, and where its state and live output go. */
export interface ShellBinding extends Pick<ShellHost, "record" | "changed" | "output"> {
  readonly id: string
}

/** What a terminal's host binds; the model sets none of it. */
export interface TerminalHost {
  readonly shells: TerminalShells
  /** Who drives: the agent's handle, or "opencorp". */
  readonly driver: string
  readonly permissions: Permissions
  /** Binds new shell `name`, which runs in `profile`. */
  shellHost(name: string, profile: TerminalProfile): ShellBinding
}

export type TerminalShell = PtyShell | PipeShell

/** A tool as the model calls it: an `OfficeTool`, declared here by its shape. `callId` is the yian call's, which a
 *  held call's card names; `signal` stops the call. */
export interface TerminalTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(
    args: Record<string, unknown>,
    options?: { readonly callId?: string; readonly signal?: AbortSignal },
  ): Promise<unknown>
}

/** What a call returns when its stop came after its gate let it run, before it started. */
const STOPPED = "Not run: stopped before it started."
const CLOSED = "this terminal has closed"
/** What a typed line is refused with when the shell moved on while it was checked, or since it was approved. */
const MOVED =
  "the shell moved on while this line was checked: its unfinished line or its running command changed; read it, " +
  "then type again"
const MOVED_SINCE =
  "the shell has moved on since this line was approved: its unfinished line or its running command changed; read " +
  "it, then type again"
/** What a start failure for want of a sandbox adds, so the agent can tell the owner what to fix. */
const SANDBOX_FIX =
  "the shell needs a sandbox: on Linux, install bubblewrap (bwrap) and allow unprivileged user namespaces; on " +
  "macOS, sandbox-exec comes with the system"
const STARTING: ShellState = { status: "starting", waiting: null, command: null, exit: null, error: null }

/** One shell of the terminal: listed from the moment it is made, ready once `opened` settles. */
interface Entry {
  readonly id: string
  readonly name: string
  readonly opened: Promise<TerminalShell>
  shell: TerminalShell | null
  /** The calls on this shell, one after another. */
  queue: Promise<unknown>
}

/** How one call runs: the yian call's id, its signal, and whether the owner approved it (no gate). */
interface Call {
  readonly callId: string | undefined
  readonly signal: AbortSignal
  readonly approved: boolean
}

/** The profile of the sandbox `shells` run in. */
export function profileOf(shells: TerminalShells): TerminalProfile {
  if (shells.sandbox instanceof SandboxPolicy) return "workspace"
  return shells.sandbox instanceof SshPolicy ? "ssh" : "none"
}

/** One session's shells, as its host binds them, and the tools the agent works them with. */
export class Terminal {
  /** The sandbox the shells run in. */
  readonly profile: TerminalProfile
  /** The owner's home as the kernel names it, which a PTY shell's folder is told the gate under as `~`; null for
   *  shells in a workspace's sandbox, whose home is their temp folder. */
  private readonly home: string | null
  private readonly entries: Entry[] = []
  /** The calls running now, each stopped by its controller: `interruptWaits` ends them. */
  private readonly calls = new Set<AbortController>()
  private made = 0
  private closed = false

  constructor(private readonly host: TerminalHost) {
    this.profile = profileOf(host.shells)
    const { shells } = host
    this.home = shells.sandbox instanceof SshPolicy
      ? shells.sandbox.home
      : shells.kind === "pty" && shells.sandbox === null && shells.env.HOME
        ? realOrSame(shells.env.HOME)
        : null
  }

  /** The model-facing tools: description, parameters, `call(args, { callId, signal })`. */
  tools(): Record<ToolName, TerminalTool> {
    const specs = toolSpecs(this.host.shells.kind)
    const tool = (name: ToolName): TerminalTool => ({
      ...specs[name],
      call: (args, options = {}) => this.call(name, args, options),
    })
    return Object.fromEntries(TOOLS.map((name) => [name, tool(name)])) as Record<ToolName, TerminalTool>
  }

  /** Where shell `id` runs, as the gate reads it (a new shell when `id` names none): from the shells' sandbox, the
   *  host's `where()` giving only the start folder of shells with none and the credentials it marks, and from a PTY
   *  shell the folder it reports. A host deciding a held card again reads it here. */
  where(id?: string): Where {
    const start = this.startWhere()
    const shell = id === undefined ? undefined : this.shell(id)
    if (!(shell instanceof PtyShell)) return start
    const folder = shell.cwd()
    const home = this.home
    const homed = folder !== null && home !== null && (folder === home || folder.startsWith(`${home}/`))
    return { ...start, cwd: homed ? `~${folder!.slice(home!.length)}` : folder }
  }

  /** Where a shell starts. */
  private startWhere(): Where {
    const base = this.host.permissions.where()
    const { sandbox } = this.host.shells
    const marked = [...(base.credentials ?? []), ...(sandbox instanceof SshPolicy ? sandbox.credentials : [])]
    const credentials = marked.length > 0 ? { credentials: marked } : {}
    if (sandbox instanceof SandboxPolicy) {
      const writable = sandbox.writable ? [sandbox.workspace, sandbox.tmpdir] : [sandbox.tmpdir]
      return { profile: "workspace", cwd: sandbox.workspace, writable, ...credentials }
    }
    const cwd = sandbox instanceof SshPolicy ? sandbox.tmpdir : base.cwd
    return { profile: "ssh", cwd, writable: [], ...credentials }
  }

  /** Runs held call `tool` with `args` once its card says Yes, with no gate; the tools' own refusals still apply (the
   *  shell may have ended or moved on, and a typed line must still be the one approved). The host's approved runner. */
  async runApproved(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if (this.closed) return refusalText(CLOSED)
    if (tool !== "run" && tool !== "type") {
      return refusalText(`${tool} never waits for the owner's approval; only run and type do`)
    }
    const parsed = parseArgs(tool, args, tool === "type" ? ["line", "into"] : [])
    if (typeof parsed === "string") return refusalText(parsed)
    const call: Call = { callId: undefined, signal, approved: true }
    if (parsed.tool === "run") return (await this.run(parsed, call)) as string
    const { line, into } = args
    if (typeof line !== "string" || (into !== null && typeof into !== "string")) {
      return refusalText("this approval doesn't say which line it approved")
    }
    const entry = this.find(parsed.shell)
    if (entry === undefined) return refusalText(this.unknown(parsed.shell))
    const typed = parsed as Parsed & { tool: "type" }
    return (await this.queue(entry, (shell) => this.type(entry, shell, typed, call, { line, into }))) as string
  }

  shells(): readonly { id: string; name: string; state: ShellState }[] {
    return this.entries.map(({ id, name, shell }) => ({ id, name, state: shell?.state() ?? { ...STARTING } }))
  }

  /** For the host: the owner's keys, the owner's Ctrl-C, a resize. Undefined while it starts. */
  shell(id: string): TerminalShell | undefined {
    return this.entries.find((entry) => entry.id === id)?.shell ?? undefined
  }

  /** Ends every reply the agent's calls wait on now, as Esc does, and stops every call still in its gate (Auto's
   *  check) or queued behind another, which then types nothing; the shells keep running. An approved call's reply
   *  ends only with its own signal, as the host's approvals stop it. */
  interruptWaits(): void {
    for (const call of [...this.calls]) call.abort()
  }

  /** Ends every shell; their records stay. Later calls are refused. */
  async close(): Promise<void> {
    this.closed = true
    this.interruptWaits()
    await Promise.all(
      this.entries.map(async (entry) => {
        try {
          await (await entry.opened).close()
        } catch {
          // A shell that never opened has nothing to end.
        }
      }),
    )
  }

  private async call(
    tool: ToolName,
    args: Record<string, unknown>,
    options: { readonly callId?: string; readonly signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed) return refusalText(CLOSED)
    const parsed = parseArgs(tool, args)
    if (typeof parsed === "string") return refusalText(parsed)
    const own = new AbortController()
    this.calls.add(own)
    const signal = options.signal ? AbortSignal.any([own.signal, options.signal]) : own.signal
    try {
      const call: Call = { callId: options.callId, signal, approved: false }
      if (parsed.tool === "run") return await this.run(parsed, call)
      const entry = this.find(parsed.shell)
      if (entry === undefined) return refusalText(this.unknown(parsed.shell))
      return await this.queue(entry, async (shell): Promise<unknown> => {
        switch (parsed.tool) {
          case "type":
            return await this.type(entry, shell, parsed, call, null)
          case "read": {
            const from = parsed.from === undefined ? {} : { from: parsed.from }
            return this.text(entry, shell, await shell.read({ waitMs: parsed.waitMs, signal, ...from }))
          }
          case "interrupt":
            return this.text(entry, shell, shell.interrupt())
          case "close":
            await shell.close()
            return this.text(entry, shell, await shell.read({ waitMs: 0 }))
        }
      })
    } finally {
      this.calls.delete(own)
    }
  }

  /** Runs a command in the named shell once it is idle, or in a new one, which starts only once the gate lets the
   *  command run. */
  private async run(parsed: Parsed & { tool: "run" }, call: Call): Promise<unknown> {
    const { command, why, waitMs } = parsed
    const action: Action = { kind: "command", text: command }
    if (parsed.shell !== null) {
      const entry = this.find(parsed.shell)
      if (entry === undefined) return refusalText(this.unknown(parsed.shell))
      return await this.queue(entry, async (shell) => {
        const problem = shell.runProblem(command)
        if (problem !== null) return this.text(entry, shell, shell.refusal(problem))
        const gated = await this.gated(action, "run", why, cardArgs(parsed), call, entry.id)
        if (!gated.run) return gated.result
        return this.text(entry, shell, await shell.run(command, waitMs, call.signal))
      })
    }
    const { shells } = this.host
    const problem = shells.kind === "pty"
      ? PtyShell.commandProblem(command, shellKind(shells.shell))
      : PipeShell.commandProblem(command)
    if (problem !== null) return refusalText(problem)
    const gated = await this.gated(action, "run", why, cardArgs(parsed), call)
    if (!gated.run) return gated.result
    const entry = this.create()
    if (typeof entry === "string") return refusalText(entry)
    return await this.queue(entry, async (shell) => {
      if (call.signal.aborted) return STOPPED
      return this.text(entry, shell, await shell.run(command, waitMs, call.signal))
    })
  }

  /** Types into the shell's running command, gated on the whole line it makes; an approved call (`approved`, the
   *  line and command its card was decided on) types only while the shell still holds that line and command. */
  private async type(
    entry: Entry,
    shell: TerminalShell,
    parsed: Parsed & { tool: "type" },
    call: Call,
    approved: { line: string; into: string | null } | null,
  ): Promise<unknown> {
    const { text, enter, why, waitMs } = parsed
    const problem = shell.typeProblem(text)
    if (problem !== null) return this.text(entry, shell, shell.refusal(problem))
    const line = shell.pendingLine() + text
    const into = shell.state().command
    const same = () => shell.pendingLine() + text === line && shell.state().command === into
    if (approved !== null && (approved.line !== line || approved.into !== into)) {
      return this.text(entry, shell, shell.refusal(MOVED_SINCE))
    }
    const action: Action = { kind: "input", text: line, partial: !enter, ...(into === null ? {} : { into }) }
    const gated = await this.gated(action, "type", why, { ...cardArgs(parsed), line, into }, call, entry.id)
    if (!gated.run) return gated.result
    // Auto's check takes time: the owner's keys or the command's end may have changed what the line would be.
    if (!same()) return this.text(entry, shell, shell.refusal(MOVED))
    return this.text(entry, shell, await shell.type(text, { enter, waitMs, signal: call.signal }))
  }

  /** The gate for `action` in shell `id` (a new shell when undefined): the session's permissions, with the shell's
   *  `where`, or the owner's approval already given. A call stopped before or during it runs nothing and holds
   *  nothing. */
  private async gated(
    action: Action,
    tool: "run" | "type",
    why: string,
    args: Record<string, unknown>,
    call: Call,
    id?: string,
  ): Promise<Gate> {
    if (call.signal.aborted) return { run: false, result: STOPPED }
    if (call.approved) return { run: true, by: "the owner's approval" }
    const base = this.host.permissions
    const { check, blocked } = base
    const permissions: Permissions = {
      mode: () => base.mode(),
      rules: () => base.rules(),
      where: () => this.where(id),
      hold: (card, callId) => base.hold(card, callId),
      ...(check ? { check: (input: CheckInput, signal: AbortSignal) => check.call(base, input, signal) } : {}),
      ...(blocked ? { blocked: () => blocked.call(base) } : {}),
    }
    const decided = await gate(permissions, action, { tool, why, args, callId: call.callId, signal: call.signal })
    if (decided.run && call.signal.aborted) return { run: false, result: STOPPED }
    return decided
  }

  /** Makes the next shell and lists it; why not, when the terminal has closed or the host can't bind it. */
  private create(): Entry | string {
    if (this.closed) return CLOSED
    const name = `shell ${++this.made}`
    let binding: ShellBinding
    try {
      binding = this.host.shellHost(name, this.profile)
    } catch (error) {
      return `a new shell couldn't be made: ${(error as Error).message}`
    }
    const { shells, driver } = this.host
    const host = {
      record: binding.record,
      driver,
      changed: (state: ShellState) => binding.changed(state),
      output: (chunk: Uint8Array) => binding.output(chunk),
    }
    let opened: Promise<TerminalShell>
    if (shells.kind === "pipes") {
      const run = async (argv: readonly string[], options: RunOptions) => {
        try {
          return await shells.run(argv, options)
        } catch (error) {
          throw withFix(error)
        }
      }
      try {
        opened = Promise.resolve(PipeShell.open(binding.id, name, { ...host, run }))
      } catch (error) {
        return `a new shell couldn't be made: ${(error as Error).message}`
      }
    } else {
      const start: ShellHost["start"] = (argv, io) => {
        try {
          return shells.start(argv, io)
        } catch (error) {
          throw withFix(error)
        }
      }
      const kind = shells.shell === undefined ? {} : { shell: shells.shell }
      opened = PtyShell.open(binding.id, name, { ...host, start, env: shells.env, ...kind })
    }
    const entry: Entry = { id: binding.id, name, opened, shell: null, queue: Promise.resolve() }
    this.entries.push(entry)
    opened.then(
      (shell) => {
        entry.shell = shell
      },
      () => {
        // A shell that didn't open isn't listed; the call that made it gets its error.
        const at = this.entries.indexOf(entry)
        if (at >= 0) this.entries.splice(at, 1)
      },
    )
    return entry
  }

  /** Runs `job` on `entry`'s shell after the calls on it before. */
  private queue<T>(entry: Entry, job: (shell: TerminalShell) => Promise<T>): Promise<T> {
    const turn = entry.queue.then(async () => await job(await entry.opened))
    entry.queue = turn.catch(() => undefined)
    return turn
  }

  private find(name: string): Entry | undefined {
    return this.entries.find((entry) => entry.name === name)
  }

  private unknown(name: string): string {
    const names = this.entries.map((entry) => entry.name)
    const listed = names.length > 0 ? `the shells are ${names.join(", ")}` : "there are none yet"
    return `no shell is named ${JSON.stringify(name)}: ${listed}; run with no shell starts a new one`
  }

  private text(entry: Entry, shell: TerminalShell, reply: Reply): string {
    const dontAsk = this.host.permissions.mode() === "dontAsk"
    return replyText(reply, { name: entry.name, error: shell.state().error, dontAsk })
  }
}

/** `path` with its links resolved, or as it is when it can't be. */
function realOrSame(path: string): string {
  try {
    return fs.realpathSync(path)
  } catch {
    return path
  }
}

/** A start failure for want of a sandbox, saying what to install. */
function withFix(error: unknown): unknown {
  return error instanceof SandboxUnavailable ? new SandboxUnavailable(`${error.message}; ${SANDBOX_FIX}`) : error
}

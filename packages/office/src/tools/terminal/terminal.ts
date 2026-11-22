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
 *  end with the call's signal, with its interrupt (the agent's, as yian passes it, which reaches a call that came after
 *  `interruptWaits` too) and with `interruptWaits`, and a call stopped in its gate types nothing. Calls on one shell
 *  queue; calls on different shells run together.
 *
 *  **A call cut off stops its command.** A `run`, the agent's or an approved one, whose signal aborts before its reply
 *  returns stops the command it waits on, as the owner's Ctrl-C does, and replies once it has ended (or after a few
 *  seconds). A command whose reply said it is still running goes on: the agent reads it later, or interrupts it.
 *
 *  **Audit.** The host's `audit` gets each command or typed line the gate holds or refuses, and each command the gate
 *  or an approval let run, once it ends, during the agent's wait or after it. A call stopped in its gate writes
 *  none.
 *
 *  **Notes.** A host that takes them (`ended`) gets one note when a command whose reply said it runs on ends: its
 *  shell, the command, its exit and its last lines, fenced, keyed by the shell and the command's number there. None comes when
 *  the agent interrupted the command or closed its shell, when a read or type the agent was waiting on returned the
 *  end, or once the terminal has closed. A note leaves the agent's place in the view where it was. The shell's record
 *  keeps the key of each note owed (`told`), so the host can send a note of it after a restart (`restoredNote`). */
import {
  type Action, type CheckInput, type Gate, gate, type Permissions, type Where,
} from "../../runtime/permissions/policy.ts"
import fs from "node:fs"
import { SandboxPolicy } from "../../runtime/sandbox/policy.ts"
import { type Result, type RunOptions, SandboxUnavailable } from "../../runtime/sandbox/run.ts"
import { SshPolicy } from "../../runtime/sandbox/ssh_policy.ts"
import { PipeShell } from "./pipes.ts"
import { PtyShell, type Reply, type ShellHost, shellKind, type ShellState } from "./shell.ts"
import type { InstrumentRecord, RecordedCommand } from "./record.ts"
import { cardArgs, type Parsed, parseArgs, refusalText, replyText, type ToolName, TOOLS, toolSpecs } from "./tools.ts"

/** How a terminal's shells run: on PTYs, in `sandbox` (null: none, which only the owner allows); or as the
 *  workspace's pipes, each command its own call in the workspace's sandbox.
 *
 *  Invariant: `start` (or `run`) starts every shell in `sandbox`, and `env` is that sandbox's (`scrubbedEnv` and
 *  `TERM`). The gate trusts `sandbox` for the profile, the folder and the credentials, so a host builds both from the
 *  one policy. The terminal checks what it cheaply can: a PTY's `HOME` and `TMPDIR` are its sandbox's. */
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

/** One row of the host's audit. A held or refused call says why; a command that ran says how it ended, in seconds,
 *  and what let it run (`by <the gate's reason>`, or the approval's credit), and, when it ended with no exit, why
 *  (`stopped`). `shell` is null for a new shell not yet made. */
export type TerminalAudit =
  | {
      readonly outcome: "held" | "denied"
      readonly tool: "terminal_run" | "terminal_type"
      readonly text: string
      readonly shell: string | null
      readonly reason: string
    }
  | {
      readonly outcome: "ok" | "error"
      readonly tool: "terminal_run"
      readonly text: string
      readonly shell: string
      readonly exit: number | null
      readonly duration: number
      readonly why: string
      readonly stopped: string | null
    }

/** A command the agent was told runs on has ended: its note, as the model reads it, and its shell. `key` names the
 *  command alone (`terminal:<shell id>:<n>`, the nth command the terminal ran in that shell), so a note sent again
 *  is the same note. */
export interface CommandEnded {
  readonly key: string
  readonly shell: string
  readonly text: string
}

/** What the host binds for one new shell: its id, its record, and where its state and live output go. */
export interface ShellBinding extends Pick<ShellHost, "record" | "changed" | "output"> {
  readonly id: string
}

/** What a terminal's host binds; the model sets none of it. */
export interface TerminalHost {
  readonly shells: TerminalShells
  /** Who drives: the agent's handle, or "opencorp". */
  readonly driver: string
  /** The session's permissions. Their `where` is the base a shell's own is read over: only its credentials, and for
   *  shells with no sandbox its folder, count (`Terminal.where`). */
  readonly permissions: Permissions
  /** Binds new shell `name`, which runs in `profile`. */
  shellHost(name: string, profile: TerminalProfile): ShellBinding
  /** Gets the terminal's audit rows (`TerminalAudit`), if the host keeps them. */
  audit?(row: TerminalAudit): void
  /** Gets a note when a command the agent was told runs on ends, if the host tells the session (see the module). */
  ended?(note: CommandEnded): void
}

/** One of a terminal's shells: a PTY shell, or the workspace's pipes shell. */
export type TerminalShell = PtyShell | PipeShell

/** A tool as the model calls it: an `OfficeTool`, declared here by its shape. `callId` is the yian call's, which a
 *  held call's card names; `signal` stops the call, and so does `interrupted`, the agent's interrupt while it runs. */
export interface TerminalTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(
    args: Record<string, unknown>,
    options?: { readonly callId?: string; readonly signal?: AbortSignal; readonly interrupted?: AbortSignal },
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
/** What an approved command is refused with when its shell is in another folder than its card was decided in. */
const MOVED_FOLDER = (was: string | null, now: string | null) =>
  `the shell is in another folder than when this command was approved (${was ?? "unknown"}, now ` +
  `${now ?? "unknown"}); run it again to have it checked there`
/** What a start failure for want of a sandbox adds, so the agent can tell the owner what to fix; doctor says it too. */
export const SANDBOX_FIX =
  "the shell needs a sandbox: on Linux, install bubblewrap (bwrap) and allow unprivileged user namespaces; on " +
  "macOS, sandbox-exec comes with the system"
const STARTING: ShellState = { status: "starting", waiting: null, command: null, exit: null, error: null }
/** How long a cut-off call waits for its stopped command to end before it replies. */
const STOP_WAIT_MS = 3000
/** What a note shows of a command's output: its last lines, at most this many, in at most this many bytes. */
const NOTE_LINES = 20
const NOTE_BYTES = 2048
/** How much of the view a note reads to find them: room for 20 lines of 2 KiB in all, cut short. */
const NOTE_READ = 4 * NOTE_BYTES
/** How much of a command a note's first line shows. */
const NOTE_COMMAND = 200
/** Why a command ended with no exit, for its audit row. */
const CUT_OFF = "its call was cut off"
const AGENT_INTERRUPT = "the agent interrupted it"
const SHELL_ENDED = "its shell ended"
/** The owner's Ctrl-C reaches the shell itself, and a call that couldn't run ends the same way. */
const NO_EXIT = "it was stopped, or couldn't run"
/** A reply's `note` when its `exit` is null, by why the command ended with none. */
const NO_EXIT_NOTES: Readonly<Record<string, string>> = {
  [CUT_OFF]: "No exit: the command was stopped because its call was cut off.",
  [AGENT_INTERRUPT]: "No exit: you interrupted the command.",
  [SHELL_ENDED]: "No exit: the shell ended while the command ran.",
  [NO_EXIT]: "No exit: the owner stopped the command (Ctrl-C), or it couldn't run.",
}
const STILL_RUNNING = "No exit yet: the command is still running."
const SHELL_GONE = "No exit: the shell ended, closed or killed by a signal."

/** One shell of the terminal: listed from the moment it is made, ready once `opened` settles. */
interface Entry {
  readonly id: string
  readonly name: string
  readonly opened: Promise<TerminalShell>
  /** Its record, as its host bound it. */
  readonly record: InstrumentRecord
  shell: TerminalShell | null
  /** The calls on this shell, one after another. */
  queue: Promise<unknown>
  /** The command the terminal ran here and its end hasn't come yet, if any. */
  running: Running | null
  /** Why the last command the terminal ran here ended with no exit, as its audit row says; null when it had one. */
  noExit: string | null
  /** How many commands the terminal has run here: each one's number, for its note's key. */
  commands: number
  /** How many of the agent's reads and types on this shell wait now: a reply that returns after an end carries it. */
  waits: number
  /** A command that ended while a read or type waited, and whose note waits on that reply. */
  untold: Running | null
}

/** A command the terminal ran: what let it run, when, where its output starts in the view, its number in its shell,
 *  whether the shell has started it, why the terminal stopped it (if it did), whether the agent was told it runs on,
 *  and its end. */
interface Running {
  readonly command: string
  readonly why: string
  readonly started: number
  readonly from: number
  readonly n: number
  seen: boolean
  stopped: string | null
  /** A reply told the agent it runs on, and nothing since told it of its end: its end gets a note. */
  told: boolean
  /** How it ended, once it has: its exit, why it had none, and how long it ran, in seconds. */
  end: { exit: number | null; stopped: string | null; duration: number } | null
  readonly ended: PromiseWithResolvers<void>
}

/** How one call runs: the yian call's id, its signal, and whether the owner approved it (no gate). An approved
 *  command carries the folder its card was decided in (`folder`) and what approved it (`credit`). */
interface Call {
  readonly callId: string | undefined
  readonly signal: AbortSignal
  readonly approved: boolean
  readonly folder?: string | null
  readonly credit?: string
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
  /** Whether the shells take typed keys: PTYs, not the workspace's pipes. */
  readonly interactive: boolean
  /** The owner's home as the kernel names it, which a PTY shell's folder is told the gate under as `~`; null for
   *  shells in a workspace's sandbox, whose home is their temp folder. */
  private readonly home: string | null
  private readonly entries: Entry[] = []
  /** The calls running now, each stopped by its controller: `interruptWaits` ends them. */
  private readonly calls = new Set<AbortController>()
  private made = 0
  private closed = false

  /** Throws a `RangeError` when a PTY's `HOME` or `TMPDIR` isn't its sandbox's (see `TerminalShells`). */
  constructor(private readonly host: TerminalHost) {
    this.profile = profileOf(host.shells)
    this.interactive = host.shells.kind === "pty"
    const { shells } = host
    if (shells.kind === "pty" && shells.sandbox !== null) {
      const { sandbox, env } = shells
      const home = sandbox instanceof SshPolicy ? sandbox.home : sandbox.tmpdir
      if (env.HOME !== home || env.TMPDIR !== sandbox.tmpdir) {
        throw new RangeError(`the shells' environment isn't their sandbox's: HOME ${env.HOME}, TMPDIR ${env.TMPDIR}`)
      }
    }
    this.home = shells.sandbox instanceof SshPolicy
      ? shells.sandbox.home
      : shells.kind === "pty" && shells.sandbox === null && shells.env.HOME
        ? realOrSame(shells.env.HOME)
        : null
  }

  /** The model-facing tools: description, parameters, `call(args, { callId, signal })`. */
  tools(): Record<ToolName, TerminalTool> {
    const specs = toolSpecs(this.host.shells.kind, this.host.ended !== undefined)
    const tool = (name: ToolName): TerminalTool => ({
      ...specs[name],
      call: (args, options = {}) => this.call(name, args, options),
    })
    return Object.fromEntries(TOOLS.map((name) => [name, tool(name)])) as Record<ToolName, TerminalTool>
  }

  /** Where `shell` (by id, or by name, as a card names it) runs, as the gate reads it, or a new shell when it names
   *  none: from the shells' sandbox, the host's `where()` giving only the start folder of shells with none and the
   *  credentials it marks, and from a PTY shell the folder it reports, a home as `~`. A host deciding a held card
   *  again reads it here. */
  where(shell?: string): Where {
    const start = this.startWhere()
    const found = shell === undefined ? undefined : this.entries.find((e) => e.id === shell || e.name === shell)?.shell
    const folder = found instanceof PtyShell ? found.cwd() : start.cwd
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

  /** Runs held call `tool` (its card's tool, `terminal_run` or `terminal_type`) with `args` once its card says Yes,
   *  with no gate; the tools' own refusals still apply (the shell may have ended or moved on, and a typed line must
   *  still be the one approved). `credit` says what approved it, for its audit row ("approved" when not given). The
   *  host's approved runner: only `signal` ends its wait, and then its command stops. */
  async runApproved(
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    credit?: string,
  ): Promise<string> {
    if (this.closed) return refusalText(CLOSED)
    if (tool !== "terminal_run" && tool !== "terminal_type") {
      return refusalText(`${tool} never waits for the owner's approval; only terminal_run and terminal_type do`)
    }
    const parsed =
      tool === "terminal_type" ? parseArgs("type", args, ["line", "into"]) : parseArgs("run", args, ["cwd"])
    if (typeof parsed === "string") return refusalText(parsed)
    if (parsed.tool === "run") {
      const { cwd } = args
      if (cwd !== null && typeof cwd !== "string") {
        return refusalText("this approval doesn't say which folder it was decided in")
      }
      const credited = credit === undefined ? {} : { credit }
      return (await this.run(parsed, { callId: undefined, signal, approved: true, folder: cwd, ...credited })) as string
    }
    const call: Call = { callId: undefined, signal, approved: true }
    const { line, into } = args
    if (typeof line !== "string" || (into !== null && typeof into !== "string")) {
      return refusalText("this approval doesn't say which line it approved")
    }
    const entry = this.find(parsed.shell)
    if (entry === undefined) return refusalText(this.unknown(parsed.shell))
    const typed = parsed as Parsed & { tool: "type" }
    return (await this.queue(entry, (shell) => this.type(entry, shell, typed, call, { line, into }))) as string
  }

  /** The terminal's shells, in the order they were made, each with its state: an ended or failed one stays listed;
   *  one still starting shows `starting`. */
  shells(): readonly { id: string; name: string; state: ShellState }[] {
    return this.entries.map(({ id, name, shell }) => ({ id, name, state: shell?.state() ?? { ...STARTING } }))
  }

  /** For the host: the owner's keys, the owner's Ctrl-C, a resize. Undefined while it starts. */
  shell(id: string): TerminalShell | undefined {
    return this.entries.find((entry) => entry.id === id)?.shell ?? undefined
  }

  /** Cuts off the agent's calls now, as Esc does: every reply they wait on ends, and the command each `run` waits on
   *  stops; a call still in its gate (Auto's check) or queued behind another runs and types nothing. A command whose
   *  reply already said it is running goes on. An approved call ends only with its own signal, as the host's
   *  approvals stop it. */
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
    options: { readonly callId?: string; readonly signal?: AbortSignal; readonly interrupted?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed) return refusalText(CLOSED)
    const parsed = parseArgs(tool, args)
    if (typeof parsed === "string") return refusalText(parsed)
    const own = new AbortController()
    this.calls.add(own)
    // The agent's interrupt reaches a call that came after `interruptWaits` cut off the ones it found: Esc, say, while
    // the call was on its way.
    const stops = [own.signal, options.signal, options.interrupted].filter((s) => s !== undefined)
    const signal = AbortSignal.any(stops)
    try {
      const call: Call = { callId: options.callId, signal, approved: false }
      if (parsed.tool === "run") return await this.run(parsed, call)
      const entry = this.find(parsed.shell)
      if (entry === undefined) return refusalText(this.unknown(parsed.shell))
      return await this.queue(entry, async (shell): Promise<unknown> => {
        switch (parsed.tool) {
          case "type":
            return await this.waiting(entry, () => this.type(entry, shell, parsed, call, null))
          case "read": {
            const from = parsed.from === undefined ? {} : { from: parsed.from }
            return await this.waiting(entry, async () =>
              this.text(entry, shell, await shell.read({ waitMs: parsed.waitMs, signal, ...from })),
            )
          }
          case "interrupt": {
            const running = entry.running
            const reply = shell.interrupt()
            if (reply.refused === undefined && running !== null) {
              running.stopped ??= AGENT_INTERRUPT
              this.untell(entry, running)
            }
            return this.text(entry, shell, reply)
          }
          case "close":
            // The agent ends its own command: it needs no note of that.
            if (entry.running !== null) this.untell(entry, entry.running)
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
    const { command, why } = parsed
    const action: Action = { kind: "command", text: command }
    if (parsed.shell !== null) {
      const entry = this.find(parsed.shell)
      if (entry === undefined) return refusalText(this.unknown(parsed.shell))
      return await this.queue(entry, async (shell) => {
        const problem = shell.runProblem(command)
        if (problem !== null) return this.text(entry, shell, shell.refusal(problem))
        // The folder the gate reads relative paths from, kept on the card: an approval holds only there.
        const folder = this.where(entry.id).cwd
        if (call.approved && call.folder !== folder) {
          return this.text(entry, shell, shell.refusal(MOVED_FOLDER(call.folder ?? null, folder)))
        }
        const args = { ...cardArgs(parsed), cwd: folder }
        const gated = await this.gated(action, "terminal_run", why, args, call, entry.id)
        if (!gated.run) return gated.result
        if (call.signal.aborted) return STOPPED
        return await this.runIn(entry, shell, parsed, call, gated.by)
      })
    }
    const { shells } = this.host
    const problem = shells.kind === "pty"
      ? PtyShell.commandProblem(command, shellKind(shells.shell))
      : PipeShell.commandProblem(command)
    if (problem !== null) return refusalText(problem)
    const folder = this.where().cwd
    if (call.approved && call.folder !== folder) return refusalText(MOVED_FOLDER(call.folder ?? null, folder))
    const gated = await this.gated(action, "terminal_run", why, { ...cardArgs(parsed), cwd: folder }, call)
    if (!gated.run) return gated.result
    const entry = this.create()
    if (typeof entry === "string") return refusalText(entry)
    return await this.queue(entry, async (shell) => {
      if (call.signal.aborted) return STOPPED
      return await this.runIn(entry, shell, parsed, call, gated.by)
    })
  }

  /** Runs the command in `shell`, which the gate (saying `by` what) or an approval (`by` its credit) let run, and
   *  replies. Its end, whenever it comes, goes to the host's audit, and, when this reply said it runs on, to the host's
   *  notes. A call cut off before its reply stops the command, as the owner's Ctrl-C does, and replies once it has
   *  ended, or after `STOP_WAIT_MS`. */
  private async runIn(
    entry: Entry,
    shell: TerminalShell,
    parsed: Parsed & { tool: "run" },
    call: Call,
    by: string,
  ): Promise<string> {
    const why = call.approved ? by : `by ${by}`
    const running: Running = {
      command: parsed.command, why, started: performance.now(), from: shell.viewEnd(), n: ++entry.commands,
      seen: false, stopped: null, told: false, end: null, ended: Promise.withResolvers<void>(),
    }
    entry.running = running
    const reply = await shell.run(parsed.command, parsed.waitMs, call.signal)
    // Refused by the shell itself: it never started.
    if (!running.seen && entry.running === running) entry.running = null
    if (!call.signal.aborted && running.seen && reply.refused === undefined && runsOn(reply)) {
      running.told = this.host.ended !== undefined
      if (running.told) {
        try {
          entry.record.told(noteKey(entry, running))
        } catch {
          // meta.json can't be written: only a note after a restart is lost.
        }
      }
      // It ended between this reply and now: its end came untold.
      if (running.end !== null) this.tell(entry, running)
      return this.text(entry, shell, reply, running.told)
    }
    if (!call.signal.aborted || entry.running !== running) return this.text(entry, shell, reply)
    running.stopped = CUT_OFF
    shell.stop()
    await within(running.ended.promise, STOP_WAIT_MS)
    const { status, exit, waiting } = shell.state()
    return this.text(entry, shell, { ...reply, status, exit, waiting })
  }

  /** Follows `entry`'s state for the command the terminal ran there: it starts when the shell runs it, and ends when
   *  the shell stops running it, its row then going to the host's audit. */
  private follow(entry: Entry, state: ShellState): void {
    const running = entry.running
    if (running === null) return
    if (!running.seen) {
      if (state.status === "running" && state.command === running.command) {
        running.seen = true
        entry.noExit = null
      }
      return
    }
    if (state.status === "running" || state.status === "waiting") return
    entry.running = null
    const duration = (performance.now() - running.started) / 1000
    const { command: text, why } = running
    const outcome = state.exit === 0 ? "ok" : "error"
    const stopped = state.exit !== null
      ? null
      : (running.stopped ??
        (state.status === "failed" ? `the shell failed: ${state.error}` : state.status === "ended" ? SHELL_ENDED : NO_EXIT))
    entry.noExit = stopped
    running.end = { exit: state.exit, stopped, duration }
    this.audit({ outcome, tool: "terminal_run", text, shell: entry.name, exit: state.exit, duration, why, stopped })
    running.ended.resolve()
    if (running.told) this.tell(entry, running)
  }

  /** `running`, a command the agent was told runs on, has ended: the host gets its note, unless the terminal has
   *  closed, or once the read or type the agent waits on returns without its end. */
  private tell(entry: Entry, running: Running): void {
    if (!running.told || this.closed) return
    if (entry.waits > 0) {
      entry.untold = running
      return
    }
    running.told = false
    const shell = entry.shell
    if (shell === null) return
    try {
      this.host.ended?.({ key: noteKey(entry, running), shell: entry.name, text: noteText(entry, shell, running) })
    } catch {
      // The host's notes failed; the command's end stands, and its row is written.
    }
  }

  /** `running` needs no note: the agent stopped it, or a reply told it of its end. */
  private untell(entry: Entry, running: Running): void {
    if (!running.told) return
    running.told = false
    try {
      entry.record.untold(noteKey(entry, running))
    } catch {
      // meta.json can't be written: a restart may then send a note of it after all.
    }
  }

  /** Runs `job`, a read or type the agent waits on in `entry`'s shell. A command that ended while it waited gets its
   *  note once no such call waits, unless a reply carried its end (`text`). */
  private async waiting<T>(entry: Entry, job: () => Promise<T>): Promise<T> {
    entry.waits += 1
    try {
      return await job()
    } finally {
      entry.waits -= 1
      const untold = entry.untold
      if (untold !== null && entry.waits === 0) {
        entry.untold = null
        this.tell(entry, untold)
      }
    }
  }

  /** Gives `row` to the host's audit, which never fails a call. */
  private audit(row: TerminalAudit): void {
    try {
      this.host.audit?.(row)
    } catch {
      // The host's audit failed; the call's own result stands.
    }
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
    const gated = await this.gated(action, "terminal_type", why, { ...cardArgs(parsed), line, into }, call, entry.id)
    if (!gated.run) return gated.result
    // Auto's check takes time: the owner's keys or the command's end may have changed what the line would be.
    if (!same()) return this.text(entry, shell, shell.refusal(MOVED))
    return this.text(entry, shell, await shell.type(text, { enter, waitMs, signal: call.signal }))
  }

  /** The gate for `action` in shell `id` (a new shell when undefined): the session's permissions, with the shell's
   *  `where`, or the owner's approval already given. A held call's card names `tool` as the model called it, which
   *  `runApproved` takes back. A call stopped before or during it runs nothing and holds nothing. */
  private async gated(
    action: Action,
    tool: "terminal_run" | "terminal_type",
    why: string,
    args: Record<string, unknown>,
    call: Call,
    id?: string,
  ): Promise<Gate> {
    if (call.signal.aborted) return { run: false, result: STOPPED }
    if (call.approved) return { run: true, by: call.credit ?? "approved" }
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
    if (call.signal.aborted) return decided.run ? { run: false, result: STOPPED } : decided
    if (!decided.run) {
      const shell = id === undefined ? null : (this.entries.find((entry) => entry.id === id)?.name ?? null)
      // A card the host's hold refused (dontAsk's refusal, as text) is a refusal like any other.
      const held = decided.held !== undefined && typeof decided.result !== "string"
      const reason = held ? decided.held!.reason : String(decided.result)
      this.audit({ outcome: held ? "held" : "denied", tool, text: action.text, shell, reason })
    }
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
    // The entry, once made: a shell's first state change (its start) can come before.
    let made: Entry | undefined
    const host = {
      record: binding.record,
      driver,
      changed: (state: ShellState) => {
        if (made !== undefined) this.follow(made, state)
        binding.changed(state)
      },
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
    const entry: Entry = {
      id: binding.id, name, opened, record: binding.record, shell: null, queue: Promise.resolve(), running: null,
      noExit: null, commands: 0, waits: 0, untold: null,
    }
    made = entry
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

  /** `reply` as the model reads it; with `told`, the note that the agent will be told of its command's end. A reply
   *  that shows the shell's command has ended carries the end of one whose note waited on it. */
  private text(entry: Entry, shell: TerminalShell, reply: Reply, told = false): string {
    if (entry.untold !== null && !runsOn(reply)) {
      this.untell(entry, entry.untold)
      entry.untold = null
    }
    const dontAsk = this.host.permissions.mode() === "dontAsk"
    const note = noExitNote(entry, reply)
    return replyText(reply, { name: entry.name, error: shell.state().error, dontAsk, runsOn: told, note })
  }
}

/** Why `reply`'s exit is null, for its note: the command still runs, or how the last command the terminal ran ended
 *  with none, or the shell ended. Undefined when it has an exit, was refused, or waits at a secret prompt, whose own
 *  note says what to do; and for an idle shell whose last command the terminal didn't run, or that ran none. */
function noExitNote(entry: Entry, reply: Reply): string | undefined {
  if (reply.exit !== null || reply.refused !== undefined || reply.waiting !== null) return undefined
  if (reply.status === "running") return STILL_RUNNING
  const why = entry.noExit === null ? undefined : NO_EXIT_NOTES[entry.noExit]
  if (reply.status === "ended") return why ?? SHELL_GONE
  return reply.status === "idle" ? why : undefined
}

/** The key of `running`'s note: its shell and its number there, the same each time it is sent. */
function noteKey(entry: Entry, running: Running): string {
  return `terminal:${entry.id}:${running.n}`
}

/** The note a host sends after a restart of `command`, which shell `shell` ran and whose note the agent was owed
 *  (`told`): the shell is gone, and the command ended as its record says, or was stopped, perhaps by the office's
 *  stop. Its first line names the shell as gone, since a new shell may take its name. */
export function restoredNote(shell: string, command: RecordedCommand): string {
  const ended =
    typeof command.exit === "number"
      ? `ended, exit ${command.exit}`
      : "ended with no exit code: it was stopped, maybe when the office stopped"
  const head = `${shell} (gone): \`${oneLine(command.command)}\` ${ended}`
  const gone = "The office has restarted since, so that shell is gone; run the command again in a new shell if you " +
    "need to."
  return `${head}\n${gone}`
}

/** Whether `reply` says its shell's command still runs, at a secret prompt or not. */
function runsOn(reply: Reply): boolean {
  return reply.status === "running" || reply.status === "waiting"
}

/** The note of `running`, which ended, in `entry`'s `shell`: a first line naming the shell, the command and how it
 *  ended; how long it ran; its last lines (`lastLines`) as the view shows them, fenced, so no line of the output reads
 *  as the note's own; and, when the agent hasn't read the output before them, where to read it from. */
function noteText(entry: Entry, shell: TerminalShell, running: Running): string {
  const { exit, stopped, duration } = running.end!
  const ended = exit !== null ? `ended, exit ${exit}` : `ended with no exit code: ${stopped}`
  const { output, start, cursor } = shell.peek(running.from, NOTE_READ)
  const lines = lastLines(output, start > running.from)
  const shownFrom = start + output.replace(/\n$/, "").length - lines.length
  const head = `${entry.name}: \`${oneLine(running.command)}\` ${ended}`
  const ran = `It ran for ${elapsed(duration)}.`
  const fence = "`".repeat(Math.max(3, ...(lines.match(/`+/g) ?? []).map((run) => run.length + 1)))
  const body = lines === "" ? [`${ran} It printed nothing.`] : [`${ran} Its last lines:`, fence, lines, fence]
  const unread = cursor < shownFrom
    ? [`[You haven't read its output before these lines: call terminal_read on ${entry.name} from ${cursor}.]`]
    : []
  return [head, ...body, ...unread].join("\n")
}

/** The end of `text` a note shows: its last `NOTE_LINES` lines, trailing line end dropped, in at most `NOTE_BYTES`
 *  bytes, so whole lines from the front go first, then the head of a longer last line. A first line `cut` at its start
 *  goes when another follows it. */
function lastLines(text: string, cut: boolean): string {
  let lines = text.replace(/\n$/, "").split("\n")
  if (cut && lines.length > 1) lines = lines.slice(1)
  lines = lines.slice(-NOTE_LINES)
  while (lines.length > 1 && Buffer.byteLength(lines.join("\n")) > NOTE_BYTES) lines.shift()
  const [only] = lines
  if (lines.length === 1 && Buffer.byteLength(only!) > NOTE_BYTES) return tailBytes(only!, NOTE_BYTES)
  return lines.join("\n")
}

/** The end of `text` in at most `bytes` UTF-8 bytes, never inside a character. */
function tailBytes(text: string, bytes: number): string {
  const chars = [...text]
  let size = 0
  let at = chars.length
  while (at > 0 && size + Buffer.byteLength(chars[at - 1]!) <= bytes) size += Buffer.byteLength(chars[--at]!)
  return chars.slice(at).join("")
}

/** `command` on one line: each run of white space one space, and its first `NOTE_COMMAND` characters, `…` after. */
function oneLine(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim()
  const chars = [...flat]
  return chars.length > NOTE_COMMAND ? `${chars.slice(0, NOTE_COMMAND).join("")}…` : flat
}

/** `seconds` as a note says it: `12s`, `4m12s`, or `1h03m`. */
function elapsed(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
}

/** Resolves once `promise` does, or after `ms`, whichever comes first. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
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

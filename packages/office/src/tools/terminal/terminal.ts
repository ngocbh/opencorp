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
 *  **Every command and every typed line goes through the session's gate** (yian's `beforeToolCall`, which the host
 *  binds): the mode, the rules, the reader and Auto's check, as the workspace's shell does. The terminal decides
 *  nothing itself. The gate reads what a command or typed line would be from `plan`: a typed line whole, the shell's
 *  unfinished line with the new text, `partial` without Enter, `into` the command it is typed into, so `sca` then
 *  `ncel 42` is decided as `scancel 42`, never as two harmless pieces. It decides it, holds what asks on the host's
 *  card. The call then acts only on what the gate decided
 *  for it (`Permissions.decided`), and only while the shell is still where it was decided (its folder, or its line
 *  and the command typed into), else it is refused, to be run again and checked again. The tools' own refusals come
 *  first: a command or line a shell can't take, a shell not ready for it, a secret prompt, the owner part-way through
 *  a line, and typed text in a pipes shell.
 *
 *  **No authority from the agent.** No argument approves a call or widens what it may do; only the host's gate lets
 *  a call act, and the agent's `why` reaches the card, never Auto's check.
 *
 *  **Waits.** A reply waits at most two minutes; a held call waits in yian for its card instead. Each call's wait ends
 *  with the call's signal, with its interrupt (the agent's, as yian passes it, which reaches a call that came after
 *  `interruptWaits` too) and with `interruptWaits`, and a call stopped before it acts types nothing. A message for the
 *  agent while a call waits (`messageArrived`) ends that wait too, with its command running on, so the agent reads it
 *  at its next step. Calls on one shell queue; calls on different shells run together.
 *
 *  **A call cut off stops its command.** A `run` whose signal aborts before its reply
 *  returns stops the command it waits on, as the owner's Ctrl-C does, and replies once it has ended (or after a few
 *  seconds). A command whose reply said it is still running goes on: the agent reads it later, or interrupts it.
 *
 *  **What is kept.** Each shell's record keeps the commands it ran, who ran them, when, and each one's exit; why a
 *  command ran or was refused, and the reply the agent read, are in the run's log.
 *
 *  **Notes.** A host that takes them (`ended`) gets one note when a command whose reply said it runs on ends: its
 *  shell, the command, its exit and its last lines, fenced, keyed by the shell and the command's number there. None comes when
 *  the agent interrupted the command or closed its shell, when a read or type the agent was waiting on returned the
 *  end, or once the terminal has closed. A note leaves the agent's place in the view where it was. The shell's record
 *  keeps the key of each note owed (`told`), so the host can send a note of it after a restart (`restoredNote`).
 *
 *  **The owner's close** (`ownerClose`) ends a shell as the agent's close does, signed by the owner: the shell's record
 *  says who closed it, the host gets one quiet note of it, naming the command it stopped, in place of that command's
 *  note, and a later call on the shell, but a read, is refused with who closed it. */
import { type Action, type Basis, type Decided, type Permissions, type Where } from "../../runtime/permissions/policy.ts"
import fs from "node:fs"
import { SandboxPolicy } from "../../runtime/sandbox/policy.ts"
import { type Result, type RunOptions, SandboxUnavailable } from "../../runtime/sandbox/run.ts"
import { SshPolicy } from "../../runtime/sandbox/ssh_policy.ts"
import { elapsed, fence, lastLines, oneLine } from "../../util/lines.ts"
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

/** A command the agent was told runs on has ended: its note, as the model reads it, and its shell. `key` names the
 *  command alone (`terminal:<shell id>:<n>`, the nth command the terminal ran in that shell), so a note sent again
 *  is the same note. A `quiet` note reports the owner's own act (`ownerClose`): it needn't wake an agent at rest. */
export interface CommandEnded {
  readonly key: string
  readonly shell: string
  readonly text: string
  readonly quiet?: boolean
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
  /** Gets a note when a command the agent was told runs on ends, if the host tells the session (see the module). */
  ended?(note: CommandEnded): void
}

/** What the session's gate needs to decide a terminal call (`Terminal.plan`): nothing (`decide: false`, for a read, an
 *  interrupt, a close, or a call its own refusal stops), or the command or typed line it would act on, where it runs,
 *  the agent's reason, the card's arguments, the state it is decided on, and its shell's name (null for a new one). */
export type CommandPlan =
  | { readonly decide: false }
  | {
      readonly decide: true
      readonly tool: "terminal_run" | "terminal_type"
      readonly action: Action
      readonly where: Where
      readonly why: string
      readonly args: Record<string, unknown>
      readonly basis: Basis
      readonly shell: string | null
    }

/** What the gate decided for the call `plan` says (`approved` when its approver said Yes on a card):
 *  `Permissions.decided`'s answer for it. */
export function decidedFor(plan: CommandPlan & { decide: true }, approved: boolean): Decided {
  const { tool, action, basis, shell } = plan
  return { basis, approved, tool, text: action.text, partial: action.partial ?? false, shell }
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

/** What a call returns when its stop came after the gate let it run, before it started. */
const STOPPED = "Not run: stopped before it started."
const CLOSED = "this terminal has closed"
/** What a call is refused with when the gate decided nothing for it, or something else. */
const NO_DECISION = "no permission check decided this call"
const NOT_DECIDED = "this call isn't the one that was decided; run it again to have it checked"
/** What a typed line is refused with when the shell moved on since the gate decided it, or since it was approved. */
const MOVED =
  "the shell moved on while this line was checked: its unfinished line or its running command changed; read it, " +
  "then type again"
const MOVED_SINCE =
  "the shell has moved on since this line was approved: its unfinished line or its running command changed; read " +
  "it, then type again"
/** What a command is refused with when its shell is in another folder than the gate decided it in. */
const MOVED_FOLDER = (was: string | null, now: string | null) =>
  `the shell is in another folder than when this command was approved (${was ?? "unknown"}, now ` +
  `${now ?? "unknown"}); run it again to have it checked there`
/** What a start failure for want of a sandbox adds, so the agent can tell the owner what to fix; doctor says it too. */
export const SANDBOX_FIX =
  "the shell needs a sandbox: on Linux, install bubblewrap (bwrap) and allow unprivileged user namespaces; on " +
  "macOS, sandbox-exec comes with the system"
const STARTING: ShellState = {
  status: "starting", waiting: null, command: null, exit: null, error: null, ownerTyping: false,
}
/** How long a cut-off call waits for its stopped command to end before it replies. */
const STOP_WAIT_MS = 3000
/** What a note shows of a command's output: its last lines, at most this many, in at most this many bytes. */
const NOTE_LINES = 20
const NOTE_BYTES = 2048
/** How much of the view a note reads to find them: room for 20 lines of 2 KiB in all, cut short. */
const NOTE_READ = 4 * NOTE_BYTES
/** How much of a command a note's first line shows. */
const NOTE_COMMAND = 200
/** Why a command ended with no exit, for its reply's note. */
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
/** What a call on a shell the owner closed is refused with. */
const closedRefusal = (by: string) => `@${by} closed this shell; run with no shell to start a new one`

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
  /** Why the last command the terminal ran here ended with no exit, as its reply's note says; null when it had one. */
  noExit: string | null
  /** How many commands the terminal has run here: each one's number, for its note's key. */
  commands: number
  /** How many of the agent's reads and types on this shell wait now: a reply that returns after an end carries it. */
  waits: number
  /** A command that ended while a read or type waited, and whose note waits on that reply. */
  untold: Running | null
  /** Who closed the shell from their client (`ownerClose`), once one has. */
  closedBy: string | null
}

/** A command the terminal ran: what, when, where its output starts in the view, its number in its shell,
 *  whether the shell has started it, why the terminal stopped it (if it did), whether the agent was told it runs on,
 *  and its end. */
interface Running {
  readonly command: string
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

/** How one call runs: the yian call's id, its signal, and what the gate decided for it (null: nothing), taken as the
 *  call started. Its reply's wait also ends early on `early`, a message for the agent, with its command running on. */
interface Call {
  readonly callId: string | undefined
  readonly signal: AbortSignal
  readonly early: AbortSignal
  readonly decided: Decided | null
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
  /** The agent's calls running now, a held one the owner approved among them, each one's wait ended early by its
   *  controller: `messageArrived` ends them. */
  private readonly early = new Set<AbortController>()
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
    const specs = toolSpecs(this.host.shells.kind, this.notes)
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

  /**
   * What the session's gate decides for tool call `tool` with `args`, read from the shells' live state now: the command
   * or the whole typed line, where it runs, the card's arguments and the state it is decided on. Nothing to decide for
   * a read, an interrupt, a close, or a call the tool's own refusals stop (bad arguments, a closed terminal, a shell
   * that isn't there or can't take it, a secret prompt, the owner typing), which the call then refuses itself.
   */
  plan(tool: string, args: Record<string, unknown>): CommandPlan {
    const none = { decide: false } as const
    if (this.closed || (tool !== "run" && tool !== "type")) return none
    const parsed = parseArgs(tool, args, [], this.notes)
    if (typeof parsed === "string" || (parsed.tool !== "run" && parsed.tool !== "type")) return none
    const entry = parsed.shell === null ? undefined : this.find(parsed.shell)
    if (parsed.shell !== null && entry?.shell == null) return none
    const shell = entry?.shell ?? null
    if (parsed.tool === "run") {
      const { command, why } = parsed
      const { shells } = this.host
      const problem = shell !== null
        ? shell.runProblem(command)
        : shells.kind === "pty"
          ? PtyShell.commandProblem(command, shellKind(shells.shell))
          : PipeShell.commandProblem(command)
      if (problem !== null) return none
      const where = this.where(entry?.id)
      const action: Action = { kind: "command", text: command }
      const card = { ...cardArgs(parsed), cwd: where.cwd }
      const name = entry?.name ?? null
      const basis = { cwd: where.cwd }
      return { decide: true, tool: "terminal_run", action, where, why, args: card, basis, shell: name }
    }
    if (shell === null || shell.typeProblem(parsed.text) !== null) return none
    const line = shell.pendingLine() + parsed.text
    const into = shell.state().command
    const action: Action = { kind: "input", text: line, partial: !parsed.enter, ...(into === null ? {} : { into }) }
    const card = { ...cardArgs(parsed), line, into }
    const where = this.where(entry!.id)
    const basis = { line, into }
    const shellName = entry!.name
    return { decide: true, tool: "terminal_type", action, where, why: parsed.why, args: card, basis, shell: shellName }
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
   *  stops; a call queued behind another runs and types nothing. A command whose reply already said it is running goes
   *  on. */
  interruptWaits(): void {
    for (const call of [...this.calls]) call.abort()
  }

  /** A message for the agent arrived: every reply the agent's calls wait on comes now, a held call the owner approved
   *  included, so the agent reads the message at its next step. Their commands run on, as after the wait, and a call
   *  queued behind another goes on. A call that starts after it, as one the model asked for while the message came,
   *  waits on: nothing here knows whether the agent has read it (yian#1806). */
  messageArrived(): void {
    for (const call of [...this.early]) call.abort()
  }

  /** The owner, `by`, closes shell `id` from their client, as the agent's close does: the shell ends, and so does its
   *  command. Its record says who closed it, and the host gets one quiet note of it, signed by the shell, which names
   *  the command it stopped in place of that command's own note. Nothing for a shell still starting, or one that has
   *  ended. */
  async ownerClose(id: string, by: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id)
    const shell = entry?.shell
    if (entry === undefined || shell == null || entry.closedBy !== null) return
    const { status } = shell.state()
    if (status === "starting" || status === "ended" || status === "failed") return
    entry.closedBy = by
    try {
      entry.record.closedBy(by)
    } catch {
      // meta.json can't be written: the note still says who closed it.
    }
    const running = entry.running
    if (running !== null) this.untell(entry, running)
    await shell.close()
    if (this.closed) return
    const head = `${entry.name}: closed by @${by}`
    const text = running === null
      ? `${head}.`
      : `${head} while \`${oneLine(running.command, NOTE_COMMAND)}\` ran; the command was stopped.`
    try {
      this.host.ended?.({ key: `terminal:${entry.id}:${entry.commands}:closed`, shell: entry.name, text, quiet: true })
    } catch {
      // The host's notes failed; the shell is closed, and its record says by whom.
    }
  }

  /** Whether the host tells the session when a command whose reply said it runs on ends. */
  private get notes(): boolean {
    return this.host.ended !== undefined
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
    // Taken first, whatever the call does next: a refused call leaves no decision behind.
    const decided = this.host.permissions.decided(options.callId)
    if (this.closed) return refusalText(CLOSED)
    const parsed = parseArgs(tool, args, [], this.notes)
    if (typeof parsed === "string") return refusalText(parsed)
    const own = new AbortController()
    this.calls.add(own)
    const early = new AbortController()
    this.early.add(early)
    // The agent's interrupt reaches a call that came after `interruptWaits` cut off the ones it found: Esc, say, while
    // the call was on its way.
    const stops = [own.signal, options.signal, options.interrupted].filter((s) => s !== undefined)
    const signal = AbortSignal.any(stops)
    try {
      const call: Call = { callId: options.callId, signal, early: early.signal, decided }
      if (parsed.tool === "run") return await this.run(parsed, call)
      const entry = this.find(parsed.shell)
      if (entry === undefined) return refusalText(this.unknown(parsed.shell))
      return await this.queue(entry, async (shell): Promise<unknown> => {
        if (entry.closedBy !== null && parsed.tool !== "read") {
          return this.text(entry, shell, shell.refusal(closedRefusal(entry.closedBy)))
        }
        switch (parsed.tool) {
          case "type":
            return await this.waiting(entry, () => this.type(entry, shell, parsed, call))
          case "read": {
            const from = parsed.from === undefined ? {} : { from: parsed.from }
            return await this.waiting(entry, async () => {
              const reply = await shell.read({ waitMs: parsed.waitMs, signal: waitSignal(call), ...from })
              return this.text(entry, shell, reply, false, endedEarly(call))
            })
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
      this.early.delete(early)
    }
  }

  /** Runs a command in the named shell once it is idle, or in a new one, which starts only if the gate let the command
   *  run there. */
  private async run(parsed: Parsed & { tool: "run" }, call: Call): Promise<unknown> {
    const { command } = parsed
    if (parsed.shell !== null) {
      const entry = this.find(parsed.shell)
      if (entry === undefined) return refusalText(this.unknown(parsed.shell))
      return await this.queue(entry, async (shell) => {
        const problem = entry.closedBy !== null ? closedRefusal(entry.closedBy) : shell.runProblem(command)
        if (problem !== null) return this.text(entry, shell, shell.refusal(problem))
        // The folder the gate reads relative paths from: its decision holds only there.
        const moved = this.movedRun(call.decided, parsed, entry.name, this.where(entry.id).cwd)
        if (moved !== null) return this.text(entry, shell, shell.refusal(moved))
        if (call.signal.aborted) return STOPPED
        return await this.runIn(entry, shell, parsed, call)
      })
    }
    const { shells } = this.host
    const problem = shells.kind === "pty"
      ? PtyShell.commandProblem(command, shellKind(shells.shell))
      : PipeShell.commandProblem(command)
    if (problem !== null) return refusalText(problem)
    const moved = this.movedRun(call.decided, parsed, null, this.where().cwd)
    if (moved !== null) return refusalText(moved)
    if (call.signal.aborted) return STOPPED
    const entry = this.create()
    if (typeof entry === "string") return refusalText(entry)
    return await this.queue(entry, async (shell) => {
      if (call.signal.aborted) return STOPPED
      return await this.runIn(entry, shell, parsed, call)
    })
  }

  /** Why the command `parsed` asks for, in shell `shell` (its name; null for a new one), can't run in `folder` under
   *  the gate's decision `decided` (null: none): no decision, a decision for another tool, command or shell, or its
   *  shell is in another folder than the gate decided it in; null when it can. */
  private movedRun(
    decided: Decided | null,
    parsed: Parsed & { tool: "run" },
    shell: string | null,
    folder: string | null,
  ): string | null {
    if (decided === null) return NO_DECISION
    const same = decided.tool === "terminal_run" && decided.text === parsed.command && decided.shell === shell
    if (!same) return NOT_DECIDED
    const was = "cwd" in decided.basis ? decided.basis.cwd : undefined
    return was === folder ? null : MOVED_FOLDER(was ?? null, folder)
  }

  /** Runs the command in `shell`, which the gate let run, and replies. Its end, whenever it comes, goes to the
   *  shell's record, and, when this reply said it runs on, to the host's notes. A
   *  call cut off before its reply stops the command, as the owner's Ctrl-C does, and replies once it has ended, or
   *  after `STOP_WAIT_MS`. */
  private async runIn(
    entry: Entry,
    shell: TerminalShell,
    parsed: Parsed & { tool: "run" },
    call: Call,
  ): Promise<string> {
    const running: Running = {
      command: parsed.command, started: performance.now(), from: shell.viewEnd(), n: ++entry.commands,
      seen: false, stopped: null, told: false, end: null, ended: Promise.withResolvers<void>(),
    }
    entry.running = running
    const reply = await shell.run(parsed.command, parsed.waitMs, waitSignal(call), call.callId)
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
      return this.text(entry, shell, reply, running.told, endedEarly(call))
    }
    if (!call.signal.aborted || entry.running !== running) return this.text(entry, shell, reply)
    running.stopped = CUT_OFF
    shell.stop()
    await within(running.ended.promise, STOP_WAIT_MS)
    const { status, exit, waiting } = shell.state()
    return this.text(entry, shell, { ...reply, status, exit, waiting })
  }

  /** Follows `entry`'s state for the command the terminal ran there: it starts when the shell runs it, and ends when
   *  the shell stops running it. */
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
    const stopped = state.exit !== null
      ? null
      : (running.stopped ??
        (state.status === "failed" ? `the shell failed: ${state.error}` : state.status === "ended" ? SHELL_ENDED : NO_EXIT))
    entry.noExit = stopped
    running.end = { exit: state.exit, stopped, duration }
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

  /** Types into the shell's running command, as the gate decided on the whole line it makes, and only while the
   *  shell still holds the line and command it was decided on. */
  private async type(entry: Entry, shell: TerminalShell, parsed: Parsed & { tool: "type" }, call: Call): Promise<unknown> {
    const { text, enter, waitMs } = parsed
    const problem = shell.typeProblem(text)
    if (problem !== null) return this.text(entry, shell, shell.refusal(problem))
    const line = shell.pendingLine() + text
    const into = shell.state().command
    const decided = call.decided
    if (decided === null) return this.text(entry, shell, shell.refusal(NO_DECISION))
    // The same text typed into the same shell, decided on a line the shell has since moved on from, is this call.
    const same = decided.tool === "terminal_type" && decided.text.endsWith(text) && decided.partial === !enter
    if (!same || decided.shell !== entry.name) return this.text(entry, shell, shell.refusal(NOT_DECIDED))
    const was = "line" in decided.basis ? decided.basis : null
    if (was === null || decided.text !== line || was.line !== line || was.into !== into) {
      return this.text(entry, shell, shell.refusal(decided.approved ? MOVED_SINCE : MOVED))
    }
    if (call.signal.aborted) return STOPPED
    const reply = await shell.type(text, { enter, waitMs, signal: waitSignal(call) })
    return this.text(entry, shell, reply, false, endedEarly(call))
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
      noExit: null, commands: 0, waits: 0, untold: null, closedBy: null,
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

  /** `reply` as the model reads it; with `told`, the note that the agent will be told of its command's end, and with
   *  `early`, that a message ended its wait. A reply that shows the shell's command has ended carries the end of one
   *  whose note waited on it. */
  private text(entry: Entry, shell: TerminalShell, reply: Reply, told = false, early = false): string {
    if (entry.untold !== null && !runsOn(reply)) {
      this.untell(entry, entry.untold)
      entry.untold = null
    }
    const dontAsk = this.host.permissions.mode() === "dontAsk"
    const note = noExitNote(entry, reply)
    return replyText(reply, { name: entry.name, error: shell.state().error, dontAsk, runsOn: told, note, early })
  }
}

/** What ends `call`'s reply's wait: its signal, and a message for the agent. */
function waitSignal(call: Call): AbortSignal {
  return AbortSignal.any([call.signal, call.early])
}

/** Whether a message for the agent, not the call's own end, ended `call`'s wait. */
function endedEarly(call: Call): boolean {
  return call.early.aborted && !call.signal.aborted
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
  const head = `${shell} (gone): \`${oneLine(command.command, NOTE_COMMAND)}\` ${ended}`
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
  const lines = lastLines(output, { lines: NOTE_LINES, bytes: NOTE_BYTES, cut: start > running.from })
  const shownFrom = start + output.replace(/\n$/, "").length - lines.length
  const head = `${entry.name}: \`${oneLine(running.command, NOTE_COMMAND)}\` ${ended}`
  const ran = `It ran for ${elapsed(duration)}.`
  const quote = fence(lines)
  const body = lines === "" ? [`${ran} It printed nothing.`] : [`${ran} Its last lines:`, quote, lines, quote]
  const unread = cursor < shownFrom
    ? [`[You haven't read its output before these lines: call terminal_read on ${entry.name} from ${cursor}.]`]
    : []
  return [head, ...body, ...unread].join("\n")
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

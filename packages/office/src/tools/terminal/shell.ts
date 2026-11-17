/** The terminal instrument's shell: an interactive bash on a PTY, with no line editing, aliases, brace expansion, job
 *  control or history, which an agent and the owner share.
 *
 *  **What the model sees** is the screen as it is (`ModelView`), and the record keeps it. The owner's keys go
 *  straight to the running command; what the terminal echoes of them is screen output like any other, and input it
 *  doesn't echo, as at a password prompt, is in no output, so it reaches no view, record or log. The shell keeps no
 *  copy of the owner's keys and logs nothing. Only the echo of the line the host types for the agent is cut, with
 *  `$ <command>` in its place.
 *
 *  **Where a command ends.** The host types the agent's command as `eval '<command>'; \__oc_s <nonce> $?`, with a
 *  fresh nonce for each command. `__oc_s` sets `__oc_n` to the nonce and keeps the command's exit code; the
 *  `PROMPT_COMMAND` the shell's set-up line installs then puts the terminal's line settings back as they were at the
 *  start, prints a marker (an OSC holding `__oc_n` and the exit code) and clears `__oc_n`. Only a marker with the
 *  command's nonce ends it.
 *  - The nonce is in no variable, `PS1` or environment while the command runs, or between commands: it reaches the
 *    shell in the typed line's last call, which runs once the command has. The shell reads the whole line before it
 *    runs any of it, so nothing of it is left for the command to read as input.
 *  - `__oc_s`, the prompt's function and `PROMPT_COMMAND` are read-only, and they run `stty`, `printf` and `sh` by
 *    path and no builtin, so a command can't redefine, unset or shadow them.
 *  - The line settings come back before each marker, so a command's `stty eof ';'` can't split the next typed line.
 *  - `eval` takes a command whatever its syntax: one that doesn't parse fails and still ends.
 *  - A nonce the shell prints (with `set -x`, say) is neutralised in the views, even split across reads.
 *
 *  Without `PROMPT_COMMAND` (another sh), the typed line puts the settings back and prints the marker itself, and `PS1`
 *  is a marker with no nonce. A marker with no nonce is the shell back at its prompt: the end of the owner's command,
 *  and of the agent's once a Ctrl-C has reached it (a Ctrl-C stops the rest of the line).
 *
 *  The marker keeps the record's boundaries and exit codes honest; it isn't a wall. The shell holds the typed line,
 *  nonce and all, while it runs it, so a command that changes how the shell runs it can still forge its end (a DEBUG
 *  trap sees the line) or hide it (a command that hides it leaves the shell running until it is closed). The sandbox
 *  is the security boundary. The owner's own command can end early by printing a marker with no nonce.
 *
 *  **An unfinished line** the agent leaves when its command ends is killed (Ctrl-U), so neither the next command nor
 *  the owner's next line takes it on; a line the owner typed after it on the same line goes with it.
 *
 *  **Secret prompts.** While a command runs, the shell checks `ownerPrompt` after each output chunk and every 200 ms.
 *  At a secret prompt (a password, passphrase or code) it waits for the owner and refuses the agent's keys and its
 *  interrupt, in every mode; so does a line the owner is part-way through. Should the prompt end while the owner is
 *  part-way through their answer (the program timed out, or turned echo back on), the shell kills that line and drops
 *  the owner's keys until their Enter, saying so in the view, so a partial password never reaches a shell prompt or
 *  the record. Every other prompt, ssh's host-key question and Duo's menu among them, is the mode's to decide.
 *
 *  **What isn't guarded yet.** A password the owner types at a secret prompt can be read by other processes the agent
 *  started in the same terminal: a background process left over from an earlier command that reads the terminal, a
 *  process that traces the shell or ssh (ptrace), or a fake prompt the agent's command prints itself. Nothing in the
 *  shell stops that yet: only the commands the session lets run stand in the way. In ask mode the owner approves each
 *  command; in default mode, each one past the rules and the known read-only forms; in auto and dontAsk, the rules
 *  and Auto's check decide, and no one reads a command for this. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import type { Instrument } from "@opencorp/protocol"
import type { PtyProcess } from "../../platform.ts"
import { type OwnerPrompt, ownerPrompt } from "./guards.ts"
import { ModelView, PlainText } from "./output.ts"
import type { InstrumentRecord } from "./record.ts"

/** A shell's state, as its host lists it. `command` is the agent's command while it runs, never the owner's. */
export interface ShellState {
  status: Instrument["status"]
  waiting: OwnerPrompt | null
  command: string | null
  exit: number | null
  error: string | null
}

/** What a call on the shell returns: its state, and a page of the model's view from where the call started. `next`
 *  is where the agent reads on from; `refused` says why nothing was done; `skipped`, that the page's start is no
 *  longer in memory. */
export interface Reply {
  shell: string
  status: ShellState["status"]
  exit: number | null
  waiting: OwnerPrompt | null
  output: string
  next: number
  more: boolean
  refused?: string
  skipped?: string
}

/** What a shell's host binds: how its PTY starts, its env, its record, and where its state and live output go. */
export interface ShellHost {
  /** Starts argv on a PTY: `startOnTerminal` with the host's profile, or `spawnPty` in tests. */
  start(
    argv: readonly string[],
    io: { cols: number; rows: number; env: Record<string, string>; onData(chunk: Uint8Array): void },
  ): PtyProcess
  /** The shell's environment (`scrubbedEnv` and `TERM` in the sandbox), which the shell clears of what would run code
   *  or set options at its start. */
  env: Record<string, string>
  record: InstrumentRecord
  /** Who runs the agent's commands, as the record names them: the agent's handle. */
  driver: string
  /** Called on every state change, for the host's `instrument.updated`. */
  changed(state: ShellState): void
  /** The raw bytes, the wrapper's echo cut and `$ <command>` put in, for the owner's live view only. */
  output(chunk: Uint8Array): void
  /** Which shell: bash where `/bin/bash` exists, else sh. */
  shell?: "bash" | "sh"
}

/** The longest line the host types, in bytes. Linux cuts a typed line past 4095 bytes. */
const LINE_MAX = 1000
const LONG_LINE =
  "a line of this command is over 1000 bytes; a terminal cuts longer lines (Linux keeps 4095 bytes, macOS 1024): " +
  "write a script with the file tools and run it"
const SECRET = "the program is asking for a password; only the owner types it. Call read to see what happens next."
const OWNER_TYPING = "the owner is typing a line in this shell; call read, and try again once they've finished it"
const OWNER_SECRET = "the shell is waiting for the owner at a prompt for a secret; only they can answer or stop it"
/** What the owner's live view and the model's say when a secret prompt ends under the owner's answer. */
const DROPPED_NOTE =
  "\r\n[the prompt ended while you were typing: the rest of that line is dropped until you press Enter]\r\n"
/** What a kill (Ctrl-U) echoes, whatever the line settings: erasures, or `^U` and a line end. */
const KILL_ECHO = "\b ^U\r\n"

/** A marker: the OSC the shell prints at its prompt, with the nonce (empty at a plain prompt) and the exit code. */
const MARK = "\x1b]633;opencorp-mark;"
const MARKER = /\x1b\]633;opencorp-mark;([^;\x07\x1b]*);([^\x07\x1b]*)\x07/g
/** The first marker, which says the shell is ready. */
const READY = new RegExp(MARKER.source)
/** How far past `MARK` a marker runs: a 16-hex nonce, a `;` and an exit code. */
const MARK_TAIL = 32
/** What a command's output shows in place of the nonce. */
const NONCE_SHOWN = "[nonce]"

/** The set-up line each shell types first, its echo cut with everything else before the first marker. */
const SETUP = {
  // The prompt's work runs in read-only functions that call programs by path and no builtin (a command can shadow
  // `return`, `builtin` or `printf` with a function); the start's line settings are saved for each prompt to restore.
  bash:
    "set +B +m +o history; shopt -u expand_aliases; unalias -a; set +o emacs +o vi; PS1=; PS2=; " +
    `__oc_y=$(type -P stty); __oc_f=$(type -P printf); __oc_t=$("$__oc_y" -g </dev/tty); ` +
    "readonly __oc_y __oc_f __oc_t; " +
    `__oc_s() { __oc_n=$1; /bin/sh -c 'exit "$1"' sh "$2"; }; ` +
    `__oc_p() { "$__oc_y" "$__oc_t" </dev/tty 2>/dev/null; ` +
    `"$__oc_f" "\\033]633;opencorp-mark;%s;%d\\007" "$__oc_n" "$1" >/dev/tty; __oc_n=; }; ` +
    `readonly -f __oc_s __oc_p; PROMPT_COMMAND='__oc_p "$?"'; readonly PROMPT_COMMAND\n`,
  // sh's set may not know some of these options, and a special builtin's error would end the line, so each goes
  // last, alone and through `command`. A sh that is bash edits lines unless told not to.
  sh:
    `PS1="$(printf '\\033]633;opencorp-mark;;')\\$?$(printf '\\007')"; PS2=; set +m; unalias -a; ` +
    `__oc_y=$(command -v stty); __oc_t=$("$__oc_y" -g </dev/tty); readonly __oc_y __oc_t; ` +
    "for o in '+o emacs' '+o vi' +B '+o history'; do command set $o 2>/dev/null; done; " +
    "command shopt -u expand_aliases 2>/dev/null\n",
}
const ARGV = { bash: ["/bin/bash", "--noprofile", "--norc", "--noediting", "-i"], sh: ["/bin/sh", "-i"] }
/** Variables the shell never takes from its host: they would run code at its start or turn options back on. */
const DROPPED = new Set(["ENV", "BASH_ENV", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS"])

const GUARD_MS = 200
const START_MS = 15_000
const HANGUP_MS = 2_000
/** The longest a reply waits, whatever it is asked. */
const WAIT_MAX_MS = 10 * 60_000

/** A control character a command can't hold: all but newline and tab. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** `env` for the shell: its prompts empty, no history file, and nothing that runs code or sets options at its start. */
function shellEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!DROPPED.has(key) && !key.startsWith("BASH_FUNC_") && !key.startsWith("__oc_")) out[key] = value
  }
  return { ...out, PS1: "", PS2: "", HISTFILE: "/dev/null" }
}

/** Where a possible marker starts at the end of `text`, held back for the next chunk; -1 when there's none. */
function heldFrom(text: string): number {
  const at = text.lastIndexOf("\x1b")
  if (at < 0 || text.length - at > MARK.length + MARK_TAIL) return -1
  const tail = text.slice(at)
  if (tail.length <= MARK.length) return MARK.startsWith(tail) ? at : -1
  return tail.startsWith(MARK) && !/[\x07\x1b]/.test(tail.slice(1)) ? at : -1
}

/** `text`'s UTF-8 bytes as a string of one char per byte, as the shell's output is parsed. */
const bytesOf = (text: string): string => Buffer.from(text, "utf8").toString("latin1")

/** A shell on a PTY that an agent drives and its owner can type into. */
export class PtyShell {
  private pty: PtyProcess | null = null
  private readonly view = new ModelView()
  private readonly decoder = new TextDecoder()
  private current: ShellState = { status: "starting", waiting: null, command: null, exit: null, error: null }
  /** The agent's running command's nonce. */
  private nonce: string | null = null
  /** The owner's command runs: one they started at the prompt. */
  private ownerRunning = false
  /** A Ctrl-C reached the agent's command: the shell's prompt ends it, nonce or not. */
  private interrupted = false
  /** The echo still to cut of the line the host typed, as bytes, and how much of it has come. */
  private echo: string | null = null
  private echoAt = 0
  /** A possible marker's start, held back for the next chunk, and how many guard checks it has waited. */
  private held = ""
  private heldChecks = 0
  /** The owner has typed keys since their last Enter, Ctrl-C or Ctrl-D: all the shell keeps of their keys, with the
   *  next two. */
  private ownerMidLine = false
  /** Those keys went to a secret prompt. */
  private ownerAtSecret = false
  /** A secret prompt ended under the owner's answer: their keys are dropped until their Enter. */
  private dropping = false
  /** What the agent typed without Enter since its last Enter, Ctrl-C or an owner key. */
  private agentLine = ""
  /** The terminal's line may hold what the agent typed without Enter, owner keys after it or not. */
  private agentDirty = false
  /** A kill (Ctrl-U) was sent since the last typed line: its echo may come before that line's. */
  private killSent = false
  /** sh's prompt marker is still to come after the agent's line printed its own. */
  private promptAfter = false
  /** Where the agent reads on from: the last reply's `next`. */
  private cursor = 0
  /** What came before the shell was ready, as bytes. */
  private startup = ""
  private ready: (() => void) | null = null
  private guardTimer: ReturnType<typeof setInterval> | null = null
  private readonly waiters = new Set<() => void>()
  /** How many secret prompts have held the shell: a reply's wait ends when one begins. */
  private holds = 0
  /** Settles once the shell's process has ended and the shell has taken its exit (or it never started). */
  private ended: Promise<void> = Promise.resolve()

  private constructor(
    readonly id: string,
    readonly name: string,
    private readonly host: ShellHost,
    private readonly kind: "bash" | "sh",
  ) {}

  /** Starts a shell on `host`'s PTY and resolves once it is ready at its prompt, or has failed (`state().error` says
   *  why, and the record ends failed). */
  static async open(
    id: string,
    name: string,
    host: ShellHost,
    size: { cols: number; rows: number } = { cols: 80, rows: 24 },
  ): Promise<PtyShell> {
    const shell = new PtyShell(id, name, host, host.shell ?? (fs.existsSync("/bin/bash") ? "bash" : "sh"))
    await shell.start(size)
    return shell
  }

  state(): ShellState {
    return { ...this.current }
  }

  /** The agent's unfinished line: what it typed without Enter since its last Enter, Ctrl-C or an owner key. */
  pendingLine(): string {
    return this.agentLine
  }

  /** Runs the agent's `command` and waits for its end, a secret prompt, `waitMs` or `signal`. Refused, with nothing
   *  typed, when the shell isn't idle, the owner is part-way through a line, the command is empty or holds a control
   *  character other than newline and tab, or a line of it would be over 1000 bytes. */
  async run(command: string, waitMs: number, signal?: AbortSignal): Promise<Reply> {
    const why = this.refuseRun(command)
    if (why !== null) return this.refused(why)
    const nonce = randomBytes(8).toString("hex")
    const quoted = `'${command.replaceAll("'", "'\\''")}'`
    const typed =
      this.kind === "bash"
        ? `eval ${quoted}; \\__oc_s ${nonce} $?\n`
        : `eval ${quoted}; __oc_r=$?; "$__oc_y" "$__oc_t" </dev/tty 2>/dev/null; ` +
          `printf '\\033]633;opencorp-mark;%s;%d\\007' ${nonce} "$__oc_r" >/dev/tty\n`
    if (typed.split("\n").some((line) => Buffer.byteLength(line) > LINE_MAX)) return this.refused(LONG_LINE)
    try {
      this.host.record.command(command, this.host.driver)
    } catch (error) {
      return this.refused(`the shell's record can't be written: ${(error as Error).message}`)
    }
    // A marker's start held back at the prompt was output after all; the echo must come first.
    this.emit(this.held)
    this.held = ""
    // From where the agent last read, so what came in between (the owner's command, say) is read once.
    const start = this.cursor
    this.nonce = nonce
    this.interrupted = false
    this.echo = bytesOf(typed).replaceAll("\n", "\r\n")
    this.echoAt = 0
    this.emit(bytesOf(`$ ${command.replaceAll("\n", "\r\n")}\r\n`))
    this.set({ status: "running", waiting: null, command, exit: null })
    this.write(typed)
    await this.wait(waitMs, signal)
    return this.reply(start)
  }

  /** Types `text` (printable ASCII, at most 1000 bytes on a line) into the running command, with Enter when `enter`,
   *  and waits as `run` does. Refused at a secret prompt, while the owner is part-way through a line, and when
   *  nothing runs. */
  async type(text: string, opts: { enter: boolean; waitMs: number; signal?: AbortSignal }): Promise<Reply> {
    // The screen as it is now, not at the last check: a read may have turned echo off since.
    this.guard()
    const { status } = this.current
    if (status === "waiting") return this.refused(SECRET)
    if (status !== "running") return this.refused("nothing is running in this shell to type into; run a command")
    if (this.ownerMidLine) return this.refused(OWNER_TYPING)
    if (!/^[\x20-\x7e]*$/.test(text)) {
      return this.refused("type takes printable ASCII only; interrupt sends Ctrl-C")
    }
    if (this.agentLine.length + text.length > LINE_MAX) {
      return this.refused("a typed line would be over 1000 bytes, and a terminal cuts longer lines")
    }
    const from = this.cursor
    this.agentLine = opts.enter ? "" : this.agentLine + text
    this.agentDirty = !opts.enter && (this.agentDirty || text !== "")
    this.write(opts.enter ? `${text}\r` : text)
    await this.wait(opts.waitMs, opts.signal)
    return this.reply(from)
  }

  /** The model's view from `from` (the last reply's `next` by default), once the running command ends, a secret
   *  prompt holds it, `waitMs` passes or `signal` aborts; at once when nothing runs. */
  async read(opts: { waitMs: number; from?: number; signal?: AbortSignal }): Promise<Reply> {
    const from = opts.from ?? this.cursor
    await this.wait(opts.waitMs, opts.signal)
    return this.reply(from)
  }

  /** Sends Ctrl-C to the agent's own running command. Refused when nothing runs, or the command is the owner's. */
  interrupt(): Reply {
    if (this.current.status === "waiting") return this.refused(OWNER_SECRET)
    if (this.ownerMidLine) return this.refused(OWNER_TYPING)
    if (this.nonce === null) {
      const why = this.ownerRunning ? "the running command is the owner's; only they can stop it" : "nothing is running"
      return this.refused(why)
    }
    this.interrupted = true
    this.agentLine = ""
    this.agentDirty = false
    this.write("\x03")
    return this.reply(this.cursor)
  }

  /** Writes the owner's keys to the PTY, straight to the running command. The shell keeps only whether the owner is
   *  part-way through a line, and whether at a secret prompt; an Enter at the prompt starts the owner's command. While
   *  a secret prompt that ended under their answer is being dropped, their keys up to their Enter go nowhere. */
  ownerKeys(data: string): void {
    const { status } = this.current
    if (status === "starting" || status === "ended" || status === "failed") return
    this.agentLine = ""
    let keys = ""
    for (const key of data) {
      const ends = key === "\r" || key === "\n" || key === "\x03" || key === "\x04"
      if (this.dropping) {
        if (ends) this.dropping = this.ownerMidLine = false
        continue
      }
      keys += key
      if (!ends) {
        this.ownerMidLine = true
        if (this.current.status === "waiting") this.ownerAtSecret = true
        continue
      }
      this.ownerMidLine = this.ownerAtSecret = false
      if (key === "\x03" && this.nonce !== null) this.interrupted = true
      if ((key === "\r" || key === "\n") && this.current.status === "idle") {
        this.ownerRunning = true
        this.set({ status: "running", waiting: null, command: null, exit: null })
      }
    }
    if (keys !== "") this.write(keys)
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // The terminal has closed: the shell has ended.
    }
  }

  /** Ends the shell: SIGHUP to its process group, then SIGKILL after 2 s; resolves once it has ended. */
  async close(): Promise<void> {
    const pty = this.pty
    if (pty === null || this.current.status === "ended" || this.current.status === "failed") return await this.ended
    pty.kill("SIGHUP")
    const kill = setTimeout(() => pty.kill("SIGKILL"), HANGUP_MS)
    await this.ended
    clearTimeout(kill)
  }

  private async start(size: { cols: number; rows: number }): Promise<void> {
    this.host.record.follow(this.view)
    let pty: PtyProcess
    try {
      const env = shellEnv(this.host.env)
      pty = this.host.start(ARGV[this.kind], { ...size, env, onData: (chunk) => this.onData(chunk) })
    } catch (error) {
      this.fail(`the shell couldn't start: ${(error as Error).message}`)
      return
    }
    this.pty = pty
    this.ended = pty.exited.then(
      (code) => this.onExit(code),
      () => this.onExit(null),
    )
    this.write(SETUP[this.kind])
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      this.ready = resolve
      const late = () => this.fail(`the shell wasn't ready within ${START_MS / 1000} s${this.startupTail()}`)
      timer = setTimeout(late, START_MS)
    })
    clearTimeout(timer)
  }

  /** What the PTY printed: before the shell is ready, its start-up; then the wrapper's echo is cut, markers are taken
   *  out and acted on, and the rest goes to both views. */
  private onData(chunk: Uint8Array): void {
    let text = this.held + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1")
    this.held = ""
    this.heldChecks = 0
    if (this.current.status === "starting") {
      const rest = this.started(text)
      if (rest === null) return
      text = rest
    }
    if (this.current.status === "failed") return
    text = this.cutEcho(text)
    let at = 0
    for (const match of text.matchAll(MARKER)) {
      this.emit(this.neutral(text.slice(at, match.index)))
      at = match.index + match[0].length
      this.marker(match[1]!, match[2]!)
    }
    let rest = text.slice(at)
    const hold = this.holdFrom(rest)
    if (hold >= 0) {
      this.held = rest.slice(hold)
      rest = rest.slice(0, hold)
    }
    this.emit(this.neutral(rest))
    this.guard()
  }

  /** Where the end of `text` may be cut short, to hold back for the next chunk: a marker's start, or the start of the
   *  running command's nonce; -1 when it isn't. */
  private holdFrom(text: string): number {
    const marker = heldFrom(text)
    if (marker >= 0 || this.nonce === null) return marker
    for (let n = Math.min(this.nonce.length - 1, text.length); n > 0; n--) {
      if (this.nonce.startsWith(text.slice(-n))) return text.length - n
    }
    return -1
  }

  /** Takes start-up output until the first marker: then the shell is ready, if its line editing is off (echo and
   *  whole lines on), and what followed the marker is returned. Null until then, or when the start failed. */
  private started(text: string): string | null {
    this.startup = (this.startup + text).slice(-64 * 1024)
    const found = READY.exec(this.startup)
    if (found === null) return null
    const rest = this.startup.slice(found.index + found[0].length)
    this.startup = ""
    const modes = this.pty!.modes()
    if (!modes.echo || !modes.canonical) {
      this.fail("the shell's line editing couldn't be turned off")
      return null
    }
    this.set({ status: "idle" })
    this.ready?.()
    return rest
  }

  /** Cuts the echo of the line the host typed from the front of `text`: exact, since the shell has no line editing.
   *  A kill's echo may come first, and stays. Other output first stops the cut, and the rest of the echo shows, as on
   *  screen, its nonce neutralised. */
  private cutEcho(text: string): string {
    if (this.echo === null) return text
    let start = 0
    if (this.echoAt === 0 && this.killSent) while (start < text.length && KILL_ECHO.includes(text[start]!)) start += 1
    let at = start
    while (at < text.length && this.echoAt < this.echo.length && text[at] === this.echo[this.echoAt]) {
      at += 1
      this.echoAt += 1
    }
    if (this.echoAt > 0) this.killSent = false
    if (this.echoAt === this.echo.length || at < text.length) this.echo = null
    return text.slice(0, start) + text.slice(at)
  }

  /** `text` with the agent's command's nonce neutralised. */
  private neutral(text: string): string {
    return this.nonce !== null && text.includes(this.nonce) ? text.replaceAll(this.nonce, NONCE_SHOWN) : text
  }

  /** A marker with `nonce` and `exitText`: the end of the agent's command when it holds its nonce (or none, after a
   *  Ctrl-C), or of the owner's when it holds none. Any other is ignored. */
  private marker(nonce: string, exitText: string): void {
    const exit = /^-?\d+$/.test(exitText) ? Number(exitText) : null
    if (nonce === "" && this.promptAfter) {
      // sh's prompt after the agent's line, which already ended it: never the end of a command started since.
      this.promptAfter = false
      return
    }
    if (this.nonce !== null) {
      if (nonce !== this.nonce && !(nonce === "" && this.interrupted)) return
      this.promptAfter = this.kind === "sh" && nonce !== ""
      try {
        this.host.record.exit(exit)
      } catch {
        // meta.json can't be written now; the record keeps the exit for its next write.
      }
    } else if (!(nonce === "" && this.ownerRunning)) return
    this.settle()
    this.set({ status: "idle", waiting: null, command: null, exit })
  }

  /** Clears what a command held: its nonce, its echo, and the agent's unfinished line, which a kill (Ctrl-U) takes off
   *  the terminal's line too, with any owner keys after it. */
  private settle(): void {
    this.nonce = null
    this.ownerRunning = false
    this.interrupted = false
    this.echo = null
    this.agentLine = ""
    if (this.agentDirty) this.kill()
    this.agentDirty = false
  }

  /** Kills the terminal's unfinished line (Ctrl-U), which the prompt's line settings make the kill key. The owner's
   *  keys on it go too; whether they went to a secret prompt still counts, for `drop`. */
  private kill(): void {
    this.write("\x15")
    this.killSent = true
    this.ownerMidLine = false
  }

  /** Holds the shell for the owner while the screen asks a secret, and lets it go once it doesn't. */
  private guard(): void {
    const { status } = this.current
    if ((status !== "running" && status !== "waiting") || this.pty === null) return
    const waiting = ownerPrompt(this.lastLine(), this.pty.modes())
    if (waiting !== this.current.waiting) this.set({ status: waiting ? "waiting" : "running", waiting })
  }

  /** The tail of the view's unfinished last line: as much as a prompt check needs. */
  private lastLine(): string {
    const length = this.view.length
    const start = Math.max(this.view.page(length).next, length - 4096)
    return length > start ? this.view.page(start, length - start).output : ""
  }

  /** Sends `text` (bytes, one char each) to the owner's live view and the model's. */
  private emit(text: string): void {
    if (text === "") return
    const bytes = Buffer.from(text, "latin1")
    this.host.output(bytes)
    this.view.append(this.decoder.decode(bytes, { stream: true }))
  }

  private write(data: string): void {
    try {
      this.pty?.write(data)
    } catch {
      // The terminal has closed: the exit settles the state.
    }
  }

  /** Updates the state, tells the host, runs the guard's timer while a command runs, and wakes waiting replies. */
  private set(change: Partial<ShellState>): void {
    const next = { ...this.current, ...change }
    const same = (Object.keys(next) as (keyof ShellState)[]).every((key) => next[key] === this.current[key])
    if (next.status === "waiting" && this.current.status !== "waiting") this.holds += 1
    const dropping = this.current.status === "waiting" && next.status !== "waiting" && this.ownerAtSecret
    this.current = next
    if (same) return
    if (dropping && next.status !== "ended" && next.status !== "failed") this.drop()
    const busy = next.status === "running" || next.status === "waiting"
    if (busy && this.guardTimer === null) this.guardTimer = setInterval(() => this.check(), GUARD_MS)
    if (!busy && this.guardTimer !== null) {
      clearInterval(this.guardTimer)
      this.guardTimer = null
    }
    this.host.changed(this.state())
    for (const waiter of [...this.waiters]) waiter()
  }

  /** A secret prompt ended under the owner's answer: kills the line they were typing and drops their keys up to their
   *  Enter, telling them so. */
  private drop(): void {
    this.emit(bytesOf(DROPPED_NOTE))
    this.kill()
    this.ownerAtSecret = false
    this.dropping = this.ownerMidLine = true
  }

  /** The guard's timed check; a possible marker's start held through a whole check is plain output after all. */
  private check(): void {
    if (this.held !== "" && this.heldChecks++ > 0) {
      const held = this.held
      this.held = ""
      this.emit(this.neutral(held))
    }
    this.guard()
  }

  /** Resolves once the command ends (or the shell does), a secret prompt begins to hold it, `waitMs` passes or `signal`
   *  aborts; at once when nothing runs. A wait that starts while a prompt holds waits for what comes after it. */
  private wait(waitMs: number, signal?: AbortSignal): Promise<void> {
    const holds = this.holds
    const over = () => this.holds !== holds || (this.current.status !== "running" && this.current.status !== "waiting")
    return new Promise((resolve) => {
      if (over() || signal?.aborted) return resolve()
      const ms = Number.isFinite(waitMs) ? Math.min(Math.max(0, waitMs), WAIT_MAX_MS) : 0
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", done)
        this.waiters.delete(check)
        resolve()
      }
      const check = () => {
        if (over()) done()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener("abort", done)
      this.waiters.add(check)
    })
  }

  /** Why the agent can't run a command now, or null when it can. */
  private refuseRun(command: string): string | null {
    const { status, error } = this.current
    if (status === "failed") return `the shell failed to start: ${error}`
    if (status === "ended") return "the shell has ended; start a new one"
    if (status === "starting") return "the shell is still starting"
    if (status === "waiting") return SECRET
    if (status === "running" && this.ownerRunning) return "the owner's command is running; call read to follow it"
    if (status === "running") {
      return "a command is still running in this shell; call read to follow it, type to answer it, or interrupt it"
    }
    if (this.ownerMidLine) return OWNER_TYPING
    if (command.trim() === "") return "the command is empty"
    if (CONTROL.test(command)) {
      return "a command can't hold a control character other than newline and tab"
    }
    return null
  }

  /** The state and the view from `from`; the agent reads on from its `next`. */
  private reply(from: number): Reply {
    const page = this.view.page(from)
    this.cursor = page.next
    const { status, exit, waiting } = this.current
    const { output, next, more } = page
    const reply: Reply = { shell: this.id, status, exit, waiting, output, next, more }
    if (page.skipped !== undefined) reply.skipped = page.skipped
    return reply
  }

  private refused(why: string): Reply {
    const { status, exit, waiting } = this.current
    return { shell: this.id, status, exit, waiting, output: "", next: this.cursor, more: false, refused: why }
  }

  /** The shell's process has ended: what it held back is output, and the shell ends with its exit code. */
  private onExit(code: number | null): void {
    if (this.current.status === "starting") {
      this.fail(`the shell exited before it was ready${this.startupTail()}`)
      return
    }
    if (this.current.status === "failed") return
    const held = this.held
    this.held = ""
    this.emit(this.neutral(held))
    this.view.append(this.decoder.decode())
    if (this.nonce !== null) {
      try {
        this.host.record.exit(code)
      } catch {
        // As in `marker`: the record's end saves it.
      }
    }
    this.settle()
    this.set({ status: "ended", waiting: null, command: null, exit: code })
    try {
      this.host.record.end("ended")
    } catch {
      // meta.json can't be written; output.log is complete and closed.
    }
  }

  /** The shell couldn't start: it ends failed, with `error`, and its process is killed. */
  private fail(error: string): void {
    if (this.current.status !== "starting") return
    this.set({ status: "failed", error })
    this.pty?.kill("SIGKILL")
    this.pty?.close()
    try {
      this.host.record.end("failed", error)
    } catch {
      // As in `onExit`.
    }
    this.ready?.()
  }

  /** The last of what the shell printed while starting, its set-up line's echo left out, for a failure's message. */
  private startupTail(): string {
    const plain = new PlainText().push(Buffer.from(this.startup, "latin1").toString("utf8"))
    const text = plain.replaceAll(SETUP[this.kind].trim(), "").trim().slice(-300)
    return text === "" ? "" : `: ${text}`
  }
}

/** The terminal's pipes shell, for an employee's workspace: each command its own sandboxed call, with no terminal and
 *  no input, which an agent drives and the owner watches and can interrupt.
 *
 *  **One stream.** A command runs as `exec 2>&1; <command>` in a sandboxed `/bin/sh -c`, so its stdout and stderr
 *  share one pipe and reach the model's view, the owner's live view and the record in the order they were written,
 *  as on a terminal: two pipes read by two handlers can reorder lines. Its input is empty (`/dev/null`), so `type` is
 *  refused.
 *
 *  **The PTY shell's contract.** It has `PtyShell`'s states, replies and record, so the terminal's tools treat both
 *  alike.
 *  - `$ <command>` heads each command's output. It follows the last command's output where that ended, on the same
 *    line when the output ended inside one, as a prompt does on a terminal.
 *  - The model reads the output as a terminal shows it (`ModelView`). A reply starts where the agent last read, so
 *    output that came after a reply is read once, in the next read or run.
 *  - The record keeps that view and each command's exit, as a shell's `$?` gives it; an interrupted command's exit is
 *    null, as is one whose call couldn't run.
 *  - OpenCorp scrubs nothing here.
 *
 *  **Each command is its own call.** It starts in the workspace, with the sandbox's environment: no folder or
 *  variable carries over, so the folder the gate reads for a command is always the workspace, whatever the last one
 *  `cd`ed to; only a `cd` earlier in the same command moves it. It runs until it ends, is interrupted, or the shell
 *  closes; then its call's process group is killed, so nothing it left in the background outlives it (`run`). A call
 *  that couldn't run ends its command with a note in brackets saying why, and the shell runs on; where the sandbox
 *  can't run at all, the shell fails.
 *
 *  **Two interrupts.** The agent's `interrupt` returns a page from where it last read; the owner's Ctrl-C
 *  (`ownerKeys`) only stops the command, and leaves the agent's place as it was. */
import { type Result, type RunOptions, SandboxUnavailable } from "../../runtime/sandbox/run.ts"
import { ModelView } from "./output.ts"
import { peekView, type Reply, type ShellHost, type ShellState } from "./shell.ts"

/** What a pipes shell's host binds: how a command runs, and the record, driver and listeners a PTY shell's host binds
 *  too. */
export interface PipeHost extends Pick<ShellHost, "record" | "driver" | "changed" | "output"> {
  /** Runs `argv` as one sandboxed call: `run` from runtime/sandbox, with the workspace's policy and the host's
   *  tracking. */
  run(argv: readonly string[], options: RunOptions): Promise<Result>
}

const NO_INPUT = "this shell takes no input"
/** The longest command, in bytes: well within what one argument may hold (128 KiB on Linux). */
const COMMAND_MAX = 64 * 1024
/** `run`'s longest timeout (about 24.8 days): a command runs until it ends or is stopped, as in a PTY shell. */
const NO_TIMEOUT_S = 2_147_483
/** The longest a reply waits, whatever it is asked. */
const WAIT_MAX_MS = 10 * 60_000

/** A control character a command can't hold: all but newline and tab, as in a PTY shell. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** A shell with no terminal that runs each of an agent's commands as its own sandboxed call. */
export class PipeShell {
  private readonly view = new ModelView()
  private current: ShellState = { status: "starting", waiting: null, command: null, exit: null, error: null }
  /** Stops the running command's call; null while none runs. */
  private call: AbortController | null = null
  /** Settles once the running command's call has ended. */
  private settled: Promise<void> = Promise.resolve()
  private closing = false
  /** Where the agent reads on from: the last reply's `next`. */
  private cursor = 0
  private readonly waiters = new Set<() => void>()

  private constructor(
    readonly id: string,
    readonly name: string,
    private readonly host: PipeHost,
  ) {}

  /** A pipes shell on `host`, idle at once: nothing runs until its first command. */
  static open(id: string, name: string, host: PipeHost): PipeShell {
    const shell = new PipeShell(id, name, host)
    host.record.follow(shell.view)
    shell.set({ status: "idle" })
    return shell
  }

  state(): ShellState {
    return { ...this.current }
  }

  /** Always empty: this shell takes no input. */
  pendingLine(): string {
    return ""
  }

  /** Runs the agent's `command` as its own sandboxed call and waits for its end, `waitMs` or `signal`. Refused, with
   *  nothing run, when the shell isn't idle, the command is empty, holds a control character other than newline and
   *  tab, or is over 64 KiB. */
  async run(command: string, waitMs: number, signal?: AbortSignal): Promise<Reply> {
    const why = this.runProblem(command)
    if (why !== null) return this.refusal(why)
    try {
      this.host.record.command(command, this.host.driver)
    } catch (error) {
      return this.refusal(`the shell's record can't be written: ${(error as Error).message}`)
    }
    // From where the agent last read, so what came in between (the end of a command it left running) is read once.
    const start = this.cursor
    const call = new AbortController()
    this.call = call
    this.show(`$ ${command}\n`)
    this.set({ status: "running", command, exit: null })
    this.settled = this.runCall(command, call.signal)
    await this.wait(waitMs, signal)
    return this.reply(start)
  }

  /** Refused: the shell has no input to type into. */
  type(text: string, _opts: { enter: boolean; waitMs: number; signal?: AbortSignal }): Promise<Reply> {
    return Promise.resolve(this.refusal(this.typeProblem(text)))
  }

  /** The model's view from `from` (the last reply's `next` by default), once the running command ends, `waitMs`
   *  passes or `signal` aborts; at once when nothing runs. */
  async read(opts: { waitMs: number; from?: number; signal?: AbortSignal }): Promise<Reply> {
    const from = opts.from ?? this.cursor
    await this.wait(opts.waitMs, opts.signal)
    return this.reply(from)
  }

  /** The agent's interrupt: stops the running command, killing its call's process group, and returns the view from
   *  where the agent last read. Refused when nothing runs. */
  interrupt(): Reply {
    if (this.call === null) return this.refusal("nothing is running")
    this.call.abort()
    return this.reply(this.cursor)
  }

  /** The owner's keys. A Ctrl-C among them stops the running command, as the agent's interrupt does, and leaves the
   *  agent's place in the view where it was. Every other key goes nowhere: the shell takes no input, and its host
   *  refuses them. */
  ownerKeys(data: string): void {
    if (data.includes("\x03")) this.call?.abort()
  }

  /** Stops the running command for a call cut off, as the owner's Ctrl-C does. */
  stop(): void {
    this.call?.abort()
  }

  /** Ends the shell, stopping a running command; resolves once its call has ended. */
  async close(): Promise<void> {
    if (this.closing || this.current.status === "failed") return await this.settled
    this.closing = true
    this.call?.abort()
    await this.settled
    // The call may have failed the shell meanwhile.
    if (this.state().status === "failed") return
    this.set({ status: "ended", command: null })
    try {
      this.host.record.end("ended")
    } catch {
      // meta.json can't be written; output.log is complete and closed.
    }
  }

  /** Runs `command`'s call, streaming its output to both views; then the command ends with its exit. A call that
   *  couldn't run ends it with a note saying why, and fails the shell when the sandbox can't run at all. */
  private async runCall(command: string, signal: AbortSignal): Promise<void> {
    // One decoder per stream, so a character split across one stream's chunks never takes the other's bytes.
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    // The call's output so far ends inside a line: a note goes on a line of its own.
    let open = false
    let result: Result | undefined
    let failure: unknown
    try {
      result = await this.host.run(["/bin/sh", "-c", `exec 2>&1; ${command}`], {
        signal,
        timeout: NO_TIMEOUT_S,
        // The view and the record keep the output; the call's result keeps none of it.
        maxOutput: 0,
        onOutput: (stream, chunk) => {
          if (chunk.length > 0) open = chunk[chunk.length - 1] !== 0x0a
          this.host.output(chunk)
          this.view.append(decoders[stream].decode(chunk, { stream: true }))
        },
      })
    } catch (error) {
      failure = error
    }
    this.view.append(decoders.stdout.decode() + decoders.stderr.decode())
    // `run` gives a signal's end as minus the signal; a shell's `$?` gives it as 128 plus the signal.
    let exit: number | null = null
    if (result !== undefined) exit = result.exit !== null && result.exit < 0 ? 128 - result.exit : result.exit
    try {
      this.host.record.exit(exit)
    } catch {
      // meta.json can't be written now; the record keeps the exit for its next write.
    }
    this.call = null
    if (result === undefined) {
      const message = (failure as Error).message
      // Only a sandbox that can't run here fails the shell; a spawn or tracking error fails this call alone.
      const why =
        failure instanceof SandboxUnavailable
          ? `the sandbox can't run commands here: ${message}`
          : `this command couldn't run: ${message}`
      this.show(`${open ? "\n" : ""}[${why}]\n`)
      if (failure instanceof SandboxUnavailable) return this.fail(why)
    }
    this.set({ status: this.closing ? "ended" : "idle", command: null, exit })
  }

  /** Puts the shell's own text (a command's head, a note) in the owner's live view and the model's. */
  private show(text: string): void {
    this.host.output(Buffer.from(text))
    this.view.append(text)
  }

  /** Updates the state, tells the host, and wakes waiting replies. */
  private set(change: Partial<ShellState>): void {
    const next = { ...this.current, ...change }
    const same = (Object.keys(next) as (keyof ShellState)[]).every((key) => next[key] === this.current[key])
    this.current = next
    if (same) return
    this.host.changed(this.state())
    for (const waiter of [...this.waiters]) waiter()
  }

  /** Resolves once the command ends (or the shell does), `waitMs` passes or `signal` aborts; at once when nothing
   *  runs. */
  private wait(waitMs: number, signal?: AbortSignal): Promise<void> {
    const over = () => this.current.status !== "running"
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

  /** Why the agent's `command` can't run in a pipes shell whatever its state, or null: it is empty, holds a control
   *  character other than newline and tab, or is over 64 KiB. */
  static commandProblem(command: string): string | null {
    if (command.trim() === "") return "the command is empty"
    if (CONTROL.test(command)) return "a command can't hold a control character other than newline and tab"
    if (Buffer.byteLength(command) > COMMAND_MAX) {
      return "this command is over 64 KiB: write a script with the file tools and run it"
    }
    return null
  }

  /** Why `run` would refuse `command` now, with nothing run, or null: the shell isn't idle, or the command can't run
   *  (`commandProblem`). */
  runProblem(command: string): string | null {
    const { status, error } = this.current
    if (status === "failed") return `the shell failed: ${error}`
    if (status === "ended" || this.closing) return "the shell has ended; start a new one"
    if (status === "running") return "a command is still running in this shell; call read to follow it, or interrupt it"
    return PipeShell.commandProblem(command)
  }

  /** Why `type` refuses `text`: always, since this shell takes no input. */
  typeProblem(_text: string): string {
    return NO_INPUT
  }

  /** Where the model's view ends now: where a command started here begins. */
  viewEnd(): number {
    return this.view.length
  }

  /** The model's view from `from` to its end, at most its last `max` characters, where that text starts, and where
   *  the agent reads on from; the agent's place doesn't move. */
  peek(from: number, max: number): { output: string; start: number; cursor: number } {
    return peekView(this.view, from, max, this.cursor)
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

  /** A reply saying why nothing was done, with the shell's state, from where the agent last read. */
  refusal(why: string): Reply {
    const { status, exit, waiting } = this.current
    return { shell: this.id, status, exit, waiting, output: "", next: this.cursor, more: false, refused: why }
  }

  /** The sandbox can't run here: the shell fails with `error`, and its record ends failed. */
  private fail(error: string): void {
    this.set({ status: "failed", command: null, exit: null, error })
    try {
      this.host.record.end("failed", error)
    } catch {
      // As in `close`.
    }
  }
}

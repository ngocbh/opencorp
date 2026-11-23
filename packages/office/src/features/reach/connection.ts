/** OpenCorp's connection shell: the PTY where learning's chain test runs reach.sh and then the node master, so ssh's
 *  prompts (a password, Duo, a host key) reach the owner in the chat, where the shell opens itself at a password. It
 *  runs with no sandbox and the visit's config, as every visit's replay and master do; OpenCorp drives it, ungated,
 *  and the agent has no tool that reaches it. Its record goes to the session's folder.
 *
 *  The shell is listed in the session as "OpenCorp's connection", and outlives it: the host removes the listing when
 *  the session ends without closing the shell, the visit then holds the tunnel running in it, and closes it at the
 *  visit's end. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { now } from "@opencorp/protocol"
import { spawnPty } from "../../platform.ts"
import type { SessionBinding } from "../../runtime/sessions/builtin.ts"
import { shellInstrument } from "../../tools/terminal/instrument.ts"
import { InstrumentRecord } from "../../tools/terminal/record.ts"
import { PtyShell } from "../../tools/terminal/shell.ts"
import { newId } from "../../util/ids.ts"
import { checkFolder, makePrivateFolder, replaceFile } from "../../util/private_files.ts"
import { type Connection, connect, describe, ReachFailure } from "./connect.ts"
import type { Spec } from "./spec.ts"
import {
  KEEP_CHARS,
  knowsSessionOptions,
  type Master,
  masterArgv,
  type ReachContext,
  readStatuses,
  resetStatus,
  sshEnv,
  tailChars,
} from "./ssh.ts"
import { classify, type Reached } from "./tools/replay.ts"

/** The shell's name, as the chat lists it. */
export const CONNECTION = "OpenCorp's connection"
/** Who runs its commands, as its record names them. */
const DRIVER = "opencorp"
/** How long a stopped command has to end before the shell is closed under it. */
const STOP_MS = 2000

/** What OpenCorp's connection shell is made from. */
export interface ConnectionShellOptions {
  /** The visit's context: hq's paths, the real ssh, the env its children get a part of, the limits and its stop. */
  readonly ctx: ReachContext
  /** The session's folder: the shell's record goes to `<folder>/terminal/<id>/`. */
  readonly folder: string
  /** The session's id, which the listing names. */
  readonly sessionId: string
  /** Where the shell is listed: the session's instruments, whose listing the host removes at its end. */
  readonly instruments: SessionBinding["instruments"]
}

/** How a command OpenCorp ran in the shell ended: its exit (null when a signal ended it, or the shell did), whether
 *  it ran out of time or was stopped, and the screen it printed. */
interface Ran {
  readonly exit: number | null
  readonly stopped: boolean
  readonly screen: string
}

/** OpenCorp's connection shell; see the module's doc. A PTY shell is opened, and listed, on first use, and again
 *  after the last one has ended. */
export class ConnectionShell {
  #shell: PtyShell | null = null
  #id: string | null = null
  #tmpdir: string | null = null
  #closed = false

  constructor(private readonly o: ConnectionShellOptions) {}

  /** The shell running now, if any. */
  get shell(): PtyShell | null {
    return this.#shell
  }

  /** The shell, opened and listed when there's none or the last has ended. Throws once closed, or when it can't
   *  start. */
  async #open(): Promise<PtyShell> {
    if (this.#closed) throw new Error("OpenCorp's connection shell has closed")
    const status = this.#shell?.state().status
    if (this.#shell !== null && status !== "ended" && status !== "failed") return this.#shell
    this.#unlist()
    const { ctx, folder, instruments } = this.o
    this.#tmpdir ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-connection-")))
    const records = path.join(folder, "terminal")
    for (const dir of [folder, records]) {
      makePrivateFolder(dir)
      checkFolder(dir, "folder")
    }
    const id = newId()
    const meta = { id, name: CONNECTION, kind: "terminal" as const, profile: "none", driver: DRIVER, started: now() }
    const record = new InstrumentRecord(path.join(records, id), meta)
    const env = { ...sshEnv(ctx), TMPDIR: this.#tmpdir, LANG: "en_US.UTF-8", TERM: "xterm-256color" }
    this.#id = id
    instruments.add(
      shellInstrument({
        sessionId: this.o.sessionId,
        id,
        name: CONNECTION,
        driver: DRIVER,
        profile: "none",
        interactive: true,
        shell: () => (this.#id === id ? (this.#shell ?? undefined) : undefined),
      }),
    )
    const shell = await PtyShell.open(id, CONNECTION, {
      start: (argv, io) => spawnPty(argv, { cwd: ctx.paths.dir, env: io.env, cols: io.cols, rows: io.rows, onData: io.onData }),
      env,
      record,
      driver: DRIVER,
      changed: () => this.#tell((list) => list.updated(id)),
      output: (chunk) => this.#tell((list) => list.output(id, chunk)),
    })
    this.#shell = shell
    this.#tell((list) => list.updated(id))
    const error = shell.state().error
    if (shell.state().status === "failed") throw new Error(error ?? "OpenCorp's connection shell didn't start")
    return shell
  }

  /** Calls `fn` on the session's instruments; after the session has ended, its host ignores it. */
  #tell(fn: (list: SessionBinding["instruments"]) => void): void {
    try {
      fn(this.o.instruments)
    } catch {}
  }

  /** Takes the last shell's listing out of the session. */
  #unlist(): void {
    if (this.#id !== null) {
      const id = this.#id
      this.#tell((list) => list.remove(id))
    }
    this.#id = null
  }

  /** Runs `command` in the shell, OpenCorp driving it, and resolves once it ends, `limitMs` pass or `signal`
   *  aborts; then it is stopped: a Ctrl-C, or, at a secret prompt or when that doesn't end it, the shell's close. */
  async #run(command: string, limitMs: number, signal?: AbortSignal): Promise<Ran> {
    const shell = await this.#open()
    const deadline = performance.now() + limitMs
    const left = () => Math.max(0, deadline - performance.now())
    let reply = await shell.run(command, left(), signal)
    if (reply.refused !== undefined) throw new Error(`OpenCorp's connection shell refused the command: ${reply.refused}`)
    let screen = reply.output
    const busy = () => ["running", "waiting"].includes(shell.state().status)
    while (busy() && left() > 0 && !signal?.aborted) {
      reply = await shell.read({ waitMs: left(), signal })
      screen += reply.output
    }
    const stopped = busy()
    if (stopped) {
      if (shell.interrupt().refused === undefined) await shell.read({ waitMs: STOP_MS })
      if (busy()) await shell.close()
    }
    return { exit: shell.state().status === "idle" ? shell.state().exit : null, stopped, screen }
  }

  /** Runs `bytes`, reach.sh as checked, as a visit's replay does, here: from a private copy in the hq folder (0600,
   *  unique to this run, removed after), its stdin from /dev/null and its stdout to the shell's temp folder, for up to
   *  `promptMs` or until `signal` (the card's, which Esc stops; the visit's by default) aborts; then classifies the
   *  run with the exits the wrapper recorded, its stderr being what the screen showed. */
  async replay(bytes: Uint8Array, signal: AbortSignal | undefined = this.o.ctx.signal): Promise<Reached> {
    const { ctx } = this.o
    const name = `.reach-${process.pid}-${randomBytes(4).toString("hex")}.sh`
    replaceFile(ctx.paths.dir, name, bytes)
    const copy = path.join(ctx.paths.dir, name)
    try {
      resetStatus(ctx)
      const ran = await this.#run(`sh ${quoted(copy)} </dev/null >"$TMPDIR/spec.out"`, ctx.limits.promptMs, signal)
      const out = path.join(this.#tmpdir!, "spec.out")
      let stdout = ""
      try {
        stdout = tailChars(fs.readFileSync(out, "utf8"), KEEP_CHARS)
      } catch {}
      fs.rmSync(out, { force: true })
      const exit = ran.exit ?? 255
      return classify({ code: exit, stdout, stderr: ran.screen, timedOut: ran.stopped }, readStatuses(ctx))
    } finally {
      fs.rmSync(copy, { force: true })
    }
  }

  /** The node master for `spec`, as the shell's running command: `masterArgv` with the visit's config, after any
   *  leftover `cm/node` goes. It ends when the shell's command ends (a drop). `kill` stops it with a Ctrl-C, and
   *  closes the shell when that hasn't ended it within `STOP_MS`. */
  async master(spec: Spec): Promise<Master> {
    const { ctx } = this.o
    const { paths } = ctx
    fs.rmSync(paths.node, { force: true })
    const argv = masterArgv(ctx.ssh, spec, {
      config: paths.config,
      socket: paths.node,
      sessionOptions: knowsSessionOptions(ctx.ssh),
    })
    const shell = await this.#open()
    const reply = await shell.run(argv.map(quoted).join(" "), 0)
    if (reply.refused !== undefined) throw new Error(`OpenCorp's connection shell refused the master: ${reply.refused}`)
    const exited = new Promise<number>((resolve) => {
      const check = () => {
        const state = shell.state()
        if (state.status === "running" || state.status === "waiting") return false
        resolve(state.status === "idle" ? (state.exit ?? 255) : 255)
        return true
      }
      if (check()) return
      const timer = setInterval(() => {
        if (check()) clearInterval(timer)
      }, 100)
    })
    return {
      exited,
      socket: paths.node,
      kill: () => {
        // Ended already: nothing to stop, and the shell stays for the next try.
        const busy = () => ["running", "waiting"].includes(shell.state().status)
        if (!busy()) return
        if (shell.interrupt().refused !== undefined) return void shell.close()
        setTimeout(() => {
          if (busy()) void shell.close()
        }, STOP_MS).unref?.()
      },
    }
  }

  /** Ends the shell and what runs in it, and removes its listing and temp folder. Never rejects. */
  async close(): Promise<void> {
    this.#closed = true
    try {
      await this.#shell?.close()
    } catch {}
    this.#unlist()
    if (this.#tmpdir !== null) fs.rmSync(this.#tmpdir, { recursive: true, force: true })
  }
}

/** `word` single-quoted for the shell. */
const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/** The chain test on `bytes`, reach.sh as it will be saved, in OpenCorp's connection shell: the replay, then the
 *  connection a visit makes, its node master running in the shell. Resolves to the open connection, or to why it
 *  failed, naming the step; a failed connect has ended only the node master, so a retry rides the login node's. */
export async function chainTest(
  shell: ConnectionShell,
  bytes: Uint8Array,
  port: number,
  ctx: ReachContext,
): Promise<Connection | string> {
  const reached = await shell.replay(bytes, ctx.signal)
  ctx.signal?.throwIfAborted()
  if (reached.outcome !== "ok") return `reach.sh failed the test (${reached.outcome}): ${reached.detail}`
  try {
    return await connect(reached.spec!, port, ctx, (_, spec) => shell.master(spec))
  } catch (error) {
    ctx.signal?.throwIfAborted()
    if (!(error instanceof ReachFailure)) return `reach.sh ran, then ${(error as Error).message}`
    return `reach.sh ran, then ${describe(error, port, ctx.paths.command).line.replace(/^opencorp hq: /, "")}`
  }
}

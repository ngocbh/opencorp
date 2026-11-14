/** One learning run's state, which `learn_hq`'s host tools take as their context, and what those tools share: the
 *  owner's terminal, which the visit's Ctrl-C stops too, what commands print without the model's key or sign-in, and
 *  the warning when a command or reach.sh names hq's credential files. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import type { ToolContext } from "@ngocbh/yian"
import { Asking, withOwner } from "../install/interview.ts"
import { KeyboardInterrupt, type Prompter } from "../install/prompts.ts"
import { REDACTED, redact } from "../perm/redact.ts"
import type { Connection } from "./connect.ts"
import type { ReachPaths } from "./paths.ts"
import { quietStdin, type ReachContext } from "./ssh.ts"

/** A one-time sign-in code as a link or `opencorp hq --json` shows it. */
const SIGN_IN_CODE = /pair#[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g

/** One learning run: the owner's terminal, the reach context, where the model's key or sign-in tokens come from
 *  (never saved), the port, the clock, the commands asked for, the connection `save_access` left open, and the folder
 *  commands run in. */
export class Learning {
  readonly asking: Asking
  /** Each command the model asked to run, with its exit code, or null when it didn't run. */
  readonly commands: { command: string; code: number | null }[] = []
  connection: Connection | null = null
  #workDir: string | null = null
  readonly #source: () => readonly string[]
  readonly #seen = new Set<string>()

  /** `secrets` is the key or tokens, or a function that reads them as they are now: yian refreshes a subscription's
   *  tokens during the run. */
  constructor(
    readonly ctx: ReachContext,
    prompter: Prompter,
    readonly stdin: Readable,
    secrets: readonly string[] | (() => readonly string[]),
    readonly port: number,
    readonly now: () => Date = () => new Date(),
  ) {
    this.asking = new Asking(prompter)
    this.#source = typeof secrets === "function" ? secrets : () => secrets
    // Before the run, which may replace them.
    this.secrets()
  }

  /** The model's key or sign-in tokens as they are now, and every one seen before, which a command may still print. */
  secrets(): string[] {
    for (const secret of this.#source()) if (secret !== "") this.#seen.add(secret)
    return [...this.#seen]
  }

  /** The empty private folder (0700) commands run in, made on first use: never the hq folder, whose files a command
   *  could read or change. */
  workDir(): string {
    this.#workDir ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-learn-")))
    return this.#workDir
  }

  /** `run`, a child that may prompt on the terminal (ssh's password, Duo or host key), with the terminal handed to it;
   *  `why` says what runs. On the plain terminal it already has it, so this only runs it. */
  async handOver<T>(why: string, run: () => Promise<T>): Promise<T> {
    const { prompter } = this.asking
    await prompter.handOver(why)
    try {
      return await run()
    } finally {
      prompter.takeBack()
    }
  }

  /** Removes the folder commands ran in. */
  close(): void {
    if (this.#workDir !== null) fs.rmSync(this.#workDir, { recursive: true, force: true })
    this.#workDir = null
  }

  /** `text` without any form of the model's key or sign-in tokens, or a one-time sign-in code. */
  scrub(text: string): string {
    const keys = this.secrets()
    return (keys.length > 0 ? redact(text, [], keys) : text).replace(SIGN_IN_CODE, `pair#${REDACTED}`)
  }
}

/** How long an unfinished line of a command's output waits for the rest before it's shown. */
export const PARTIAL_MS = 100
/** The longest unfinished line held back. */
const PARTIAL_CHARS = 4096

/** `echo` with each line of text scrubbed by `scrub` as a whole, so a key split across two writes is still found; an
 *  unfinished line (a prompt's text, say) is shown after `PARTIAL_MS` without more. `flush` shows what's left. */
export function scrubbedEcho(echo: (text: string) => void, scrub: (text: string) => string) {
  let pending = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    if (pending !== "") echo(scrub(pending))
    pending = ""
  }
  const write = (text: string) => {
    pending += text
    const at = pending.lastIndexOf("\n")
    if (at !== -1) {
      echo(scrub(pending.slice(0, at + 1)))
      pending = pending.slice(at + 1)
    }
    clearTimeout(timer)
    if (pending.length > PARTIAL_CHARS) flush()
    else if (pending !== "") timer = setTimeout(flush, PARTIAL_MS)
  }
  return { write, flush }
}

/** The running learn_hq's state: a tool's `ctx.context`. */
export function learning(c: ToolContext<unknown>): Learning {
  if (!(c.context instanceof Learning)) throw new Error("learn_hq's tools run only in opencorp hq's learning run")
  return c.context
}

/** `fn` with the owner's terminal, as `withOwner`; the visit's Ctrl-C stops it too, since at a numbered list it
 *  arrives as SIGINT rather than as a key, and then pauses stdin, so the line read the question left pending can't
 *  keep the process alive. */
export function withOwnerOrStop<T>(state: Learning, fn: (prompter: Prompter) => Promise<T>): Promise<T> {
  const signal = state.ctx.signal
  return withOwner(state.asking, (prompter) => {
    if (signal === undefined) return fn(prompter)
    const stopped = new Promise<never>((_, reject) => {
      const stop = () => {
        quietStdin(state.stdin)
        reject(new KeyboardInterrupt())
      }
      if (signal.aborted) stop()
      else signal.addEventListener("abort", stop, { once: true })
    })
    return Promise.race([fn(prompter), stopped])
  })
}

/** Whether `text` names the hq folder or one of its files that hold the model's key or sign-in: reach.sh runs in
 *  the folder, so a bare name counts. A hint for the owner, not a guard. */
export function namesCredentials(text: string, paths: ReachPaths): boolean {
  const folder = `${path.basename(paths.home)}/hq`
  return /\b(?:auth|provider)\.json\b/.test(text) || text.includes(paths.dir) || text.includes(folder)
}

/** Said above the question when a command or reach.sh `namesCredentials`. */
export function credentialWarning(paths: ReachPaths): string {
  return (
    `Careful: this names ${paths.dir}, provider.json or auth.json, which hold the model's key or its ChatGPT sign-in;` +
    " what reads them reaches the model."
  )
}

/** What the model is told to use instead of a character that isn't printable ASCII. */
export const ASCII_ONLY = "use only printable ASCII, tabs and newlines"

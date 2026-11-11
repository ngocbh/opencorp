/** Learning the path to HQ: `learn_hq`, whose agent works it out with the owner, and its host tools: `shell`, which runs
 *  a command once the owner approves it, and `save_access`, which saves reach.sh and notes.md once the owner approves
 *  them and the whole chain works. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { type FunctionTool, loadFlow, ReportedToolError, type ToolContext, tool } from "@ngocbh/yian"
import { FileLockError } from "@ngocbh/yian/platform"
import { loadProvider, type Provider, ProviderError } from "../chat/provider.ts"
import { Asking, askUser, withOwner } from "../install/interview.ts"
import {
  askProviderTo,
  checkProvider,
  type Listers,
  lexists,
  type ModelCheck,
  runSetup,
  withDefaultModel,
} from "../install/onboard.ts"
import { clean, KeyboardInterrupt, OnboardError, type Prompter } from "../install/prompts.ts"
import { REDACTED, redact, strip } from "../perm/redact.ts"
import { embedded } from "../platform.ts"
import { writePrivate } from "../secrets.ts"
import { workerEnv } from "../worker/spawn.ts"
import { type Connection, connect, describe, ReachFailure } from "./connect.ts"
import { runBytes } from "./replay.ts"
import type { ReachPaths } from "./paths.ts"
import { beforeSaving } from "./risks.ts"
import { lineCount, numberedLines, oddCharacter } from "./show.ts"
import {
  cleanOutput,
  quietStdin,
  type Ran,
  type ReachContext,
  readStatuses,
  resetStatus,
  runChild,
  sshEnv,
  wellFormed,
} from "./ssh.ts"
import { type Access, AccessError, readAccess, sha256, writeAccess } from "./state.ts"
import learnYaml from "./flows/learn_hq.yaml" with { type: "file" }

export { learnYaml }

/** A one-time sign-in code as a link or `opencorp hq --json` shows it. */
const SIGN_IN_CODE = /pair#[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g

/** One learning run: the owner's terminal, the reach context, the model's key (never saved), the port, the clock, the
 *  commands asked for, the connection `save_access` left open, and the folder commands run in. */
export class Learning {
  readonly asking: Asking
  /** Each command the model asked to run, with its exit code, or null when it didn't run. */
  readonly commands: { command: string; code: number | null }[] = []
  connection: Connection | null = null
  #workDir: string | null = null

  constructor(
    readonly ctx: ReachContext,
    prompter: Prompter,
    readonly stdin: Readable,
    readonly secrets: readonly string[],
    readonly port: number,
    readonly now: () => Date = () => new Date(),
  ) {
    this.asking = new Asking(prompter)
  }

  /** The empty private folder (0700) commands run in, made on first use: never the hq folder, whose files a command
   *  could read or change. */
  workDir(): string {
    this.#workDir ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-learn-")))
    return this.#workDir
  }

  /** Removes the folder commands ran in. */
  close(): void {
    if (this.#workDir !== null) fs.rmSync(this.#workDir, { recursive: true, force: true })
    this.#workDir = null
  }

  /** `text` without any form of the model's key, or a one-time sign-in code. */
  scrub(text: string): string {
    const keys = this.secrets.filter((key) => key !== "")
    return (keys.length > 0 ? redact(text, [], keys) : text).replace(SIGN_IN_CODE, `pair#${REDACTED}`)
  }
}

/** How long an unfinished line of a command's output waits for the rest before it's shown. */
export const PARTIAL_MS = 100
/** The longest unfinished line held back. */
const PARTIAL_CHARS = 4096

/** `echo` with each line of text scrubbed by `scrub` as a whole, so a key split across two writes is still found; an
 *  unfinished line (a prompt's text, say) is shown after `PARTIAL_MS` without more. `flush` shows what's left. */
function scrubbedEcho(echo: (text: string) => void, scrub: (text: string) => string) {
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
function learning(c: ToolContext<unknown>): Learning {
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

export const RUN = "Run it"
export const DONT_RUN = "Don't run it"
/** The question for a command of `lines` lines: the count shows when the command is longer than it looks. */
export const runQuestion = (lines: number) => `Run this ${lines}-line command?`
export const WHY_NOT = "Why not? (empty to skip)"

/** Control characters other than tab and newline: notes holding one could read other than they are. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
/** What the model is told to use instead of a character that isn't printable ASCII. */
const ASCII_ONLY = "use only printable ASCII, tabs and newlines"

/** The `shell` tool: refuses a command holding anything but printable ASCII, tabs and newlines, shows the rest
 *  numbered with why, runs it with `sh -c` in the run's empty folder once the owner approves,
 *  and returns its exit, stdout and stderr, which reach the owner and the model without the model's key or a sign-in
 *  code. Meanwhile stdin is paused and cooked, so ssh, not Bun, reads the terminal. */
export async function runShell(args: { command: string; why: string }, state: Learning): Promise<string> {
  const { command, why } = args
  const { ctx } = state
  // A look-alike blank or an invisible character could make the command read other than it runs.
  const odd = oddCharacter(command)
  if (odd !== null) {
    state.commands.push({ command, code: null })
    throw new ReportedToolError(`Not run: the command holds ${odd}; ${ASCII_ONLY} (printf can write other bytes).`)
  }
  const refusal = await withOwnerOrStop(state, async (p) => {
    p.say(`The model wants to run a command: ${clean(why)}`)
    for (const line of numberedLines(command)) p.say(line)
    const answer = await p.choose(runQuestion(lineCount(command)), [RUN, DONT_RUN], DONT_RUN)
    quietStdin(state.stdin)
    if (answer === RUN) return null
    const reason = strip(await p.ask(WHY_NOT))
    quietStdin(state.stdin)
    return reason
  })
  if (refusal !== null) {
    state.commands.push({ command, code: null })
    throw new ReportedToolError(refusal ? `The owner didn't run it: ${refusal}` : "The owner didn't run it.")
  }
  resetStatus(ctx)
  const shown = scrubbedEcho(ctx.echo, (text) => state.scrub(text))
  const ran = await runChild(["/bin/sh", "-c", command], {
    env: sshEnv(ctx),
    cwd: state.workDir(),
    timeoutMs: ctx.limits.promptMs,
    signal: ctx.signal,
    echo: shown.write,
    echoStdout: true,
  })
  shown.flush()
  state.commands.push({ command, code: ran.code })
  return shellResult({ ...ran, stdout: state.scrub(ran.stdout), stderr: state.scrub(ran.stderr) }, readStatuses(ctx))
}

/** The command's result as one JSON object, so nothing it prints can pass for the result's own fields: `exit` (null,
 *  with `stopped`, once it ran out of time), `ssh` when an ssh in it exited 255, and its `stdout` and `stderr`. */
export function shellResult(ran: Ran, statuses: readonly number[]): string {
  return JSON.stringify({
    exit: ran.timedOut ? null : ran.code,
    ...(ran.timedOut ? { stopped: "it didn't finish within 5 minutes" } : {}),
    ...(statuses.includes(255) ? { ssh: "an ssh in it exited 255: it couldn't connect" } : {}),
    stdout: wellFormed(cleanOutput(ran.stdout)),
    stderr: wellFormed(cleanOutput(ran.stderr)),
  })
}

/** `learn_hq`'s `shell` tool. */
export const shellTool: FunctionTool = tool({
  name: "shell",
  description:
    "Run one POSIX sh command on this machine once the owner approves it; returns its exit code, stdout and stderr " +
    "as one JSON object. " +
    "SSH prompts go to the owner's terminal. No stdin; stopped after 5 minutes.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command in printable ASCII, run with sh -c in an empty folder." },
      why: { type: "string", description: "One line for the owner: what the command finds out or does." },
    },
    required: ["command", "why"],
  },
  execute: (args, c) => runShell(args as { command: string; why: string }, learning(c)),
})

/** Why `text` can't be saved, or null: it holds the model's key (any form `perm/redact.ts`'s three-argument `redact`
 *  finds), a private key, or a password handed to ssh. */
export function secretIn(text: string, keys: readonly string[]): string | null {
  if (keys.some((key) => key !== "" && redact(text, [], [key]) !== text)) return "it holds the model's API key"
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) return "it holds a private key"
  if (/\bsshpass\b|\bSSHPASS=/.test(text)) return "it hands a password to ssh"
  return null
}

export const SAVE = "Test it, then save it"
export const CANCEL = "Don't save it"
/** The question for a reach.sh of `lines` lines. */
export const saveQuestion = (lines: number) =>
  `Save this ${lines}-line reach.sh and the notes, after testing the whole connection?`
export const WHAT_SHOULD_CHANGE = "What should change? (empty for nothing)"

/** What save_access is given: reach.sh, notes.md, and the risks of this setup the owner should know. */
export interface ToSave {
  script: string
  notes: string
  risks: readonly string[]
}

/** Why `files` can't be saved, or null: a secret in either file; in reach.sh anything but printable ASCII, tabs and
 *  newlines, which could make it read other than it runs; in notes.md a control character. */
function problemIn(files: ToSave, keys: readonly string[]): string | null {
  for (const [name, text] of [
    ["reach.sh", files.script],
    ["notes.md", files.notes],
  ] as const) {
    const secret = secretIn(text, keys)
    if (secret !== null) return `${name}: ${secret}; SSH asks for passwords and Duo itself, so leave them out`
  }
  const odd = oddCharacter(files.script)
  if (odd !== null) return `reach.sh holds ${odd}; ${ASCII_ONLY}`
  if (CONTROL.test(files.notes)) return `notes.md holds control characters; ${ASCII_ONLY}, or other printable text`
  return null
}

/** `save_access`: refuses files holding a secret or, in reach.sh, a character that isn't printable ASCII, before
 *  showing anything; then shows both files numbered and the risks,
 *  the fixed ones first, and asks the owner; a cancel tells the model what the owner wants changed. Once approved, the
 *  chain test runs; only when it passes are the files written and the connection kept. Refused once one has been
 *  saved. */
export async function saveAccess(files: ToSave, state: Learning): Promise<string> {
  // One path per run: a second would replace what the visit is about to use.
  if (state.connection !== null)
    throw new ReportedToolError("Not saved again: the path is saved and connected already; reply with one line for the owner.")
  const problem = problemIn(files, state.secrets)
  if (problem !== null) throw new ReportedToolError(`Not saved: ${problem}.`)
  const { paths } = state.ctx
  const change = await withOwnerOrStop(state, async (p) => {
    const say = (line: string) => p.say(clean(line))
    say(`The model wants to save how this machine reaches HQ. ${paths.script}, which runs on every visit:`)
    for (const line of numberedLines(files.script)) p.say(line)
    say(`${paths.notes}:`)
    // Notes may hold any printable text: they're read, never run.
    for (const line of numberedLines(files.notes, clean)) p.say(line)
    say("Before you save it:")
    for (const risk of [...beforeSaving(paths), ...files.risks]) say(`  - ${risk}`)
    const answer = await p.choose(saveQuestion(lineCount(files.script)), [SAVE, CANCEL], CANCEL)
    quietStdin(state.stdin)
    if (answer === SAVE) return null
    const wanted = strip(await p.ask(WHAT_SHOULD_CHANGE))
    quietStdin(state.stdin)
    return wanted
  })
  if (change !== null)
    throw new ReportedToolError(change ? `Not saved: the owner wants a change: ${change}` : "Not saved: the owner didn't save it.")
  const conn = await chainTest(Buffer.from(files.script, "utf8"), state)
  await save(Buffer.from(files.script, "utf8"), files.notes, state)
  state.connection = conn
  state.asking.prompter.say(SAVED)
  return `${SAVED} Reply with one line for the owner.`
}

export const SAVED = "Saved, and the whole connection works."

/** The whole chain on `bytes`, the script as it will be saved: run it, then connect as a visit does. Resolves to the
 *  open connection; throws `ReportedToolError` naming the step that failed, having ended only the node master, so a
 *  retry rides the login node's without a new Duo. */
async function chainTest(bytes: Buffer, state: Learning): Promise<Connection> {
  const { ctx, port } = state
  const shown = scrubbedEcho(ctx.echo, (text) => state.scrub(text))
  const reached = await runBytes(bytes, { ...ctx, echo: shown.write })
  shown.flush()
  ctx.signal?.throwIfAborted()
  // The details quote output from other machines.
  const told = (text: string) => new ReportedToolError(wellFormed(state.scrub(text)))
  if (reached.outcome !== "ok") throw told(`Not saved: reach.sh failed the test (${reached.outcome}): ${reached.detail}`)
  try {
    return await connect(reached.spec!, port, ctx)
  } catch (error) {
    ctx.signal?.throwIfAborted()
    if (!(error instanceof ReachFailure)) throw error
    throw told(`Not saved: reach.sh ran, then ${describe(error, port).line.replace(/^opencorp hq: /, "")}`)
  }
}

/** Writes reach.sh, its approved copy, notes.md, then access.json, each 0600; the old path stays whole until reach.sh
 *  is replaced. `signed_in_at` stays when the port does: the browser's session lives in HQ's store. */
async function save(bytes: Buffer, notes: string, state: Learning): Promise<void> {
  const { paths } = state.ctx
  let old: Access | null
  try {
    old = await readAccess(paths)
  } catch (error) {
    if (!(error instanceof AccessError)) throw error
    old = null
  }
  await writePrivate(paths.script, bytes)
  await writePrivate(paths.approved, bytes)
  await writePrivate(paths.notes, notes)
  await writeAccess(paths, {
    port: state.port,
    sha256: sha256(bytes),
    learned_at: state.now().toISOString(),
    last_used_at: old?.last_used_at ?? null,
    signed_in_at: old !== null && old.port === state.port ? old.signed_in_at : null,
  })
}

/** `learn_hq`'s `save_access` tool. */
export const saveAccessTool: FunctionTool = tool({
  name: "save_access",
  description:
    "Show the owner reach.sh, notes.md and the risks; once they approve, test the whole chain (run the script, log in, " +
    "check HQ there, forward its socket, check its health) and save both files only if it all works.",
  parameters: {
    type: "object",
    properties: {
      script: { type: "string", description: "reach.sh: POSIX sh whose last line of stdout is the spec." },
      notes: { type: "string", description: "notes.md: how the cluster is reached and the node found, in plain words." },
      risks: { type: "array", items: { type: "string" }, description: "Risks of this setup the owner should know." },
    },
    required: ["script", "notes", "risks"],
  },
  execute: (args, c) => saveAccess(args as unknown as ToSave, learning(c)),
})

/** Said before each of the agent's questions. */
export const ANSWER_GOES_TO_MODEL =
  "Your answer goes to the model. Type passwords, passphrases and codes only at ssh's own prompts, never here."

/** `ask_user`: the agent's question, marked as its own, after a line on where the answer goes. */
function askOwner(request: { question: string; options?: readonly string[] | null }, state: Learning): Promise<string> {
  return withOwnerOrStop(state, (p) => {
    p.say(ANSWER_GOES_TO_MODEL)
    return askUser({ ...request, question: `The agent asks: ${request.question}` }, state.asking)
  })
}

/** What a learning run ended with: the agent's last reply when it finished, why it failed (null when it didn't), and
 *  whether yian stopped it at the turn cap. */
export interface Learned {
  output: string | null
  message: string | null
  capped: boolean
}

/** Runs learn_hq with `provider`'s model and the host tools, in this process (no workers), with no run log, then
 *  removes the folder its commands ran in.
 *  Rejects with the owner's `KeyboardInterrupt` or `OnboardError` (their input ended), and with the visit's stop. */
export async function runLearn(
  provider: Provider,
  inputs: { notes: string; script: string; failure: string },
  state: Learning,
): Promise<Learned> {
  const flow = await loadFlow(embedded(learnYaml).toString("utf8"), { sourceLabel: "reach/flows/learn_hq.yaml" })
  const text = { notes: wellFormed(inputs.notes), script: wellFormed(inputs.script), failure: wellFormed(inputs.failure) }
  let ran: Awaited<ReturnType<typeof runSetup>>
  try {
    ran = await runSetup(flow, text, provider, {
      tools: {
        shell: shellTool,
        save_access: saveAccessTool,
        ask: (request, c) => askOwner(request, learning(c)),
      },
      context: state,
      env: workerEnv(state.ctx.env),
      signal: state.ctx.signal,
    })
  } finally {
    state.close()
  }
  const { result, message } = ran
  if (state.asking.stopped) throw state.asking.stopped
  return {
    output: result?.status === "succeeded" ? (result.output as string) : null,
    message,
    capped: result?.failure?.code === "agent.max_tool_iterations",
  }
}

/** The model for learning: `hq/provider.json`, else asked for with init's picker, checked, and saved there (delete
 *  the file to forget the model). Throws `OnboardError` when the file can't be used, naming it. */
export async function learnProvider(
  paths: ReachPaths,
  prompter: Prompter,
  options: { listers: Listers; checkModel: ModelCheck },
): Promise<Provider> {
  const file = paths.provider
  if (!lexists(file)) {
    prompter.say(`Learning needs a model. Its connection is kept in ${file}, readable only by you.`)
    return askProviderTo(file, prompter, options)
  }
  const again = "fix it, or delete it to set up the model again"
  try {
    return withDefaultModel(await loadProvider(file, checkProvider, { missingOk: false }))
  } catch (error) {
    // A ProviderError's message names the file; checkProvider's doesn't.
    if (error instanceof ProviderError) throw new OnboardError(`${error.message}; ${again}`)
    if (error instanceof OnboardError) throw new OnboardError(`${file}: ${error.message}; ${again}`)
    if (error instanceof FileLockError) throw new OnboardError(`can't read ${file}: ${error.message}`)
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (typeof code === "string") throw new OnboardError(`can't read ${file}: ${code}`)
    throw error
  }
}

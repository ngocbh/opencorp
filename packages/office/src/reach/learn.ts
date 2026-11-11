/** Learning the path to HQ: `learn_hq`, whose agent works it out with the owner, and its host tools: `shell`, which runs
 *  a command once the owner approves it, and `save_access`, which saves reach.sh and notes.md once the owner approves
 *  them and the whole chain works. */
import type { Readable } from "node:stream"
import { type FunctionTool, ReportedToolError, type ToolContext, tool } from "@ngocbh/yian"
import { Asking, withOwner } from "../install/interview.ts"
import { clean, KeyboardInterrupt, type Prompter } from "../install/prompts.ts"
import { strip } from "../perm/redact.ts"
import type { Connection } from "./connect.ts"
import { cleanOutput, quietStdin, type Ran, type ReachContext, readStatuses, resetStatus, runChild, sshEnv } from "./ssh.ts"

/** One learning run: the owner's terminal, the reach context, the model's key (never saved), the port, the commands
 *  asked for, and the connection `save_access` left open. */
export class Learning {
  readonly asking: Asking
  /** Each command the model asked to run, with its exit code, or null when it didn't run. */
  readonly commands: { command: string; code: number | null }[] = []
  connection: Connection | null = null

  constructor(
    readonly ctx: ReachContext,
    prompter: Prompter,
    readonly stdin: Readable,
    readonly secrets: readonly string[],
    readonly port: number,
  ) {
    this.asking = new Asking(prompter)
  }
}

/** The running learn_hq's state: a tool's `ctx.context`. */
function learning(c: ToolContext<unknown>): Learning {
  if (!(c.context instanceof Learning)) throw new Error("learn_hq's tools run only in opencorp hq's learning run")
  return c.context
}

/** `fn` with the owner's terminal, as `withOwner`; the visit's Ctrl-C stops it too, since at a numbered list it
 *  arrives as SIGINT rather than as a key. */
export function withOwnerOrStop<T>(state: Learning, fn: (prompter: Prompter) => Promise<T>): Promise<T> {
  const signal = state.ctx.signal
  return withOwner(state.asking, (prompter) => {
    if (signal === undefined) return fn(prompter)
    const stopped = new Promise<never>((_, reject) => {
      const stop = () => reject(new KeyboardInterrupt())
      if (signal.aborted) stop()
      else signal.addEventListener("abort", stop, { once: true })
    })
    return Promise.race([fn(prompter), stopped])
  })
}

export const RUN = "Run it"
export const DONT_RUN = "Don't run it"
export const RUN_QUESTION = "Run this command?"
export const WHY_NOT = "Why not? (empty to skip)"

/** Control characters other than tab and newline: a command holding one could show other than it runs. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** The `shell` tool: shows the command and why, runs it with `sh -c` once the owner approves, and returns its exit,
 *  stdout and stderr. Meanwhile stdin is paused and cooked, so ssh, not Bun, reads the terminal. */
export async function runShell(args: { command: string; why: string }, state: Learning): Promise<string> {
  const { command, why } = args
  const { ctx } = state
  if (CONTROL.test(command)) {
    state.commands.push({ command, code: null })
    throw new ReportedToolError("Not run: the command holds control characters; write it with printable text, tabs and newlines only.")
  }
  const refusal = await withOwnerOrStop(state, async (p) => {
    p.say(`The model wants to run a command: ${clean(why)}`)
    for (const line of command.split("\n")) p.say(`  ${clean(line)}`)
    const answer = await p.choose(RUN_QUESTION, [RUN, DONT_RUN], DONT_RUN)
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
  const ran = await runChild(["/bin/sh", "-c", command], {
    env: sshEnv(ctx),
    cwd: ctx.paths.dir,
    timeoutMs: ctx.limits.promptMs,
    signal: ctx.signal,
    echo: ctx.echo,
    echoStdout: true,
  })
  state.commands.push({ command, code: ran.code })
  return shellResult(ran, readStatuses(ctx))
}

/** `exit N` (or "stopped" once it ran out of time), "an ssh in it exited 255: it couldn't connect" when one did, then
 *  `stdout:` and `stderr:`, each "(none)" when empty. */
export function shellResult(ran: Ran, statuses: readonly number[]): string {
  const text = (stream: string) => cleanOutput(stream).replace(/\n$/, "") || "(none)"
  return [
    ran.timedOut ? "stopped: it didn't finish within 5 minutes" : `exit ${ran.code}`,
    ...(statuses.includes(255) ? ["an ssh in it exited 255: it couldn't connect"] : []),
    "stdout:",
    text(ran.stdout),
    "stderr:",
    text(ran.stderr),
  ].join("\n")
}

/** `learn_hq`'s `shell` tool. */
export const shellTool: FunctionTool = tool({
  name: "shell",
  description:
    "Run one POSIX sh command on this machine once the owner approves it; returns its exit code, stdout and stderr. " +
    "SSH prompts go to the owner's terminal. No stdin; stopped after 5 minutes.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command, run with sh -c in OpenCorp's hq folder." },
      why: { type: "string", description: "One line for the owner: what the command finds out or does." },
    },
    required: ["command", "why"],
  },
  execute: (args, c) => runShell(args as { command: string; why: string }, learning(c)),
})

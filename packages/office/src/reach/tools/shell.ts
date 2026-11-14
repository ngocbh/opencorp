/** `learn_hq`'s `shell` tool, which runs a command once the owner approves it. */
import { type FunctionTool, ReportedToolError, tool } from "@ngocbh/yian"
import { clean } from "../../install/prompts.ts"
import { strip } from "../../perm/redact.ts"
import {
  ASCII_ONLY,
  credentialWarning,
  type Learning,
  learning,
  namesCredentials,
  scrubbedEcho,
  withOwnerOrStop,
} from "../learning.ts"
import { lineCount, numberedLines, oddCharacter } from "../show.ts"
import { cleanOutput, quietStdin, type Ran, readStatuses, resetStatus, runChild, sshEnv, wellFormed } from "../ssh.ts"

export const RUN = "Run it"
export const DONT_RUN = "Don't run it"
/** The question for a command of `lines` lines: the count shows when the command is longer than it looks. */
export const runQuestion = (lines: number) => `Run this ${lines}-line command?`
export const WHY_NOT = "Why not? (empty to skip)"

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
    if (namesCredentials(command, ctx.paths)) p.say(clean(credentialWarning(ctx.paths)))
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

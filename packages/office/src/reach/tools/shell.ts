/** `learn_hq`'s `shell` tool, which runs a command once the owner approves it. */
import { type FunctionTool, ReportedToolError, tool } from "@ngocbh/yian"
import { type Card, clean } from "../../install/prompts.ts"
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
import { HAND_OVER_COMMAND } from "../risks.ts"
import { lineCount, numberedLines, oddCharacter } from "../show.ts"
import { cleanOutput, quietStdin, type Ran, readStatuses, resetStatus, runChild, sshEnv, wellFormed } from "../ssh.ts"

export const RUN = "Run it"
export const DONT_RUN = "Don't run it"
/** The question for a command of `lines` lines: the count shows when the command is longer than it looks. */
export const runQuestion = (lines: number) => `Run this ${lines}-line command?`
export const WHY_NOT = "Why not? (empty to skip)"

/** The `shell` tool: refuses a command holding anything but printable ASCII, tabs and newlines, shows the rest
 *  numbered with why, runs it with `sh -c` in the run's empty folder once the owner approves, with the terminal
 *  handed to it, then shows the owner how it ended; returns its exit, stdout and stderr, which reach the owner and the
 *  model without the model's key or a sign-in code. Meanwhile stdin is paused and cooked, so ssh, not Bun, reads the
 *  terminal. */
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
    p.show({
      type: "command",
      title: `The model wants to run a command: ${clean(why)}`,
      warning: namesCredentials(command, ctx.paths) ? clean(credentialWarning(ctx.paths)) : "",
      lines: numberedLines(command),
    })
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
  const ran = await state.handOver(HAND_OVER_COMMAND, async () => {
    const shown = scrubbedEcho(ctx.echo, (text) => state.scrub(text))
    try {
      return await runChild(["/bin/sh", "-c", command], {
        env: sshEnv(ctx),
        cwd: state.workDir(),
        timeoutMs: ctx.limits.promptMs,
        signal: ctx.signal,
        echo: shown.write,
        echoStdout: true,
      })
    } finally {
      // Before the terminal goes back: the rest of a line it printed belongs with the rest of its output.
      shown.flush()
    }
  })
  state.commands.push({ command, code: ran.code })
  const scrubbed = { ...ran, stdout: state.scrub(ran.stdout), stderr: state.scrub(ran.stderr) }
  const statuses = readStatuses(ctx)
  state.asking.prompter.show(resultCard(scrubbed, statuses, ctx.signal?.aborted === true))
  return shellResult(scrubbed, statuses)
}

/** How the command ended, for the owner: its exit (or why it was stopped), whether an ssh in it couldn't connect,
 *  and all of its stdout then stderr that the model is given — kept the same, so the owner can read in the scrollable
 *  transcript everything the model sees (on the plain terminal it already streamed as it came). */
export function resultCard(ran: Ran, statuses: readonly number[], stopped: boolean): Card {
  const how = stopped ? "Stopped" : ran.timedOut ? "Stopped: it didn't finish within 5 minutes" : `Exited ${ran.code}`
  const ssh = statuses.includes(255) ? "; an ssh in it couldn't connect" : ""
  const lines = [ran.stdout, ran.stderr]
    .flatMap((text) => cleanOutput(text).replace(/\n$/, "").split("\n"))
    .filter((line) => line !== "")
  return {
    type: "result",
    title: `${how}${ssh}`,
    ok: !stopped && !ran.timedOut && ran.code === 0 && ssh === "",
    lines: lines.map(clean),
  }
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

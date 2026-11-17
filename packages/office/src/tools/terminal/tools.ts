/** The terminal tool group as the model sees it (group `terminal`: `terminal_run` and the rest): the five tools'
 *  descriptions and parameters, how their arguments are read, and the one JSON object each reply is. The JSON form
 *  keeps a command's output from posing as the reply's own fields. */
import type { Reply } from "./shell.ts"

export const TOOLS = ["run", "type", "read", "interrupt", "close"] as const
export type ToolName = (typeof TOOLS)[number]

/** A reply's wait, in seconds, unless the call says: the default, and the cap. A steer reaches the agent only between
 *  steps, so a reply comes within two minutes and the agent can read its messages. */
const WAIT_DEFAULT_S = 30
const WAIT_MAX_S = 120

/** The model's tool arguments, read. `shell: null` asks `run` for a new shell; `waitMs` is the capped wait. */
export type Parsed =
  | {
      readonly tool: "run"
      readonly command: string
      readonly why: string
      readonly shell: string | null
      readonly waitMs: number
    }
  | {
      readonly tool: "type"
      readonly shell: string
      readonly text: string
      readonly enter: boolean
      readonly why: string
      readonly waitMs: number
    }
  | { readonly tool: "read"; readonly shell: string; readonly from: number | undefined; readonly waitMs: number }
  | { readonly tool: "interrupt" | "close"; readonly shell: string }

/** What a reply says, waiting on a secret prompt, when the session doesn't ask and when it does. Only the owner may
 *  answer, and the agent's interrupt is refused there, so in dontAsk closing the shell is the agent's way out. */
const SECRET_DONT_ASK =
  "Only the owner can answer this prompt, and this session doesn't ask. Unless the owner answers it, close this " +
  "shell; don't poll read."
const SECRET_ASKED =
  "Only the owner can answer this prompt, and they have been asked to type here. Call read with a long wait to see " +
  "what happens next; don't poll it with short ones."

const REPLY =
  "The reply is one JSON object: `shell`; `status` (idle, running, waiting, ended or failed); `exit`; `waiting` " +
  '("secret" while a prompt waits for a password, passphrase or code, which only the owner types); `output`, the ' +
  "screen as it showed from where you last read; `next`, where to read on from; `more`, whether more output is " +
  "ready past this page; `skipped`, when the start of what you asked to read is no longer kept; `note`, when the " +
  "owner must act; `error`, why a shell failed; and `refused`, why nothing was done."
const SHELLS_PTY =
  "A shell keeps its state between commands, as a terminal does: its folder (`cd`), its variables and what " +
  "earlier commands defined. Programs run on a real terminal: answer a program's question with type."
const SHELLS_PIPES =
  "Each command runs on its own in the workspace, with no terminal and no input: nothing carries over between " +
  "commands, not the folder (`cd`) nor any variable, so join steps that need each other in one command " +
  "(`cd src && make`). A program that asks a question gets no answer."

const runDescription = (shells: string) =>
  "Run a command in a shell and return its output. Commands are POSIX sh: printable ASCII, newlines and tabs; " +
  'quote paths that hold spaces or special characters. Leave out `shell`, or give "new", to start a new shell ' +
  `(shell 1, shell 2, …); name a shell to run in it again once its last command has ended. ${shells} Every command ` +
  "goes through this session's permissions first, and may wait for the owner's approval. The reply comes when the " +
  "command ends, or after `wait` seconds with the command still running: it keeps running, so follow it with read " +
  "from the reply's `next`, with a long wait. DO NOT poll read with short waits; do other work meanwhile. Prefer a " +
  `dedicated tool over a shell command when there is one. ${REPLY}`
const TYPE_PTY =
  "Type text into the command running in a shell, as a person at its terminal would: an answer to a program's " +
  "question (`yes`, a menu's `1`), or a line for a program that reads them. `enter` (default true) presses Enter " +
  "after it; text typed without Enter stays on the line, and the next text joins it. Each time, the whole line goes " +
  "through this session's permissions, and an unfinished line waits for the owner's approval unless a rule allows " +
  "it. Refused at a prompt for a password, passphrase or code, which only the owner types, and while the owner is " +
  "typing a line. Waits and replies as run does."
const TYPE_PIPES =
  "Type text into the command running in a shell. The shells here take no input, so type is refused: give a " +
  "command its input in the command itself (a here-document, or a file). Replies as run does."

const WAIT = {
  type: "number",
  minimum: 0,
  maximum: WAIT_MAX_S,
  description:
    `Seconds to wait for the command to end before replying: default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}.`,
}
const WHY = { type: "string", description: "One line for the owner: what this finds out or does." }
const SHELL = { type: "string", description: 'The shell, by name: "shell 1".' }
const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const PARAMETERS = {
  run: object(
    {
      command: { type: "string", description: "The command: POSIX sh, printable ASCII, newlines and tabs." },
      why: WHY,
      shell: {
        type: "string",
        description: 'The shell to run it in, by name ("shell 1"); leave it out, or give "new", for a new shell.',
      },
      wait: WAIT,
    },
    ["command", "why"],
  ),
  type: object(
    {
      shell: SHELL,
      text: { type: "string", description: "What to type: printable ASCII." },
      enter: { type: "boolean", description: "Press Enter after it: default true." },
      why: WHY,
      wait: WAIT,
    },
    ["shell", "text", "why"],
  ),
  read: object(
    {
      shell: SHELL,
      from: {
        type: "integer",
        minimum: 0,
        description: "Where to read from: an earlier reply's `next`; by default where you last read.",
      },
      wait: WAIT,
    },
    ["shell"],
  ),
  interrupt: object({ shell: SHELL }, ["shell"]),
  close: object({ shell: SHELL }, ["shell"]),
} satisfies Record<ToolName, unknown>

/** The five tools' descriptions and parameters, for a terminal of PTY shells or of the workspace's pipes. */
export function toolSpecs(
  kind: "pty" | "pipes",
): Record<ToolName, { readonly description: string; readonly parameters: Record<string, unknown> }> {
  return {
    run: { description: runDescription(kind === "pty" ? SHELLS_PTY : SHELLS_PIPES), parameters: PARAMETERS.run },
    type: { description: kind === "pty" ? TYPE_PTY : TYPE_PIPES, parameters: PARAMETERS.type },
    read: {
      description:
        "Read a shell's output from `from` (an earlier reply's `next`; by default where you last read). While a " +
        "command runs, it waits up to `wait` seconds for the command to end or to stop at a prompt for the owner: " +
        "use a long wait, not polling with short ones. Replies as run does.",
      parameters: PARAMETERS.read,
    },
    interrupt: {
      description:
        "Interrupt the command you are running in a shell, as Ctrl-C does. Refused for a command the owner started, " +
        "and while a prompt waits for the owner. Replies as run does.",
      parameters: PARAMETERS.interrupt,
    },
    close: {
      description:
        "End a shell, and any command still running in it. Its record stays; run starts a new shell. Replies as run " +
        "does.",
      parameters: PARAMETERS.close,
    },
  }
}

/** `tool`'s arguments read, or why they can't be: an argument its parameters don't name (`extra` adds the host's
 *  own, on an approved call), or one of the wrong kind. A `wait` past two minutes is capped there. */
export function parseArgs(
  tool: ToolName,
  args: Record<string, unknown>,
  extra: readonly string[] = [],
): Parsed | string {
  if (typeof args !== "object" || args === null) return `${tool} takes its arguments as an object`
  const known = new Set([...Object.keys(PARAMETERS[tool].properties), ...extra])
  const unknown = Object.keys(args).find((key) => !known.has(key))
  if (unknown !== undefined) return `${tool} takes no argument ${JSON.stringify(unknown)}`
  const notText = (key: string) => `${key} must be text`
  // Only run may leave the shell out, for a new one.
  const shell = args.shell === undefined && tool === "run" ? null : args.shell
  if (shell !== null && typeof shell !== "string") return notText("shell")
  if (tool === "interrupt" || tool === "close") return { tool, shell: shell as string }
  const waitMs = waitOf(args.wait)
  if (waitMs === null) return `wait is a number of seconds, from 0 to ${WAIT_MAX_S}`
  if (tool === "read") {
    const { from } = args
    if (from !== undefined && !(typeof from === "number" && Number.isSafeInteger(from) && from >= 0)) {
      return "from is an offset from an earlier reply's next: a whole number, 0 or more"
    }
    return { tool, shell: shell as string, from, waitMs }
  }
  const { why } = args
  if (typeof why !== "string") return notText("why")
  if (tool === "run") {
    const { command } = args
    if (typeof command !== "string") return notText("command")
    if (!/^[\x20-\x7e\n\t]*$/.test(command)) return "a command holds only printable ASCII, newlines and tabs"
    return { tool, command, why, shell: shell === "new" ? null : shell, waitMs }
  }
  const { text, enter = true } = args
  if (typeof text !== "string") return notText("text")
  if (typeof enter !== "boolean") return "enter must be true or false"
  return { tool, shell: shell as string, text, enter, why, waitMs }
}

/** A wait in seconds as the milliseconds a reply waits, capped at two minutes; null when it isn't a number of
 *  seconds from 0. */
function waitOf(wait: unknown): number | null {
  if (wait === undefined) return WAIT_DEFAULT_S * 1000
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0) return null
  return Math.min(wait, WAIT_MAX_S) * 1000
}

/** The arguments a held call's card keeps, in the model's terms, for the host to run it with once approved. */
export function cardArgs(parsed: Parsed & { tool: "run" | "type" }): Record<string, unknown> {
  const wait = parsed.waitMs / 1000
  if (parsed.tool === "run") {
    const { command, why, shell } = parsed
    return { command, why, wait, ...(shell === null ? {} : { shell }) }
  }
  const { shell, text, enter, why } = parsed
  return { shell, text, enter, why, wait }
}

/** `reply` as the model reads it, `shell` by its name: one JSON object, with the shell's `error` when it failed,
 *  and a `note` when a secret prompt waits for the owner. */
export function replyText(reply: Reply, o: { name: string; error: string | null; dontAsk: boolean }): string {
  const { status, exit, waiting, output, next, more, skipped, refused } = reply
  return JSON.stringify({
    shell: o.name,
    status,
    exit,
    waiting,
    output,
    next,
    more,
    ...(skipped === undefined ? {} : { skipped }),
    ...(status === "failed" && o.error !== null ? { error: o.error } : {}),
    ...(waiting === "secret" ? { note: o.dontAsk ? SECRET_DONT_ASK : SECRET_ASKED } : {}),
    ...(refused === undefined ? {} : { refused }),
  })
}

/** A refusal that names no shell, as the model reads it. */
export function refusalText(why: string): string {
  return JSON.stringify({ refused: why })
}

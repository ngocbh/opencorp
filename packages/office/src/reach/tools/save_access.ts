/** `learn_hq`'s `save_access` tool, which saves reach.sh and notes.md once the owner approves them and the whole chain
 *  works. */
import { type FunctionTool, ReportedToolError, tool } from "@ngocbh/yian"
import { clean } from "../../install/prompts.ts"
import { redact, strip } from "../../perm/redact.ts"
import { writePrivate } from "../../secrets.ts"
import { type Connection, connect, describe, ReachFailure } from "../connect.ts"
import {
  ASCII_ONLY,
  credentialWarning,
  type Learning,
  learning,
  namesCredentials,
  scrubbedEcho,
  withOwnerOrStop,
} from "../learning.ts"
import { beforeSaving, HAND_OVER_TEST } from "../risks.ts"
import { lineCount, numberedLines, oddCharacter } from "../show.ts"
import { quietStdin, wellFormed } from "../ssh.ts"
import { type Access, AccessError, readAccess, sha256, writeAccess } from "../state.ts"
import { MAX_SCRIPT_BYTES, runBytes } from "./replay.ts"

/** Control characters other than tab and newline: notes holding one could read other than they are. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** Why `text` can't be saved, or null: it holds the model's key or a sign-in token (any form `perm/redact.ts`'s
 *  three-argument `redact` finds), a private key, or a password handed to ssh. */
export function secretIn(text: string, keys: readonly string[]): string | null {
  if (keys.some((key) => key !== "" && redact(text, [], [key]) !== text)) {
    return "it holds the model's API key or sign-in token"
  }
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

/** Why `files` can't be saved, or null: either file over `MAX_SCRIPT_BYTES`, a secret in either; in reach.sh anything but printable ASCII, tabs and
 *  newlines, which could make it read other than it runs; in notes.md a control character. */
function problemIn(files: ToSave, keys: readonly string[]): string | null {
  for (const [name, text] of [
    ["reach.sh", files.script],
    ["notes.md", files.notes],
  ] as const) {
    // A visit reads neither past this.
    if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) return `${name} is over 1 MiB`
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
 *  chain test runs with the terminal handed to it; only when it passes are the files written and the connection kept,
 *  and when it fails the owner sees why. Refused once one has been saved. */
export async function saveAccess(files: ToSave, state: Learning): Promise<string> {
  // One path per run: a second would replace what the visit is about to use.
  if (state.connection !== null)
    throw new ReportedToolError("Not saved again: the path is saved and connected already; reply with one line for the owner.")
  const problem = problemIn(files, state.secrets())
  if (problem !== null) throw new ReportedToolError(`Not saved: ${problem}.`)
  const { paths } = state.ctx
  const change = await withOwnerOrStop(state, async (p) => {
    p.show({
      type: "review",
      title: "The model wants to save how this machine reaches HQ.",
      files: [
        { name: clean(`${paths.script}, which runs on every visit`), lines: numberedLines(files.script) },
        // Notes may hold any printable text: they're read, never run.
        { name: clean(paths.notes), lines: numberedLines(files.notes, clean) },
      ],
      risks: [...beforeSaving(paths), ...files.risks].map(clean),
      warning: namesCredentials(files.script, paths) ? clean(credentialWarning(paths)) : "",
    })
    const answer = await p.choose(saveQuestion(lineCount(files.script)), [SAVE, CANCEL], CANCEL)
    quietStdin(state.stdin)
    if (answer === SAVE) return null
    const wanted = strip(await p.ask(WHAT_SHOULD_CHANGE))
    quietStdin(state.stdin)
    return wanted
  })
  if (change !== null)
    throw new ReportedToolError(change ? `Not saved: the owner wants a change: ${change}` : "Not saved: the owner didn't save it.")
  let conn: Connection
  try {
    conn = await chainTest(Buffer.from(files.script, "utf8"), state)
  } catch (error) {
    // The model is told why; the owner sees it too, the terminal back.
    if (error instanceof ReportedToolError) state.asking.prompter.show({ type: "result", title: clean(error.message), ok: false })
    throw error
  }
  await save(Buffer.from(files.script, "utf8"), files.notes, conn, state)
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
  // The details quote output from other machines.
  const told = (text: string) => new ReportedToolError(wellFormed(state.scrub(text)))
  // Both steps may prompt: reach.sh's ssh, then the node master's login.
  return state.handOver(HAND_OVER_TEST, async () => {
    const shown = scrubbedEcho(ctx.echo, (text) => state.scrub(text))
    const reached = await runBytes(bytes, { ...ctx, echo: shown.write })
    shown.flush()
    ctx.signal?.throwIfAborted()
    if (reached.outcome !== "ok") throw told(`Not saved: reach.sh failed the test (${reached.outcome}): ${reached.detail}`)
    try {
      return await connect(reached.spec!, port, ctx)
    } catch (error) {
      ctx.signal?.throwIfAborted()
      if (!(error instanceof ReachFailure)) throw error
      throw told(`Not saved: reach.sh ran, then ${describe(error, port).line.replace(/^opencorp hq: /, "")}`)
    }
  })
}

/** Writes reach.sh, its approved copy, notes.md, then access.json, each 0600; the old path stays whole until reach.sh
 *  is replaced. `signed_in_at` stays only while the port, the host and HQ's socket there are the last connection's:
 *  the browser's cookie is tied to the port, and its session lives in that HQ's store. */
async function save(bytes: Buffer, notes: string, conn: Connection, state: Learning): Promise<void> {
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
  const signedIn =
    old !== null && old.port === state.port && old.host === conn.spec.host && old.socket === conn.socket
      ? old.signed_in_at
      : null
  await writeAccess(paths, {
    port: state.port,
    sha256: sha256(bytes),
    learned_at: state.now().toISOString(),
    last_used_at: old?.last_used_at ?? null,
    signed_in_at: signedIn,
    host: conn.spec.host,
    socket: conn.socket,
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

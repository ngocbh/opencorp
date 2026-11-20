/** `learn_hq`'s `save_access` tool, which saves reach.sh and notes.md once the owner approves them on a card and the
 *  whole chain works in OpenCorp's connection shell. */
import type { QuestionCard, SessionBinding } from "../../../runtime/sessions/builtin.ts"
import type { OfficeTool } from "../../../runtime/worker/rpc.ts"
import { clean } from "../../setup/prompts.ts"
import { redact, strip } from "../../../util/redact.ts"
import { writePrivate } from "../../../util/private_files.ts"
import type { Connection } from "../connect.ts"
import { chainTest, type ConnectionShell } from "../connection.ts"
import { ASCII_ONLY, credentialWarning, type Learning, namesCredentials } from "../learning.ts"
import type { ReachPaths } from "../paths.ts"
import { beforeSaving } from "../risks.ts"
import { lineCount, numberedLines, oddCharacter } from "../../../util/show.ts"
import { wellFormed } from "../ssh.ts"
import { type Access, AccessError, readAccess, sha256, writeAccess } from "../state.ts"
import { MAX_SCRIPT_BYTES } from "./replay.ts"

/** Control characters other than tab and newline: notes holding one could read other than they are. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

/** Why `text` can't be saved, or null: it holds the model's key or a sign-in token (any form `util/redact.ts`'s
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
/** The save card's title. */
export const SAVE_TITLE = "OpenCorp wants to save how this machine reaches HQ"
/** The question for a reach.sh of `lines` lines. */
export const saveQuestion = (lines: number) =>
  `Save this ${lines}-line reach.sh and the notes, after testing the whole connection?`
/** Why the save card asks, in every mode: what `dontAsk`'s refusal names. */
export const SAVING_ASKS = "saving how this machine reaches HQ always asks the owner"
export const SAVED = "Saved, and the whole connection works."

/** What save_access is given: reach.sh, notes.md, and the risks of this setup the owner should know. */
export interface ToSave {
  script: string
  notes: string
  risks: readonly string[]
}

/** `args` as `ToSave`, or why they aren't one. */
function toSave(args: Record<string, unknown>): ToSave | string {
  const { script, notes, risks } = args
  if (typeof script !== "string" || typeof notes !== "string") return "script and notes must be text"
  if (!Array.isArray(risks) || !risks.every((risk) => typeof risk === "string")) return "risks must be a list of text"
  return { script, notes, risks }
}

/** Why `files` can't be saved, or null: either file over `MAX_SCRIPT_BYTES`, a secret in either; in reach.sh anything
 *  but printable ASCII, tabs and newlines, which could make it read other than it runs; in notes.md a control
 *  character. */
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

/** The save card for `files`: its title, both files numbered, what to know before saving (the fixed risks first,
 *  then the agent's), a warning when reach.sh names hq's credentials, and the question, which the owner reads whole
 *  before the choices. The title heads the text too, as a single question's card shows only its text. */
export function saveCard(files: ToSave, paths: ReachPaths): QuestionCard {
  const risks = [...beforeSaving(paths), ...files.risks].map(clean)
  const lines = [
    SAVE_TITLE,
    "",
    clean(`${paths.script}, which runs on every visit:`),
    ...numberedLines(files.script),
    "",
    // Notes may hold any printable text: they're read, never run.
    clean(`${paths.notes}:`),
    ...numberedLines(files.notes, clean),
    "",
    "Before you save it:",
    ...risks.map((risk) => `  - ${risk}`),
    ...(namesCredentials(files.script, paths) ? ["", clean(credentialWarning(paths))] : []),
    "",
    saveQuestion(lineCount(files.script)),
  ]
  return { title: SAVE_TITLE, question: lines.join("\n"), options: [SAVE, CANCEL], reason: SAVING_ASKS }
}

/** What `save_access` needs from its session: the learning run's state, the binding its card is held through, and
 *  OpenCorp's connection shell, made on first use. */
export interface SaveAccessHost {
  readonly state: Learning
  readonly binding: Pick<SessionBinding, "ask">
  connection(): ConnectionShell
}

/** `save_access` on `files`: refuses files holding a secret or, in reach.sh, a character that isn't printable ASCII,
 *  before any card; then holds the call on the save card, which asks in every mode (and is refused in `dontAsk`).
 *  "Test it, then save it" runs the chain test in OpenCorp's connection shell, then writes the files and keeps the
 *  connection; the other choice, or what the owner types, tells the agent what should change. Refused once one has
 *  been saved. */
export function saveAccess(args: Record<string, unknown>, callId: string | undefined, host: SaveAccessHost): unknown {
  const { state } = host
  // One path per run: a second would replace what the visit is about to use.
  if (state.connection !== null) return AGAIN
  const files = toSave(args)
  if (typeof files === "string") return `Not saved: ${files}.`
  const problem = problemIn(files, state.secrets())
  if (problem !== null) return `Not saved: ${problem}.`
  if (callId === undefined) return "Not saved: this call can't wait for the owner's answer."
  return host.binding.ask(saveCard(files, state.ctx.paths), callId, async (answer, signal) => {
    if (answer.typed) {
      const wanted = strip(answer.value)
      return wanted ? `Not saved: the owner wants a change: ${wellFormed(wanted)}` : NOT_SAVED
    }
    if (answer.value !== SAVE) return NOT_SAVED
    if (state.connection !== null) return AGAIN
    const ctx = { ...state.ctx, signal: state.ctx.signal ? AbortSignal.any([state.ctx.signal, signal]) : signal }
    const bytes = Buffer.from(files.script, "utf8")
    const tested = await chainTest(host.connection(), bytes, state.port, ctx)
    if (typeof tested === "string") return `Not saved: ${wellFormed(tested)}`
    await save(bytes, files.notes, tested, state)
    state.connection = tested
    return `${SAVED} Reply with one line for the owner.`
  })
}

const NOT_SAVED = "Not saved: the owner didn't save it."
const AGAIN = "Not saved again: the path is saved and connected already; reply with one line for the owner."

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

/** `learn_hq`'s `save_access` tool for `host`'s session: a group of one, so the model calls it by its own name. */
export function saveAccessTool(host: SaveAccessHost): OfficeTool {
  return {
    description:
      "Show the owner reach.sh, notes.md and the risks on a card; once they choose to test and save, test the whole " +
      "chain (run the script, log in, check HQ there, forward its socket, check its health) in OpenCorp's own " +
      "connection shell, where SSH asks the owner for any password, and save both files only if it all works.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "reach.sh: POSIX sh whose last line of stdout is the spec." },
        notes: { type: "string", description: "notes.md: how the cluster is reached and the node found, in plain words." },
        risks: { type: "array", items: { type: "string" }, description: "Risks of this setup the owner should know." },
      },
      required: ["script", "notes", "risks"],
    },
    call: (args, options) => saveAccess(args, options?.callId, host),
  }
}

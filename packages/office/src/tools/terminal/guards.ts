/** The terminal's prompt guards: code, not the model's judgement, since command output is untrusted.
 *
 *  At a secret prompt the agent's input is refused in every mode, and the shell opens for the owner. Every other
 *  prompt, ssh's host-key question and Duo's "Passcode or option" among them, is the mode's to decide. */

/** What only the owner may answer at a terminal: a secret. */
export type OwnerPrompt = "secret"

/** A word that makes a line ending in `:` a secret prompt. Inside ssh the local terminal is raw, so a remote
 *  prompt is known only by its text. */
const SECRET_WORD = /\b(password|passphrase|PIN|OTP|token|one-time (code|password)|verification code)\b/i

/** Keyboard-interactive's bare prompt, which says nothing of what it asks. */
const BARE_RESPONSE = /^Response:$/i

/** Whether the screen waits for a secret: echo off with whole lines on (a local password, passphrase or code read,
 *  such as ssh's own), or a last line that asks for one. `lastLine` is the view's plain text, its escapes stripped
 *  (`PlainText`, `ModelView`); only the text after its last newline counts.
 *
 *  The text rule is `\b(password|…)\b[^\n]*:\s*$`, checked as "ends in a colon, and holds a secret word": the
 *  single pattern backtracks quadratically on a long line, and a command's output picks the line. */
export function ownerPrompt(lastLine: string, modes: { echo: boolean; canonical: boolean }): OwnerPrompt | null {
  if (!modes.echo && modes.canonical) return "secret"
  const line = lastLine.slice(lastLine.lastIndexOf("\n") + 1).trim()
  if (!line.endsWith(":")) return null
  return SECRET_WORD.test(line) || BARE_RESPONSE.test(line) ? "secret" : null
}

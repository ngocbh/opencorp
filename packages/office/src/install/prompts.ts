/** How onboarding talks to the owner: the errors it stops with and the prompter it asks through. */
import type { Readable } from "node:stream"
import { repr } from "../perm/redact.ts"

/** Onboarding stopped; the message says why and what to do. It never contains a key. */
export class OnboardError extends Error {
  override name = "OnboardError"
}

/** A secret was asked for, but there's no terminal to read it from without echo. */
export class NoTerminal extends OnboardError {
  override name = "NoTerminal"
}

/** The owner cancelled a question on the terminal. */
export class KeyboardInterrupt extends Error {
  override name = "KeyboardInterrupt"
}

/** How many answers a question takes before giving up: a preset or a default comes back the same each time. */
export const TRIES = 5

/** The last choice of a typed list on the terminal; picking it asks for the answer. */
export const TYPE_OWN = "Type my own answer"

/** The error for stdin ending before `question` was answered. */
export function closedInput(question: string): OnboardError {
  return new OnboardError(`no answer to ${repr(question)} (stdin closed)`)
}

/** A step as shown: a header such as `Step 2 of 5: You`, then one line on why it matters. */
export function stepLines(number: number, total: number, title: string, why: string): [string, string] {
  return [`Step ${number} of ${total}: ${title}`, why]
}

/** How onboarding talks to the owner. */
export interface Prompter {
  /** Whether there's someone at a terminal to ask; without one, questions take their defaults and secrets throw
   *  `NoTerminal`. */
  readonly interactive: boolean
  /** An answer, or `defaultAnswer` for an empty one. */
  ask(question: string, defaultAnswer?: string): Promise<string>
  /** One of `options`, picked by the owner, or with `typed` an answer they type instead; `defaultAnswer` (an
   *  option, or with `typed` any text) for an empty answer or when there's no one to ask. */
  choose(question: string, options: readonly string[], defaultAnswer?: string, typed?: boolean): Promise<string>
  /** An answer read without echo. */
  secret(question: string): Promise<string>
  /** Tell the owner something. */
  say(text: string): void
  /** Start step `number` of `total`: show `stepLines`. */
  step(number: number, total: number, title: string, why: string): void
}

/** One line from `input` without its `\n` (and a trailing `\r`), the rest left unread; the last
 *  unterminated line at the end; `undefined` once the input has ended with nothing left. */
export function readLine(input: Readable): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (input.readableEnded) {
      resolve(undefined)
      return
    }
    const parts: Buffer[] = []
    const text = () => {
      const line = Buffer.concat(parts).toString("utf8")
      return line.endsWith("\r") ? line.slice(0, -1) : line
    }
    // No listener stays on the stream, so a later terminal prompt on it gets every key. The pause waits a tick
    // because Bun undoes one made inside the handler, and a stream left reading keeps the process alive while the
    // TUI holds stdin open.
    const finish = (settle: () => void) => {
      input.off("readable", onReadable)
      input.off("end", onEnd)
      input.off("error", onError)
      process.nextTick(() => input.pause())
      settle()
    }
    const onReadable = () => {
      let chunk: string | Buffer | null
      while ((chunk = input.read()) !== null) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
        // A newline byte never sits inside a UTF-8 sequence, so splitting the bytes there is safe.
        const at = bytes.indexOf(0x0a)
        if (at === -1) {
          parts.push(bytes)
          continue
        }
        if (at + 1 < bytes.length) input.unshift(bytes.subarray(at + 1))
        parts.push(bytes.subarray(0, at))
        finish(() => resolve(text()))
        return
      }
    }
    const onEnd = () => finish(() => resolve(parts.some((p) => p.length > 0) ? text() : undefined))
    const onError = (error: Error) => finish(() => reject(error))
    input.on("readable", onReadable)
    input.on("end", onEnd)
    input.on("error", onError)
  })
}

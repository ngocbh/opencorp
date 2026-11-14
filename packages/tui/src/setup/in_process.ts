import { PassThrough, type Readable } from "node:stream"
import type { SetupPrompt } from "@opencorp/protocol"
import { printable } from "../util/printable"
import { type SetupChild, parsePrompt } from "./child"

/** What a run behind the setup screen in this process writes to and reads from. */
export interface ScreenIo {
  /** Where its prompts go: JSON lines, as `--json-prompts` writes them on stdout. */
  readonly prompts: { write(text: string): unknown }
  /** Where the screen's answers come from: a `SetupAnswer` JSON line each. Ends at Ctrl-C on the screen. */
  readonly answers: Readable
  /** Shows a child's output: on the plain terminal while a child has it (or once the screen is gone), else on the
   *  screen. */
  echo(text: string): void
}

/** The screen's side of an in-process channel, the run's side (`io`), and `end`, which ends the "child" with `code`.
 *  `ready` resolves once the screen listens, or once it's gone before it did. */
export interface Channel {
  readonly child: SetupChild
  readonly io: ScreenIo
  end(code: number): void
  readonly ready: Promise<void>
  /** Whether the screen closed the channel (its renderer went, by a signal). */
  readonly closed: boolean
}

/**
 * A setup "child" in this process: the lines written to `io.prompts` are parsed as `spawnSetup` parses a child's
 * stdout, so the screen gets the same prompts; its answers go to `io.answers`. Ctrl-C on the screen (`interrupt`)
 * ends `io.answers`, so a question waiting there stops, and calls `interrupt` each time. Output given to `io.echo`
 * goes to `echo` while the terminal is handed over, or after the end, and onto the screen otherwise.
 */
export function inProcessChild(o: { interrupt: () => void; echo: (text: string) => void }): Channel {
  const answers = new PassThrough()
  const queued: SetupPrompt[] = []
  let listener: ((prompt: SetupPrompt) => void) | undefined
  let buffer = ""
  let away = false
  let ended = false
  let closed = false
  let resolveDone!: (code: number) => void
  const done = new Promise<number>((resolve) => (resolveDone = resolve))
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => (resolveReady = resolve))

  const emit = (prompt: SetupPrompt) => {
    if (prompt.type === "hand_over") away = true
    else if (prompt.type === "take_back") away = false
    if (listener) listener(prompt)
    else queued.push(prompt)
  }
  const endAnswers = () => {
    if (!answers.writableEnded) answers.end()
  }
  const child: SetupChild = {
    onPrompt(next) {
      listener = next
      for (const prompt of queued.splice(0)) next(prompt)
      resolveReady()
    },
    answer(text) {
      if (!answers.writableEnded) answers.write(JSON.stringify({ answer: text }) + "\n")
    },
    interrupt() {
      // The run's stop first: a question racing it then ends with the owner's Ctrl-C, not with closed input.
      o.interrupt()
      endAnswers()
    },
    close() {
      closed = true
      resolveReady()
      if (ended) return
      o.interrupt()
      endAnswers()
    },
    done,
    stderr: () => "",
  }
  const io: ScreenIo = {
    prompts: {
      write(text: string) {
        const lines = (buffer + text).split("\n")
        buffer = lines.pop()!
        for (const line of lines) emit(parsePrompt(line))
        return true
      },
    },
    answers,
    echo(text) {
      if (away || ended) return void o.echo(text)
      for (const line of text.replace(/\n$/, "").split("\n")) if (line !== "") emit({ type: "say", text: printable(line) })
    },
  }
  return {
    child,
    io,
    end(code) {
      if (ended) return
      ended = true
      endAnswers()
      resolveDone(code)
    },
    ready,
    get closed() {
      return closed
    },
  }
}

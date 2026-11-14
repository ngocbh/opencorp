/** How onboarding talks to the owner: the errors it stops with and the prompter it asks through. */
import type { Readable, Writable } from "node:stream"
import { type CANCEL_SYMBOL, type CommonOptions, isCancel, password, select, text } from "@clack/prompts"
import type { SetupCommand, SetupResult, SetupReview } from "@opencorp/protocol"
import { repr, strip } from "../perm/redact.ts"

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

/** `text` safe to print: line breaks and tabs become spaces and other control characters are dropped, so model or
 *  program text can't move the cursor or send escapes; invisible format characters (bidi controls, zero-width ones)
 *  are shown as `<U+202E>`, so text can't read other than it runs. */
export function clean(text: string): string {
  // C1 controls (0x80-0x9f) go too: some terminals read 0x9b as the start of an escape sequence.
  return text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? " " : ""))
    .replace(/\p{Cf}/gu, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`)
}

/** The error for stdin ending before `question` was answered. */
export function closedInput(question: string): OnboardError {
  return new OnboardError(`no answer to ${repr(question)} (stdin closed)`)
}

/** A step as shown: a header such as `Step 2 of 5: You`, then one line on why it matters. */
export function stepLines(number: number, total: number, title: string, why: string): [string, string] {
  return [`Step ${number} of ${total}: ${title}`, why]
}

/** Something to look at closely: a command to approve, how it ended, or files to review before saving. */
export type Card = SetupCommand | SetupResult | SetupReview

/** `card` as lines on the terminal: a command's title, warning and lines; a review's title, each file under its name,
 *  what to know before saving, and its warning; a result's title alone — how it ended, or why a chain test failed —
 *  since its output already streamed to the terminal as it came. */
export function cardLines(card: Card): string[] {
  const warning = card.type !== "result" && card.warning ? [card.warning] : []
  if (card.type === "command") return [card.title, ...warning, ...card.lines]
  if (card.type === "result") return [card.title]
  const risks = card.risks ?? []
  return [
    card.title,
    ...card.files.flatMap((file) => [`${file.name}:`, ...file.lines]),
    ...(risks.length > 0 ? ["Before you save it:", ...risks.map((risk) => `  - ${risk}`)] : []),
    ...warning,
  ]
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
  /** Show `card`. */
  show(card: Card): void
  /** Hand the terminal to a child that may prompt on it (ssh's password, Duo or host key), `why` saying what runs;
   *  resolves once the child can have it. `takeBack` once it ends. */
  handOver(why: string): Promise<void>
  /** Take the terminal back after `handOver`. */
  takeBack(): void
}

/** One line from `input` without its `\n` (and a trailing `\r`), the rest left unread; the last
 *  unterminated line at the end or close; `undefined` once the input has ended or closed with nothing left.
 *  Rejects with the stream's error. */
export function readLine(input: Readable): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    // A stream that already failed or closed emits nothing more, so waiting for an event would hang.
    if (input.errored) return reject(input.errored)
    if (input.readableEnded || input.destroyed) return resolve(undefined)
    const parts: Buffer[] = []
    const text = () => {
      const line = Buffer.concat(parts).toString("utf8")
      return line.endsWith("\r") ? line.slice(0, -1) : line
    }
    // No listener stays on the stream, so a later terminal prompt on it gets every key, and a paused stream doesn't
    // keep the process alive while the TUI holds stdin open. The pause is made now, not a tick later, where it
    // would stop the next read's resume.
    const finish = (settle: () => void) => {
      input.off("data", onData)
      input.off("end", onEnd)
      input.off("close", onEnd)
      input.off("error", onError)
      input.pause()
      settle()
    }
    // Flowing mode, not 'readable' and read(): once a readline interface (clack's prompts) has used Bun's tty
    // stream, the stream never delivers to a paused-mode reader again, so a line question after a secret on a dumb
    // terminal would wait for ever.
    const onData = (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      // A newline byte never sits inside a UTF-8 sequence, so splitting the bytes there is safe.
      const at = bytes.indexOf(0x0a)
      if (at === -1) {
        parts.push(bytes)
        return
      }
      parts.push(bytes.subarray(0, at))
      // Paused and without our listener first: an unshift into a flowing stream would hand the rest straight back
      // to a 'data' handler, or drop it with none.
      finish(() => {
        if (at + 1 < bytes.length) input.unshift(bytes.subarray(at + 1))
        resolve(text())
      })
    }
    const onEnd = () => finish(() => resolve(parts.some((p) => p.length > 0) ? text() : undefined))
    const onError = (error: Error) => finish(() => reject(error))
    input.on("data", onData)
    input.on("end", onEnd)
    // A stream destroyed mid-read closes without an end.
    input.on("close", onEnd)
    input.on("error", onError)
    input.resume()
  })
}

/** Whether `stream` is a terminal. */
export function isTTY(stream: Readable | Writable): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true
}

/** Where a `TtyPrompter` asks, and what it knows without asking. */
export interface TtyOptions {
  /** Answers by question text, taken without asking; empty ones are dropped. */
  preset?: Record<string, string>
  /** Whether there's someone to ask (default true). */
  interactive?: boolean
  /** Where answers come from (default `process.stdin`). */
  input?: Readable
  /** Where questions go (default `process.stdout`). */
  output?: Writable
  /** The environment whose `TERM` and `NO_COLOR` decide how questions look (default `process.env`), read once. */
  env?: Record<string, string | undefined>
}

/**
 * Asks on the terminal; a secret is read masked, so it is never echoed.
 *
 * `preset` answers questions by their text without asking (from command-line flags); with `interactive` false,
 * every other question takes its default. When input and output are both terminals, a list is picked with the
 * arrow keys; otherwise it is numbered, and a line picks from it. A typed list ends with `TYPE_OWN`, which asks
 * for the answer; an empty one is the default. A numbered typed list also takes, as the answer, a line that is
 * neither an option nor a number.
 */
export class TtyPrompter implements Prompter {
  readonly interactive: boolean
  readonly dumb: boolean
  readonly color: boolean
  private readonly preset: Map<string, string>
  private readonly input: Readable
  private readonly output: Writable

  constructor(options: TtyOptions = {}) {
    // A Map, so a question such as "constructor" never finds an inherited property.
    this.preset = new Map(Object.entries(options.preset ?? {}).filter(([, v]) => v))
    this.interactive = options.interactive ?? true
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    // Read now: the init flow runs its questions in an environment without these.
    const env = options.env ?? process.env
    this.dumb = env.TERM === "dumb"
    this.color = !env.NO_COLOR && !this.dumb
  }

  /** Whether to colour what is printed: colour is on and it goes to a terminal. */
  private styled(): boolean {
    return this.color && isTTY(this.output)
  }

  /** Whether to draw questions on the terminal rather than ask line by line. */
  private drawn(): boolean {
    // A dumb terminal can't move the cursor to redraw a list.
    return this.interactive && isTTY(this.input) && isTTY(this.output) && !this.dumb
  }

  /** A line typed after `shown`, stripped. */
  private async line(question: string, shown: string): Promise<string> {
    this.output.write(shown)
    const line = await readLine(this.input)
    if (line === undefined) throw closedInput(question)
    return strip(line)
  }

  async ask(question: string, defaultAnswer = ""): Promise<string> {
    const preset = this.preset.get(question)
    if (preset !== undefined) return preset
    if (!this.interactive) return defaultAnswer
    if (this.drawn()) return this.drawnAsk(question, defaultAnswer)
    return (await this.line(question, shown(question, defaultAnswer))) || defaultAnswer
  }

  async choose(question: string, options: readonly string[], defaultAnswer = "", typed = false): Promise<string> {
    const preset = this.preset.get(question)
    if (preset !== undefined) return preset
    if (!this.interactive) return defaultAnswer
    if (!typed) return this.pick(question, options, defaultAnswer)
    // A list on the terminal can't take text, so a last choice asks for it.
    const own = options.includes(defaultAnswer) ? "" : defaultAnswer
    const picked = await this.pick(question, [...options, TYPE_OWN], own ? TYPE_OWN : defaultAnswer, true)
    if (picked !== TYPE_OWN) return picked
    // An empty typed answer is the default, as on the JSON path, so a deployment is never saved empty.
    return (await this.ask(question, own)) || defaultAnswer
  }

  /** One of `options` picked from a list, `defaultAnswer` for an empty answer; with `typed`, a numbered list takes
   *  a line that is neither an option nor a number as the answer. */
  private async pick(
    question: string,
    options: readonly string[],
    defaultAnswer: string,
    typed = false,
  ): Promise<string> {
    // Here, not in choose: without anyone to ask, any list gives its default, and a typed list is never empty.
    if (options.length === 0) throw new Error("a choice needs at least one option")
    if (this.drawn()) return this.drawnPick(question, options, defaultAnswer)
    options.forEach((option, i) => this.say(`  ${i + 1}. ${option}`))
    for (let i = 0; i < TRIES; i++) {
      const line = await this.line(question, shown(question, defaultAnswer))
      // An option is taken before a number, so an option that is a number picks itself.
      if (options.includes(line)) return line
      const number = /^[0-9]+$/.test(line) ? Number(line) : 0
      if (number >= 1 && number <= options.length) return options[number - 1]!
      if (!line) return defaultAnswer
      // A number out of range is a slip, not a typed answer.
      if (typed && !/^[0-9]+$/.test(line)) return line
      this.say(`That doesn't work: choose 1 to ${options.length}`)
    }
    throw new OnboardError(`no usable answer to ${repr(question)}`)
  }

  async secret(question: string): Promise<string> {
    // Without a terminal on both sides the answer would be read or shown in the clear; the input stays unread.
    if (!this.interactive || !isTTY(this.input) || !isTTY(this.output))
      throw new NoTerminal(`there is no terminal to read ${repr(question)} without echo`)
    return this.drawnSecret(question)
  }

  say(text: string): void {
    this.output.write(text + "\n")
  }

  step(number: number, total: number, title: string, why: string): void {
    let [header, line] = stepLines(number, total, title, why)
    if (this.styled()) [header, line] = [`\x1b[1;36m${header}\x1b[0m`, `\x1b[90m${line}\x1b[0m`]
    this.output.write(`\n${header}\n${line}\n`)
  }

  show(card: Card): void {
    for (const line of cardLines(card)) this.say(line)
  }

  /** The terminal is the child's already: questions here are asked only between children. */
  async handOver(_why: string): Promise<void> {}

  takeBack(): void {}

  /** The answer `run` gets from a clack prompt on this terminal. A cancel (Ctrl-C) throws `KeyboardInterrupt`;
   *  input that ends or fails first is closed input. */
  private async clack(
    question: string,
    run: (common: CommonOptions) => Promise<string | typeof CANCEL_SYMBOL>,
  ): Promise<string> {
    const input = this.input
    // clack never notices its input ending and would wait for ever; aborting makes it cancel.
    const controller = new AbortController()
    const abort = () => controller.abort()
    input.on("end", abort)
    input.on("close", abort)
    // An input error (EIO once the terminal is gone) ends the prompt as closed input. readline still re-emits
    // the error on itself, so the setup's top-level handler deals with that.
    input.on("error", abort)
    if (input.readableEnded || input.destroyed) abort()
    try {
      const value = await run({ input, output: this.output, signal: controller.signal, withGuide: false })
      if (isCancel(value)) throw controller.signal.aborted ? closedInput(question) : new KeyboardInterrupt()
      return value
    } finally {
      input.off("end", abort)
      input.off("close", abort)
      input.off("error", abort)
    }
  }

  private async drawnAsk(question: string, defaultAnswer: string): Promise<string> {
    const answer = await this.clack(question, (common) =>
      text({ ...common, message: question, placeholder: defaultAnswer, defaultValue: defaultAnswer }),
    )
    return strip(answer) || defaultAnswer
  }

  private async drawnPick(question: string, options: readonly string[], defaultAnswer: string): Promise<string> {
    return this.clack(question, (common) =>
      select({
        ...common,
        message: question,
        options: options.map((o) => ({ value: o, label: o })),
        // A default that isn't an option starts the list at the top.
        ...(options.includes(defaultAnswer) ? { initialValue: defaultAnswer } : {}),
      }),
    )
  }

  private async drawnSecret(question: string): Promise<string> {
    return strip(await this.clack(question, (common) => password({ ...common, message: question })))
  }
}

/** A line-by-line question as shown: `Q [default]: `, or `Q: ` without a default. */
function shown(question: string, defaultAnswer: string): string {
  return defaultAnswer ? `${question} [${defaultAnswer}]: ` : `${question}: `
}

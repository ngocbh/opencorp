/** Questions for `opencorp`'s setup screen: one `SetupPrompt` JSON line out, one `SetupAnswer` JSON line back. */
import type { Readable } from "node:stream"
import {
  SetupAnswer,
  type SetupAsk,
  type SetupChoose,
  type SetupSay,
  type SetupSecret,
  type SetupStep,
} from "@opencorp/protocol"
import type { z } from "zod"
import { repr, strip } from "../perm/redact.ts"
import { OnboardError, type Prompter, closedInput, readLine } from "./prompts.ts"

type Prompt =
  | z.output<typeof SetupAsk>
  | z.output<typeof SetupChoose>
  | z.output<typeof SetupSecret>
  | z.output<typeof SetupSay>
  | z.output<typeof SetupStep>

/** Where prompts are written. */
export interface TextOut {
  write(text: string): unknown
}

/**
 * Asks through `opencorp`'s setup screen: each prompt is a JSON line on `out`, each answer a JSON line on
 * `answers`.
 *
 * `preset` answers questions by their text without asking, as `TtyPrompter`'s does.
 */
export class JsonPrompter implements Prompter {
  readonly interactive = true
  private readonly preset: Map<string, string>

  constructor(
    private readonly out: TextOut,
    private readonly answers: Readable,
    preset: Record<string, string> = {},
  ) {
    // A Map, so a question such as "constructor" never finds an inherited property.
    this.preset = new Map(Object.entries(preset).filter(([, v]) => v))
  }

  // Each object is built in the field order the TUI's setup screen and Python's models wrote.
  private send(prompt: Prompt): void {
    this.out.write(JSON.stringify(prompt) + "\n")
  }

  private async answer(question: string): Promise<string> {
    const line = await readLine(this.answers)
    if (line === undefined) throw closedInput(question)
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      value = undefined
    }
    const parsed = SetupAnswer.safeParse(value)
    // The line may be a secret sent wrong; say only that it wasn't an answer, with no cause that quotes it.
    if (!parsed.success) throw new OnboardError(`the answer to ${repr(question)} isn't a setup answer`)
    return parsed.data.answer
  }

  async ask(question: string, defaultAnswer = ""): Promise<string> {
    const preset = this.preset.get(question)
    if (preset !== undefined) return preset
    this.send({ type: "ask", question, default: defaultAnswer })
    return strip(await this.answer(question)) || defaultAnswer
  }

  async choose(question: string, options: readonly string[], defaultAnswer = "", typed = false): Promise<string> {
    const preset = this.preset.get(question)
    if (preset !== undefined) return preset
    // The setup screen can't show a choice without options and would wait forever.
    if (options.length === 0) throw new Error("a choice needs at least one option")
    this.send({ type: "choose", question, options: [...options], default: defaultAnswer, typed })
    const answer = await this.answer(question)
    if (options.includes(answer)) return answer
    if (typed) return strip(answer) || defaultAnswer
    // Python checked the raw answer here, so "  " is refused rather than taken as the default.
    if (!answer) return defaultAnswer
    throw new OnboardError(`the answer to ${repr(question)} isn't one of its options`)
  }

  async secret(question: string): Promise<string> {
    this.send({ type: "secret", question })
    return strip(await this.answer(question))
  }

  say(text: string): void {
    this.send({ type: "say", text })
  }

  step(number: number, total: number, title: string, why: string): void {
    this.send({ type: "step", number, total, title, why })
  }
}

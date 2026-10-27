// Protocol schemas: setup.
import { z } from "zod"

/** A typed answer; an empty one means `default`. */
export const SetupAsk = z.strictObject({
  type: z.literal("ask"),
  question: z.string(),
  default: z.string().default(""),
})
export type SetupAsk = z.input<typeof SetupAsk>

/** Pick one of `options`, or with `typed` type an answer. */
export const SetupChoose = z.strictObject({
  type: z.literal("choose"),
  question: z.string(),
  options: z.array(z.string()).min(1),
  default: z.string().default(""),
  /** Whether the owner may type an answer of their own instead of picking one of `options`. */
  typed: z.boolean().default(false),
})
export type SetupChoose = z.input<typeof SetupChoose>

/** An answer typed without being shown. */
export const SetupSecret = z.strictObject({
  type: z.literal("secret"),
  question: z.string(),
})
export type SetupSecret = z.input<typeof SetupSecret>

/** A line to show. */
export const SetupSay = z.strictObject({
  type: z.literal("say"),
  text: z.string(),
})
export type SetupSay = z.input<typeof SetupSay>

/** The start of step `number` of `total`. */
export const SetupStep = z.strictObject({
  type: z.literal("step"),
  number: z.int().min(1),
  total: z.int().min(1),
  title: z.string(),
  why: z.string(),
})
export type SetupStep = z.input<typeof SetupStep>

/**
 * One line `opencorp init|onboard --json-prompts` writes on stdout: a question for `opencorp`'s setup
 * screen, or something to show.
 */
export const SetupPrompt = z.discriminatedUnion("type", [
  SetupAsk, SetupChoose, SetupSecret, SetupSay, SetupStep,
])
export type SetupPrompt = z.input<typeof SetupPrompt>

/**
 * One line `opencorp`'s setup screen writes to the install's stdin: the answer to the last ask, choose or
 * secret.
 */
export const SetupAnswer = z.strictObject({
  answer: z.string(),
})
export type SetupAnswer = z.input<typeof SetupAnswer>

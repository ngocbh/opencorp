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

/** A command to approve, as it will run: what it's for, a warning (empty for none), and its lines as shown. */
export const SetupCommand = z.strictObject({
  type: z.literal("command"),
  title: z.string(),
  warning: z.string().default(""),
  lines: z.array(z.string()),
})
export type SetupCommand = z.input<typeof SetupCommand>

/** How a command ended (`ok` when it exited 0), and the last lines it printed. */
export const SetupResult = z.strictObject({
  type: z.literal("result"),
  title: z.string(),
  ok: z.boolean(),
  lines: z.array(z.string()).default([]),
})
export type SetupResult = z.input<typeof SetupResult>

/** Files to save, shown before the question that saves them: each file's heading and lines as shown, what to know
 *  first, and a warning (empty for none). */
export const SetupReview = z.strictObject({
  type: z.literal("review"),
  title: z.string(),
  files: z.array(z.strictObject({ name: z.string(), lines: z.array(z.string()) })).min(1),
  risks: z.array(z.string()).default([]),
  warning: z.string().default(""),
})
export type SetupReview = z.input<typeof SetupReview>

/** The terminal goes to a program that may prompt on it, such as ssh asking for a password; `why` says what runs.
 *  Answered (with an empty answer) once the program can have it. */
export const SetupHandOver = z.strictObject({
  type: z.literal("hand_over"),
  why: z.string(),
})
export type SetupHandOver = z.input<typeof SetupHandOver>

/** The terminal comes back after a `hand_over`. */
export const SetupTakeBack = z.strictObject({
  type: z.literal("take_back"),
})
export type SetupTakeBack = z.input<typeof SetupTakeBack>

/**
 * One line `opencorp init|onboard --json-prompts` writes on stdout: a question for `opencorp`'s setup
 * screen, or something to show.
 */
export const SetupPrompt = z.discriminatedUnion("type", [
  SetupAsk, SetupChoose, SetupSecret, SetupSay, SetupStep, SetupCommand, SetupResult, SetupReview, SetupHandOver,
  SetupTakeBack,
])
export type SetupPrompt = z.input<typeof SetupPrompt>

/**
 * One line `opencorp`'s setup screen writes to the install's stdin: the answer to the last ask, choose, secret or
 * hand_over.
 */
export const SetupAnswer = z.strictObject({
  answer: z.string(),
})
export type SetupAnswer = z.input<typeof SetupAnswer>

// What the model call view says of a call: its line in a node's list and the rows of its tool calls under it, a long
// text's fold, the office's cuts, usage, a thought the provider didn't share, and a tool call's state and the gate's
// notes on it.
import type { RunCall, RunCallEntry, RunCallToolCall, RunCallToolResult, RunCallUsage } from "@opencorp/protocol"

/** A long text shows its first FOLD_LINES lines, at most FOLD_CHARS characters, until "Show all". */
export const FOLD_LINES = 12
export const FOLD_CHARS = 1_000

/** Yian's finish reasons in words. */
const FINISHES: Record<string, string> = {
  stop: "replied",
  tool_calls: "asked for tools",
  length: "cut off at the token limit",
  content_filter: "refused by the provider",
  interrupted: "interrupted",
}

/** How a call finished, in words: "replied", "asked for tools"…; "failed" for none; any other provider text as is. */
export function finishText(finish: string | null | undefined): string {
  if (finish == null) return "failed"
  return Object.hasOwn(FINISHES, finish) ? FINISHES[finish]! : finish
}

/** A part of a listed call's line, and its tooltip. */
export type CallPart = { text: string; title?: string }

/**
 * A listed call's line in parts: "Call 2", its model, how it finished in words (its raw value the tooltip), then its
 * purpose when it isn't chat and its attempts past one. `ordinal` is its place among the node's calls, from 1: the
 * call's `n` is its step in the node, which tool results and retried attempts take too, so it only opens the call.
 */
export function callParts(call: RunCallEntry, ordinal: number): CallPart[] {
  const finish = call.finish ?? null
  const parts: CallPart[] = [
    { text: `Call ${ordinal}` },
    { text: call.model },
    finish === null ? { text: finishText(finish) } : { text: finishText(finish), title: finish },
  ]
  if (call.purpose !== "chat") parts.push({ text: call.purpose })
  if ((call.attempts ?? 1) > 1) parts.push({ text: `${call.attempts} attempts` })
  return parts
}

/** A listed call's line as text: "Call 2 · gpt-5 · replied". */
export const callLine = (call: RunCallEntry, ordinal: number) =>
  callParts(call, ordinal)
    .map((part) => part.text)
    .join(" · ")

/** The head `text` shows folded: its first FOLD_LINES lines, cut to FOLD_CHARS; null when it shows whole. */
export function foldedHead(text: string): string | null {
  let head = text.split("\n").slice(0, FOLD_LINES).join("\n")
  if (head.length > FOLD_CHARS) {
    // Never half of a surrogate pair.
    const end = /[\uD800-\uDBFF]/.test(head[FOLD_CHARS - 1]!) ? FOLD_CHARS - 1 : FOLD_CHARS
    head = head.slice(0, end)
  }
  return head.length < text.length ? head : null
}

/** The JSON pointer of `tokens`, as the office names a string it cut. */
export const pointer = (...tokens: (string | number)[]) =>
  tokens.map((t) => `/${String(t).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("")

/** Whether the office cut the string at `at`, or one under it. */
export const cutAt = (call: Pick<RunCall, "cut">, at: string) =>
  (call.cut ?? []).some((cut) => cut === at || cut.startsWith(`${at}/`))

/** Token counts as one line, leaving out what the provider didn't report: "1,200 in · 300 out · 800 cached". */
export function usageText(usage: RunCallUsage | null | undefined): string {
  if (!usage) return ""
  const counts: [number | null, string][] = [
    [usage.input_tokens, "in"],
    [usage.output_tokens, "out"],
    [usage.cache_read_tokens, "cached"],
    [usage.cache_creation_tokens, "cache written"],
    [usage.reasoning_tokens, "reasoning"],
  ]
  return counts
    .filter(([count]) => count != null)
    .map(([count, what]) => `${count!.toLocaleString("en-US")} ${what}`)
    .join(" · ")
}

/** What a thought with no text says: the provider didn't share it (OpenAI shares only a summary, and only when asked),
 *  and what it cost when `usage` reports reasoning tokens. */
export function hiddenReasoning(usage: RunCallUsage | null | undefined): string {
  const tokens = usage?.reasoning_tokens ?? 0
  if (tokens <= 0) return "The provider didn't share its reasoning"
  const count = `${tokens.toLocaleString("en-US")} token${tokens === 1 ? "" : "s"}`
  return `Reasoned privately (${count}): the provider didn't share its reasoning`
}

/** How yian closed a call it wrote the result of, in words: `timed_out` as "timed out"; another closer as it is. */
const closedText = (closed: string) => (closed === "timed_out" ? "timed out" : closed)

/** How a listed tool call stands, in words: the closer yian wrote its result with (crashed, refused, skipped…), else
 *  its outcome (ok, error, held, pending); one a later yian adds as it is. */
export const outcomeText = (tool: RunCallToolCall) => (tool.closed ? closedText(tool.closed) : tool.outcome)

/** A listed tool call's row as text: "run_command · ok". */
export const toolLine = (tool: RunCallToolCall) => `${tool.name} · ${outcomeText(tool)}`

/** Whether a listed tool call went wrong: its result is an error, its tool's or one yian wrote in its place. */
export const wentWrong = (tool: RunCallToolCall) => tool.outcome === "error"

/** A rebuilt tool call's state in the words its listed row uses: how yian closed it, held while the gate holds it,
 *  pending while it has no result, else ok or error. */
export function toolState(result: RunCallToolResult): string {
  if (result.closed) return closedText(result.closed)
  if (result.output == null) return result.held && !result.release_note ? "held" : "pending"
  return result.is_error ? "error" : "ok"
}

/** What the office's gate said of a tool call, a line each: why it let it run, and a hold and how it ended. */
export function gateLines(result: RunCallToolResult): string[] {
  const lines: string[] = []
  if (result.note) lines.push(`Allowed: ${result.note}`)
  if (result.held) {
    if (result.release_note) lines.push(`Held, then released: ${result.release_note}`)
    else if (result.output == null) lines.push("Held: waiting for an answer")
    else lines.push("Held, then answered without running")
  }
  if (result.closed === "refused") lines.push("Refused by the gate")
  return lines
}

/** A tool call's arguments in one short line: their first string, else their JSON, cut to 80 characters. */
export function argsLine(args: Record<string, unknown> | null | undefined): string {
  if (!args) return ""
  const first = Object.values(args).find((value) => typeof value === "string") as string | undefined
  const line = (first ?? JSON.stringify(args)).replace(/\s+/g, " ").trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** A wait or a span in seconds: "0.5 s", "12 s". */
export const seconds = (s: number) => `${Number.isInteger(s) ? s : s.toFixed(1)} s`

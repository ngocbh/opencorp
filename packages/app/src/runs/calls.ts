// What the model call view says of a call: its line in a node's list, a long text's fold, the office's cuts, usage,
// and a tool call's state and the gate's notes on it.
import type { RunCall, RunCallEntry, RunCallToolResult, RunCallUsage } from "@opencorp/protocol"

/** A long text shows its first FOLD_LINES lines, at most FOLD_CHARS characters, until "Show all". */
export const FOLD_LINES = 12
export const FOLD_CHARS = 1_000

/** A listed call's line: "Call 4 · gpt-5 · stop", then its purpose when it isn't chat and its attempts past one. */
export function callLine(call: RunCallEntry): string {
  const parts = [`Call ${call.n}`, call.model, call.finish ?? "failed"]
  if (call.purpose !== "chat") parts.push(call.purpose)
  if ((call.attempts ?? 1) > 1) parts.push(`${call.attempts} attempts`)
  return parts.join(" · ")
}

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

/** A tool call's state in a word: how yian closed it (refused, skipped, interrupted…), waiting while it has no result,
 *  else ran or error. */
export function toolState(result: RunCallToolResult): string {
  if (result.closed) return result.closed
  if (result.output == null) return "waiting"
  return result.is_error ? "error" : "ran"
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

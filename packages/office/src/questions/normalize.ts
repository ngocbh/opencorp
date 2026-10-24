/** Clean the options a model sends with a question. */
import { casefold } from "../perm/redact.ts"

export const MAX_OPTIONS = 6
export const MAX_OPTION_CHARS = 80

/** The card's own controls; a model option with one of these labels would look like one. */
export const ACTION_LABELS = ["type an answer", "chat about this", "send discussion back", "stop"] as const

const FORMAT = /^\p{Cf}$/u
const VARIATION_SELECTOR = /^[\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]$/u
const PUNCTUATION_OR_SYMBOL = /^[\p{P}\p{S}]$/u
/** What Python's `str.split()` splits on: JS `\s` lacks the information separators and NEL. */
const WHITESPACE = /[\s\x1c-\x1f\x85]+/u

/**
 * Return the option labels a card shows for a model's `options` argument.
 *
 * Any shape is accepted and none throws: a JSON list string is parsed, other strings are one label, non-string
 * items are dropped, labels are squeezed to one line, cut to 80 characters, deduplicated case-insensitively, and at
 * most six are kept. Then labels matching a card action, or `Stop <name>` for one of the asker's `names`, are
 * dropped, compared by `key`.
 */
export function normalizeOptions(value: unknown, options: { names?: Iterable<string> } = {}): string[] {
  const actions = new Set<string>(ACTION_LABELS.map(key))
  for (const name of options.names ?? []) actions.add(key(`stop ${name}`))
  return labels(value).filter((label) => !actions.has(key(label)))
}

/**
 * `label` for comparing with an action.
 *
 * NFKC-normalized, punctuation and symbols (emoji included) as spaces, invisible format characters and variation
 * selectors removed, spaces collapsed, and casefolded.
 */
function key(label: string): string {
  let kept = ""
  // By code point, so an astral emoji is one symbol.
  for (const char of label.normalize("NFKC")) {
    if (FORMAT.test(char) || VARIATION_SELECTOR.test(char)) continue
    kept += PUNCTUATION_OR_SYMBOL.test(char) ? " " : char
  }
  return casefold(kept.split(WHITESPACE).filter((part) => part !== "").join(" "))
}

/**
 * Return the cleaned labels for a model's `options` argument, before action labels are dropped; exported for the
 * test that compares it with yian's cleaning.
 */
export function labels(value: unknown): string[] {
  // Mirrors yian's `normalizeOptions` (`ts/src/tools/registry.ts`), which cleans a model's `ask_user` options.
  if (typeof value === "string") {
    let parsed: unknown = null
    try {
      // yian parses with its own JSON reader; the two differ only on edge inputs (huge exponents, unpaired
      // surrogate keys).
      parsed = JSON.parse(value)
    } catch {
      // Not JSON: the string is one label.
    }
    value = Array.isArray(parsed) ? parsed : [value]
  }
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string") continue
    let label = item.split(/\s+/).filter((part) => part !== "").join(" ")
    // Code points, as Python's `len` counts them.
    const chars = Array.from(label)
    if (chars.length > MAX_OPTION_CHARS) label = chars.slice(0, MAX_OPTION_CHARS - 1).join("") + "…"
    const folded = label.toUpperCase().toLowerCase()
    if (label === "" || seen.has(folded)) continue
    seen.add(folded)
    result.push(label)
    if (result.length === MAX_OPTIONS) break
  }
  return result
}

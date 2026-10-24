/** Secret scrubbing for asset-tool results and audit rows: every form of a secret the office
 *  knows, as Python's monitor scrubs them (perm/monitor.py), with the Python string functions it relies on. */

// The Python string functions the forms above are built with

const JSON_NAMED: Record<number, string> = { 0x22: "\\\"", 0x5c: "\\\\", 0x08: "\\b", 0x0c: "\\f", 0x0a: "\\n",
  0x0d: "\\r", 0x09: "\\t" }

const hex4 = (unit: number) => "\\u" + unit.toString(16).padStart(4, "0")

/** Python's `json.dumps(text, ensure_ascii=...)` of a str, quotes included. */
export function jsonDumps(text: string, ensureAscii = true): string {
  let out = "\""
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    // Units are escaped one by one, so an astral character becomes its surrogate pair as in Python.
    const escaped = JSON_NAMED[unit] ?? (unit < 0x20 || (ensureAscii && unit > 0x7e) ? hex4(unit) : undefined)
    if (escaped === undefined) continue
    out += text.slice(start, i) + escaped
    start = i + 1
  }
  return out + text.slice(start) + "\""
}

const ALWAYS_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~"
const PERCENT = Array.from({ length: 256 }, (_, byte) => "%" + byte.toString(16).toUpperCase().padStart(2, "0"))

/** Python's `urllib.parse.quote(text, safe)`. */
export function quote(text: string, safe = "/"): string {
  const table = PERCENT.slice()
  // Python drops non-ASCII characters of `safe`, so only ASCII ones keep their byte.
  for (const char of ALWAYS_SAFE + safe) if (char.charCodeAt(0) < 0x80) table[char.charCodeAt(0)] = char
  let out = ""
  for (const byte of new TextEncoder().encode(text)) out += table[byte]
  return out
}

/** Python's `urllib.parse.quote_plus(text, safe)`. */
export function quotePlus(text: string, safe = ""): string {
  if (!text.includes(" ")) return quote(text, safe)
  return quote(text, safe + " ").replaceAll(" ", "+")
}

/** Python's whitespace (`str.isspace`); unlike JS's, it holds U+001C to U+001F and U+0085 but not U+FEFF. */
const SPACE = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

/** Python's `str.strip()` with no argument. */
export function strip(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && SPACE.test(text[start]!)) start++
  while (end > start && SPACE.test(text[end - 1]!)) end--
  return text.slice(start, end)
}

/** Python's `str.splitlines()` without line ends. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  // A text that ends at a break (or is empty) leaves an empty last piece that Python doesn't return.
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** Text as a note to an agent quotes it: an output's last lines in a few bytes, a long text on one line, a fence no
 *  line of the text can close, and how long something ran. */

/** The end of `text`: its last `lines` lines, trailing line end dropped, in at most `bytes` UTF-8 bytes, so whole
 *  lines from the front go first, then the head of a longer last line. A first line `cut` at its start goes when
 *  another follows it. */
export function lastLines(text: string, { lines: most, bytes, cut = false }: { lines: number; bytes: number; cut?: boolean }): string {
  let lines = text.replace(/\n$/, "").split("\n")
  if (cut && lines.length > 1) lines = lines.slice(1)
  lines = lines.slice(-most)
  while (lines.length > 1 && Buffer.byteLength(lines.join("\n")) > bytes) lines.shift()
  const [only] = lines
  if (lines.length === 1 && Buffer.byteLength(only!) > bytes) return tailBytes(only!, bytes)
  return lines.join("\n")
}

/** The end of `text` in at most `bytes` UTF-8 bytes, never inside a character. */
export function tailBytes(text: string, bytes: number): string {
  const chars = [...text]
  let size = 0
  let at = chars.length
  while (at > 0 && size + Buffer.byteLength(chars[at - 1]!) <= bytes) size += Buffer.byteLength(chars[--at]!)
  return chars.slice(at).join("")
}

/** `text` on one line: each run of white space one space, and its first `chars` characters, `…` after. */
export function oneLine(text: string, chars: number): string {
  const flat = [...text.replace(/\s+/g, " ").trim()]
  return flat.length > chars ? `${flat.slice(0, chars).join("")}…` : flat.join("")
}

/** The fence that quotes `text`: backticks, one more than its longest run of them, and at least three, so no line of
 *  it closes the quote. */
export function fence(text: string): string {
  return "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)))
}

/** `seconds` as a note says it: `12s`, `4m12s`, or `1h03m`. */
export function elapsed(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
}

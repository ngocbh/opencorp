/** The last `limit` code units of `text`, without a low surrogate whose pair the limit cut off. */
export function tail(text: string, limit: number) {
  if (text.length <= limit) return text
  const start = text.length - limit
  const code = text.charCodeAt(start)
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start)
}

/** The last `limit` code units of a program's output, starting at a line when one starts within them, so the cut
 *  splits neither a character nor an escape sequence; else as `tail` cuts it. */
export function lineTail(text: string, limit: number) {
  if (text.length <= limit) return text
  const kept = tail(text, limit)
  const line = kept.indexOf("\n")
  return line < 0 ? kept : kept.slice(line + 1)
}

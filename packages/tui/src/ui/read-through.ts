import { createMemo } from "solid-js"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** `line` broken into pieces no wider than `width`, so a line wider than the screen wraps whole and never clips; an
 *  empty line stays one row. A card wraps its text with this and draws each row unwrapped, so the rows it counts are
 *  the rows on screen. */
export function wrap(line: string, width: number): string[] {
  if (line === "") return [""]
  const rows: string[] = []
  let row = ""
  let cells = 0
  // By grapheme and by the cells each takes, so a wide character counts as two and a surrogate pair is never split.
  for (const { segment } of graphemes.segment(line)) {
    const w = Bun.stringWidth(segment)
    if (cells + w > width && row !== "") {
      rows.push(row)
      row = ""
      cells = 0
    }
    row += segment
    cells += w
  }
  rows.push(row)
  return rows
}

/** Whether every row of a card has been on screen in its final layout: rows seen before `ready` (the question's
 *  footer drawn) don't count, and a re-wrap (a resize, or full screen) counts again from what is on screen. */
export function createReadThrough(opts: {
  rows: () => readonly unknown[]
  top: () => number
  view: () => number
  ready: () => boolean
}): () => boolean {
  // How far down the rows have been on screen, for the rows it was counted on. A memo rather than an effect, so a
  // re-wrap is never read against the count of the rows before it.
  const through = createMemo<{ rows?: readonly unknown[]; seen: number }>(
    (prev) => {
      const rows = opts.rows()
      const now = Math.min(opts.top() + opts.view(), rows.length)
      if (!opts.ready()) return { seen: 0 }
      if (prev.rows !== rows) return { rows, seen: now }
      return { rows, seen: Math.max(prev.seen, now) }
    },
    { seen: 0 },
  )
  return () => opts.ready() && through().rows === opts.rows() && through().seen >= opts.rows().length
}

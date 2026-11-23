import type { TextareaRenderable } from "@opentui/core"

// Deletes the document cells [start, end) and leaves the cursor at start.
export function deleteCells(input: TextareaRenderable, start: number, end: number) {
  const from = input.editBuffer.offsetToPosition(start)
  const to = input.editBuffer.offsetToPosition(end)
  if (from && to) input.deleteRange(from.row, from.col, to.row, to.col)
}

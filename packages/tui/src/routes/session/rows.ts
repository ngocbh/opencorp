import type { Message, Part, ToolPart } from "@opencorp/protocol"
import {
  partitionPending,
  partPath,
  projectEntries,
  type AppendPart,
  type ProjectionEntry,
  type SessionRow,
  type Verbosity,
} from "./grouping/session"

/**
 * An assistant message's parts as transcript rows: each run of tool calls grouped as `verbosity` says, and the calls
 * in `pending` (waiting on an approval card) kept out of their group's summary. `name` gives the upstream tool a call
 * stands for. A run never crosses a text part, but a blank one (`blank`, the part at `index`) draws nothing and breaks
 * none.
 */
export function reduceMessageRows(
  message: Message,
  verbosity: Verbosity,
  name: (part: ToolPart) => string,
  pending: Set<string>,
  blank: (part: Part, index: number) => boolean = blankText,
): SessionRow[] {
  const entries = message.parts.flatMap((part, index): ProjectionEntry[] => {
    if (blank(part, index)) return []
    const append: AppendPart = part.type === "tool" ? { type: "tool", name: name(part) } : { type: part.type }
    return [
      {
        entry: { type: "part", ref: { messageID: message.id, partID: part.id } },
        part: append,
        path: partPath(append, verbosity),
      },
    ]
  })
  const rows = projectEntries(entries)
  partitionPending(rows, pending)
  return rows
}

/** Whether a part draws nothing: a text part with only whitespace. Stops at its first other character. */
export function blankText(part: Part) {
  return part.type === "text" && !/\S/.test(part.text)
}

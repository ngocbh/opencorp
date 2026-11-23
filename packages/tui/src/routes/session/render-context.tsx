import { createContext, useContext } from "solid-js"
import type { useTuiConfig } from "../../config"
import type { createTimelineAnchors } from "./anchors"
import type { GroupKind, Verbosity } from "./grouping/session"

/** What a session's transcript renders with. */
export const context = createContext<{
  /** The mounted parts, group headers and whole messages, by where they are. */
  anchors: ReturnType<typeof createTimelineAnchors>
  width: number
  sessionID: string
  conceal: () => boolean
  /** Whether the last reply can still grow. */
  streaming: () => boolean
  showTimestamps: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  /** How much of a reply's tool activity shows. */
  verbosity: () => Verbosity
  /** Whether adjacent reads and searches group under one line. */
  groupExploration: () => boolean
  /** Whether group `groupID` is open: as the owner left it, else open at High for reads and searches. */
  groupExpanded: (groupID: string, kind: GroupKind) => boolean
  setGroupExpanded: (groupID: string, expanded: boolean) => void
  tui: ReturnType<typeof useTuiConfig>
  /** Opens instrument `id` in the right pane, as the session's `onOpen`. */
  onOpen?: (id: string) => void
}>()

export function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

import type { Renderable } from "@opentui/core"
import { groupID, type PartRef, type SessionEntry, type SessionNode } from "./grouping/session"

export type AnchorTarget = { type: "part"; ref: PartRef } | { type: "group"; groupID: string }

type Anchor = {
  target: AnchorTarget
  node: Pick<Renderable, "y" | "height" | "isDestroyed">
}

/** Where the reader left a transcript: the anchor at the viewport's top, and the screen row it was on. */
export type ScrollAnchor = {
  target: AnchorTarget
  screenY: number
}

export function anchorKey(target: AnchorTarget) {
  return target.type === "part"
    ? JSON.stringify(["part", target.ref.messageID, target.ref.partID])
    : JSON.stringify(["group", target.groupID])
}

/** A user message or an instrument note renders whole: its one reference is its body. */
export function messageRef(messageID: string): PartRef {
  return { messageID, partID: "message" }
}

/** Whether `ref` is a whole message's body rather than a part of a reply. */
export function isMessageRef(ref: PartRef) {
  return ref.partID === "message"
}

/** An entry's reference, copied. */
export function entryRef(entry: SessionEntry): PartRef {
  // Saved identities must not follow an in-place Solid store reconciliation.
  return { messageID: entry.ref.messageID, partID: entry.ref.partID }
}

export function containsAnchor(
  node: SessionEntry | Extract<SessionNode, { type: "group" }>,
  target: AnchorTarget,
  level = 0,
): boolean {
  if (node.type === "group") {
    if (target.type === "group" && groupID(node, level) === target.groupID) return true
    return node.children.some((child) =>
      containsAnchor(child.type === "entry" ? child.entry : child, target, level + 1),
    )
  }
  const ref = entryRef(node)
  return target.type === "part" && ref.messageID === target.ref.messageID && ref.partID === target.ref.partID
}

/** Only mounted parts and actual group headers register. Geometry stays in OpenTUI. */
export function createTimelineAnchors() {
  const entries = new Map<string, Anchor>()
  const list = () =>
    [...entries.values()]
      .filter((anchor) => !anchor.node.isDestroyed && anchor.node.height > 0)
      .sort((a, b) => a.node.y - b.node.y)
  return {
    register(anchor: Anchor) {
      const key = anchorKey(anchor.target)
      entries.set(key, anchor)
      return () => {
        if (entries.get(key) === anchor) entries.delete(key)
      }
    },
    get(target: AnchorTarget) {
      const anchor = entries.get(anchorKey(target))
      return anchor && !anchor.node.isDestroyed && anchor.node.height > 0 ? anchor : undefined
    },
    forMessage(messageID: string) {
      return list().find((anchor) => anchor.target.type === "part" && anchor.target.ref.messageID === messageID)
    },
    messagePositions() {
      const seen = new Set<string>()
      return list().flatMap((anchor) => {
        if (anchor.target.type !== "part" || seen.has(anchor.target.ref.messageID)) return []
        const id = anchor.target.ref.messageID
        seen.add(id)
        return [{ id, y: anchor.node.y }]
      })
    },
    list,
  }
}

/** How many sessions' scroll anchors a TUI keeps: those left most recently. */
export const SCROLL_MEMORY_SIZE = 50

const memories = new WeakMap<object, Map<string, ScrollAnchor>>()

/**
 * Where the reader left each session's transcript, by session id, kept in memory as long as the TUI runs, as
 * upstream's session tabs keep it: the session route remounts on navigation, and a session opens where it was left.
 * None while the reader is at the bottom; upstream drops a session's anchor with its tab, and ours, with no tabs, keeps
 * the most recent `SCROLL_MEMORY_SIZE`. One store per renderer, so two TUIs in one process keep their own.
 */
export function scrollMemory(renderer: object) {
  let anchors = memories.get(renderer)
  if (!anchors) memories.set(renderer, (anchors = new Map()))
  const saved = anchors
  return {
    scrollAnchor(sessionID: string) {
      return saved.get(sessionID)
    },
    setScrollAnchor(sessionID: string, anchor: ScrollAnchor | undefined) {
      if (anchor === undefined) return void saved.delete(sessionID)
      const current = saved.get(sessionID)
      if (current && anchorKey(current.target) === anchorKey(anchor.target) && current.screenY === anchor.screenY)
        return
      // A map keeps insertion order: setting it anew makes it the most recent.
      saved.delete(sessionID)
      saved.set(sessionID, anchor)
      if (saved.size > SCROLL_MEMORY_SIZE) saved.delete(saved.keys().next().value!)
    },
  }
}

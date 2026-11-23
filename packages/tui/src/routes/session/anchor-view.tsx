import { children, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { Renderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { entryRef, type AnchorTarget } from "./anchors"
import type { SessionEntry } from "./grouping/session"
import { use } from "./render-context"

/** Registers `node` as the transcript's anchor for `target` while both are set. */
export function useAnchor(props: {
  target: Accessor<AnchorTarget | undefined>
  node: Accessor<Renderable | undefined>
}) {
  const ctx = use()
  createEffect(() => {
    const target = props.target()
    const node = props.node()
    if (!target || !node) return
    onCleanup(ctx.anchors.register({ target, node }))
  })
}

/**
 * The first renderable `content` renders. Upstream boxes each anchored entry; ours register the entry's own first
 * node instead, since a reply's rows lay out against their siblings (an inline tool row's margin reads the row above
 * it) and a box around one would change its spacing.
 */
function firstNode(content: Accessor<JSX.Element>) {
  const nodes = children(content)
  // Solid types resolved children as the DOM's; here they are renderables.
  const node = createMemo(
    () => nodes.toArray().find((item: unknown) => item instanceof Renderable) as Renderable | undefined,
  )
  return { nodes, node }
}

/** Registers the first node of a reply's part as the anchor for `entry`, around what renders it. */
export function EntryAnchor(props: { entry: SessionEntry; children: JSX.Element }) {
  const { nodes, node } = firstNode(() => props.children)
  useAnchor({ target: () => ({ type: "part", ref: entryRef(props.entry) }), node })
  return <>{nodes()}</>
}

/** Registers the first node of a group, its line, as the anchor for group `groupID` while `active`. */
export function GroupAnchor(props: { groupID: string | undefined; active: boolean; children: JSX.Element }) {
  const { nodes, node } = firstNode(() => props.children)
  useAnchor({
    target: () => (props.groupID && props.active ? { type: "group", groupID: props.groupID } : undefined),
    node,
  })
  return <>{nodes()}</>
}

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useRenderer, type JSX } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { summarizeActivity, type ActivityItem } from "./activity-summary"
import {
  groupID,
  visitEntries,
  type PartRef,
  type SessionEntry,
  type SessionGroup,
  type SessionNode,
} from "./grouping/session"
import { InlineToolRow } from "./message-parts"
import { use } from "./render-context"

type Renderers = {
  /** A call as its group's summary reads it; undefined for a part that is no call. */
  item: (ref: PartRef) => ActivityItem | undefined
  entry: (entry: SessionEntry) => JSX.Element
}

type GroupProps = Renderers & {
  node: Extract<SessionNode, { type: "group" }>
  level: number
  completed: boolean
  pending: readonly PartRef[]
  pendingOutside?: boolean
}

export function SessionGroupView(props: Renderers & { row: SessionGroup }) {
  return <Group {...props} node={props.row} level={0} completed={props.row.completed} pending={props.row.pending} />
}

function Group(props: GroupProps) {
  // Keep kind-specific hover/title state isolated during reconciliation.
  return (
    <Show when={props.node.kind} keyed>
      {(kind) => (
        <Switch fallback={<GroupContent {...props} />}>
          <Match when={kind === "activity"}>
            <ActivityGroup {...props} />
          </Match>
        </Switch>
      )}
    </Show>
  )
}

/** Adjacent reads and searches under one line, such as "Explored: 2 reads, 1 search", that a click opens. */
function GroupContent(props: GroupProps) {
  const ctx = use()
  const { theme } = useTheme()
  const disclosure = useDisclosure(props)
  const [hover, setHover] = createSignal(false)
  const entries = createMemo(() => descendants(props.node))
  const tools = createMemo(() =>
    entries().flatMap((entry) => {
      if (isPending(entry, props.pending)) return []
      const item = props.item(entry.ref)
      return item ? [item] : []
    }),
  )
  const grouped = () => ctx.groupExploration()
  const completed = () =>
    props.completed || (tools().length > 0 && tools().every((item) => item.state !== "pending" && item.state !== "running"))
  const label = createMemo(() => {
    const counts = tools().reduce<Record<string, number>>((result, item) => {
      const name = item.name === "list" || item.name === "search" ? "search" : item.name
      result[name] = (result[name] ?? 0) + 1
      return result
    }, {})
    const names = Object.entries(counts).map(
      ([name, count]) => `${count} ${count === 1 ? name : name === "search" ? `${name}es` : `${name}s`}`,
    )
    return `${completed() ? "Explored" : "Exploring"}: ${names.join(", ")}`
  })
  const children = () => <Children {...props} nodes={props.node.children} />

  return (
    <>
      <Show when={grouped()} fallback={children()}>
        <Show when={tools().length > 0}>
          <InlineToolRow
            icon={completed() ? "→" : "✱"}
            color={hover() ? theme.text : theme.textMuted}
            complete={completed()}
            pending={label()}
            spinner={!completed()}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={() => disclosure.toggle()}
          >
            {label()}
          </InlineToolRow>
        </Show>
        <Show when={disclosure.expanded() && tools().length > 0}>{children()}</Show>
      </Show>
      <PendingEntries {...props} entries={entries()} />
    </>
  )
}

/**
 * Low verbosity: one summary for a run of tools, such as "+ 3 commands, 1 edit, 4 reads", that a click opens. Its
 * calls show as the transcript shows them, one after another.
 */
function ActivityGroup(props: GroupProps) {
  const { theme } = useTheme()
  const disclosure = useDisclosure(props)
  const [hover, setHover] = createSignal(false)
  const entries = createMemo(() => descendants(props.node))
  const summary = createMemo(() => summarizeActivity(props.node, props.item, props.pending))
  return (
    <>
      <Show when={summary().label}>
        <InlineToolRow
          icon={disclosure.expanded() ? "−" : "+"}
          color={hover() ? theme.text : theme.textMuted}
          complete={true}
          pending={summary().label}
          spinner={!disclosure.expanded() && summary().active}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => disclosure.toggle()}
        >
          {summary().label}
        </InlineToolRow>
        <Show when={disclosure.expanded()}>
          <Children {...props} nodes={props.node.children} />
        </Show>
      </Show>
      <PendingEntries {...props} entries={entries()} />
    </>
  )
}

function useDisclosure(props: GroupProps) {
  const ctx = use()
  const renderer = useRenderer()
  const id = createMemo(() => groupID(props.node, props.level))
  const expanded = () => {
    const key = id()
    return key ? ctx.groupExpanded(key, props.node.kind) : false
  }
  return {
    id,
    expanded,
    toggle() {
      if (renderer.getSelection()?.getSelectedText()) return
      const key = id()
      if (key) ctx.setGroupExpanded(key, !expanded())
    },
  }
}

function descendants(node: Extract<SessionNode, { type: "group" }>) {
  const result: SessionEntry[] = []
  visitEntries(node.children, (entry) => result.push(entry))
  return result
}

/** Permission-blocked tools stay visible below the root group, even when collapsed. */
function PendingEntries(props: GroupProps & { entries: readonly SessionEntry[] }) {
  return (
    <Show when={!props.pendingOutside}>
      <For each={props.pending}>
        {(ref) => {
          const leaf = createMemo(() =>
            props.entries.find((entry) => entry.ref.messageID === ref.messageID && entry.ref.partID === ref.partID),
          )
          return <Show when={leaf()}>{(item) => props.entry(item())}</Show>
        }}
      </For>
    </Show>
  )
}

function Children(props: GroupProps & { nodes: readonly SessionNode[] }) {
  return (
    <For each={props.nodes}>
      {(node, index) => (
        <Switch>
          <Match when={node.type === "group" ? node : undefined}>
            {(node) => (
              <Group
                {...props}
                node={node()}
                level={props.level + 1}
                pendingOutside
                completed={
                  props.completed ||
                  props.nodes
                    .slice(index() + 1)
                    .some((next) => next.type === "group" || !isPending(next.entry, props.pending))
                }
              />
            )}
          </Match>
          <Match when={node.type === "entry" ? node : undefined}>
            {(node) => <Show when={!isPending(node().entry, props.pending)}>{props.entry(node().entry)}</Show>}
          </Match>
        </Switch>
      )}
    </For>
  )
}

function isPending(entry: SessionEntry, pending: readonly PartRef[]) {
  return pending.some((ref) => ref.messageID === entry.ref.messageID && ref.partID === entry.ref.partID)
}

// One run's page: its header (what ran, who drove it, when, its links and usage), the state of its log, and the
// Timeline of its node attempts, kept current by run.updated.
import { isSecretsUnavailable } from "@opencorp/client"
import type { RunDetail, RunDivider, RunNode, RunNodePage, RunSummary } from "@opencorp/protocol"
import { A } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { throttle } from "../data/costs"
import { useOffice } from "../data/office"
import { flowText, shortId, STATUS_DOT, took } from "./format"
import { CopyId } from "./list"
import { readQueue } from "./queue"
import { dividerText, nodeStatus, timeline, type Row } from "./timeline"

/** How often a log being read for the first time is asked about again. */
const POLL_MS = 1_000
/** Live updates re-read the page at most this often. */
const REFETCH_MS = 1_000
/** A failed node's error is cut to this many characters in the Timeline. */
const ERROR_CHARS = 200

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const LINK = `rounded underline ${RING}`

/** What a log state says when the office sent no message for it. */
const LOG_STATE: Record<RunDetail["log_state"], string> = {
  ok: "",
  indexing: "reading the log",
  missing: "the run log is missing",
  not_started: "no run log: the run didn't start",
  unsupported_schema: "this office can't read this run log",
}

/** A time to the minute, in the browser's locale. */
const at = (t: string) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

/** Bytes as whole MB (2^20), as the office's "reading the log" message counts them. */
const mb = (bytes: number) => Math.floor(bytes / 2 ** 20)

/** A node page's "indexing" answer as the log status shows it. */
const readingText = (page: RunNodePage) => `reading the log: ${mb(page.bytes_done ?? 0)} of ${mb(page.bytes_total ?? 0)} MB`

/** A read's failure: its message, and whether it was the office failing to load the secrets to remove. */
type Failure = { message: string; secrets: boolean }

/** The Timeline's node attempts as read so far: the newest page and every older page unfolded. */
type Nodes = { nodes: RunNode[]; dividers: RunDivider[]; next: number | null; dropped: boolean; loaded: boolean }

/** `/runs/<id>`: one run's header, log state and Timeline, read from the office and kept current. */
export function RunPage(props: { id: string }) {
  const office = useOffice()
  // Stores reconciled by key: a refetch updates the page in place, so focus and folds stay where they were.
  const [detail, setDetail] = createStore<{ value?: RunDetail; kids?: RunSummary[] }>({})
  const [log, setLog] = createStore<Nodes>({ nodes: [], dividers: [], next: null, dropped: false, loaded: false })
  /** A node page's "reading the log" text, while it answers "indexing". */
  const [reading, setReading] = createSignal<string>()
  const [failure, setFailure] = createSignal<Failure>()
  const [kidsError, setKidsError] = createSignal<string>()

  // Reads run one at a time, so a refetch and an older page never interleave; a refetch waiting to start isn't
  // queued again.
  const queue = readQueue()
  let disposed = false
  let poll: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    clearTimeout(poll)
  })

  /** Queues `read`; its failure shows inline, and a later success clears it. */
  function enqueue(read: () => Promise<void>, key?: string) {
    queue(async () => {
      if (disposed) return
      try {
        await read()
        if (!disposed) setFailure(undefined)
      } catch (e) {
        if (!disposed) setFailure({ message: e instanceof Error ? e.message : String(e), secrets: isSecretsUnavailable(e) })
      }
    }, key)
  }

  /** Asks again in a second: the log is still being read for the first time. */
  function again() {
    clearTimeout(poll)
    poll = setTimeout(refresh, POLL_MS)
  }

  /** Takes the newest node page in: it replaces the nodes it covers and keeps the older pages already read. */
  function takeNewest(page: RunNodePage) {
    const all = page.next_before == null || !log.loaded
    const low = Math.min(...page.nodes.map((n) => n.seq))
    const keep = <T extends { seq: number }>(old: T[]) => (all ? [] : old.filter((x) => x.seq < low))
    setLog("nodes", reconcile([...page.nodes, ...keep(unwrap(log.nodes))], { key: "seq" }))
    setLog("dividers", reconcile([...(page.dividers ?? []), ...keep(unwrap(log.dividers))], { key: "seq" }))
    if (all) setLog({ next: page.next_before ?? null, dropped: !!page.dropped })
    setLog("loaded", true)
  }

  /** Reads the header, then (once the log can be read) the newest node page, and "Show all"'s children if shown. */
  function refresh() {
    enqueue(async () => {
      const d = await office.client.runs.get(props.id)
      if (disposed) return
      setDetail("value", reconcile(d, { key: "run_id" }))
      if (detail.kids) await readKids()
      if (d.log_state === "indexing") return again()
      if (d.log_state !== "ok") return
      const page = await office.client.runs.nodes(props.id)
      if (disposed) return
      if (page.indexing) {
        setReading(readingText(page))
        return again()
      }
      setReading(undefined)
      takeNewest(page)
    }, "refresh")
  }

  /** Reads the next older node page and appends it. */
  function older() {
    const before = log.next
    if (before == null) return
    enqueue(async () => {
      const page = await office.client.runs.nodes(props.id, before)
      // A refresh that read the whole Timeline since has nothing older to add.
      if (disposed || log.next !== before) return
      if (page.indexing) {
        setReading(readingText(page))
        return again()
      }
      setLog("nodes", reconcile([...unwrap(log.nodes), ...page.nodes], { key: "seq" }))
      setLog("dividers", reconcile([...unwrap(log.dividers), ...(page.dividers ?? [])], { key: "seq" }))
      setLog({ next: page.next_before ?? null, dropped: !!page.dropped })
    })
  }

  /** Reads every run started from this one: "Show all", past the newest 200 the header holds. */
  async function readKids() {
    try {
      const kids = await office.client.runs.children(props.id)
      if (disposed) return
      setDetail("kids", reconcile(kids, { key: "run_id" }))
      setKidsError(undefined)
    } catch (e) {
      if (!disposed) setKidsError(`Couldn't read the runs under this one: ${e instanceof Error ? e.message : String(e)}.`)
    }
  }

  const refetch = throttle(() => void (disposed || refresh()), REFETCH_MS)
  onMount(() => {
    refetch.call()
    const off = office.on("run.updated", (e) =>
      e.data.run_id === props.id || e.data.parent_run_id === props.id ? refetch.call() : undefined,
    )
    onCleanup(off)
  })
  // Events missed while the office was away: read again once it's back.
  createEffect(on(office.status, (now, before) => void (now === "online" && before && before !== "online" && refetch.call()), { defer: true }))

  /** What the log status says, or nothing while the Timeline can show. */
  const logText = () => {
    const d = detail.value
    if (!d) return undefined
    if (d.log_state === "ok") return reading()
    const run = d.run
    if (d.log_state === "not_started" && (run.status === "idle" || run.status === "waiting")) return "idle, not started yet"
    return d.log_message || LOG_STATE[d.log_state]
  }

  return (
    <div>
      <Show when={failure()}>
        {(f) => (
          <div class="flex items-center gap-2 px-4 pt-3 text-sm">
            <p role="alert">
              {f().secrets ? "Couldn't load the secrets to remove; try again." : `Couldn't read the run: ${f().message}.`}
            </p>
            <button type="button" class={LINK} onClick={() => refresh()}>
              Retry
            </button>
          </div>
        )}
      </Show>
      <Show when={detail.value}>
        {(d) => (
          <>
            <Header detail={d()} kids={detail.kids} kidsError={kidsError()} onShowAll={() => enqueue(readKids)} />
            <div class="space-y-2 p-4 max-md:px-3">
              <h3 class="text-sm font-semibold">Timeline</h3>
              <Show when={logText()}>
                {(text) => (
                  <p role="status" aria-label="Log" class={`text-sm ${MUTED}`}>
                    {text()}
                  </p>
                )}
              </Show>
              <Show when={d().log_state === "ok" && log.loaded}>
                <Show when={log.nodes.length} fallback={<p class={`text-sm ${MUTED}`}>No node has started yet.</p>}>
                  <Timeline nodes={log.nodes} dividers={log.dividers} />
                </Show>
                <Show when={log.next != null}>
                  <button type="button" onClick={older} class={`text-sm ${LINK}`}>
                    Older nodes
                  </button>
                </Show>
                <Show when={log.dropped && log.next == null}>
                  <p class={`text-sm ${MUTED}`}>older nodes: see Raw</p>
                </Show>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

/** One fact of the header: a label and its value, side by side on a desktop and stacked on a phone. */
function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex gap-4 max-md:flex-col max-md:gap-0">
      <dt class={`w-24 shrink-0 ${MUTED} max-md:text-xs`}>{props.label}</dt>
      <dd class="min-w-0 wrap-anywhere">{props.children}</dd>
    </div>
  )
}

/** A link to another run, by its short id or `label`. */
const RunLink = (props: { id: string; label?: string }) => (
  <A href={`/runs/${props.id}`} class={`${props.label ? "" : "font-mono"} ${LINK}`}>
    {props.label ?? shortId(props.id)}
  </A>
)

/** The run's header: what ran and at which version, its status, who drove it, when, its links, usage and session. */
function Header(props: { detail: RunDetail; kids?: RunSummary[]; kidsError?: string; onShowAll: () => void }) {
  const run = () => props.detail.run
  // "Show all"'s read, once it holds more than the summary's newest 200.
  const kids = () => {
    const all = props.kids
    const some = run().children ?? []
    return all && all.length > some.length ? all : some
  }
  const total = () => Math.max(run().children_total ?? 0, kids().length)
  const usage = () => props.detail.usage
  const fingerprint = () => props.detail.flow_fingerprint
  return (
    <section aria-label="Run" class="space-y-3 border-b border-neutral-200 p-4 max-md:px-3 dark:border-neutral-800">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 class="text-lg font-semibold">{flowText(run())}</h2>
        <span class={`font-mono text-xs wrap-anywhere ${MUTED}`}>{run().flow_path}</span>
      </div>
      <dl class="space-y-1.5 text-sm">
        <Fact label="Status">
          <span class="inline-flex items-center gap-1.5">
            <span aria-hidden="true" class={`size-2 shrink-0 rounded-full ${STATUS_DOT[run().status]}`} />
            {run().status}
          </span>
          <Show when={run().reason}>{(reason) => <span class={MUTED}> · {reason()}</span>}</Show>
        </Fact>
        <Fact label="Version">
          <Show when={fingerprint()}>
            {(fp) => (
              <>
                flow{" "}
                <span class="font-mono" title={fp()}>
                  {fp().slice(0, 12)}
                </span>{" "}
                ·{" "}
              </>
            )}
          </Show>
          commit{" "}
          <span class="font-mono" title={props.detail.repo_commit}>
            {props.detail.repo_commit.slice(0, 12)}
          </span>
        </Fact>
        <Fact label="Run">
          <span class="inline-flex flex-wrap items-center gap-1">
            <span class="font-mono">{run().run_id}</span>
            <CopyId id={run().run_id} />
          </span>
        </Fact>
        <Fact label="People">
          driven by {run().driver === "office" ? "office" : `@${run().driver}`}
          <Show when={(run().participants ?? []).length}>
            <span class={MUTED}> · with </span>
            {(run().participants ?? []).join(", ")}
          </Show>
        </Fact>
        <Fact label="When">
          launched {at(run().launched_at)}
          <Show when={run().ended_at}>{(end) => <> · ended {at(end())}</>}</Show>
          <Show when={run().ended_at}> · took {took(run())}</Show>
        </Fact>
        <Show when={props.detail.parent || run().replaces || run().replaced_by || total() > 0}>
          <Fact label="Links">
            <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Show when={props.detail.parent}>{(p) => <RunLink id={p().run_id} label={`parent ${shortId(p().run_id)}`} />}</Show>
              <Show when={run().replaces}>{(id) => <RunLink id={id()} label={`replaces …${id().slice(-4)}`} />}</Show>
              <Show when={run().replaced_by}>{(id) => <RunLink id={id()} label={`replaced by …${id().slice(-4)}`} />}</Show>
            </span>
            <Show when={kids().length}>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class={MUTED}>started from it:</span>
                <For each={kids()}>{(kid) => <RunLink id={kid.run_id} />}</For>
                <Show when={total() > kids().length}>
                  <button type="button" onClick={() => props.onShowAll()} class={LINK}>
                    Show all {total()}
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={props.kidsError}>
              {(message) => (
                <p role="alert" class="text-red-700 dark:text-red-400">
                  {message()}
                </p>
              )}
            </Show>
          </Fact>
        </Show>
        <Fact label="Usage">
          <Show when={usage()} fallback={<span class={MUTED}>usage not recorded</span>}>
            {(u) =>
              `${u().input_tokens.toLocaleString()} in · ${u().output_tokens.toLocaleString()} out · $${u().usd.toFixed(4)}`
            }
          </Show>
        </Fact>
        <Fact label="Session">
          <span class="inline-flex flex-wrap items-center gap-1">
            session <span class="font-mono">{shortId(run().session_id)}</span> in the TUI
            <CopyId id={run().session_id} label="Copy session id" />
          </span>
        </Fact>
      </dl>
      <p class={`text-xs ${MUTED}`}>Every signed-in human can read every run log; only secrets are removed.</p>
    </section>
  )
}

/** A Timeline row's key: stable across refetches (a group by its iteration and its oldest node), for focus and folds. */
function rowKey(row: Row): string {
  if (row.type === "node") return `n:${row.node.seq}`
  if (row.type === "divider") return `d:${row.divider.seq}`
  return `g:${row.group.key}:${row.group.nodes[row.group.nodes.length - 1]!.seq}`
}

/** A node status's color: open shows as live, failed as an error. */
const STATUS_TEXT: Partial<Record<RunNode["status"], string>> = {
  open: "text-green-700 dark:text-green-400",
  failed: "text-red-700 dark:text-red-400",
  restarted: MUTED,
}

/**
 * The Timeline: node attempts newest first, an iteration's consecutive nodes grouped (the latest open, the rest
 * folded), and the resume dividers. The WAI-ARIA tree pattern with nested groups and a roving tabindex.
 */
function Timeline(props: { nodes: RunNode[]; dividers: RunDivider[] }) {
  const rows = createMemo(() => timeline(props.nodes, props.dividers))
  const byKey = createMemo(() => new Map(rows().map((r) => [rowKey(r), r])))
  const keys = createMemo(() => [...byKey().keys()])
  const [folds, setFolds] = createStore<Record<string, boolean>>({})
  const firstGroup = createMemo(() => keys().find((k) => k.startsWith("g:")))
  const isOpen = (key: string) => folds[key] ?? key === firstGroup()
  /** The treeitems on show, in order, each with the group it's in. */
  const items = createMemo(() =>
    rows().flatMap((r): { key: string; parent?: string }[] => {
      const key = rowKey(r)
      if (r.type === "divider") return []
      if (r.type === "node" || !isOpen(key)) return [{ key }]
      return [{ key }, ...r.group.nodes.map((n) => ({ key: `n:${n.seq}`, parent: key }))]
    }),
  )
  const [focused, setFocused] = createSignal<string>()
  /** The treeitem with tabindex 0: the focused one while it's on show, else the first. */
  const current = () => {
    const f = focused()
    return f && items().some((i) => i.key === f) ? f : items()[0]?.key
  }
  const elements = new Map<string, HTMLElement>()
  const focus = (key: string) => {
    setFocused(key)
    elements.get(key)?.focus()
  }
  /** Opens or folds a group; folding it over the focused node moves focus to the group. */
  function toggle(key: string) {
    const open = isOpen(key)
    if (open && items().find((i) => i.key === focused())?.parent === key) focus(key)
    setFolds(key, !open)
  }
  /** Keeps a treeitem's element, for moving focus to it. */
  const keep = (key: string) => (el: HTMLElement) => {
    elements.set(key, el)
    onCleanup(() => elements.delete(key))
  }

  function onKey(e: KeyboardEvent) {
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key
    const list = items()
    const i = list.findIndex((x) => x.key === key)
    if (!key || i < 0) return
    const group = key.startsWith("g:")
    let to: string | undefined
    if (e.key === "ArrowDown") to = list[i + 1]?.key
    else if (e.key === "ArrowUp") to = list[i - 1]?.key
    else if (e.key === "Home") to = list[0]?.key
    else if (e.key === "End") to = list[list.length - 1]?.key
    else if (e.key === "ArrowRight" && group) {
      if (!isOpen(key)) toggle(key)
      else to = list[i + 1]?.key
    } else if (e.key === "ArrowLeft") {
      if (group && isOpen(key)) toggle(key)
      else to = list[i]!.parent
    } else if ((e.key === "Enter" || e.key === " ") && group) toggle(key)
    else return
    e.preventDefault()
    if (to) focus(to)
  }

  const NodeItem = (p: { node: RunNode; level: number }) => (
    <li
      role="treeitem"
      aria-label={`${p.node.node_id} ${nodeStatus(p.node)}`}
      aria-level={p.level}
      data-key={`n:${p.node.seq}`}
      tabindex={current() === `n:${p.node.seq}` ? 0 : -1}
      ref={keep(`n:${p.node.seq}`)}
      onFocus={() => setFocused(`n:${p.node.seq}`)}
      class={`rounded px-2 py-1 ${RING}`}
    >
      <span class="font-mono wrap-anywhere">{p.node.node_id}</span>{" "}
      <span class={STATUS_TEXT[p.node.status] ?? MUTED}>{nodeStatus(p.node)}</span>
      <Show when={p.node.status === "failed" && p.node.error}>
        {(error) => (
          <span class="block text-xs wrap-anywhere text-red-700 dark:text-red-400">
            {error().length > ERROR_CHARS ? `${error().slice(0, ERROR_CHARS)}…` : error()}
          </span>
        )}
      </Show>
    </li>
  )

  return (
    <ul role="tree" aria-label="Timeline" onKeyDown={onKey} class="text-sm">
      <For each={keys()}>
        {(key) => (
          <Show when={byKey().get(key)}>
            {(row) => {
              const r = row()
              if (r.type === "divider")
                return (
                  <li role="separator" class={`my-1 flex items-center gap-2 text-xs ${MUTED}`}>
                    <span aria-hidden="true" class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                    {dividerText(r.divider)}
                    <span aria-hidden="true" class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                  </li>
                )
              if (r.type === "node") return <NodeItem node={r.node} level={1} />
              const group = () => (row() as Extract<Row, { type: "group" }>).group
              return (
                <li
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={isOpen(key)}
                  aria-label={`iteration ${group().key} ${nodeStatus(group().nodes[0]!)}`}
                  data-key={key}
                  tabindex={current() === key ? 0 : -1}
                  ref={keep(key)}
                  onFocus={() => setFocused(key)}
                  onClick={(e) => {
                    // A click on a node inside the open group isn't a click on the group.
                    if ((e.target as HTMLElement).closest('[role="treeitem"]') !== e.currentTarget) return
                    toggle(key)
                  }}
                  class={`rounded ${RING}`}
                >
                  <div class="flex cursor-default items-center gap-1.5 px-2 py-1 select-none">
                    <span aria-hidden="true" class={`w-3 text-xs ${MUTED}`}>
                      {isOpen(key) ? "▾" : "▸"}
                    </span>
                    <span class="font-mono">{group().key}</span>
                    <span class={STATUS_TEXT[group().nodes[0]!.status] ?? MUTED}>{nodeStatus(group().nodes[0]!)}</span>
                    <Show when={!isOpen(key)}>
                      <span class={`text-xs ${MUTED}`}>
                        {group().nodes.length} {group().nodes.length === 1 ? "node" : "nodes"}
                      </span>
                    </Show>
                  </div>
                  <Show when={isOpen(key)}>
                    <ul role="group" class="ml-4 border-l border-neutral-200 pl-2 dark:border-neutral-800">
                      <For each={group().nodes}>{(node) => <NodeItem node={node} level={2} />}</For>
                    </ul>
                  </Show>
                </li>
              )
            }}
          </Show>
        )}
      </For>
    </ul>
  )
}

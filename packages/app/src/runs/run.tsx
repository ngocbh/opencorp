// One run's page: its header (what ran, who drove it, when, its links and usage), the state of its log, the Timeline
// of its node attempts with the detail of the one selected, Raw and the download, kept current by run.updated.
import { isSecretsUnavailable } from "@opencorp/client"
import type { RunDetail, RunDivider, RunNode, RunSummary } from "@opencorp/protocol"
import { A } from "@solidjs/router"
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { throttle } from "../data/costs"
import { useOffice } from "../data/office"
import { useDesktop, useShell } from "../shell"
import { flowText, shortId, STATUS_DOT, took, where } from "./format"
import { CopyId } from "./list"
import { NodeDetail } from "./node"
import { LogLine, Raw, reading, type LogStatus, type Progress, type RawApi } from "./raw"
import { readQueue } from "./queue"
import { dividerText, nodeStatus, takeNewest, timeline, type Group, type Row } from "./timeline"

/** How often a log being read for the first time is asked about again. */
const POLL_MS = 1_000
/** Live updates re-read the page at most this often. */
const REFETCH_MS = 1_000
/** A failed node's error is cut to this many characters in the Timeline. */
const ERROR_CHARS = 200
/** Children per read of "Show all". */
const KIDS_PAGE = 50

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

/** A read's failure: its message, and whether it was the office failing to load the secrets to remove. */
type Failure = { message: string; secrets: boolean }

/** What the Timeline can do for the page around it. */
type TimelineApi = { focusNode: (seq: number) => void }

/** The Timeline's current treeitem, where focus goes when nothing better is left. */
const currentItem = () => document.querySelector<HTMLElement>('[role="tree"] [role="treeitem"][tabindex="0"]') ?? undefined

/** `/runs/<id>`: one run's header, log state, Timeline with node detail, and Raw, read from the office and kept current. */
export function RunPage(props: { id: string }) {
  const office = useOffice()
  // Stores reconciled by key: a refetch updates the page in place, so focus and folds stay where they were.
  const [detail, setDetail] = createStore<{ value?: RunDetail; kids?: RunSummary[] }>({})
  const [log, setLog] = createStore({
    nodes: [] as RunNode[],
    dividers: [] as RunDivider[],
    next: null as number | null,
    dropped: false,
    loaded: false,
  })
  /** A node page's progress, while it answers "indexing". */
  const [indexing, setIndexing] = createSignal<Progress>()
  const [failure, setFailure] = createSignal<Failure>()
  const [kidsError, setKidsError] = createSignal<string>()
  const [kidsLoading, setKidsLoading] = createSignal(false)
  let olderButton: HTMLButtonElement | undefined
  let timelineApi: TimelineApi | undefined

  // The node whose detail shows, by seq, so a refetch that updates it (open, then succeeded) shows the update.
  const [selected, setSelected] = createSignal<number>()
  const selectedNode = () => {
    const seq = selected()
    return seq === undefined ? undefined : log.nodes.find((n) => n.seq === seq)
  }
  /** The row that opened node detail, where focus goes back when it closes. */
  let opener: HTMLElement | undefined
  const returnTo = () => (opener?.isConnected ? opener : currentItem())
  function select(node: RunNode, row: HTMLElement) {
    opener = row
    setSelected(node.seq)
  }
  // On a phone node detail is a sheet over the whole screen: nothing behind it can take focus.
  const desktop = useDesktop()
  const sheet = () => !desktop() && !!selectedNode()
  const shell = useShell()
  createEffect(() => shell?.setCovered(sheet()))
  onCleanup(() => shell?.setCovered(false))

  // Reads run one at a time, so a refetch and an older page never interleave; a keyed read waiting to start isn't
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

  /** Shows `nodes`, `dividers` and the older pages' cursor, each node and divider updated in place by its seq. */
  function show(s: { nodes: RunNode[]; dividers: RunDivider[]; next: number | null; dropped: boolean }) {
    setLog("nodes", reconcile(s.nodes, { key: "seq" }))
    setLog("dividers", reconcile(s.dividers, { key: "seq" }))
    setLog({ next: s.next, dropped: s.dropped, loaded: true })
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
        setIndexing({ done: page.bytes_done ?? 0, total: page.bytes_total ?? 0 })
        return again()
      }
      setIndexing(undefined)
      show(takeNewest(log.loaded ? unwrap(log) : undefined, page))
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
        setIndexing({ done: page.bytes_done ?? 0, total: page.bytes_total ?? 0 })
        return again()
      }
      // The button goes once the oldest page is in: focus moves to the first node it brought, not to the page.
      const handOff = document.activeElement === olderButton && page.next_before == null
      show({
        nodes: [...unwrap(log.nodes), ...page.nodes],
        dividers: [...unwrap(log.dividers), ...(page.dividers ?? [])],
        next: page.next_before ?? null,
        dropped: !!page.dropped,
      })
      if (handOff && page.nodes.length) timelineApi?.focusNode(page.nodes[0]!.seq)
    })
  }

  /** Reads every run started from this one: "Show all", the pages past the newest 200 the header holds. */
  async function readKids() {
    try {
      const shown = unwrap(detail.value?.run.children ?? [])
      let kids = [...shown]
      let before = shown.at(-1)?.run_id
      do {
        const page = await office.client.runs.children(props.id, { before, limit: KIDS_PAGE })
        kids = [...kids, ...page.runs]
        before = page.next ?? undefined
      } while (before)
      if (disposed) return
      setDetail("kids", reconcile(kids, { key: "run_id" }))
      setKidsError(undefined)
    } catch (e) {
      if (!disposed) setKidsError(`Couldn't read the runs under this one: ${e instanceof Error ? e.message : String(e)}.`)
    }
  }
  /** "Show all": reads the children once, however often it's pressed while the read waits or runs. */
  function showAll() {
    if (kidsLoading()) return
    setKidsLoading(true)
    enqueue(async () => {
      try {
        await readKids()
      } finally {
        if (!disposed) setKidsLoading(false)
      }
    }, "kids")
  }

  const refetch = throttle(() => {
    if (disposed) return
    refresh()
    rawApi?.refresh()
  }, REFETCH_MS)
  onMount(() => {
    refetch.call()
    const off = office.on("run.updated", (e) =>
      e.data.run_id === props.id || e.data.parent_run_id === props.id ? refetch.call() : undefined,
    )
    onCleanup(off)
  })
  // Events missed while the office was away: read again once it's back. Not deferred, so a page opened while the
  // office is away knows the status it opened with (`before` is undefined only on this first run).
  createEffect(on(office.status, (now, before) => void (now === "online" && before !== undefined && before !== "online" && refetch.call())))

  /** What the log status says while the log can't be read, or nothing once it can. */
  const logStatus = (): LogStatus | undefined => {
    const d = detail.value
    if (!d || d.log_state === "ok") return undefined
    if (d.log_state === "indexing" && d.bytes_done != null && d.bytes_total != null)
      return reading({ done: d.bytes_done, total: d.bytes_total })
    const run = d.run
    if (d.log_state === "not_started" && (run.status === "idle" || run.status === "waiting")) return { text: "idle, not started yet" }
    return { text: d.log_message || LOG_STATE[d.log_state] }
  }

  // The Timeline and Raw tabs; Raw reads its first page when it's first shown, and both keep their place after.
  const [tab, setTab] = createSignal<Tab>("timeline")
  const [rawShown, setRawShown] = createSignal(false)
  let rawApi: RawApi | undefined
  function chooseTab(to: Tab) {
    setTab(to)
    if (to === "raw") setRawShown(true)
  }
  const tabsId = createUniqueId()

  return (
    <div>
      <div inert={sheet()}>
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
            <Header
              detail={d()}
              kids={detail.kids}
              kidsError={kidsError()}
              kidsLoading={kidsLoading()}
              onShowAll={showAll}
            />
          )}
        </Show>
      </div>
      <Show when={detail.value}>
        {(d) => (
          <div class="flex">
            <div class="min-w-0 flex-1 space-y-2 p-4 max-md:px-3" inert={sheet()}>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <Show when={d().log_state === "ok"} fallback={<h3 class="text-sm font-semibold">Timeline</h3>}>
                  <Tabs id={tabsId} tab={tab()} onTab={chooseTab} />
                </Show>
                {/* The scrubbed log downloads even when this office can't read it for the Timeline or Raw. */}
                <Show when={d().log_state === "ok" || d().log_state === "unsupported_schema"}>
                  <a download={`${props.id}.jsonl`} href={office.client.runs.logUrl(props.id)} class={`text-sm ${LINK}`}>
                    Download
                  </a>
                </Show>
              </div>
              <Show when={logStatus()}>{(s) => <LogLine status={s()} />}</Show>
              <Show when={d().log_state === "ok"}>
                <div
                  role="tabpanel"
                  id={`${tabsId}-timeline-panel`}
                  aria-labelledby={`${tabsId}-timeline`}
                  hidden={tab() !== "timeline"}
                  class="space-y-2"
                >
                  <Show when={indexing()}>{(p) => <LogLine status={reading(p())} />}</Show>
                  <Show when={log.loaded}>
                    <Show when={log.nodes.length} fallback={<p class={`text-sm ${MUTED}`}>No node has started yet.</p>}>
                      <Timeline
                        nodes={log.nodes}
                        dividers={log.dividers}
                        api={(a) => (timelineApi = a)}
                        selected={selected()}
                        onSelect={select}
                      />
                    </Show>
                    <Show when={log.next != null}>
                      <button ref={olderButton} type="button" onClick={older} class={`text-sm ${LINK}`}>
                        Older nodes
                      </button>
                    </Show>
                    <Show when={log.dropped && log.next == null}>
                      <p class={`text-sm ${MUTED}`}>older nodes: see Raw</p>
                    </Show>
                  </Show>
                </div>
                <Show when={rawShown()}>
                  <div
                    role="tabpanel"
                    id={`${tabsId}-raw-panel`}
                    aria-labelledby={`${tabsId}-raw`}
                    hidden={tab() !== "raw"}
                  >
                    <Raw runId={props.id} api={(a) => (rawApi = a)} />
                  </div>
                </Show>
              </Show>
            </div>
            <Show when={selectedNode()}>
              {(node) => (
                <NodeDetail
                  runId={props.id}
                  node={node()}
                  detail={d()}
                  modal={!desktop()}
                  onClose={() => setSelected(undefined)}
                  returnTo={returnTo}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

/** The run page's two views of its log. */
type Tab = "timeline" | "raw"
const TABS: [Tab, string][] = [
  ["timeline", "Timeline"],
  ["raw", "Raw"],
]

/** The Timeline and Raw tabs: the WAI-ARIA tabs pattern, the arrow keys moving between them. */
function Tabs(props: { id: string; tab: Tab; onTab: (tab: Tab) => void }) {
  const buttons = new Map<Tab, HTMLButtonElement>()
  function onKey(e: KeyboardEvent) {
    const i = TABS.findIndex(([t]) => t === props.tab)
    let to: number | undefined
    if (e.key === "ArrowRight") to = (i + 1) % TABS.length
    else if (e.key === "ArrowLeft") to = (i + TABS.length - 1) % TABS.length
    else if (e.key === "Home") to = 0
    else if (e.key === "End") to = TABS.length - 1
    else return
    e.preventDefault()
    const [tab] = TABS[to]!
    props.onTab(tab)
    buttons.get(tab)?.focus()
  }
  return (
    <div role="tablist" aria-label="The log" onKeyDown={onKey} class="flex gap-1">
      <For each={TABS}>
        {([tab, label]) => (
          <button
            ref={(el) => buttons.set(tab, el)}
            type="button"
            role="tab"
            id={`${props.id}-${tab}`}
            aria-selected={props.tab === tab}
            aria-controls={`${props.id}-${tab}-panel`}
            tabindex={props.tab === tab ? 0 : -1}
            onClick={() => props.onTab(tab)}
            class={`rounded px-2 py-1 text-sm font-semibold ${RING} ${
              props.tab === tab
                ? "bg-neutral-200/70 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50"
                : `${MUTED} hover:bg-neutral-100 dark:hover:bg-neutral-900`
            }`}
          >
            {label}
          </button>
        )}
      </For>
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
function Header(props: {
  detail: RunDetail
  kids?: RunSummary[]
  kidsError?: string
  kidsLoading: boolean
  onShowAll: () => void
}) {
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
  // Where the run is, as the list says it, unless that repeats the status word or (once finished) the "took" below;
  // and its reason, when that says more.
  const place = () => {
    const text = where(run())
    return text && text !== run().status && run().status !== "finished" ? text : null
  }
  const reason = () => (run().reason && run().reason !== place() ? run().reason : null)
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
          <Show when={place()}>{(text) => <> · {text()}</>}</Show>
          <Show when={reason()}>{(text) => <span class={MUTED}> · {text()}</span>}</Show>
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
                  <button type="button" disabled={props.kidsLoading} onClick={() => props.onShowAll()} class={LINK}>
                    {props.kidsLoading ? "reading…" : `Show all ${total()}`}
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

/** A Timeline row's key: stable across refetches (a group by its iteration and its oldest node), for focus. */
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
 * folded), and the resume dividers, each describing the item after it. The WAI-ARIA tree pattern with nested groups
 * and a roving tabindex.
 */
function Timeline(props: {
  nodes: RunNode[]
  dividers: RunDivider[]
  api?: (api: TimelineApi) => void
  /** The seq of the node whose detail shows. */
  selected?: number
  /** Opens a node's detail, from its row. */
  onSelect: (node: RunNode, row: HTMLElement) => void
}) {
  const uid = createUniqueId()
  const rows = createMemo(() => timeline(props.nodes, props.dividers))
  const byKey = createMemo(() => new Map(rows().map((r) => [rowKey(r), r])))
  const keys = createMemo(() => [...byKey().keys()])
  const groupOf = (key: string | undefined) => {
    const row = key === undefined ? undefined : byKey().get(key)
    return row?.type === "group" ? row.group : undefined
  }
  // A group's fold is kept for each of its nodes, so it holds when the group gains nodes: newer ones live, or older
  // ones from an older page (which changes the group's key).
  const [folds, setFolds] = createStore<Record<number, boolean>>({})
  const foldOf = (group: Group) => group.nodes.map((n) => folds[n.seq]).find((f) => f !== undefined)
  const setFold = (group: Group, open: boolean) => setFolds(Object.fromEntries(group.nodes.map((n) => [n.seq, open])))
  // Every group that has been the latest iteration, which is open by default. When a newer iteration starts, the one
  // before stays open, with focus inside. Kept as the first group is worked out, not set by an effect after it:
  // an effect runs after the render, which would already have folded the group and dropped its focus.
  const wasFirst = new Set<string>()
  const firstGroup = createMemo(() => {
    const key = keys().find((k) => k.startsWith("g:"))
    if (key) wasFirst.add(key)
    return key
  })
  const isOpen = (key: string) => {
    const group = groupOf(key)
    const first = firstGroup()
    return (group && foldOf(group)) ?? (key === first || wasFirst.has(key))
  }
  /** The ids of what describes each row: the dividers just before it. */
  const describedBy = createMemo(() => {
    const by = new Map<string, string>()
    let pending: string[] = []
    for (const r of rows()) {
      if (r.type === "divider") pending.push(`${uid}-d${r.divider.seq}`)
      else if (pending.length) {
        by.set(rowKey(r), pending.join(" "))
        pending = []
      }
    }
    return by
  })
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
  const current = createMemo(() => {
    const f = focused()
    return f && items().some((i) => i.key === f) ? f : items()[0]?.key
  })
  const elements = new Map<string, HTMLElement>()
  const focus = (key: string) => {
    setFocused(key)
    elements.get(key)?.focus()
  }
  /** Opens or folds a group; folding it over the focused node moves focus to the group. */
  function toggle(key: string) {
    const group = groupOf(key)
    if (!group) return
    const open = isOpen(key)
    if (open && items().find((i) => i.key === focused())?.parent === key) focus(key)
    setFold(group, !open)
  }
  /** Keeps a treeitem's element, for moving focus to it. */
  const keep = (key: string) => (el: HTMLElement) => {
    elements.set(key, el)
    onCleanup(() => elements.delete(key))
  }
  props.api?.({
    // A node's own item while it's on show, else its folded group's.
    focusNode(seq) {
      const key = `n:${seq}`
      const item = items().find((i) => i.key === key)
      if (item) return focus(key)
      const group = rows().find((r) => r.type === "group" && r.group.nodes.some((n) => n.seq === seq))
      if (group) focus(rowKey(group))
    },
  })

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
    else if (e.key === "Enter" || e.key === " ") {
      const node = props.nodes.find((n) => `n:${n.seq}` === key)
      const row = elements.get(key)
      if (node && row) props.onSelect(node, row)
    } else return
    e.preventDefault()
    if (to) focus(to)
  }

  const NodeItem = (p: { node: RunNode; level: number; describedBy?: string }) => {
    const key = `n:${p.node.seq}`
    const error = `${uid}-e${p.node.seq}`
    const failed = () => (p.node.status === "failed" && p.node.error) || undefined
    return (
      <li
        role="treeitem"
        aria-label={`${p.node.node_id} ${nodeStatus(p.node)}`}
        aria-level={p.level}
        aria-selected={props.selected === p.node.seq}
        aria-describedby={[p.describedBy, failed() && error].filter(Boolean).join(" ") || undefined}
        data-key={key}
        tabindex={current() === key ? 0 : -1}
        ref={keep(key)}
        onFocus={() => setFocused(key)}
        onClick={(e) => props.onSelect(p.node, e.currentTarget)}
        class={`cursor-pointer rounded px-2 py-1 hover:bg-neutral-100 aria-selected:bg-neutral-200/70 dark:hover:bg-neutral-900 dark:aria-selected:bg-neutral-800 ${RING}`}
      >
        <span class="font-mono wrap-anywhere">{p.node.node_id}</span>{" "}
        <span class={STATUS_TEXT[p.node.status] ?? MUTED}>{nodeStatus(p.node)}</span>
        <Show when={failed()}>
          {(text) => (
            <span id={error} class="block text-xs wrap-anywhere text-red-700 dark:text-red-400">
              {text().length > ERROR_CHARS ? `${text().slice(0, ERROR_CHARS)}…` : text()}
            </span>
          )}
        </Show>
      </li>
    )
  }

  return (
    <ul role="tree" aria-label="Timeline" onKeyDown={onKey} class="text-sm">
      <For each={keys()}>
        {(key) => (
          <Show when={byKey().get(key)}>
            {(row) => {
              const r = row()
              if (r.type === "divider")
                return (
                  <li id={`${uid}-d${r.divider.seq}`} role="separator" class={`my-1 flex items-center gap-2 text-xs ${MUTED}`}>
                    <span aria-hidden="true" class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                    {dividerText(r.divider)}
                    <span aria-hidden="true" class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                  </li>
                )
              if (r.type === "node") return <NodeItem node={r.node} level={1} describedBy={describedBy().get(key)} />
              const group = () => (row() as Extract<Row, { type: "group" }>).group
              return (
                <li
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={isOpen(key)}
                  aria-label={`iteration ${group().key} ${nodeStatus(group().nodes[0]!)}`}
                  aria-describedby={describedBy().get(key)}
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

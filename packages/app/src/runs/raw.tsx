// A run's Raw tab: its log's records as stored, a page at a time, filtered by kind or node, each
// cut record one click from whole; and the status line it shares with the run page while a log is first read.
import type { RunEvent } from "@opencorp/protocol"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useOffice } from "../data/office"
import { pretty, ReadError, tooLarge } from "./node"
import { readQueue } from "./queue"

/** How often a log being read for the first time is asked about again. */
const POLL_MS = 1_000

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const LINK = `rounded underline ${RING}`
const FIELD = `rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950 ${RING}`

/** How far the first read of a large log has got. */
export type Progress = { done: number; total: number }

/** What the log status says; `progress` follows `text` and isn't announced as it changes every second. */
export type LogStatus = { text: string; progress?: string }

/** Bytes as whole MB (2^20), as the office's "reading the log" message counts them. */
const mb = (bytes: number) => Math.floor(bytes / 2 ** 20)

/** The log status while a log is first read: "reading the log: 120 of 480 MB". */
export const reading = (p: Progress): LogStatus => ({ text: "reading the log: ", progress: `${mb(p.done)} of ${mb(p.total)} MB` })

/** The log's status line, as the Timeline and Raw show it. */
export function LogLine(props: { status: LogStatus }) {
  return (
    <p role="status" aria-label="Log" class={`text-sm ${MUTED}`}>
      {props.status.text}
      <Show when={props.status.progress}>{(p) => <span aria-live="off">{p()}</span>}</Show>
    </p>
  )
}

/** What the run page can ask of Raw. */
export type RawApi = {
  /** Reads the records written since the last one shown, once Raw has read to the end of the log. */
  refresh: () => void
}

/** Whether a record still has parts left out: a field cut, or its evidence. */
const partial = (e: RunEvent) => (e.cut ?? []).length > 0 || !!e.evidence_left_out

/** The Raw tab of run `runId`: its records from the first, more on "Load more records". */
export function Raw(props: { runId: string; api?: (api: RawApi) => void }) {
  const office = useOffice()
  const [records, setRecords] = createSignal<RunEvent[]>([])
  const [next, setNext] = createSignal<number | null>(null)
  const [loaded, setLoaded] = createSignal(false)
  const [indexing, setIndexing] = createSignal<Progress>()
  const [failure, setFailure] = createSignal<{ error: unknown; retry: () => void }>()
  /** The records opened whole, by seq: one still partial after that is too large to show whole. */
  const [opened, setOpened] = createSignal<ReadonlySet<number>>(new Set())
  const [kind, setKind] = createSignal("")
  const [node, setNode] = createSignal("")

  // Reads run one at a time, so a live read and "Load more records" never add the same page twice.
  const queue = readQueue()
  let disposed = false
  let poll: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    clearTimeout(poll)
  })
  const lastSeq = () => records()[records().length - 1]?.seq

  /** Reads the page after the last record shown and appends it. */
  function read(key?: string) {
    const attempt = () =>
      queue(async () => {
        if (disposed) return
        try {
          const page = await office.client.runs.events(props.runId, lastSeq())
          if (disposed) return
          setFailure(undefined)
          if (page.indexing) {
            setIndexing({ done: page.bytes_done ?? 0, total: page.bytes_total ?? 0 })
            clearTimeout(poll)
            poll = setTimeout(() => read("more"), POLL_MS)
            return
          }
          setIndexing(undefined)
          const last = lastSeq() ?? -1
          setRecords([...records(), ...page.events.filter((e) => e.seq > last)])
          setNext(page.next_after ?? null)
          setLoaded(true)
        } catch (e) {
          if (!disposed) setFailure({ error: e, retry: attempt })
        }
      }, key)
    attempt()
  }

  /** Reads record `seq` whole and shows it in place of its page's copy. */
  function open(seq: number) {
    office.client.runs.event(props.runId, seq).then(
      (whole) => {
        if (disposed) return
        setFailure(undefined)
        setRecords(records().map((e) => (e.seq === seq ? whole : e)))
        setOpened(new Set([...opened(), seq]))
      },
      (e) => !disposed && setFailure({ error: e, retry: () => open(seq) }),
    )
  }

  onMount(() => read("more"))
  props.api?.({
    refresh: () => {
      if (loaded() && next() == null) read("more")
    },
  })

  const kinds = createMemo(() => [...new Set(records().map((e) => e.kind))].sort())
  const shown = createMemo(() =>
    records().filter((e) => (!kind() || e.kind === kind()) && (!node() || (e.node_id ?? "").startsWith(node()))),
  )

  return (
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <select aria-label="Kind" value={kind()} onChange={(e) => setKind(e.currentTarget.value)} class={FIELD}>
          <option value="">every kind</option>
          <For each={kinds()}>{(k) => <option value={k}>{k}</option>}</For>
        </select>
        <input
          type="search"
          aria-label="Node"
          placeholder="node id starts with"
          value={node()}
          onInput={(e) => setNode(e.currentTarget.value)}
          class={`min-w-0 flex-1 ${FIELD}`}
        />
      </div>
      <Show when={indexing()}>{(p) => <LogLine status={reading(p())} />}</Show>
      <Show when={failure()}>{(f) => <ReadError error={f().error} onRetry={() => f().retry()} />}</Show>
      <ul aria-label="Records" class="space-y-2 text-sm">
        <For each={shown()}>
          {(e) => (
            <li class="space-y-1 rounded border border-neutral-200 p-2 dark:border-neutral-800">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class={`font-mono text-xs ${MUTED}`}>{e.seq}</span>
                <span class="font-mono">{e.kind}</span>
                <Show when={e.node_id}>{(id) => <span class="font-mono wrap-anywhere">{id()}</span>}</Show>
              </div>
              <Show when={e.size}>{(size) => <p class={MUTED}>{tooLarge(size())}</p>}</Show>
              <Show when={e.payload != null}>
                <pre class="overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere dark:bg-neutral-900">
                  {pretty(e.payload)}
                </pre>
              </Show>
              <Show when={partial(e)}>
                <Show
                  when={!opened().has(e.seq)}
                  fallback={<p class={MUTED}>too large to show whole; download the log</p>}
                >
                  <button type="button" class={`text-xs ${LINK}`} onClick={() => open(e.seq)}>
                    Open the whole record
                  </button>
                </Show>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={loaded() && !shown().length}>
        <p class={`text-sm ${MUTED}`}>{records().length ? "No record matches." : "No records yet."}</p>
      </Show>
      <Show when={next() != null}>
        <button type="button" class={`text-sm ${LINK}`} onClick={() => read("more")}>
          Load more records
        </button>
      </Show>
    </div>
  )
}

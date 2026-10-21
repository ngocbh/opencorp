import type { RunSummary } from "@opencorp/protocol"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { throttle } from "../data/costs"
import { useOffice } from "../data/office"
import { filtersOf, isRunId, type RunFilters } from "../runs/filters"
import { RunTable } from "../runs/list"
import { readQueue } from "../runs/queue"

/** Top-level runs per page. */
const PAGE = 50
/** Live updates re-read the list at most this often. */
const REFETCH_MS = 1_000

const FLOWS = ["chat", "side_chat", "profile_manager", "debrief"]
const STATUSES: RunSummary["status"][] = ["running", "waiting", "idle", "finished", "failed", "interrupted"]
const CONTROL =
  "rounded border border-neutral-300 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-visible:ring-neutral-100"
const BUTTON = "rounded underline outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"

/** Work › Run Logs: every run the office launched, filtered by the address, newest first, kept current. */
export default function Runs() {
  const office = useOffice()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filters = createMemo(() => filtersOf(params), undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  })
  // A store reconciled by run_id: a refetch updates the rows in place, so focus and folds stay where they were.
  const [runs, setRuns] = createStore<RunSummary[]>([])
  const [next, setNext] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  /** Whether a Load more is queued or reading: only that disables the button, not a live re-read it can queue after. */
  const [more, setMore] = createSignal(false)
  /** Counts finished refetches, so the table reads its "Show all" children again. */
  const [refreshed, setRefreshed] = createSignal(0)
  const [text, setText] = createSignal(filters().q ?? "")
  createEffect(on(() => filters().q, (q) => setText(q ?? ""), { defer: true }))

  // Reads run one at a time, so a refetch never drops the page a Load more brings. A filter change starts a new
  // generation, and a read queued or answered in an older one is dropped.
  let generation = 0
  const queue = readQueue()
  let disposed = false
  onCleanup(() => (disposed = true))
  const current = (gen: number) => gen === generation && !disposed

  /** Queues `read` after the reads before it (once per `key` while one waits); its failure shows as the page's error. */
  function enqueue(read: (gen: number) => Promise<void>, key?: string) {
    const gen = generation
    queue(
      async () => {
        if (!current(gen)) return
        setLoading(true)
        try {
          await read(gen)
        } catch (e) {
          if (current(gen)) setError(e instanceof Error ? e.message : String(e))
        } finally {
          if (current(gen)) setLoading(false)
        }
      },
      // Per generation: a read waiting in an older one is dropped when it starts, so it mustn't hold back a new one.
      key === undefined ? undefined : `${key} ${gen}`,
    )
  }

  const read = (f: RunFilters, before?: string) => office.client.runs.list({ ...f, before, limit: PAGE })

  /** Reads the page after `before` (the first without it) and appends it. */
  function load(before?: string) {
    enqueue(async (gen) => {
      try {
        const page = await read(filters(), before)
        if (!current(gen)) return
        setRuns(reconcile(before ? [...unwrap(runs), ...page.runs] : page.runs, { key: "run_id" }))
        setNext(page.next ?? null)
        setError(undefined)
      } finally {
        if (before) setMore(false)
      }
    })
  }

  /** Load more: one page at a time, however often it's pressed. */
  function loadMore(before: string) {
    if (more()) return
    setMore(true)
    load(before)
  }

  /** Re-reads the pages already shown, from the start, as one answer; not queued again while one waits to start. */
  function reread() {
    enqueue(async (gen) => {
      const want = Math.max(runs.length, 1)
      let all: RunSummary[] = []
      let before: string | undefined
      let more: string | null = null
      do {
        const page = await read(filters(), before)
        all = [...all, ...page.runs]
        more = page.next ?? null
        before = more ?? undefined
      } while (more && all.length < want)
      if (!current(gen)) return
      setRuns(reconcile(all, { key: "run_id" }))
      setNext(more)
      setError(undefined)
      setRefreshed((n) => n + 1)
    }, "reread")
  }
  const refetch = throttle(() => void (disposed || reread()), REFETCH_MS)

  createEffect(
    on(filters, () => {
      generation++
      setRuns(reconcile([]))
      setNext(null)
      setMore(false) // a Load more queued in the old generation is dropped before it reads
      setError(undefined)
      load()
    }),
  )
  onMount(() => {
    const offs = [office.on("run.updated", () => refetch.call()), office.on("session.updated", () => refetch.call())]
    onCleanup(() => offs.forEach((off) => off()))
  })
  // Events missed while the office was away: read again once it's back. Not deferred, so a page opened while the
  // office is away knows the status it opened with (`before` is undefined only on this first run).
  createEffect(on(office.status, (now, before) => void (now === "online" && before !== undefined && before !== "online" && refetch.call())))

  function search(e: SubmitEvent) {
    e.preventDefault()
    const q = text().trim()
    if (isRunId(q)) navigate(`/runs/${q.toUpperCase()}`)
    else setParams({ q: q || undefined })
  }
  const people = createMemo(() => [...office.state.people].sort((a, b) => a.name.localeCompare(b.name)))

  return (
    <div>
      <div class="flex flex-wrap items-center gap-3 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <h2 class="mr-auto text-base font-semibold">Run Logs</h2>
        <select aria-label="Flow" class={CONTROL} onChange={(e) => setParams({ flow: e.currentTarget.value || undefined })}>
          <option value="" selected={!filters().flow}>
            Any flow
          </option>
          <For each={FLOWS}>
            {(f) => (
              <option value={f} selected={filters().flow === f}>
                {f}
              </option>
            )}
          </For>
        </select>
        <select aria-label="Person" class={CONTROL} onChange={(e) => setParams({ person: e.currentTarget.value || undefined })}>
          <option value="" selected={!filters().person}>
            Anyone
          </option>
          <For each={people()}>
            {(p) => (
              <option value={p.handle} selected={filters().person === p.handle}>
                {p.name}
              </option>
            )}
          </For>
        </select>
        <select aria-label="Status" class={CONTROL} onChange={(e) => setParams({ status: e.currentTarget.value || undefined })}>
          <option value="" selected={!filters().status}>
            Any status
          </option>
          <For each={STATUSES}>
            {(s) => (
              <option value={s} selected={filters().status === s}>
                {s}
              </option>
            )}
          </For>
        </select>
        <form role="search" onSubmit={search}>
          <input
            type="search"
            aria-label="Search runs"
            placeholder="Run id, or part of one"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            class={`w-48 ${CONTROL}`}
          />
        </form>
      </div>
      <p class="px-3 pt-3 text-xs text-neutral-500 dark:text-neutral-400">
        Codex sessions themselves aren't listed: they have no run log yet. Their debriefs are.
      </p>
      <Show when={error()}>
        {(message) => (
          <div class="flex items-center gap-2 px-3 pt-3 text-sm">
            <p role="alert">Couldn't read the runs: {message()}.</p>
            <button type="button" class={BUTTON} onClick={() => reread()}>
              Retry
            </button>
          </div>
        )}
      </Show>
      <div class="p-3 max-md:px-2">
        <RunTable runs={runs} filters={filters()} refreshed={refreshed()} />
        <Show when={!loading() && !error() && runs.length === 0}>
          <p class="px-3 py-4 text-sm text-neutral-500 dark:text-neutral-400">No runs.</p>
        </Show>
        <Show when={next()}>
          {(before) => (
            <button type="button" disabled={more()} onClick={() => loadMore(before())} class={`mt-3 px-3 text-sm ${BUTTON}`}>
              Load more
            </button>
          )}
        </Show>
      </div>
    </div>
  )
}

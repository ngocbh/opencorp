import type { RunSummary } from "@opencorp/protocol"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { throttle } from "../data/costs"
import { useOffice } from "../data/office"
import { RunTable } from "../runs/list"
import { flowsOf, hrefOf, isRunId, paramsOf, parse, queryOfAddress } from "../runs/query"
import { readQueue } from "../runs/queue"
import { SearchBox } from "../runs/search"

/** Top-level runs per page. */
const PAGE = 50
/** Live updates re-read the list at most this often. */
const REFETCH_MS = 1_000

const BUTTON = "rounded underline outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Work › Run Logs: every run the office launched, filtered by the query in the address (open runs from the last 7
 * days when it has none), newest first, kept current.
 */
export default function Runs() {
  const office = useOffice()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const address = createMemo(() => queryOfAddress(params), undefined, { equals: same })
  // An old `?flow=&person=&status=` address becomes the query it means.
  createEffect(() => address().old && navigate(hrefOf(address().text), { replace: true }))
  const query = createMemo(() => parse(address().text).query, undefined, { equals: same })
  /** What a read asks for now: `started:` is resolved against the clock at each read. */
  const filters = () => paramsOf(query(), new Date())
  /** The parameters the rows shown were read with: they open a fold whose children match. */
  const [shownWith, setShownWith] = createSignal(filters(), { equals: same })
  // A store reconciled by run_id: a refetch updates the rows in place, so focus and folds stay where they were.
  const [runs, setRuns] = createStore<RunSummary[]>([])
  const [next, setNext] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  /** Whether a Load more is queued or reading: only that disables the button, not a live re-read it can queue after. */
  const [more, setMore] = createSignal(false)
  /** Counts finished refetches, so the table reads its open folds again. */
  const [refreshed, setRefreshed] = createSignal(0)
  /** Flows named by the company repo's files, read once the search box is first used. */
  const [repoFlows, setRepoFlows] = createSignal<string[]>([])

  // Reads run one at a time, so a refetch never drops the page a Load more brings. A query change starts a new
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

  /** One page of at most PAGE top-level runs after `before`, with the query's parameters as they stand now. */
  function read(before?: string) {
    const f = filters()
    setShownWith(f)
    return office.client.runs.list({ ...f, before, limit: PAGE })
  }

  /** Reads the page after `before` (the first without it) and appends it. */
  function load(before?: string) {
    enqueue(async (gen) => {
      try {
        const page = await read(before)
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
        const page = await read(before)
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
    on(query, () => {
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

  /** Opens an exact run id; otherwise puts the query in the address (the same query again reads again). */
  function search(text: string) {
    const typed = text.trim().replace(/\s+/g, " ")
    const id = parse(typed).query.text
    if (id && isRunId(id)) navigate(`/runs/${id.toUpperCase()}`)
    else if (typed === address().text) reread()
    else navigate(hrefOf(typed))
  }
  /** Reads the company repo's listing for its flow files; until it answers (or if it fails) the list's own are offered. */
  function readFlows() {
    office.client.company.tree().then(
      (tree) => !disposed && setRepoFlows(flowsOf(tree.entries)),
      (error) => console.error("Failed to read the company's flows", error),
    )
  }
  const sources = createMemo(() => ({
    flows: [...runs.map((r) => r.flow), ...repoFlows()],
    people: office.state.people.map((p) => ({ handle: p.handle, name: p.name })),
  }))

  return (
    <div>
      <div class="flex flex-wrap items-start gap-3 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <h2 class="mr-auto py-1 text-base font-semibold">Run Logs</h2>
        <SearchBox query={address().text} sources={sources()} onSearch={search} onOpen={readFlows} />
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
        <RunTable runs={runs} filters={shownWith()} refreshed={refreshed()} />
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

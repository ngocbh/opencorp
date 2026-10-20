import type { RunSummary } from "@opencorp/protocol"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { throttle } from "../data/costs"
import { useOffice } from "../data/office"
import { filtersOf, isRunId, type RunFilters } from "../runs/filters"
import { RunTable } from "../runs/list"

/** Top-level runs per page. */
const PAGE = 50
/** Live updates re-read the list at most this often. */
const REFETCH_MS = 1_000

const FLOWS = ["chat", "side_chat", "profile_manager", "debrief"]
const STATUSES: RunSummary["status"][] = ["running", "waiting", "idle", "finished", "failed", "interrupted"]
const CONTROL = "rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
const BUTTON = "rounded underline outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"

/** Work › Run Logs: every run the office launched, filtered by the address, newest first, kept current. */
export default function Runs() {
  const office = useOffice()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filters = createMemo(() => filtersOf(params), undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  })
  const [runs, setRuns] = createSignal<RunSummary[]>([])
  const [next, setNext] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [text, setText] = createSignal(filters().q ?? "")
  createEffect(on(() => filters().q, (q) => setText(q ?? ""), { defer: true }))

  // Each reset or refetch starts a new generation; an answer from an older one is dropped.
  let generation = 0
  let disposed = false
  onCleanup(() => (disposed = true))

  const read = (f: RunFilters, before?: string) => office.client.runs.list({ ...f, before, limit: PAGE })
  const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  /** Reads the page after `before` (the first without it) and appends it. */
  async function load(before?: string) {
    const gen = generation
    setLoading(true)
    try {
      const page = await read(filters(), before)
      if (gen !== generation || disposed) return
      setRuns((rs) => (before ? [...rs, ...page.runs] : page.runs))
      setNext(page.next ?? null)
      setError(undefined)
    } catch (e) {
      if (gen === generation) failed(e)
    } finally {
      if (gen === generation) setLoading(false)
    }
  }

  /** Re-reads the pages already shown, from the start, as one answer. */
  async function reread() {
    if (disposed) return
    const gen = ++generation
    const want = Math.max(runs().length, 1)
    try {
      let all: RunSummary[] = []
      let before: string | undefined
      let more: string | null = null
      do {
        const page = await read(filters(), before)
        all = [...all, ...page.runs]
        more = page.next ?? null
        before = more ?? undefined
      } while (more && all.length < want)
      if (gen !== generation || disposed) return
      setRuns(all)
      setNext(more)
      setError(undefined)
    } catch (e) {
      if (gen === generation) failed(e)
    } finally {
      if (gen === generation) setLoading(false)
    }
  }
  const refetch = throttle(() => void reread(), REFETCH_MS)

  createEffect(
    on(filters, () => {
      generation++
      setRuns([])
      setNext(null)
      setError(undefined)
      void load()
    }),
  )
  onMount(() => {
    const offs = [office.on("run.updated", () => refetch.call()), office.on("session.updated", () => refetch.call())]
    onCleanup(() => offs.forEach((off) => off()))
  })
  // Events missed while the office was away: read again once it's back.
  createEffect(on(office.status, (now, before) => void (now === "online" && before && before !== "online" && refetch.call()), { defer: true }))

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
            <button type="button" class={BUTTON} onClick={() => void reread()}>
              Retry
            </button>
          </div>
        )}
      </Show>
      <div class="p-3 max-md:px-2">
        <RunTable runs={runs()} filters={filters()} />
        <Show when={!loading() && !error() && runs().length === 0}>
          <p class="px-3 py-4 text-sm text-neutral-500 dark:text-neutral-400">No runs.</p>
        </Show>
        <Show when={next()}>
          {(before) => (
            <button type="button" disabled={loading()} onClick={() => void load(before())} class={`mt-3 px-3 text-sm ${BUTTON}`}>
              Load more
            </button>
          )}
        </Show>
      </div>
    </div>
  )
}

// The Run Logs table: one row per top-level run, the runs started from it folded under it.
import { OFFICE, type RunSummary } from "@opencorp/protocol"
import { A } from "@solidjs/router"
import Check from "lucide-solid/icons/check"
import Copy from "lucide-solid/icons/copy"
import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { useOffice } from "../data/office"
import { matches, type RunParams } from "./query"
import { flowText, shortId, STATUS_DOT, where } from "./format"
import { readLimit, readQueue } from "./queue"

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const LINK = `rounded underline ${RING}`
// On a phone a row is a grid with fixed columns, so they line up from row to row: ID, status and flow; then driver,
// participants and where/took; then the start time. A child row is indented by 1rem and its ID column is 1rem
// narrower, so its other columns still line up.
const ROW =
  "border-b border-neutral-100 align-top dark:border-neutral-900 max-md:grid max-md:items-start max-md:gap-x-2 max-md:py-2"
const GRID = { 1: "max-md:grid-cols-[9rem_6rem_minmax(0,1fr)]", 2: "max-md:grid-cols-[8rem_6rem_minmax(0,1fr)] max-md:pl-4" }
const CELL = "px-3 py-2 max-md:p-0 max-md:min-w-0 max-md:leading-6"

/** What Run Logs says on an office older than its routes (`/api/runs` answers 404 no_route). */
export function RunsUnavailable() {
  return (
    <p class={`px-3 py-4 text-sm ${MUTED}`}>
      Run Logs aren't available on this office yet. Update and restart the office to see its runs.
    </p>
  )
}

/** A launch time to the minute, in the browser's locale. */
const at = (t: string, time = false) =>
  new Date(t).toLocaleString(undefined, time ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" })

/**
 * Copies a full id (a run's, unless `label` names another), and says whether it could: the clipboard needs a secure
 * page (not plain http).
 */
export function CopyId(props: { id: string; label?: string }) {
  const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.id)
      setState("copied")
    } catch {
      setState("failed")
    }
    clearTimeout(timer)
    timer = setTimeout(() => setState("idle"), 2_000)
  }
  return (
    <>
      <button
        type="button"
        aria-label={props.label ?? "Copy run id"}
        title={props.id}
        onClick={() => void copy()}
        class={`grid size-6 place-items-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 ${MUTED} ${RING}`}
      >
        <Show when={state() === "copied"} fallback={<Copy size={12} class="h-3 w-3" />}>
          <Check size={12} class="h-3 w-3" />
        </Show>
      </button>
      {/* Announced as it changes; shown only when copying failed. */}
      <span role="status" class={state() === "failed" ? "text-xs text-red-700 dark:text-red-400" : "sr-only"}>
        {state() === "copied" ? "Copied" : state() === "failed" ? "Couldn't copy" : ""}
      </span>
    </>
  )
}

/**
 * One run's row; `toggle` is the fold button of a top-level run with runs under it, `count` of them, and whether the
 * fold is reading its first page.
 */
function Row(props: {
  run: RunSummary
  level: 1 | 2
  toggle?: { open: boolean; count: number; controls: string; onToggle: () => void; reading: boolean }
}) {
  const r = () => props.run
  return (
    <tr aria-level={props.level} class={`${ROW} ${GRID[props.level]}`}>
      <td class={CELL} classList={{ "md:pl-7": props.level === 2 }}>
        <span class="inline-flex flex-wrap items-center gap-1 whitespace-nowrap">
          <A href={`/runs/${r().run_id}`} class={`font-mono ${LINK}`}>
            {shortId(r().run_id)}
          </A>
          <Show when={props.level === 2 && r().parent_run_id}>
            {(parent) => <span class="sr-only">under …{parent().slice(-4)}</span>}
          </Show>
          <CopyId id={r().run_id} />
          <Show when={props.toggle}>
            {(t) => (
              <button
                type="button"
                aria-expanded={t().open}
                aria-controls={t().controls}
                onClick={() => t().onToggle()}
                class={`rounded px-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${MUTED} ${RING}`}
              >
                <span aria-hidden="true">{t().open ? "▾" : "▸"} </span>
                {t().count} {t().count === 1 ? "run" : "runs"}
                <span class="sr-only"> under {shortId(r().run_id)}</span>
              </button>
            )}
          </Show>
          {/* Mounted with the toggle and only its text changed, so a screen reader announces the read starting. */}
          <Show when={props.toggle}>
            {(t) => (
              <span role="status" data-testid="fold-reading" class={`text-xs ${MUTED}`}>
                {t().reading ? "reading…" : ""}
              </span>
            )}
          </Show>
        </span>
      </td>
      <td class={`${CELL} whitespace-nowrap`}>
        <span class="inline-flex items-center gap-1.5">
          <span aria-hidden="true" class={`size-2 shrink-0 rounded-full ${STATUS_DOT[r().status]}`} />
          {r().status}
        </span>
      </td>
      <td class={CELL}>
        <span class="block md:truncate">{flowText(r())}</span>
        <Show when={r().replaces}>
          {(id) => (
            <A href={`/runs/${id()}`} class={`block text-xs ${MUTED} ${LINK}`}>
              replaces …{id().slice(-4)}
            </A>
          )}
        </Show>
        <Show when={r().replaced_by}>
          {(id) => (
            <A href={`/runs/${id()}`} class={`block text-xs ${MUTED} ${LINK}`}>
              replaced by …{id().slice(-4)}
            </A>
          )}
        </Show>
      </td>
      <td data-testid="run-second-line" class={`${CELL} whitespace-nowrap max-md:col-start-1 max-md:truncate`}>
        {r().driver === OFFICE ? "office" : `@${r().driver}`}
      </td>
      <td class={`${CELL} max-md:truncate`}>{(r().participants ?? []).join(", ")}</td>
      <td class={`${CELL} wrap-anywhere`}>{where(r())}</td>
      <td class={`${CELL} whitespace-nowrap ${MUTED} max-md:col-span-2 max-md:col-start-2 max-md:text-xs`}>
        {at(r().launched_at)}
        <Show when={r().ended_at}>{(end) => <> → {at(end(), true)}</>}</Show>
      </td>
    </tr>
  )
}

/** A row under the children with one button ("Load more", "Retry", "Show the rest"), and why a read failed. */
function MoreRow(props: { label: string; onClick: () => void; disabled?: boolean; error?: string; under?: string }) {
  return (
    <tr class="max-md:block">
      <td colSpan={7} class="py-1 pl-9 text-xs max-md:block">
        <button type="button" disabled={props.disabled} onClick={() => props.onClick()} class={LINK}>
          {props.label}
          {/* Said with the run it reads under: several folds can be open, each with its own button. */}
          <Show when={props.under}>{(run) => <span class="sr-only"> runs under …{run().slice(-4)}</span>}</Show>
        </button>
        <Show when={props.error}>
          {(message) => (
            <span role="alert" class="ml-2 text-red-700 dark:text-red-400">
              {message()}
            </span>
          )}
        </Show>
      </td>
    </tr>
  )
}

/** Children per read of a fold. */
const PAGE = 50
/** Reads of children in flight at once across the table, so a filter that opens every fold doesn't send 50 together. */
const FOLD_READS = 4

/** A top-level run's fold: whether it's open, the children read so far, and the cursor of the page after them. */
type Fold = {
  open?: boolean
  /** "Show the rest" was pressed: the fold reads every child, not only those matching the filters. */
  rest?: boolean
  kids?: RunSummary[]
  next?: string | null
  /** A read the reader asked for (the first page, Load more, or Retry) is queued or running. */
  loading?: boolean
  error?: string
  /** The read Retry repeats. */
  failed?: Read
}
/** The first page of children, the page after those shown, or as many as are shown, read again. */
type Read = "first" | "more" | "again"

/**
 * A top-level run's row and, once its fold is opened, the runs started from it, a page at a time. The fold starts
 * closed, except when the run is listed only because a child matches the filters: then it opens with the matching
 * children read, until "Show the rest". Each time the list is refetched (`refreshed` changes), an open fold reads its
 * children again and a closed one forgets them.
 */
function TopRun(props: {
  run: RunSummary
  filters: RunParams
  refreshed: number
  limit: ReturnType<typeof readLimit>
}) {
  const office = useOffice()
  const under = createUniqueId()
  // The run's row is reconciled by run_id, so this outlives a refetch that keeps the run.
  const [fold, setFold] = createStore<Fold>({})
  const queue = readQueue()
  let disposed = false
  onCleanup(() => (disposed = true))
  const id = () => props.run.run_id
  // A run that doesn't match is listed for its matching children: they say why it's here.
  const forKids = () => Object.keys(props.filters).length > 0 && !matches(props.run, props.filters)
  const only = () => forKids() && !fold.rest
  const open = () => fold.open ?? forKids()
  const total = () => Math.max(props.run.children_total ?? 0, fold.kids?.length ?? 0)

  /**
   * Queues `how`, `byReader` when the reader asked for it (a live re-read isn't, unless Retry repeats it); its answer
   * replaces the children (reconciled by run_id, so focus stays) or adds to them.
   */
  function read(how: Read, byReader = how !== "again") {
    if (byReader) setFold({ loading: true })
    queue(
      async () => {
        // A read that waited while its row left the page, or a first page whose fold was closed since, isn't sent.
        const gone = () => disposed || (how === "first" && !open())
        try {
          if (gone()) return
          const opts = only() ? props.filters : {}
          // As many as are shown, from the start, for a re-read; past the last one shown for Load more.
          const want = how === "again" ? (fold.kids?.length ?? 0) : 0
          let kids = how === "more" ? [...unwrap(fold.kids ?? [])] : []
          let before = how === "more" ? (fold.next ?? undefined) : undefined
          let next: string | null
          do {
            const page = await props.limit(async () =>
              gone() ? null : office.client.runs.children(id(), { ...opts, before, limit: PAGE }),
            )
            if (!page) return
            kids = [...kids, ...page.runs]
            next = page.next ?? null
            before = next ?? undefined
          } while (next && kids.length < want)
          if (disposed) return
          setFold("kids", reconcile(kids, { key: "run_id" }))
          setFold({ next, error: undefined, failed: undefined })
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          if (!disposed) setFold({ error: `Couldn't read the runs under …${id().slice(-4)}: ${why}.`, failed: how })
        } finally {
          if (!disposed && byReader) setFold({ loading: false })
        }
      },
      // Only live re-reads share a key: a Retry dropped for a waiting one would leave `loading` set.
      how === "again" && !byReader ? "again" : undefined,
    )
  }
  // An open fold with nothing read yet reads its first page (once: a failure waits for Retry).
  createEffect(() => {
    if (open() && !fold.kids && !fold.loading && !fold.error) read("first")
  })
  createEffect(
    on(
      () => props.refreshed,
      () => {
        if (!open()) setFold({ kids: undefined, next: undefined, error: undefined, failed: undefined })
        else if (fold.kids) read("again")
      },
      { defer: true },
    ),
  )

  return (
    <>
      <tbody>
        <Row
          run={props.run}
          level={1}
          toggle={
            total() > 0
              ? {
                  open: open(),
                  count: total(),
                  controls: under,
                  onToggle: () => setFold({ open: !open() }),
                  reading: !!fold.loading && !fold.kids,
                }
              : undefined
          }
        />
      </tbody>
      <tbody id={under}>
        <Show when={open()}>
          <For each={fold.kids ?? []}>{(kid) => <Row run={kid} level={2} />}</For>
          <Show
            when={fold.failed}
            fallback={
              <Show when={fold.next}>
                <MoreRow label="Load more" under={id()} disabled={fold.loading} onClick={() => read("more")} />
              </Show>
            }
          >
            {(failed) => (
              <MoreRow
                label="Retry"
                under={id()}
                disabled={fold.loading}
                error={fold.error}
                onClick={() => read(failed(), true)}
              />
            )}
          </Show>
          <Show when={only() && fold.kids && fold.kids.length < total()}>
            <MoreRow
              label="Show the rest"
              disabled={fold.loading}
              onClick={() => {
                setFold({ rest: true })
                read("first")
              }}
            />
          </Show>
        </Show>
      </tbody>
    </>
  )
}

/** The runs table: one row per top-level run, the runs started from it folded under it. */
export function RunTable(props: { runs: RunSummary[]; filters: RunParams; refreshed: number }) {
  const limit = readLimit(FOLD_READS)
  return (
    <table aria-label="Runs" class="w-full text-sm">
      <thead class="max-md:sr-only">
        <tr class={`border-b border-neutral-200 text-left text-xs dark:border-neutral-800 ${MUTED}`}>
          <For each={["ID", "Status", "Flow", "Driver", "Participants", "Where / took", "Started"]}>
            {(h) => <th class="px-3 py-2 font-medium">{h}</th>}
          </For>
        </tr>
      </thead>
      <For each={props.runs}>
        {(run) => <TopRun run={run} filters={props.filters} refreshed={props.refreshed} limit={limit} />}
      </For>
    </table>
  )
}

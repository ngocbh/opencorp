// The Run Logs table: one row per top-level run, the runs started from it folded under it.
import type { RunSummary } from "@opencorp/protocol"
import { A } from "@solidjs/router"
import Check from "lucide-solid/icons/check"
import Copy from "lucide-solid/icons/copy"
import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useOffice } from "../data/office"
import { matches, type RunFilters } from "./filters"
import { flowText, shortId, STATUS_DOT, where } from "./format"

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

/** A launch time to the minute, in the browser's locale. */
const at = (t: string, time = false) =>
  new Date(t).toLocaleString(undefined, time ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" })

/** Copies a run's full id, and says whether it could: the clipboard needs a secure page (not plain http). */
function CopyId(props: { id: string }) {
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
        aria-label="Copy run id"
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

/** One run's row; `toggle` is the fold button of a top-level run with runs under it. */
function Row(props: {
  run: RunSummary
  level: 1 | 2
  toggle?: { open: boolean; controls: string; onToggle: () => void }
}) {
  const r = () => props.run
  return (
    <tr aria-level={props.level} class={`${ROW} ${GRID[props.level]}`}>
      <td class={CELL} classList={{ "md:pl-7": props.level === 2 }}>
        <span class="inline-flex flex-wrap items-center gap-1 whitespace-nowrap">
          {/* Every row keeps the toggle's slot, so the ids line up. */}
          <Show when={props.toggle} fallback={<span aria-hidden="true" class="size-6 shrink-0" />}>
            {(t) => (
              <button
                type="button"
                aria-expanded={t().open}
                aria-controls={t().controls}
                aria-label={`Runs under ${shortId(r().run_id)}`}
                onClick={() => t().onToggle()}
                class={`grid size-6 shrink-0 place-items-center rounded text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${RING}`}
              >
                <span aria-hidden="true">{t().open ? "▾" : "▸"}</span>
              </button>
            )}
          </Show>
          <A href={`/runs/${r().run_id}`} class={`font-mono ${LINK}`}>
            {shortId(r().run_id)}
          </A>
          <Show when={props.level === 2 && r().parent_run_id}>
            {(parent) => <span class="sr-only">under …{parent().slice(-4)}</span>}
          </Show>
          <CopyId id={r().run_id} />
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
        {r().driver === "office" ? "office" : `@${r().driver}`}
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

/** A row under the children with one button: "Show the rest" or "Show all N", and why it failed, if it did. */
function MoreRow(props: { label: string; onClick: () => void; disabled?: boolean; error?: string }) {
  return (
    <tr class="max-md:block">
      <td colSpan={7} class="py-1 pl-9 text-xs max-md:block">
        <button type="button" disabled={props.disabled} onClick={() => props.onClick()} class={LINK}>
          {props.label}
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

/** What the table remembers of a top-level run across refetches: its fold, and its children once all are read. */
type Fold = { open?: boolean; rest?: boolean; all?: RunSummary[]; loading?: boolean; error?: string }

/**
 * The runs table. A run's children start folded, except when the filters are set and a child matches: then it starts
 * open with only the matching children, until "Show the rest". Past the newest 200 children, "Show all" reads them,
 * and reads them again each time the list is refetched (`refreshed` changes).
 */
export function RunTable(props: { runs: RunSummary[]; filters: RunFilters; refreshed: number }) {
  const office = useOffice()
  const [folds, setFolds] = createStore<Record<string, Fold>>({})
  const filtered = () => Object.keys(props.filters).length > 0

  async function showAll(id: string) {
    setFolds(id, { loading: true })
    try {
      const all = await office.client.runs.children(id)
      // Reconciled by run_id, as the list is: a re-read updates the rows in place, so focus stays where it was.
      setFolds(id, "all", reconcile(all, { key: "run_id" }))
      setFolds(id, { error: undefined })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      setFolds(id, { error: `Couldn't read the runs under …${id.slice(-4)}: ${why}.` })
    } finally {
      setFolds(id, { loading: false })
    }
  }
  createEffect(
    on(
      () => props.refreshed,
      () => {
        for (const [id, fold] of Object.entries(folds)) if (fold.all) void showAll(id)
      },
      { defer: true },
    ),
  )

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
        {(run) => {
          const under = createUniqueId()
          const fold = () => folds[run.run_id] ?? {}
          const kids = () => {
            const all = fold().all
            return all && all.length > (run.children ?? []).length ? all : (run.children ?? [])
          }
          const matching = () => (filtered() ? kids().filter((k) => matches(k, props.filters)) : [])
          const open = () => fold().open ?? matching().length > 0
          // Only the matching children, while some match and "Show the rest" hasn't been pressed.
          const shown = () => (matching().length && !fold().rest ? matching() : kids())
          const total = () => Math.max(run.children_total ?? 0, kids().length)
          return (
            <>
              <tbody>
                <Row
                  run={run}
                  level={1}
                  toggle={
                    total() > 0
                      ? { open: open(), controls: under, onToggle: () => setFolds(run.run_id, { open: !open() }) }
                      : undefined
                  }
                />
              </tbody>
              <tbody id={under}>
                <Show when={open()}>
                  <For each={shown()}>{(kid) => <Row run={kid} level={2} />}</For>
                  <Show when={shown().length < kids().length}>
                    <MoreRow label="Show the rest" onClick={() => setFolds(run.run_id, { rest: true })} />
                  </Show>
                  <Show when={shown().length === kids().length && total() > kids().length}>
                    <MoreRow
                      label={`Show all ${total()}`}
                      disabled={fold().loading}
                      error={fold().error}
                      onClick={() => void showAll(run.run_id)}
                    />
                  </Show>
                </Show>
              </tbody>
            </>
          )
        }}
      </For>
    </table>
  )
}

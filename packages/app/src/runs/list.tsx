// The Run Logs table: one row per top-level run, the runs started from it folded under it.
import type { RunSummary } from "@opencorp/protocol"
import { A } from "@solidjs/router"
import Check from "lucide-solid/icons/check"
import Copy from "lucide-solid/icons/copy"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useOffice } from "../data/office"
import { matches, type RunFilters } from "./filters"
import { flowText, shortId, STATUS_DOT, where } from "./format"

const MUTED = "text-neutral-500 dark:text-neutral-400"
// On a phone a row is a two-line grid: ID, status and flow, then driver, where/took and started.
const ROW =
  "border-b border-neutral-100 align-top dark:border-neutral-900 max-md:grid max-md:grid-cols-[auto_auto_minmax(0,1fr)] max-md:items-baseline max-md:gap-x-3 max-md:py-2"
const CELL = "px-3 py-2 max-md:p-0 max-md:min-w-0"
const BUTTON = "rounded underline outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"

/** A launch time to the minute, in the browser's locale. */
const at = (t: string, time = false) =>
  new Date(t).toLocaleString(undefined, time ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" })

/** Copies a run's full id; shows a check for 2 s after. */
function CopyId(props: { id: string }) {
  const [done, setDone] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const copy = async () => {
    await navigator.clipboard.writeText(props.id)
    setDone(true)
    clearTimeout(timer)
    timer = setTimeout(() => setDone(false), 2000)
  }
  return (
    <button
      type="button"
      aria-label="Copy run id"
      title={props.id}
      onClick={() => void copy()}
      class={`rounded p-0.5 outline-none hover:bg-neutral-100 focus-visible:ring-2 dark:hover:bg-neutral-800 ${MUTED}`}
    >
      <Show when={done()} fallback={<Copy size={12} class="h-3 w-3" />}>
        <Check size={12} class="h-3 w-3" />
      </Show>
    </button>
  )
}

/** One run's row; `toggle` is the fold button of a top-level run with runs under it. */
function Row(props: { run: RunSummary; level: 1 | 2; toggle?: { open: boolean; onToggle: () => void } }) {
  const r = () => props.run
  return (
    <tr aria-level={props.level} class={ROW}>
      <td class={`${CELL} whitespace-nowrap`} classList={{ "pl-6 max-md:pl-6": props.level === 2 }}>
        <span class="inline-flex items-center gap-1">
          <Show when={props.toggle}>
            {(t) => (
              <button
                type="button"
                aria-expanded={t().open}
                aria-label={`Runs under ${shortId(r().run_id)}`}
                onClick={() => t().onToggle()}
                class="w-4 rounded text-xs outline-none focus-visible:ring-2"
              >
                <span aria-hidden="true">{t().open ? "▾" : "▸"}</span>
              </button>
            )}
          </Show>
          <A href={`/runs/${r().run_id}`} class={`font-mono ${BUTTON}`}>
            {shortId(r().run_id)}
          </A>
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
        <span class="block truncate">{flowText(r())}</span>
        <Show when={r().replaces}>
          {(id) => (
            <A href={`/runs/${id()}`} class={`block text-xs ${MUTED} ${BUTTON}`}>
              replaces …{id().slice(-4)}
            </A>
          )}
        </Show>
        <Show when={r().replaced_by}>
          {(id) => (
            <A href={`/runs/${id()}`} class={`block text-xs ${MUTED} ${BUTTON}`}>
              replaced by …{id().slice(-4)}
            </A>
          )}
        </Show>
      </td>
      <td data-testid="run-second-line" class={`${CELL} whitespace-nowrap max-md:col-start-1`}>
        {r().driver === "office" ? "office" : `@${r().driver}`}
      </td>
      <td class={`${CELL} max-md:hidden`}>{(r().participants ?? []).join(", ")}</td>
      <td class={`${CELL} break-all`}>{where(r())}</td>
      <td class={`${CELL} whitespace-nowrap ${MUTED} max-md:truncate`}>
        {at(r().launched_at)}
        <Show when={r().ended_at}>{(end) => <> → {at(end(), true)}</>}</Show>
      </td>
    </tr>
  )
}

/** A row under the children with one button: "Show the rest" or "Show all N". */
function MoreRow(props: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <tr class="max-md:block">
      <td colSpan={7} class="py-1 pl-9 text-xs max-md:block">
        <button type="button" disabled={props.disabled} onClick={() => props.onClick()} class={BUTTON}>
          {props.label}
        </button>
      </td>
    </tr>
  )
}

/** What the table remembers of a top-level run across refetches: its fold, and its children once all are read. */
type Fold = { open?: boolean; rest?: boolean; all?: RunSummary[]; loading?: boolean }

/**
 * The runs table. A run's children start folded, except when the filters are set and a child matches: then it starts
 * open with only the matching children, until "Show the rest". Past the newest 200 children, "Show all" reads them.
 */
export function RunTable(props: { runs: RunSummary[]; filters: RunFilters }) {
  const office = useOffice()
  const [folds, setFolds] = createStore<Record<string, Fold>>({})
  const filtered = () => Object.keys(props.filters).length > 0

  async function showAll(id: string) {
    setFolds(id, { loading: true })
    try {
      setFolds(id, { all: await office.client.runs.children(id) })
    } catch (error) {
      console.error("Failed to read a run's children", { id, error })
    } finally {
      setFolds(id, { loading: false })
    }
  }

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
            <tbody>
              <Row
                run={run}
                level={1}
                toggle={total() > 0 ? { open: open(), onToggle: () => setFolds(run.run_id, { open: !open() }) } : undefined}
              />
              <Show when={open()}>
                <For each={shown()}>{(kid) => <Row run={kid} level={2} />}</For>
                <Show when={shown().length < kids().length}>
                  <MoreRow label="Show the rest" onClick={() => setFolds(run.run_id, { rest: true })} />
                </Show>
                <Show when={shown().length === kids().length && total() > kids().length}>
                  <MoreRow
                    label={`Show all ${total()}`}
                    disabled={fold().loading}
                    onClick={() => void showAll(run.run_id)}
                  />
                </Show>
              </Show>
            </tbody>
          )
        }}
      </For>
    </table>
  )
}

// One node attempt's detail on the run page: its output, route or error, and its model, read from the record that
// ended it. Beside the Timeline on a desktop (or over its whole width, expanded); a modal sheet over
// everything on a phone.
import type { RunDetail, RunEvent, RunNode } from "@opencorp/protocol"
import Maximize2 from "lucide-solid/icons/maximize-2"
import Minimize2 from "lucide-solid/icons/minimize-2"
import {
  createEffect,
  createSignal,
  createUniqueId,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js"
import { useOffice } from "../data/office"
import type { LiveCall } from "./live"
import { handleText, staticPath } from "./timeline"

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const ICON_BUTTON = "grid h-8 w-8 place-items-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
const PRE = "overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere dark:bg-neutral-900"

/** A failed read, inline, with its message and a Retry button. */
export function ReadError(props: { error: unknown; onRetry: () => void }) {
  return (
    <div class="flex items-center gap-2 text-sm">
      <p role="alert" class="text-red-700 dark:text-red-400">
        {props.error instanceof Error ? props.error.message : String(props.error)}
      </p>
      <button type="button" class={`rounded underline ${RING}`} onClick={() => props.onRetry()}>
        Retry
      </button>
    </div>
  )
}

/** A value as text: a string as it is, anything else as pretty JSON. */
export const pretty = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

/** A record too large to preview, as a page and node detail say it. */
export const tooLarge = (size: number) => `${(size / 2 ** 20).toFixed(1)} MB record: too large to preview; download the log`

type Payload = Record<string, unknown>
const asObject = (v: unknown): Payload | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : undefined)

/** A titled part of node detail. */
function Part(props: { title: string; children: JSX.Element }) {
  return (
    <div class="space-y-1">
      <h3 class={`text-xs font-semibold ${MUTED}`}>{props.title}</h3>
      {props.children}
    </div>
  )
}

/** A node attempt's detail, read from the record at its `end_seq`; no per-node tokens or times (the log has none). */
export function NodeDetail(props: {
  /** Its element's id, for the splitter that resizes it. */
  id?: string
  runId: string
  node: RunNode
  detail: RunDetail
  /** Whether it's a sheet over everything (a phone), so a modal dialog. */
  modal: boolean
  onClose: () => void
  /** Where focus goes back to when it closes. */
  returnTo: () => HTMLElement | undefined
  /** Whether it has the Timeline's width too (a desktop only). */
  expanded?: boolean
  /** Expands it over the Timeline, or puts it back beside it. */
  onExpand?: (expanded: boolean) => void
  /** Its model calls in flight with text so far, while its run is running. */
  live?: LiveCall[]
}) {
  const office = useOffice()
  const headingId = createUniqueId()
  let root!: HTMLDivElement
  let heading!: HTMLHeadingElement
  const [record, setRecord] = createSignal<RunEvent>()
  const [error, setError] = createSignal<unknown>()
  // The read in flight; an answer to an older one (another node, or a retry since) is dropped.
  let reading = 0
  onCleanup(() => reading++)

  /** The seq of the record to read: none while the node is open, or for an attempt a restart cut short. */
  const wanted = () =>
    props.node.status === "open" || props.node.status === "restarted" ? null : (props.node.end_seq ?? null)

  function load(seq: number) {
    const mine = ++reading
    setError(undefined)
    office.client.runs.event(props.runId, seq).then(
      (r) => mine === reading && setRecord(r),
      (e) => mine === reading && setError(e),
    )
  }
  createEffect(
    on(wanted, (seq) => {
      reading++
      setRecord(undefined)
      setError(undefined)
      if (seq != null) load(seq)
    }),
  )

  // A sheet takes focus when it opens and when it moves to another node; beside the Timeline, focus stays on the row
  // so the Timeline's keys go on working.
  createEffect(on(() => props.node.seq, () => props.modal && heading.focus()))
  // Escape closes it from anywhere but a text field or a select, which have their own use for it.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return
    if (e.target instanceof Element && e.target.closest("input:not([type=checkbox]):not([type=radio]), select, textarea")) return
    props.onClose()
  }
  onMount(() => document.addEventListener("keydown", onKey))
  onCleanup(() => {
    document.removeEventListener("keydown", onKey)
    // After this update: on a phone the page is inert until the sheet has gone. Focus elsewhere on the page stays.
    queueMicrotask(() => {
      const at = document.activeElement
      if (!at || at === document.body || root.contains(at)) props.returnTo()?.focus()
    })
  })

  const model = () => props.detail.models?.[staticPath(props.node.node_id)]
  const payload = () => asObject(record()?.payload)
  const failure = () => asObject(payload()?.failure)
  const handle = () => {
    const h = payload()?.handle ?? props.node.handle
    return typeof h === "string" ? h : null
  }

  return (
    // A div: a section can't take the dialog role.
    <div
      ref={root}
      role={props.modal ? "dialog" : "region"}
      aria-modal={props.modal ? "true" : undefined}
      aria-labelledby={headingId}
      id={props.id}
      // Its desktop width is --detail-w, which the run page sets through the CSSOM (the CSP forbids style attributes).
      class={`fixed inset-0 z-10 space-y-3 overflow-y-auto bg-white p-4 text-sm md:sticky md:top-0 md:max-h-screen md:self-start md:min-w-0 dark:bg-neutral-950 ${
        props.expanded ? "md:flex-1" : "md:w-[var(--detail-w,50%)]"
      }`}
    >
      <div class="flex items-start justify-between gap-2">
        {/* Labelled "Node <id>": the id alone reads as a path. */}
        <h2 id={headingId} ref={heading} tabindex={-1} class={`rounded text-base font-semibold wrap-anywhere ${RING}`}>
          <span class="sr-only">Node </span>
          <span class="font-mono">{props.node.node_id}</span>
        </h2>
        <div class="flex shrink-0 items-center gap-1">
          <Show when={!props.modal && props.onExpand}>
            <button
              type="button"
              aria-label="Expand"
              aria-pressed={!!props.expanded}
              title={props.expanded ? "Show the Timeline beside it" : "Expand over the Timeline"}
              class={`${ICON_BUTTON} ${RING}`}
              onClick={() => props.onExpand?.(!props.expanded)}
            >
              <Show when={props.expanded} fallback={<Maximize2 size={16} class="h-4 w-4" />}>
                <Minimize2 size={16} class="h-4 w-4" />
              </Show>
            </button>
          </Show>
          <button type="button" aria-label="Close" class={`${ICON_BUTTON} ${RING}`} onClick={() => props.onClose()}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt class={MUTED}>Status</dt>
        <dd>{props.node.status}</dd>
        <Show when={model()}>
          {(m) => (
            <>
              <dt class={MUTED}>Model</dt>
              <dd class="font-mono">{m()}</dd>
            </>
          )}
        </Show>
      </dl>
      <Show when={props.node.status === "open"}>
        <p class={MUTED}>running: its output appears when it ends</p>
        <Show when={props.live?.length}>
          <Part title="Live">
            {/* By position, so a call's block updates in place as its text grows. */}
            <div aria-live="polite" class="space-y-2">
              <Index each={props.live}>{(call) => <pre class={PRE}>{call().text}</pre>}</Index>
            </div>
          </Part>
        </Show>
      </Show>
      <Show when={props.node.status === "restarted"}>
        <p class={MUTED}>interrupted: its partial work is only in the session's transcript</p>
      </Show>
      <Show when={wanted() != null}>
        <Show when={error()}>{(e) => <ReadError error={e()} onRetry={() => load(wanted()!)} />}</Show>
        <Show when={!record() && !error()}>
          <p class={MUTED}>reading…</p>
        </Show>
        <Show when={record()}>
          {(r) => (
            <>
              <Show when={r().size}>{(size) => <p class={MUTED}>{tooLarge(size())}</p>}</Show>
              <Show when={payload() && "value" in payload()!}>
                <Part title="Output">
                  <pre class={PRE}>{pretty(payload()!.value)}</pre>
                </Part>
              </Show>
              <Show when={handle()}>
                {(h) => (
                  <Part title="Route">
                    <p class="font-mono">{handleText(h())}</p>
                  </Part>
                )}
              </Show>
              <Show when={failure()}>
                {(f) => (
                  <Part title="Error">
                    <p class="wrap-anywhere text-red-700 dark:text-red-400">{pretty(f().message ?? "")}</p>
                    <Show when={f().traceback != null}>
                      <details>
                        <summary class={`cursor-pointer rounded ${RING}`}>Traceback</summary>
                        <pre class={`mt-1 ${PRE}`}>{pretty(f().traceback)}</pre>
                      </details>
                    </Show>
                  </Part>
                )}
              </Show>
              <Show when={(r().cut ?? []).length}>
                <p class={MUTED}>Part of this record is too large to show whole; download the log.</p>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}

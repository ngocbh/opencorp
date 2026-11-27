// One node attempt on the run page, in one shape for every kind: Metadata, Inputs, the work section its kind has (an
// agent's model calls, a case's route), Outputs and its Error, each a list of labelled rows. Its detail, read from its
// records, answers at once and shows Metadata, Outputs and Error; its view, which the office reads by replaying the log
// up to the node (seconds on a long run), comes after with Inputs and typed Outputs, a loading row meanwhile. A model
// call or a whole value opens in its place. Beside the Timeline on a desktop (or over its whole width, expanded); a
// modal sheet over everything on a phone.
import type { RunDetail, RunNode, RunNodeDetail, RunNodeValue, RunNodeView } from "@opencorp/protocol"
import ArrowLeft from "lucide-solid/icons/arrow-left"
import Maximize2 from "lucide-solid/icons/maximize-2"
import Minimize2 from "lucide-solid/icons/minimize-2"
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { useOffice } from "../data/office"
import { CallList, CallView, type OpenedCall } from "./call"
import type { LiveCall } from "./live"
import { handleText, staticPath } from "./timeline"
import { duration, nodeOutputs, preview, READING, shownWhole, workOf, type WorkKind } from "./values"

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const ICON_BUTTON = "grid h-8 w-8 place-items-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
const PRE = "overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere dark:bg-neutral-900"
const ROWS = "grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1"

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

/** A time with seconds, in the browser's locale. */
const clock = (t: string) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })

/** A titled section of node detail. */
function Section(props: { title: string; children: JSX.Element }) {
  const id = createUniqueId()
  return (
    <section aria-labelledby={id} class="space-y-1">
      <h3 id={id} class={`text-xs font-semibold ${MUTED}`}>
        {props.title}
      </h3>
      {props.children}
    </section>
  )
}

/** One labelled row of a section. */
function Row(props: { label: string; mono?: boolean; children: JSX.Element }) {
  return (
    <>
      <dt class={`${MUTED} ${props.mono ? "font-mono wrap-anywhere" : ""}`}>{props.label}</dt>
      <dd class="min-w-0 wrap-anywhere">{props.children}</dd>
    </>
  )
}

/** A section's values, a row each: its name, its type, a preview, and › to open it when the preview isn't all of it. */
function Values(props: { values: RunNodeValue[]; onOpen: (value: RunNodeValue, button: HTMLElement) => void }) {
  return (
    <dl class={ROWS}>
      <For each={props.values}>
        {(v) => (
          <Row label={v.name} mono>
            <span class="flex min-w-0 items-baseline gap-2">
              <Show when={v.type}>{(type) => <span class={`shrink-0 font-mono text-xs ${MUTED}`}>{type()}</span>}</Show>
              <span class={`min-w-0 truncate ${v.missing ? MUTED : "font-mono text-xs"}`}>{preview(v)}</span>
              <Show when={!shownWhole(v)}>
                <button
                  type="button"
                  aria-label={`Open ${v.name}`}
                  title="Open the whole value"
                  class={`grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 ${RING}`}
                  onClick={(e) => props.onOpen(v, e.currentTarget)}
                >
                  <span aria-hidden="true">›</span>
                </button>
              </Show>
            </span>
          </Row>
        )}
      </For>
    </dl>
  )
}

/** A whole value opened from Inputs (`input`) or Outputs. */
type OpenedValue = { value: RunNodeValue; input: boolean }

/** A whole value opened from its row, headed by its section and name, with a way back. */
function ValueView(props: { opened: OpenedValue; onBack: () => void }) {
  const headingId = createUniqueId()
  let heading!: HTMLHeadingElement
  const value = () => props.opened.value
  onMount(() => heading.focus())
  return (
    <section aria-labelledby={headingId} class="space-y-2">
      <div class="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back to the node"
          title="Back to the node"
          class={`${ICON_BUTTON} shrink-0 ${RING}`}
          onClick={() => props.onBack()}
        >
          <ArrowLeft size={16} class="h-4 w-4" />
        </button>
        <h3 id={headingId} ref={heading} tabindex={-1} class={`rounded text-sm font-semibold wrap-anywhere ${RING}`}>
          {props.opened.input ? "Input" : "Output"} <span class="font-mono">{value().name}</span>
        </h3>
      </div>
      <Show when={value().type}>{(type) => <p class={`font-mono text-xs ${MUTED}`}>{type()}</p>}</Show>
      <pre class={PRE}>{pretty(value().value ?? null)}</pre>
      <Show when={(value().cut ?? []).length}>
        <p class={MUTED}>Part of this value is too large to show whole; download the log.</p>
      </Show>
    </section>
  )
}

/** What a work section takes. */
type WorkProps = {
  runId: string
  node: RunNode
  handle: string | null
  live?: LiveCall[]
  onOpenCall: (call: OpenedCall, button: HTMLElement) => void
}

/** Each kind's work section, between Inputs and Outputs: an agent's model calls (and their text so far while it
 *  runs), a case's route. Another kind's slots in here and in `WORK_KINDS`. */
const WORK: Record<WorkKind, (props: WorkProps) => JSX.Element> = {
  agent: (props) => (
    <>
      <Show when={props.node.status === "open" && props.live?.length}>
        <Section title="Live">
          {/* By position, so a call's block updates in place as its text grows. */}
          <div aria-live="polite" class="space-y-2">
            <Index each={props.live}>{(call) => <pre class={PRE}>{call().text}</pre>}</Index>
          </div>
        </Section>
      </Show>
      <CallList runId={props.runId} node={props.node} onOpen={props.onOpenCall} />
    </>
  ),
  case: (props) => (
    <Show when={props.handle}>
      {(handle) => (
        <Section title="Route">
          <dl class={ROWS}>
            <Row label="Took">
              <span class="font-mono">{handleText(handle())}</span>
            </Row>
          </dl>
        </Section>
      )}
    </Show>
  ),
}

/** What shows in place of the node's sections: a model call or a whole value. */
type Opened = { call: OpenedCall } | { value: OpenedValue }

/** A node attempt's detail, read from the office by its start seq, and read again as the attempt moves on. */
export function NodeDetail(props: {
  /** Its element's id, for the splitter that resizes it. */
  id?: string
  runId: string
  node: RunNode
  detail: RunDetail
  /** Whether it's a sheet over everything (a phone), so a modal dialog. */
  modal: boolean
  onClose: () => void
  /** Where focus goes back to when it closes, given its node's seq. */
  returnTo: (seq: number) => HTMLElement | undefined
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
  const [read, setRead] = createSignal<RunNodeDetail>()
  const [error, setError] = createSignal<unknown>()
  // The read in flight; an answer to an older one (another node, or a retry since) is dropped.
  let reading = 0
  onCleanup(() => reading++)

  function load() {
    const mine = ++reading
    setError(undefined)
    office.client.runs.node(props.runId, props.node.seq).then(
      (r) => mine === reading && setRead(r),
      (e) => mine === reading && setError(e),
    )
  }
  // Its view, by the seq it was read for. A read that another replaces is aborted, so the office drops it while it is
  // still queued there.
  const [viewed, setViewed] = createSignal<{ seq: number; view: RunNodeView }>()
  const [viewError, setViewError] = createSignal<unknown>()
  let viewing: AbortController | undefined
  onCleanup(() => viewing?.abort())
  function loadView() {
    viewing?.abort()
    const mine = (viewing = new AbortController())
    const seq = props.node.seq
    setViewError(undefined)
    office.client.runs.view(props.runId, seq, { signal: mine.signal }).then(
      (view) => viewing === mine && setViewed({ seq, view }),
      (e) => viewing === mine && setViewError(e),
    )
  }
  // The same node moving on (open, then succeeded) is read again, its last read showing meanwhile.
  createEffect(
    on(
      () => [props.node.seq, props.node.status, props.node.end_seq],
      () => {
        load()
        loadView()
      },
    ),
  )

  // A model call or a whole value shown in place of the node's sections, and the button that opened it, where focus
  // goes back.
  const [opened, setOpened] = createSignal<Opened>()
  let opener: HTMLElement | undefined
  function open(what: Opened, button: HTMLElement) {
    opener = button
    setOpened(what)
  }
  function closeOpened() {
    setOpened(undefined)
    if (opener?.isConnected) opener.focus()
    else heading.focus()
  }
  createEffect(on(() => props.node.seq, () => setOpened(undefined)))

  // A sheet takes focus when it opens and when it moves to another node; beside the Timeline, focus stays on the row
  // so the Timeline's keys go on working.
  createEffect(on(() => props.node.seq, () => props.modal && heading.focus()))
  // Escape goes back from what opened to the node, and closes the node, from anywhere but a text field or a select,
  // which have their own use for it.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return
    if (e.target instanceof Element && e.target.closest("input:not([type=checkbox]):not([type=radio]), select, textarea")) return
    if (opened()) closeOpened()
    else props.onClose()
  }
  onMount(() => document.addEventListener("keydown", onKey))
  // Kept as it changes: once the node has gone, reading it is a stale read.
  let seq = props.node.seq
  createEffect(() => (seq = props.node.seq))
  onCleanup(() => {
    document.removeEventListener("keydown", onKey)
    // After this update: on a phone the page is inert until the sheet has gone. Focus elsewhere on the page stays.
    queueMicrotask(() => {
      const at = document.activeElement
      if (!at || at === document.body || root.contains(at)) props.returnTo(seq)?.focus()
    })
  })

  /** The read, once it's of this node: another node's shows nothing of it. */
  const detail = () => {
    const r = read()
    return r && r.node.seq === props.node.seq ? r : undefined
  }
  /** The view, once it's of this node. */
  const view = () => {
    const v = viewed()
    return v && v.seq === props.node.seq ? v.view : undefined
  }
  const viewLoading = () => !view() && !viewError()
  /** Its inputs show while they're read or can't be, and when it has any. */
  const showInputs = () => {
    const v = view()
    return !v || v.inputs == null || v.inputs.length > 0
  }
  const outputs = () => nodeOutputs(detail()?.outputs, view()?.outputs, viewLoading())
  const kind = () => props.node.kind ?? view()?.kind ?? null
  const model = () => detail()?.model ?? props.detail.models?.[staticPath(props.node.node_id)]
  const handle = () => detail()?.node.handle ?? props.node.handle ?? null
  const took = () => duration(detail()?.started_at, detail()?.ended_at)
  const work = () => {
    const shown = workOf({ kind: kind(), handle: handle() })
    return shown === null ? undefined : WORK[shown]
  }
  const openedCall = () => {
    const o = opened()
    return o && "call" in o ? o.call : undefined
  }
  const openedValue = () => {
    const o = opened()
    return o && "value" in o ? o.value : undefined
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
      <Show when={openedCall()}>{(call) => <CallView runId={props.runId} opened={call()} onBack={closeOpened} />}</Show>
      <Show when={openedValue()}>{(value) => <ValueView opened={value()} onBack={closeOpened} />}</Show>
      {/* Hidden, not gone, while something opened shows: the button that opened it takes focus back. */}
      <div hidden={!!opened()} class="space-y-4">
        <Section title="Metadata">
          <dl class={ROWS}>
            <Show when={kind()}>{(k) => <Row label="Kind">{k()}</Row>}</Show>
            {/* A flow call or a loop by what it came to, as its row in Overview says it. */}
            <Row label="Status">{detail()?.outcome ?? props.node.status}</Row>
            <Show when={model()}>
              {(m) => (
                <Row label="Model">
                  <span class="font-mono">{m()}</span>
                </Row>
              )}
            </Show>
            <Show when={detail()?.started_at}>
              {(t) => (
                <Row label="Started">
                  <time datetime={t()} title={t()}>
                    {clock(t())}
                  </time>
                </Row>
              )}
            </Show>
            <Show when={took()}>{(text) => <Row label="Duration">{text()}</Row>}</Show>
          </dl>
        </Section>
        <Show when={error()}>{(e) => <ReadError error={e()} onRetry={load} />}</Show>
        <Show when={!detail() && !error()}>
          <p class={MUTED}>reading…</p>
        </Show>
        <Show when={showInputs()}>
          <Section title="Inputs">
            <Show when={viewError()}>{(e) => <ReadError error={e()} onRetry={loadView} />}</Show>
            <Show when={viewLoading()}>
              <p class={MUTED}>{READING}</p>
            </Show>
            <Show when={view()}>
              {(v) => (
                <Show when={v().inputs} fallback={<p class={MUTED}>{v().missing ?? "its inputs couldn't be read"}</p>}>
                  {(inputs) => (
                    <Values values={inputs()} onOpen={(value, button) => open({ value: { value, input: true } }, button)} />
                  )}
                </Show>
              )}
            </Show>
          </Section>
        </Show>
        <Dynamic
          component={work()}
          runId={props.runId}
          node={props.node}
          handle={handle()}
          live={props.live}
          onOpenCall={(call: OpenedCall, button: HTMLElement) => open({ call }, button)}
        />
        <Show when={props.node.status === "open"}>
          <Section title="Outputs">
            <p class={MUTED}>running: its output appears when it ends</p>
          </Section>
        </Show>
        <Show when={props.node.status === "restarted"}>
          <Section title="Outputs">
            <p class={MUTED}>interrupted: its partial work is only in the session's transcript</p>
          </Section>
        </Show>
        <Show when={outputs().length}>
          <Section title="Outputs">
            <Values values={outputs()} onOpen={(value, button) => open({ value: { value, input: false } }, button)} />
          </Section>
        </Show>
        <Show when={detail()?.failure}>
          {(f) => (
            <Section title="Error">
              <Show when={f().size}>{(size) => <p class={MUTED}>{tooLarge(size())}</p>}</Show>
              <p class="wrap-anywhere text-red-700 dark:text-red-400">{f().message}</p>
              <Show when={f().traceback != null}>
                <details>
                  <summary class={`cursor-pointer rounded ${RING}`}>Traceback</summary>
                  <pre class={`mt-1 ${PRE}`}>{f().traceback}</pre>
                </details>
              </Show>
              <Show when={(f().cut ?? []).length}>
                <p class={MUTED}>Part of this error is too large to show whole; download the log.</p>
              </Show>
            </Section>
          )}
        </Show>
      </div>
    </div>
  )
}

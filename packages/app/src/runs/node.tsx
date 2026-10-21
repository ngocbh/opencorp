// One node attempt's detail on the run page: its output, route or error, its model, and its evidence, read from the
// record that ended it. Beside the Timeline on a desktop; a modal sheet over everything on a phone.
import { isIndexing, isSecretsUnavailable } from "@opencorp/client"
import type { RunDetail, RunEvent, RunNode } from "@opencorp/protocol"
import { createEffect, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useOffice } from "../data/office"
import { staticPath } from "./timeline"

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const PRE = "overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere dark:bg-neutral-900"

/** What a failed record read says: the secrets and the first read of the log each say to try again. */
export function failureText(e: unknown): string {
  if (isSecretsUnavailable(e)) return "Couldn't load the secrets to remove; try again."
  if (isIndexing(e)) return "The log is still being read; try again."
  return e instanceof Error ? e.message : String(e)
}

/** A failed read, inline, with a Retry button. */
export function ReadError(props: { error: unknown; onRetry: () => void }) {
  return (
    <div class="flex items-center gap-2 text-sm">
      <p role="alert" class="text-red-700 dark:text-red-400">
        {failureText(props.error)}
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

/** The evidence a learnable flow records for a node, each folded under its label. */
const EVIDENCE: [label: string, key: string][] = [
  ["Inputs", "bound_inputs"],
  ["Prompt", "prompt"],
  ["System prompt", "base_system_prompt"],
  ["Memory", "memory_sections"],
  ["Model turns and tool calls", "interactions"],
]

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
  runId: string
  node: RunNode
  detail: RunDetail
  /** Whether it's a sheet over everything (a phone), so a modal dialog. */
  modal: boolean
  onClose: () => void
  /** Where focus goes back to when it closes. */
  returnTo: () => HTMLElement | undefined
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
  const evidence = () => {
    const ev = asObject(payload()?.evidence)
    return ev ? EVIDENCE.filter(([, key]) => ev[key] != null).map(([label, key]) => ({ label, value: ev[key] })) : []
  }

  return (
    // A div: a section can't take the dialog role.
    <div
      ref={root}
      role={props.modal ? "dialog" : "region"}
      aria-modal={props.modal ? "true" : undefined}
      aria-labelledby={headingId}
      class="fixed inset-0 z-10 space-y-3 overflow-y-auto bg-white p-4 text-sm md:sticky md:top-0 md:inset-auto md:max-h-screen md:w-96 md:shrink-0 md:self-start md:border-l md:border-neutral-200 dark:bg-neutral-950 dark:md:border-neutral-800"
    >
      <div class="flex items-start justify-between gap-2">
        {/* Labelled "Node <id>": the id alone reads as a path. */}
        <h2 id={headingId} ref={heading} tabindex={-1} class={`rounded text-base font-semibold wrap-anywhere ${RING}`}>
          <span class="sr-only">Node </span>
          <span class="font-mono">{props.node.node_id}</span>
        </h2>
        <button
          type="button"
          aria-label="Close"
          class={`grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 ${RING}`}
          onClick={() => props.onClose()}
        >
          <span aria-hidden="true">×</span>
        </button>
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
              <Show when={r().withheld}>{(text) => <p class={MUTED}>{text()}</p>}</Show>
              <Show when={r().size}>{(size) => <p class={MUTED}>{tooLarge(size())}</p>}</Show>
              <Show when={payload() && "value" in payload()!}>
                <Part title="Output">
                  <pre class={PRE}>{pretty(payload()!.value)}</pre>
                </Part>
              </Show>
              <Show when={handle()}>
                {(h) => (
                  <Part title="Route">
                    <p class="font-mono">{h()}</p>
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
              <For each={evidence()}>
                {(part) => (
                  <details>
                    <summary class={`cursor-pointer rounded ${RING}`}>{part.label}</summary>
                    <pre class={`mt-1 ${PRE}`}>{pretty(part.value)}</pre>
                  </details>
                )}
              </For>
              <Show when={(r().cut ?? []).length}>
                <p class={MUTED}>Part of this record is too large to show whole; download the log.</p>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.detail.learnable === false}>
          <p class={MUTED}>Evidence isn't recorded: this flow isn't learnable.</p>
        </Show>
      </Show>
    </div>
  )
}

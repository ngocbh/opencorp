// An agent node's model calls in its detail, and one call rebuilt by the office from the run log: the request it sent
// (system prompt, messages, tools, model and settings), the reply (thought, text), each tool call with its arguments,
// the gate's notes and its result, and its attempts, usage and finish. Tool rows and thought blocks follow OpenCode's
// session UI (its BasicTool and ThoughtRow), and a long text folds to its head until "Show all", as its tall diffs do.
import type {
  RunCall,
  RunCallEntry,
  RunCallMessage,
  RunCallPart,
  RunCallToolResult,
  RunNode,
} from "@opencorp/protocol"
import ArrowLeft from "lucide-solid/icons/arrow-left"
import ChevronRight from "lucide-solid/icons/chevron-right"
import Wrench from "lucide-solid/icons/wrench"
import {
  createEffect,
  createMemo,
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
import { useOffice } from "../data/office"
import { argsLine, callLine, cutAt, foldedHead, gateLines, pointer, seconds, toolState, usageText } from "./calls"
import { pretty, ReadError } from "./node"

const MUTED = "text-neutral-500 dark:text-neutral-400"
const RING = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 dark:focus-visible:ring-neutral-100"
const LINK = `rounded underline ${RING}`
const PRE = "overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere dark:bg-neutral-900"
const BOX = "rounded border border-neutral-200 dark:border-neutral-800"
/** Messages of a long history shown before "Show earlier messages". */
const RECENT = 8

/** A time with seconds, in the browser's locale. */
const clock = (t: string) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/** The node's model calls, oldest first, each a button that opens it; re-read when the node moves on. */
export function CallList(props: {
  runId: string
  node: RunNode
  onOpen: (call: RunCallEntry, button: HTMLElement) => void
}) {
  const office = useOffice()
  const [calls, setCalls] = createSignal<RunCallEntry[]>()
  const [error, setError] = createSignal<unknown>()
  let reading = 0
  onCleanup(() => reading++)
  function load() {
    const mine = ++reading
    setError(undefined)
    office.client.runs.calls(props.runId, props.node.node_id).then(
      (r) => mine === reading && setCalls(r.calls),
      (e) => mine === reading && setError(e),
    )
  }
  createEffect(on(() => [props.node.seq, props.node.status, props.node.end_seq], () => load()))
  return (
    <div class="space-y-1">
      <h3 class={`text-xs font-semibold ${MUTED}`}>Model calls</h3>
      <Show when={error()}>{(e) => <ReadError error={e()} onRetry={load} />}</Show>
      <Show when={!calls() && !error()}>
        <p class={MUTED}>reading…</p>
      </Show>
      <Show when={calls()}>
        {(list) => (
          <Show when={list().length} fallback={<p class={MUTED}>No model call yet.</p>}>
            <ul aria-label="Model calls" class="space-y-0.5">
              <For each={list()}>
                {(call) => (
                  <li>
                    <button
                      type="button"
                      class={`w-full rounded px-1 py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900 ${RING} ${
                        call.finish === "interrupted" || call.finish == null ? "text-amber-700 dark:text-amber-400" : ""
                      }`}
                      onClick={(e) => props.onOpen(call, e.currentTarget)}
                    >
                      {callLine(call)}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </div>
  )
}

/** One model call, read from the office, with a way back to its node. */
export function CallView(props: { runId: string; entry: RunCallEntry; onBack: () => void }) {
  const office = useOffice()
  const headingId = createUniqueId()
  let heading!: HTMLHeadingElement
  const [call, setCall] = createSignal<RunCall>()
  const [error, setError] = createSignal<unknown>()
  let reading = 0
  onCleanup(() => reading++)
  function load() {
    const mine = ++reading
    setError(undefined)
    office.client.runs.call(props.runId, props.entry.node_id, props.entry.n).then(
      (r) => mine === reading && setCall(r),
      (e) => mine === reading && setError(e),
    )
  }
  onMount(() => {
    load()
    heading.focus()
  })
  return (
    <section aria-labelledby={headingId} class="space-y-3">
      <div class="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back to the node"
          title="Back to the node"
          class={`grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 ${RING}`}
          onClick={() => props.onBack()}
        >
          <ArrowLeft size={16} class="h-4 w-4" />
        </button>
        <h3 id={headingId} ref={heading} tabindex={-1} class={`rounded text-sm font-semibold ${RING}`}>
          Model call {props.entry.n}
        </h3>
      </div>
      <Show when={error()}>{(e) => <ReadError error={e()} onRetry={load} />}</Show>
      <Show when={!call() && !error()}>
        <p class={MUTED}>rebuilding the call from the log…</p>
      </Show>
      <Show when={call()}>{(c) => <CallBody call={c()} model={props.entry.model} />}</Show>
    </section>
  )
}

/** A titled region of the call view. */
function Section(props: { title: string; children: JSX.Element }) {
  const id = createUniqueId()
  return (
    <section aria-labelledby={id} class="space-y-1.5">
      <h4 id={id} class={`text-xs font-semibold ${MUTED}`}>
        {props.title}
      </h4>
      {props.children}
    </section>
  )
}

/** The call's facts, then its request, reply, tool calls and attempts. */
function CallBody(props: { call: RunCall; model: string }) {
  const request = () => props.call.request
  const replyParts = createMemo(() =>
    (props.call.reply?.parts ?? []).map((part, j) => ({ part, j })).filter(({ part }) => part.type !== "tool_call"),
  )
  const usage = () => usageText(props.call.usage)
  return (
    <>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt class={MUTED}>Model</dt>
        <dd class="font-mono">{request()?.model ?? props.model}</dd>
        <dt class={MUTED}>Finish</dt>
        <dd>{props.call.finish ?? "failed"}</dd>
        <Show when={props.call.purpose !== "chat"}>
          <dt class={MUTED}>Purpose</dt>
          <dd>{props.call.purpose}</dd>
        </Show>
        <Show when={usage()}>
          <dt class={MUTED}>Usage</dt>
          <dd>{usage()}</dd>
        </Show>
      </dl>
      <Show when={props.call.interrupted}>
        <p role="note" class="text-amber-700 dark:text-amber-400">
          {props.call.finish === "interrupted"
            ? "An interrupt cut this reply: it holds what arrived before."
            : "An interrupt stopped the agent before it acted on all of this reply."}
        </p>
      </Show>
      <Show when={props.call.digest_mismatch}>
        <p role="note" class={MUTED}>
          The rebuilt request differs from what this call recorded sending, so it may not be exact.
        </p>
      </Show>
      <Section title="Request">
        <Show when={request()} fallback={<p class={MUTED}>The request couldn't be rebuilt from the log.</p>}>
          {(r) => <RequestView call={props.call} request={r()} />}
        </Show>
      </Section>
      <Section title="Reply">
        <Show
          when={replyParts().length || props.call.reply}
          fallback={<p class={MUTED}>Nothing arrived.</p>}
        >
          <div class="space-y-1.5">
            <For each={replyParts()}>
              {({ part, j }) => <PartView part={part} call={props.call} at={pointer("reply", "parts", j)} />}
            </For>
            <Show when={!replyParts().length}>
              <p class={MUTED}>No text: only tool calls.</p>
            </Show>
          </div>
        </Show>
      </Section>
      <Show when={props.call.tool_results?.length}>
        <Section title="Tool calls">
          <div class="space-y-1.5">
            <For each={props.call.tool_results}>
              {(result, k) => <ToolCard result={result} call={props.call} at={pointer("tool_results", k())} />}
            </For>
          </div>
        </Section>
      </Show>
      <Section title="Attempts">
        <ol aria-label="Attempts" class="space-y-1">
          <For each={props.call.attempts}>
            {(attempt) => (
              <li class="space-y-0.5">
                <div>
                  <span class="font-medium">Attempt {attempt.n}</span>{" "}
                  <span class={MUTED}>
                    {clock(attempt.started_at)} → {clock(attempt.finished_at)}
                  </span>
                </div>
                <Show when={attempt.error}>
                  {(e) => (
                    <p class="wrap-anywhere text-red-700 dark:text-red-400">
                      {e().kind}: {e().message}
                    </p>
                  )}
                </Show>
                <Show when={attempt.retry_in != null}>
                  <p class={MUTED}>retried after {seconds(attempt.retry_in!)}</p>
                </Show>
                <Show when={usageText(attempt.usage)}>{(text) => <p class={MUTED}>{text()}</p>}</Show>
              </li>
            )}
          </For>
        </ol>
      </Section>
    </>
  )
}

/** The request: the system prompt, the messages (a long history's older ones folded), the tools and the settings. */
function RequestView(props: { call: RunCall; request: NonNullable<RunCall["request"]> }) {
  const [all, setAll] = createSignal(false)
  const messages = () => props.request.messages
  const from = () => (all() ? 0 : Math.max(0, messages().length - RECENT))
  const settings = () => {
    const r = props.request
    return {
      model: r.model,
      ...r.params,
      ...(r.tool_choice != null && { tool_choice: r.tool_choice }),
      ...(r.parallel_tool_calls != null && { parallel_tool_calls: r.parallel_tool_calls }),
      ...(r.output_format != null && { output_format: r.output_format }),
    }
  }
  return (
    <div class="space-y-2">
      <Show when={props.request.system != null}>
        <div class="space-y-1">
          <p class={`text-xs ${MUTED}`}>system</p>
          <LongText text={props.request.system!} cut={cutAt(props.call, pointer("request", "system"))} />
        </div>
      </Show>
      <Show when={from() > 0}>
        <button type="button" class={`text-xs ${LINK}`} onClick={() => setAll(true)}>
          Show {from()} earlier {from() === 1 ? "message" : "messages"}
        </button>
      </Show>
      <Index each={messages().slice(from())}>
        {(message, i) => (
          <MessageView message={message()} call={props.call} at={pointer("request", "messages", from() + i)} />
        )}
      </Index>
      <details class={BOX}>
        <summary class={`cursor-pointer rounded px-2 py-1 ${RING}`}>Tools ({props.request.tools?.length ?? 0})</summary>
        <ul class="space-y-2 p-2">
          <For each={props.request.tools}>
            {(tool) => (
              <li class="space-y-1">
                <p>
                  <span class="font-mono">{tool.name}</span>
                  <span class={MUTED}> {tool.description}</span>
                </p>
                <details>
                  <summary class={`cursor-pointer rounded text-xs ${MUTED} ${RING}`}>Parameters</summary>
                  <pre class={`mt-1 ${PRE}`}>{pretty(tool.parameters)}</pre>
                </details>
              </li>
            )}
          </For>
        </ul>
      </details>
      <details class={BOX}>
        <summary class={`cursor-pointer rounded px-2 py-1 ${RING}`}>Model and settings</summary>
        <pre class={`m-2 ${PRE}`}>{pretty(settings())}</pre>
      </details>
    </div>
  )
}

/** One message of the request: who said it, then its parts. */
function MessageView(props: { message: RunCallMessage; call: RunCall; at: string }) {
  return (
    <div class={`space-y-1 p-2 ${BOX}`}>
      <p class={`text-xs ${MUTED}`}>
        {props.message.role}
        <Show when={props.message.author}>{(who) => <> · @{who()}</>}</Show>
      </p>
      <Index each={props.message.parts}>
        {(part, j) => <PartView part={part()} call={props.call} at={`${props.at}${pointer("parts", j)}`} />}
      </Index>
    </div>
  )
}

/** A message part: text as it is, a thought folded, a tool call by name and arguments, a tool result, a file. */
function PartView(props: { part: RunCallPart; call: RunCall; at: string }) {
  const part = () => props.part
  return (
    <>
      {(() => {
        const p = part()
        switch (p.type) {
          case "text":
            return <LongText text={p.text} cut={cutAt(props.call, `${props.at}/text`)} />
          case "refusal":
            return (
              <div class="space-y-1">
                <p class={`text-xs ${MUTED}`}>refusal</p>
                <LongText text={p.text} cut={cutAt(props.call, `${props.at}/text`)} />
              </div>
            )
          case "reasoning":
            return <Thought text={p.text} cut={cutAt(props.call, `${props.at}/text`)} />
          case "tool_call":
            return (
              <div class="flex min-w-0 items-center gap-1.5 text-xs">
                <Wrench size={12} class={`h-3 w-3 shrink-0 ${MUTED}`} />
                <span class="font-mono">{p.name}</span>
                <span class={`truncate ${MUTED}`}>{argsLine(p.arguments ?? null) || (p.raw_arguments ?? "")}</span>
              </div>
            )
          case "tool_result":
            return (
              <div class="space-y-1">
                <p class={`text-xs ${MUTED}`}>
                  result of <span class="font-mono">{p.name}</span>
                </p>
                <LongText text={p.content} error={!!p.is_error} cut={cutAt(props.call, `${props.at}/content`)} />
              </div>
            )
          case "media":
            return (
              <p class={`text-xs ${MUTED}`}>
                file: {p.name ?? "unnamed"} ({p.mime})
              </p>
            )
        }
      })()}
    </>
  )
}

/** A model's thought: "Thought", opened on a click, as OpenCode's ThoughtRow shows one. */
function Thought(props: { text: string; cut: boolean }) {
  return (
    <details class="group">
      <summary class={`inline-flex cursor-pointer items-center gap-1 rounded text-xs ${MUTED} ${RING}`}>
        <ChevronRight size={12} class="h-3 w-3 transition-transform group-open:rotate-90" />
        Thought
      </summary>
      <div class="mt-1">
        <LongText text={props.text} cut={props.cut} />
      </div>
    </details>
  )
}

/**
 * One tool call of the reply, as OpenCode's BasicTool shows a tool: a row with its name, its arguments in a line and
 * its state, which opens on its arguments and result. The gate's notes show under the row, open or not.
 */
function ToolCard(props: { result: RunCallToolResult; call: RunCall; at: string }) {
  const [open, setOpen] = createSignal(false)
  const id = createUniqueId()
  const state = () => toolState(props.result)
  const bad = () => state() !== "ran" && state() !== "waiting"
  return (
    <div class={BOX}>
      <button
        type="button"
        aria-expanded={open()}
        aria-controls={id}
        class={`flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900 ${RING}`}
        onClick={() => setOpen(!open())}
      >
        <ChevronRight size={14} class={`h-3.5 w-3.5 shrink-0 transition-transform ${open() ? "rotate-90" : ""}`} />
        <span class="font-mono">{props.result.name}</span>
        <span class={`min-w-0 flex-1 truncate text-xs ${MUTED}`}>{argsLine(props.result.arguments ?? null)}</span>
        <span class={`shrink-0 text-xs ${bad() ? "text-red-700 dark:text-red-400" : MUTED}`}>{state()}</span>
      </button>
      <For each={gateLines(props.result)}>{(line) => <p class={`px-2 pb-1 text-xs ${MUTED}`}>{line}</p>}</For>
      <Show when={open()}>
        <div id={id} class="space-y-2 border-t border-neutral-200 p-2 dark:border-neutral-800">
          <div class="space-y-1">
            <p class={`text-xs ${MUTED}`}>arguments</p>
            <LongText
              text={props.result.arguments == null ? "(they didn't parse: the call never reached its tool)" : pretty(props.result.arguments)}
              cut={cutAt(props.call, `${props.at}/arguments`)}
            />
          </div>
          <div class="space-y-1">
            <p class={`text-xs ${MUTED}`}>
              result
              <Show when={props.result.started_at}>{(t) => <> · started {clock(t())}</>}</Show>
            </p>
            <Show when={props.result.output != null} fallback={<p class={MUTED}>No result yet.</p>}>
              <LongText text={props.result.output!} error={!!props.result.is_error} cut={cutAt(props.call, `${props.at}/output`)} />
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

/** The nearest ancestor of `el` that scrolls. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at
  }
  return document.scrollingElement as HTMLElement | null
}

/**
 * A text, folded to its head when long, with "Show all" and "Show less" (as OpenCode folds a tall diff: closing keeps
 * the toggle where it was pressed). A text the office cut says so once shown whole.
 */
function LongText(props: { text: string; cut?: boolean; error?: boolean }) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const head = createMemo(() => foldedHead(props.text))
  let toggle!: HTMLButtonElement
  function flip() {
    const before = toggle.getBoundingClientRect().top
    setOpen(!open())
    const moved = before - toggle.getBoundingClientRect().top
    if (moved > 1) scrollParent(toggle)?.scrollBy({ top: -moved, behavior: "instant" })
  }
  return (
    <div class="space-y-1">
      <pre id={id} class={`${PRE} ${props.error ? "text-red-700 dark:text-red-400" : ""}`}>
        {open() || head() === null ? props.text : `${head()}…`}
      </pre>
      <Show when={head() !== null}>
        <button ref={toggle} type="button" aria-expanded={open()} aria-controls={id} class={`text-xs ${LINK}`} onClick={flip}>
          {open() ? "Show less" : "Show all"}
        </button>
      </Show>
      <Show when={props.cut && (open() || head() === null)}>
        <p class={`text-xs ${MUTED}`}>Cut at 64K characters here; the log holds it whole.</p>
      </Show>
    </div>
  )
}

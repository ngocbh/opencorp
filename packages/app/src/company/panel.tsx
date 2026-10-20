import type { Group, Person } from "@opencorp/protocol"
import { createEffect, createMemo, createUniqueId, For, on, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { useOffice } from "../data/office"
import { LIVE } from "../data/snapshot"
import { costText } from "./format"

const MUTED = "text-neutral-500 dark:text-neutral-400"

/** One of the panel's parts, named by its heading. */
function Section(props: ParentProps<{ title: string }>) {
  const id = createUniqueId()
  return (
    <div role="group" aria-labelledby={id} class="mt-4">
      <h3 id={id} class="font-medium">
        {props.title}
      </h3>
      {props.children}
    </div>
  )
}

/**
 * A person's side panel, read-only: their fields from person.yaml, manager and reports, groups, and live sessions with
 * what each is doing. Beside the list it's a complementary region; on a phone it's a full-width modal sheet over it.
 */
export function Panel(props: {
  person: Person
  manager?: Person
  reports: Person[]
  groups: Map<string, Group>
  onSelect: (handle: string) => void
  onClose: () => void
  /** Whether it's a sheet over everything (a phone), so a modal dialog. */
  modal: boolean
  /** Where focus goes back to when the panel closes. */
  returnTo: () => HTMLElement | undefined
}) {
  const office = useOffice()
  /** The person's own live work: main and side sessions in a live status (profile_manager work is the office's). */
  const sessions = createMemo(() =>
    office.state.sessions.filter(
      (x) => x.person === props.person.handle && (x.kind === "main" || x.kind === "side") && LIVE.includes(x.status),
    ),
  )
  /** Their work item ids, as one string: unchanged by updates that don't change the set. */
  const workItemIds = createMemo(() =>
    [...new Set(sessions().flatMap((x) => (x.work_item_id ? [x.work_item_id] : [])))].sort().join(" "),
  )
  // Sessions carry no title, so "now doing" is their work item's: read when the panel shows a new one, not on every
  // session update (a failed read would be tried again each time).
  createEffect(
    on(workItemIds, (ids) => {
      for (const id of ids.split(" ")) if (id) office.loadWorkItem(id)
    }),
  )
  const headingId = createUniqueId()
  let root!: HTMLDivElement
  let heading!: HTMLHeadingElement
  // Focus moves into the panel when it opens and when it moves to someone else (the manager button it was on may be
  // gone).
  createEffect(on(() => props.person.handle, () => heading.focus()))
  // Escape closes the panel from anywhere but a text field or a select, which have their own use for it (a search box
  // clears); a checkbox or radio has none.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return
    if (e.target instanceof Element && e.target.closest("input:not([type=checkbox]):not([type=radio]), select, textarea")) return
    props.onClose()
  }
  onMount(() => document.addEventListener("keydown", onKey))
  onCleanup(() => {
    document.removeEventListener("keydown", onKey)
    // After this update: on a phone the list is inert until the panel has gone. Focus that's somewhere else on the
    // page (the search box, say) stays there.
    queueMicrotask(() => {
      const at = document.activeElement
      if (!at || at === document.body || root.contains(at)) props.returnTo()?.focus()
    })
  })
  return (
    // A div: <aside> can't take the dialog role.
    <div
      ref={root}
      role={props.modal ? "dialog" : "complementary"}
      aria-modal={props.modal ? "true" : undefined}
      aria-labelledby={headingId}
      class="fixed inset-0 z-10 overflow-y-auto bg-white p-4 md:sticky md:top-0 md:inset-auto md:max-h-screen md:w-80 md:shrink-0 md:self-start md:border-l md:border-neutral-200 dark:bg-neutral-950 dark:md:border-neutral-800"
    >
      <div class="flex items-start justify-between gap-2">
        <h2 id={headingId} ref={heading} tabindex={-1} class="rounded text-lg font-semibold outline-none focus-visible:ring-2">
          {props.person.name}
        </h2>
        <button
          type="button"
          aria-label="Close"
          class="grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          onClick={() => props.onClose()}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p class={`text-sm ${MUTED}`}>
        @{props.person.handle} · {props.person.kind} · {props.person.title}
      </p>
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
        <dt class={MUTED}>Home office</dt>
        <dd>{props.person.home_office ?? "—"}</dd>
        <dt class={MUTED}>Harnesses</dt>
        <dd>{(props.person.harnesses ?? []).join(", ") || "—"}</dd>
        <Show when={props.person.kind === "agent"}>
          <dt class={MUTED}>Model</dt>
          <dd>{props.person.model ?? "the office's default"}</dd>
        </Show>
      </dl>
      <p class={`mt-2 text-xs ${MUTED}`}>From person.yaml at the last commit; the profile isn't shown here yet.</p>
      <Section title="Manager">
        <Show
          when={props.manager}
          fallback={
            <p class="text-sm">
              {props.person.manager ? `@${props.person.manager}, who isn't in the company` : "None"}
            </p>
          }
        >
          {(m) => (
            <button type="button" class="text-sm underline" onClick={() => props.onSelect(m().handle)}>
              {m().name}
            </button>
          )}
        </Show>
      </Section>
      <Section title="Reports">
        <Show when={props.reports.length} fallback={<p class="text-sm">None</p>}>
          <ul aria-label="Reports" class="text-sm">
            <For each={props.reports}>{(r) => <li>{r.name}</li>}</For>
          </ul>
        </Show>
      </Section>
      <Section title="Groups">
        <p class="flex flex-wrap gap-1 text-sm">
          <For each={props.person.groups ?? []} fallback={<span>None</span>}>
            {(id) => <span class="rounded bg-neutral-100 px-1.5 dark:bg-neutral-800">{props.groups.get(id)?.name ?? id}</span>}
          </For>
        </p>
      </Section>
      <Section title="Live sessions">
        <Show when={sessions().length} fallback={<p class="text-sm">None</p>}>
          <ul aria-label="Live sessions" class="space-y-1 text-sm">
            <For each={sessions()}>
              {(x) => (
                <li>
                  {/* The office prices composer tokens only; a harness session's spend isn't known here. */}
                  {x.status} · {x.harness === "composer" ? costText(x.cost ?? 0, 0) : "unpriced"} · {x.office}
                  <Show when={x.work_item_id ? office.state.workItems[x.work_item_id] : undefined}>
                    {(w) => <> · now doing: {w().title}</>}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>
    </div>
  )
}

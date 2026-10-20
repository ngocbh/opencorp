import type { Group, Person } from "@opencorp/protocol"
import { For, Show } from "solid-js"

const MUTED = "text-neutral-500 dark:text-neutral-400"

/**
 * A person's side panel, read-only: their fields from person.yaml, manager and reports, and groups. Phones get it as a
 * full-width sheet over the list.
 */
export function Panel(props: {
  person: Person
  manager?: Person
  reports: Person[]
  groups: Map<string, Group>
  onSelect: (handle: string) => void
  onClose: () => void
}) {
  return (
    <aside
      aria-label={props.person.name}
      class="fixed inset-0 z-10 overflow-y-auto bg-white p-4 md:sticky md:top-0 md:inset-auto md:max-h-screen md:w-80 md:shrink-0 md:self-start md:border-l md:border-neutral-200 dark:bg-neutral-950 dark:md:border-neutral-800"
    >
      <div class="flex items-start justify-between gap-2">
        <h2 class="text-lg font-semibold">{props.person.name}</h2>
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
      <h3 class="mt-4 font-medium">Manager</h3>
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
      <h3 class="mt-4 font-medium">Reports</h3>
      <Show when={props.reports.length} fallback={<p class="text-sm">None</p>}>
        <ul aria-label="Reports" class="text-sm">
          <For each={props.reports}>{(r) => <li>{r.name}</li>}</For>
        </ul>
      </Show>
      <h3 class="mt-4 font-medium">Groups</h3>
      <p class="flex flex-wrap gap-1 text-sm">
        <For each={props.person.groups ?? []} fallback={<span>None</span>}>
          {(id) => <span class="rounded bg-neutral-100 px-1.5 dark:bg-neutral-800">{props.groups.get(id)?.name ?? id}</span>}
        </For>
      </p>
    </aside>
  )
}

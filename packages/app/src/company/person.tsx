import type { Group, Person, PersonCost } from "@opencorp/protocol"
import { For, Show } from "solid-js"
import { personCost } from "./format"
import type { Status } from "./status"

const DOT: Record<Status, string> = {
  waiting: "bg-amber-500",
  busy: "bg-green-500 animate-pulse",
  idle: "bg-neutral-400",
  away: "border border-neutral-400",
}

/** A closed branch's dot is outlined, so it doesn't read as the person's own status. */
const BRANCH = "outline outline-1 outline-offset-2 outline-neutral-500 dark:outline-neutral-400"

const initials = (name: string) => name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase()

/**
 * One person, as a list row's body or a chart card's: avatar, status, name and title, group chips (when `groups` is
 * given), the viewer's cards from them, and the window's cost.
 */
export function PersonBody(props: {
  person: Person
  status: Status
  needs: number
  cost: PersonCost | undefined
  groups?: Map<string, Group>
  /** Whether `status` is the person's closed branch's (its most urgent member's), not their own. */
  branch?: boolean
}) {
  return (
    <span class="flex min-w-0 flex-1 items-center gap-2">
      <span
        aria-hidden="true"
        class="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-200 text-xs dark:bg-neutral-800"
      >
        {initials(props.person.name)}
        <span class="absolute -bottom-1 -right-1 text-[10px]">{props.person.kind === "human" ? "●" : "◆"}</span>
      </span>
      <span
        data-testid="status"
        data-status={props.status}
        data-branch={props.branch ? "true" : undefined}
        class={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[props.status]} ${props.branch ? BRANCH : ""}`}
      >
        <span class="sr-only">{props.branch ? `${props.status} in this branch` : props.status}</span>
      </span>
      <span class="min-w-0 truncate">
        <span class="font-medium">{props.person.name}</span> <span class="text-neutral-500">{props.person.title}</span>
      </span>
      <Show when={props.groups}>
        {(groups) => (
          <For each={props.person.groups ?? []}>
            {(id) => <span class="rounded bg-neutral-100 px-1.5 text-xs dark:bg-neutral-800">{groups().get(id)?.name ?? id}</span>}
          </For>
        )}
      </Show>
      <Show when={props.needs > 0}>
        <span data-testid="needs-you" title="cards for you" class="rounded-full bg-amber-500 px-1.5 text-xs text-white">
          {props.needs}
        </span>
      </Show>
      <span data-testid="cost" class="ml-auto shrink-0 text-sm tabular-nums text-neutral-500">
        {personCost(props.cost)}
      </span>
    </span>
  )
}

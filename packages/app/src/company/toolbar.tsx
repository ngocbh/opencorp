import { Switch } from "@kobalte/core/switch"
import type { Group } from "@opencorp/protocol"
import { For, Show } from "solid-js"
import type { CostWindow } from "../data/window"
import type { View } from "./prefs"
import { Segmented } from "./segmented"

/**
 * The company view's controls: the company's name, the search box, the group filter, "By team", the cost window and
 * Chart/List (only where the chart fits).
 */
export function Toolbar(props: {
  company: string
  query: string
  onQuery: (q: string) => void
  groups: Group[]
  group: string
  onGroup: (id: string) => void
  byTeam: boolean
  onByTeam: (on: boolean) => void
  window: CostWindow
  onWindow: (w: CostWindow) => void
  view: View
  onView: (v: View) => void
  canChart: boolean
}) {
  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-neutral-200 p-3 dark:border-neutral-800">
      <h2 class="mr-auto text-base font-semibold">{props.company}</h2>
      <input
        type="search"
        aria-label="Search people"
        placeholder="Search people"
        value={props.query}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
        class="w-48 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
      />
      <select
        aria-label="Group"
        value={props.group}
        onChange={(e) => props.onGroup(e.currentTarget.value)}
        class="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="">All groups</option>
        <For each={props.groups}>{(g) => <option value={g.id}>{g.name}</option>}</For>
      </select>
      <Switch checked={props.byTeam} onChange={props.onByTeam} class="flex items-center gap-2">
        <Switch.Input />
        <Switch.Control class="inline-flex h-5 w-9 items-center rounded-full bg-neutral-300 transition data-[checked]:bg-neutral-900 dark:data-[checked]:bg-neutral-100">
          <Switch.Thumb class="h-4 w-4 translate-x-0.5 rounded-full bg-white transition data-[checked]:translate-x-4 dark:bg-neutral-900" />
        </Switch.Control>
        <Switch.Label>By team</Switch.Label>
      </Switch>
      <Segmented
        label="Cost window"
        value={props.window}
        onChange={props.onWindow}
        options={[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]]}
      />
      <Show when={props.canChart}>
        <Segmented label="View" value={props.view} onChange={props.onView} options={[["chart", "Chart"], ["list", "List"]]} />
      </Show>
    </div>
  )
}

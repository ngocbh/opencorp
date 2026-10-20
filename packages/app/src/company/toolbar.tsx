import { Switch } from "@kobalte/core/switch"
import type { Group } from "@opencorp/protocol"
import { For, Show } from "solid-js"
import type { CostWindow } from "../data/window"
import type { Shown } from "./address"
import { Segmented } from "./segmented"

/**
 * The company view's controls: the company's name, the people controls (the search box, the group filter, "By team"
 * and the cost window; not in Source) and the View switch (Chart only where the chart fits).
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
  view: Shown
  onView: (v: Shown) => void
  canChart: boolean
}) {
  const views = (): [Shown, string][] => [
    ...(props.canChart ? [["chart", "Chart"] as [Shown, string]] : []),
    ["list", "List"],
    ["source", "Source"],
  ]
  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-neutral-200 p-3 dark:border-neutral-800">
      <h2 class="mr-auto text-base font-semibold">{props.company}</h2>
      <Show when={props.view !== "source"}>
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
          <Switch.Input class="peer" />
          <Switch.Control
            data-testid="switch-control"
            class="inline-flex h-5 w-9 items-center rounded-full bg-neutral-300 ring-offset-2 transition peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-900 data-[checked]:bg-neutral-900 dark:bg-neutral-700 dark:ring-offset-neutral-950 dark:peer-focus-visible:ring-neutral-100 dark:data-[checked]:bg-neutral-100"
          >
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
      </Show>
      <Segmented label="View" value={props.view} onChange={props.onView} options={views()} />
    </div>
  )
}

import type { Group, PersonCost } from "@opencorp/protocol"
import { createMemo, createSignal, For, Show } from "solid-js"
import { PersonBody } from "./person"
import { isMuted, label, moveFocus, personOf, teamName, visibleRows, type Item } from "./rows"
import type { Status } from "./status"

/** What the list (and, later, the chart) show, and what they do. */
export type ListProps = {
  /** The tree's accessible name: the company's name. */
  label: string
  items: Item[]
  isOpen: (item: Item, depth: number) => boolean
  setOpen: (id: string, open: boolean) => void
  status: (handle: string) => Status
  needs: (handle: string) => number
  cost: (handle: string) => PersonCost | undefined
  groups: Map<string, Group>
  /** What a closed branch says about everyone in it, or undefined. */
  totals: (item: Item) => string | undefined
  /** Whether the group filter dims this row. */
  dimmed: (item: Item) => boolean
  onSelect: (handle: string) => void
}

/**
 * The company as an indented tree: the WAI-ARIA tree pattern with flat treeitems (aria-level, aria-setsize,
 * aria-posinset) and a roving tabindex. Flat, because a nested treeitem's accessible name takes in every row under it.
 */
export function CompanyList(props: ListProps) {
  const rows = createMemo(() => visibleRows(props.items, props.isOpen))
  // Rows are keyed by id, not by row object, so opening or closing a branch keeps every row's element (and focus).
  const ids = createMemo(() => rows().map((r) => r.item.id))
  const byId = createMemo(() => new Map(rows().map((r) => [r.item.id, r])))
  const [focused, setFocused] = createSignal<string>()
  /** The row with tabindex 0: the focused one while it's visible, else the first. */
  const current = () => (byId().has(focused() ?? "") ? focused() : ids()[0])
  const elements = new Map<string, HTMLElement>()
  function onKey(e: KeyboardEvent, id: string) {
    const row = byId().get(id)
    const p = row && personOf(row.item)
    if (e.key === "Enter" && p) {
      e.preventDefault()
      return props.onSelect(p.handle)
    }
    const move = moveFocus(rows(), id, e.key)
    if (!move) return
    e.preventDefault()
    if ("open" in move) return props.setOpen(move.open, move.to)
    setFocused(move.focus)
    elements.get(move.focus)?.focus()
  }
  return (
    <ul role="tree" aria-label={props.label} class="p-2">
      <For each={ids()}>
        {(id) => (
          <Show when={byId().get(id)}>
            {(row) => {
              const person = () => personOf(row().item)
              return (
                <li
                  role="treeitem"
                  aria-label={label(row().item)}
                  aria-level={row().level}
                  aria-setsize={row().setsize}
                  aria-posinset={row().posinset}
                  aria-expanded={row().item.children.length ? row().open : undefined}
                  aria-selected={current() === id}
                  tabindex={current() === id ? 0 : -1}
                  data-dimmed={String(props.dimmed(row().item))}
                  data-muted={isMuted(row().item) ? "true" : undefined}
                  // Computed, so Solid sets it with style.setProperty, which the CSP allows.
                  style={{ "padding-left": `${row().level - 1 + 0.5}rem` }}
                  class="flex cursor-default items-center gap-2 rounded py-1 pr-2 outline-none focus-visible:ring-2 data-[dimmed=true]:opacity-40 data-[muted=true]:opacity-60"
                  ref={(el) => elements.set(id, el)}
                  onFocus={() => setFocused(id)}
                  onKeyDown={(e) => onKey(e, id)}
                  onClick={() => {
                    const p = person()
                    if (p) props.onSelect(p.handle)
                  }}
                >
                  <Show when={row().item.children.length} fallback={<span aria-hidden="true" class="w-4 shrink-0" />}>
                    <span
                      aria-hidden="true"
                      data-testid="toggle"
                      class="w-4 shrink-0 cursor-pointer select-none text-neutral-500"
                      onClick={(e) => {
                        e.stopPropagation() // toggling isn't selecting
                        props.setOpen(id, !row().open)
                      }}
                    >
                      {row().open ? "▾" : "▸"}
                    </span>
                  </Show>
                  <Show when={person()} fallback={<span class="font-medium">{teamName(row().item)}</span>}>
                    {(p) => (
                      <PersonBody
                        person={p()}
                        status={props.status(p().handle)}
                        needs={props.needs(p().handle)}
                        cost={props.cost(p().handle)}
                        groups={props.groups}
                      />
                    )}
                  </Show>
                  <Show when={row().item.children.length > 0 && !row().open && props.totals(row().item)}>
                    {(text) => <span class="shrink-0 text-xs text-neutral-500">{text()}</span>}
                  </Show>
                </li>
              )
            }}
          </Show>
        )}
      </For>
    </ul>
  )
}

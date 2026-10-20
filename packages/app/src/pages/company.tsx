import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Banners, Unplaced } from "../company/banners"
import { totalsText } from "../company/format"
import { CompanyList } from "../company/list"
import { createPrefs } from "../company/prefs"
import { fromTeams, fromTree, holds, keep, personOf, type Item } from "../company/rows"
import { cards, inOffice, needsYou, statusByPerson, totals, type OfficeFilter } from "../company/status"
import { byTeam } from "../company/teams"
import { Toolbar } from "../company/toolbar"
import { buildTree } from "../company/tree"
import { useOffice } from "../data/office"

/** Whether the window is at least Tailwind's md breakpoint: phones always get the list. */
function useDesktop() {
  const query = matchMedia("(min-width: 768px)")
  const [desktop, setDesktop] = createSignal(query.matches)
  const changed = () => setDesktop(query.matches)
  query.addEventListener("change", changed)
  onCleanup(() => query.removeEventListener("change", changed))
  return desktop
}

/** What the page shows before the first snapshot. */
function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the company" class="space-y-3 p-6">
      <div class="h-4 w-1/3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <div class="h-4 w-1/2 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <div class="h-4 w-2/5 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
    </div>
  )
}

/** The company view. */
export default function Company() {
  const office = useOffice()
  const s = office.state
  const prefs = createPrefs()
  const desktop = useDesktop()
  // The toolbar's state. The office filter is one value today (every office); its slot is here so status and cards
  // follow it once HQ shows several offices.
  const [query, setQuery] = createSignal("")
  const [group, setGroup] = createSignal("")
  const [teamView, setTeamView] = createSignal(false)
  const [officeFilter] = createSignal<OfficeFilter>(null)
  const sessions = createMemo(() => inOffice(s.sessions, officeFilter()))
  const tree = createMemo(() => buildTree(s.people, s.company))
  const status = createMemo(() => statusByPerson(sessions(), Object.values(s.questions)))
  const assignee = (id: string) => s.workItems[id]?.assignee
  const needs = createMemo(() =>
    needsYou(office.me() ?? "", sessions(), Object.values(s.questions), s.company?.ceo ?? null, assignee),
  )
  // An ask_manager card goes to its work item's assignee (the asker's manager at the session's commit): read each
  // such work item once. Open ask_manager cards are few.
  createEffect(() => {
    for (const q of cards(Object.values(s.questions)))
      if (q.source === "ask_manager" && q.work_item_id) office.loadWorkItem(q.work_item_id)
  })
  const groups = createMemo(() => new Map(s.groups.map((g) => [g.id, g])))
  const items = createMemo(() => {
    const t = teamView() ? byTeam(s.people, s.groups) : undefined
    return keep(t ? fromTeams(t.teams, t.noTeam) : fromTree(tree().roots), query())
  })
  // A search opens every kept branch, so the matches show; branches closed during it stay closed for that search
  // only, and the remembered choices are left alone.
  const [searchOpen, setSearchOpen] = createSignal<{ query: string; open: Record<string, boolean> }>({ query: "", open: {} })
  const searching = () => query().trim()
  const openInSearch = () => (searchOpen().query === searching() ? searchOpen().open : {})
  const isOpen = (item: Item, depth: number) =>
    searching()
      ? (openInSearch()[item.id] ?? true)
      : prefs.isOpen(item.id, { depth, holdsNeedsYou: holds(item, needs()) })
  const setOpen = (id: string, open: boolean) =>
    searching() ? setSearchOpen({ query: searching(), open: { ...openInSearch(), [id]: open } }) : prefs.setOpen(id, open)
  /** A manager's branch totals, from their node in the tree by manager; leaves and "By team" rows have none. */
  const totalsOf = (item: Item) => {
    const node = item.kind === "person" ? tree().nodes.get(item.id) : undefined
    return node?.children.length ? totalsText(totals(node, status(), needs(), s.costs)) : undefined
  }
  // The group filter highlights its members and dims everyone else, keeping the tree's shape.
  const dimmed = (item: Item) => {
    const p = personOf(item)
    return !!group() && !!p && !(p.groups ?? []).includes(group())
  }
  /** What the page shows; the chart comes with its own change, and the list stays the default until then. */
  const view = () => (desktop() ? (prefs.view() ?? "list") : "list")
  const select = (_handle: string) => {} // the side panel comes next
  const name = () => s.company?.name ?? "Company"
  return (
    <Show when={office.ready()} fallback={<Skeleton />}>
      <Toolbar
        company={name()}
        query={query()}
        onQuery={setQuery}
        groups={s.groups}
        group={group()}
        onGroup={setGroup}
        byTeam={teamView()}
        onByTeam={setTeamView}
        window={office.costWindow()}
        onWindow={office.setCostWindow}
        view={view()}
        onView={prefs.setView}
        canChart={desktop()}
      />
      <Banners noCompany={!s.company} ceoHasManager={tree().ceoHasManager} issues={s.issues} />
      <Show when={view() === "chart"}>
        <p class="px-3 pt-3 text-sm text-neutral-500">The chart isn't built yet; this is the list.</p>
      </Show>
      <CompanyList
        label={name()}
        items={items()}
        isOpen={isOpen}
        setOpen={setOpen}
        status={(h) => status().get(h) ?? "away"}
        needs={(h) => needs().get(h) ?? 0}
        cost={(h) => s.costs?.people[h]}
        groups={groups()}
        totals={totalsOf}
        dimmed={dimmed}
        onSelect={select}
      />
      <Unplaced people={tree().unplaced} onSelect={select} />
    </Show>
  )
}

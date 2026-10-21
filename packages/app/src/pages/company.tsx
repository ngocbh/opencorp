import { useNavigate, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, lazy, Match, onCleanup, Show, Switch } from "solid-js"
import { chooseView, pathOf, sourceHref, type Shown } from "../company/address"
import { Banners, Unplaced } from "../company/banners"
import { totalsText } from "../company/format"
import { CompanyList, type ListProps } from "../company/list"
import { createPrefs } from "../company/prefs"
import { fromTeams, fromTree, holds, keep, personOf, type Item } from "../company/rows"
import { branchStatus, cards, inOffice, needsYou, statusByPerson, totals, type OfficeFilter } from "../company/status"
import { byTeam } from "../company/teams"
import { Panel } from "../company/panel"
import { Toolbar } from "../company/toolbar"
import { buildTree, byName } from "../company/tree"
import { useOffice } from "../data/office"
import { useDesktop, useShell } from "../shell"

// Its own chunk: phones and list users never load it.
const Chart = lazy(() => import("../company/chart"))
// Its own chunk too, with highlight.js: only Source loads it.
const Source = lazy(() => import("../company/source"))

/** What the page shows before the first snapshot. */
function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the company" class="space-y-3 p-6">
      <div class="h-4 w-1/3 motion-safe:animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <div class="h-4 w-1/2 motion-safe:animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <div class="h-4 w-2/5 motion-safe:animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
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
  /** A manager's branch status, from their node in the tree by manager. */
  const branchStatusOf = (item: Item) => {
    const node = item.kind === "person" ? tree().nodes.get(item.id) : undefined
    return node?.children.length ? branchStatus(node, status()) : undefined
  }
  // The group filter highlights its members and dims everyone else, keeping the tree's shape.
  const dimmed = (item: Item) => {
    const p = personOf(item)
    return !!group() && !!p && !(p.groups ?? []).includes(group())
  }
  const [params] = useSearchParams()
  const navigate = useNavigate()
  /** Source when the address says so; else the chart on a desktop unless this browser chose the list, and the list on a phone. */
  const view = () => chooseView(params.view, desktop(), prefs.view())
  /** Chart and List are this browser's choice; only Source goes in the address, so leaving it pushes /org. */
  const chooseShown = (v: Shown) => {
    if (v === view()) return
    if (v === "source") return navigate(sourceHref(""))
    const leaving = view() === "source"
    // A phone always starts on the list: its taps don't change what a desktop opens on.
    if (desktop()) prefs.setView(v)
    if (leaving) navigate("/org")
  }
  /** The person the side panel shows. */
  const [selected, setSelected] = createSignal<string>()
  const byHandle = createMemo(() => new Map(s.people.map((p) => [p.handle, p])))
  const shown = () => byHandle().get(selected() ?? "")
  /** The panel's person's reports, by name. */
  const reports = createMemo(() => {
    const handle = shown()?.handle
    return handle ? s.people.filter((x) => x.manager === handle).sort(byName) : []
  })
  // Source has no people: a panel open when it shows closes.
  createEffect(() => view() === "source" && setSelected(undefined))
  // Someone who leaves the company closes their panel: coming back at a later commit mustn't reopen it.
  createEffect(() => {
    if (selected() !== undefined && !shown()) setSelected(undefined)
  })
  /** The row (or Unplaced button) that opened the panel: focus goes back there when it closes. */
  let opener: HTMLElement | undefined
  /** Opens the panel on `handle` from the list or Unplaced; a move inside the panel keeps the opener. */
  const select = (handle: string) => {
    const from = document.activeElement
    opener = from instanceof HTMLElement && from !== document.body ? from : undefined
    setSelected(handle)
  }
  /** Where focus goes when the panel closes: its opener, or the tree's current row (or chart card) once it's gone. */
  const returnTo = () =>
    opener?.isConnected
      ? opener
      : (document.querySelector<HTMLElement>('[role=treeitem][tabindex="0"], [data-card] [tabindex="0"]') ?? undefined)
  // On a phone the panel is a sheet over the whole screen: nothing behind it can take focus.
  const sheet = () => !desktop() && !!shown()
  const shell = useShell()
  createEffect(() => shell?.setCovered(sheet()))
  onCleanup(() => shell?.setCovered(false))
  const name = () => s.company?.name ?? "Company"
  /** What either view shows and does; getters keep it reactive when it's spread into one. */
  const shownProps: ListProps = {
    get label() {
      return name()
    },
    get items() {
      return items()
    },
    isOpen,
    setOpen,
    status: (h) => status().get(h) ?? "away",
    branchStatus: branchStatusOf,
    needs: (h) => needs().get(h) ?? 0,
    cost: (h) => s.costs?.people[h],
    get groups() {
      return groups()
    },
    totals: totalsOf,
    dimmed,
    onSelect: select,
    get selected() {
      return shown()?.handle
    },
  }
  return (
    <Show when={office.ready()} fallback={<Skeleton />}>
      <div class="flex">
        <div class="min-w-0 flex-1" inert={sheet()}>
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
            onView={chooseShown}
            canChart={desktop()}
          />
          <Banners noCompany={!s.company} ceoHasManager={tree().ceoHasManager} issues={s.issues} />
          <Switch fallback={<CompanyList {...shownProps} />}>
            <Match when={view() === "source"}>
              <Source company={name()} path={pathOf(params.path)} desktop={desktop()} />
            </Match>
            <Match when={view() === "chart"}>
              <Chart {...shownProps} />
            </Match>
          </Switch>
          <Show when={view() !== "source"}>
            <Unplaced people={tree().unplaced} onSelect={select} />
          </Show>
        </div>
        <Show when={shown()}>
          {(p) => (
            <Panel
              person={p()}
              manager={p().manager ? byHandle().get(p().manager!) : undefined}
              reports={reports()}
              groups={groups()}
              onSelect={setSelected}
              onClose={() => setSelected(undefined)}
              returnTo={returnTo}
              modal={!desktop()}
            />
          )}
        </Show>
      </div>
    </Show>
  )
}

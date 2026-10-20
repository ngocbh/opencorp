import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Banners, Unplaced } from "../company/banners"
import { totalsText } from "../company/format"
import { CompanyList } from "../company/list"
import { createPrefs } from "../company/prefs"
import { fromTeams, fromTree, holds, keep, personOf, type Item } from "../company/rows"
import { inOffice, needsYou, statusByPerson, totals, type OfficeFilter } from "../company/status"
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
  const groups = createMemo(() => new Map(s.groups.map((g) => [g.id, g])))
  const items = createMemo(() => {
    const t = teamView() ? byTeam(s.people, s.groups) : undefined
    return keep(t ? fromTeams(t.teams, t.noTeam) : fromTree(tree().roots), query())
  })
  // While searching, every kept branch is open, so the matches show.
  const isOpen = (item: Item, depth: number) =>
    query().trim() !== "" || prefs.isOpen(item.id, { depth, holdsNeedsYou: holds(item, needs()) })
  /** A person's branch totals, from their node in the tree by manager; "By team" rows have none. */
  const totalsOf = (item: Item) => {
    const node = item.kind === "person" ? tree().nodes.get(item.id) : undefined
    return node ? totalsText(totals(node, status(), needs(), s.costs)) : undefined
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
    <>
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
        setOpen={prefs.setOpen}
        status={(h) => status().get(h) ?? "away"}
        needs={(h) => needs().get(h) ?? 0}
        cost={(h) => s.costs?.people[h]}
        groups={groups()}
        totals={totalsOf}
        dimmed={dimmed}
        onSelect={select}
      />
      <Unplaced people={tree().unplaced} onSelect={select} />
    </>
  )
}

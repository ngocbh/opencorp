import { createMemo, createSignal } from "solid-js"
import { totalsText } from "../company/format"
import { CompanyList } from "../company/list"
import { createPrefs } from "../company/prefs"
import { fromTree, holds, keep, type Item } from "../company/rows"
import { inOffice, needsYou, statusByPerson, totals, type OfficeFilter } from "../company/status"
import { Toolbar } from "../company/toolbar"
import { buildTree } from "../company/tree"
import { useOffice } from "../data/office"

/** The company view. */
export default function Company() {
  const office = useOffice()
  const s = office.state
  const prefs = createPrefs()
  // The toolbar's state. The office filter is one value today (every office); its slot is here so status and cards
  // follow it once HQ shows several offices.
  const [query, setQuery] = createSignal("")
  const [officeFilter] = createSignal<OfficeFilter>(null)
  const sessions = createMemo(() => inOffice(s.sessions, officeFilter()))
  const tree = createMemo(() => buildTree(s.people, s.company))
  const status = createMemo(() => statusByPerson(sessions(), Object.values(s.questions)))
  const assignee = (id: string) => s.workItems[id]?.assignee
  const needs = createMemo(() =>
    needsYou(office.me() ?? "", sessions(), Object.values(s.questions), s.company?.ceo ?? null, assignee),
  )
  const groups = createMemo(() => new Map(s.groups.map((g) => [g.id, g])))
  const items = createMemo(() => keep(fromTree(tree().roots), query()))
  // While searching, every kept branch is open, so the matches show.
  const isOpen = (item: Item, depth: number) =>
    query().trim() !== "" || prefs.isOpen(item.id, { depth, holdsNeedsYou: holds(item, needs()) })
  /** A person's branch totals, from their node in the tree by manager. */
  const totalsOf = (item: Item) => {
    const node = item.kind === "person" ? tree().nodes.get(item.id) : undefined
    return node ? totalsText(totals(node, status(), needs(), s.costs)) : undefined
  }
  const name = () => s.company?.name ?? "Company"
  return (
    <>
      <Toolbar company={name()} query={query()} onQuery={setQuery} />
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
        dimmed={() => false}
        onSelect={() => {}}
      />
    </>
  )
}

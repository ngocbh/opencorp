import { createMemo, createSignal } from "solid-js"
import { totalsText } from "../company/format"
import { CompanyList } from "../company/list"
import { createPrefs } from "../company/prefs"
import { fromTree, holds, type Item } from "../company/rows"
import { inOffice, needsYou, statusByPerson, totals, type OfficeFilter } from "../company/status"
import { buildTree } from "../company/tree"
import { useOffice } from "../data/office"

/** The company view. */
export default function Company() {
  const office = useOffice()
  const s = office.state
  const prefs = createPrefs()
  // One office today; the filter's slot is here so status and cards add up per office once HQ shows several.
  const [officeFilter] = createSignal<OfficeFilter>(null)
  const sessions = createMemo(() => inOffice(s.sessions, officeFilter()))
  const tree = createMemo(() => buildTree(s.people, s.company))
  const status = createMemo(() => statusByPerson(sessions(), Object.values(s.questions)))
  const assignee = (id: string) => s.workItems[id]?.assignee
  const needs = createMemo(() =>
    needsYou(office.me() ?? "", sessions(), Object.values(s.questions), s.company?.ceo ?? null, assignee),
  )
  const groups = createMemo(() => new Map(s.groups.map((g) => [g.id, g])))
  const items = createMemo(() => fromTree(tree().roots))
  const isOpen = (item: Item, depth: number) => prefs.isOpen(item.id, { depth, holdsNeedsYou: holds(item, needs()) })
  /** A person's branch totals, from their node in the tree by manager. */
  const totalsOf = (item: Item) => {
    const node = item.kind === "person" ? tree().nodes.get(item.id) : undefined
    return node ? totalsText(totals(node, status(), needs(), s.costs)) : undefined
  }
  return (
    <CompanyList
      label={s.company?.name ?? "Company"}
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
  )
}

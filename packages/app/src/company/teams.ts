import type { Group, Person } from "@opencorp/protocol"
import { byName } from "./tree"

export type TeamMember = { person: Person; muted: boolean }
export type Team = { group: Group; members: TeamMember[]; children: Team[] }

/**
 * "By team": groups nested by parent (an unknown parent or a parent cycle goes to the top level), members head first,
 * a person in several groups full under their first and muted elsewhere, ungrouped people under "No team".
 */
export function byTeam(people: Person[], groups: Group[]): { teams: Team[]; noTeam: Person[] } {
  const ids = new Map(groups.map((x) => [x.id, x]))
  const teams = new Map(groups.map((x) => [x.id, { group: x, members: [] as TeamMember[], children: [] as Team[] }]))
  // `groups` is optional in the protocol's input type (the office always sends it, defaulting to []).
  const firstGroup = (p: Person) => (p.groups ?? []).find((id) => ids.has(id))
  const inCycle = (x: Group) => {
    const seen = new Set<string>()
    for (let p = x.parent; p && ids.has(p) && !seen.has(p); p = ids.get(p)!.parent) {
      if (p === x.id) return true
      seen.add(p)
    }
    return false
  }
  for (const p of [...people].sort(byName))
    for (const id of new Set(p.groups ?? [])) teams.get(id)?.members.push({ person: p, muted: firstGroup(p) !== id })
  const top: Team[] = []
  for (const x of [...groups].sort((a, b) => a.name.localeCompare(b.name))) {
    const team = teams.get(x.id)!
    team.members.sort((a, b) => Number(b.person.handle === x.head) - Number(a.person.handle === x.head))
    if (!x.parent || !ids.has(x.parent) || inCycle(x)) top.push(team)
    else teams.get(x.parent)!.children.push(team)
  }
  return { teams: top, noTeam: people.filter((p) => !firstGroup(p)).sort(byName) }
}

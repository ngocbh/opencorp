import { expect, test } from "bun:test"
import type { Group } from "@opencorp/protocol"
import { byTeam } from "../src/company/teams"
import { person } from "./people"

const g = (id: string, parent: string | null = null, head: string | null = null): Group => ({ id, name: id.toUpperCase(), parent, head })

test("groups nest by parent; members head first; a person in two groups is full in the first and muted elsewhere", () => {
  const people = [person("al", null, { groups: ["eng", "ops"] }), person("bo", null, { groups: ["eng"] }), person("cy", null)]
  const { teams, noTeam } = byTeam(people, [g("eng", null, "bo"), g("ops", "eng")])
  expect(teams.map((t) => t.group.id)).toEqual(["eng"])
  expect(teams[0].members.map((m) => [m.person.handle, m.muted])).toEqual([["bo", false], ["al", false]])
  expect(teams[0].children[0].members.map((m) => [m.person.handle, m.muted])).toEqual([["al", true]])
  expect(noTeam.map((p) => p.handle)).toEqual(["cy"])
})

test("an unknown parent or a parent cycle puts the group at the top level", () => {
  const { teams } = byTeam([], [g("a", "ghost"), g("b", "c"), g("c", "b"), g("d", "b"), g("e", "e")])
  expect(teams.map((t) => t.group.id).sort()).toEqual(["a", "b", "c", "e"])
  expect(teams.find((t) => t.group.id === "b")!.children.map((t) => t.group.id)).toEqual(["d"])
})

test("an unknown group id on a person is ignored, and the first known group is their full one", () => {
  expect(byTeam([person("al", null, { groups: ["nope"] })], []).noTeam.map((p) => p.handle)).toEqual(["al"])
  const { teams } = byTeam([person("al", null, { groups: ["nope", "ops", "ops"] })], [g("ops")])
  expect(teams[0].members.map((m) => [m.person.handle, m.muted])).toEqual([["al", false]])
})

test("people without groups, and no groups at all, are all 'No team'", () => {
  const { groups: _, ...noGroups } = person("bo", null)
  expect(byTeam([person("cy", null), noGroups], [])).toEqual({ teams: [], noTeam: [noGroups, person("cy", null)] })
  expect(byTeam([], [])).toEqual({ teams: [], noTeam: [] })
})

/** Who may change a profile or hire under a manager, and the commit line naming them. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { actorLine, mayEditProfile, mayHireUnder } from "../../src/company/access.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { makeCompany, person } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A person file for `handle` of `kind` reporting to `manager`. */
function someone(handle: string, manager: string | null, kind = "human"): Record<string, unknown> {
  const extra = kind === "agent" ? { main: "../../shared/flows/chat.yaml", harnesses: ["composer"] } : {}
  return { handle, name: handle, kind, title: "R", manager, ...extra }
}

/** The base company (CEO ngocbh, agent minh under ngocbh) plus human bob under the CEO, with `overrides`. */
function repoWith(overrides: Record<string, unknown> = {}) {
  return loadRepo(makeCompany({ "people/bob/person.yaml": someone("bob", "ngocbh"), ...overrides }))
}

test("the CEO may edit any profile, an unknown one included", () => {
  const repo = repoWith()
  expect(mayEditProfile(repo, "ngocbh", "minh")).toBe(true)
  expect(mayEditProfile(repo, "ngocbh", "ngocbh")).toBe(true)
  expect(mayEditProfile(repo, "ngocbh", "ghost")).toBe(true)
})

test("a human outside the chain may edit no profile, their own included", () => {
  const repo = repoWith()
  expect(mayEditProfile(repo, "bob", "minh")).toBe(false)
  expect(mayEditProfile(repo, "bob", "ngocbh")).toBe(false)
  expect(mayEditProfile(repo, "bob", "bob")).toBe(false)
})

test("a human manager may edit their report profile", () => {
  const repo = repoWith({ "people/minh/person.yaml": person("minh", { manager: "bob" }) })
  expect(mayEditProfile(repo, "bob", "minh")).toBe(true)
})

test("the chain passes agents but only a human may edit", () => {
  const repo = repoWith({
    "people/kai/person.yaml": someone("kai", "bob", "agent"),
    "people/minh/person.yaml": person("minh", { manager: "kai" }),
  })
  expect(repo.people.get("kai")?.kind).toBe("agent")
  expect(mayEditProfile(repo, "bob", "minh")).toBe(true)
  expect(mayEditProfile(repo, "kai", "minh")).toBe(false)
})

test("a manager cycle ends the walk", () => {
  const repo = repoWith({
    "people/a/person.yaml": someone("a", "b"),
    "people/b/person.yaml": someone("b", "a"),
  })
  expect(mayEditProfile(repo, "bob", "a")).toBe(false)
  expect(mayEditProfile(repo, "b", "a")).toBe(true)
})

test("the walk stops at an unknown manager", () => {
  const repo = repoWith({ "people/minh/person.yaml": person("minh", { manager: "ghost" }) })
  expect(mayEditProfile(repo, "bob", "minh")).toBe(false)
  expect(mayEditProfile(repo, "ghost", "minh")).toBe(false)
})

test("a person gone from the repo is the CEO only", () => {
  const repo = repoWith({ "people/minh/person.yaml": null, "people/minh/memory/profile.md": null })
  expect(mayEditProfile(repo, "bob", "minh")).toBe(false)
  expect(mayEditProfile(repo, "ngocbh", "minh")).toBe(true)
})

test("hiring under a manager needs the CEO or a human on its chain", () => {
  let repo = repoWith()
  expect(mayHireUnder(repo, "ngocbh", "minh")).toBe(true)
  expect(mayHireUnder(repo, "ngocbh", "ghost")).toBe(true)
  expect(mayHireUnder(repo, "bob", "bob")).toBe(true)
  expect(mayHireUnder(repo, "bob", "minh")).toBe(false)
  expect(mayHireUnder(repo, "bob", "ngocbh")).toBe(false)
  expect(mayHireUnder(repo, "bob", "ghost")).toBe(false)
  repo = repoWith({ "people/minh/person.yaml": person("minh", { manager: "bob" }) })
  expect(mayHireUnder(repo, "bob", "minh")).toBe(true)
})

test("the actor line is one fixed body line for a handle", () => {
  expect(actorLine("bob")).toBe("\n\nActor: @bob")
  expect(() => actorLine("Bad\nX")).toThrow(RangeError)
  expect(() => actorLine("bob\n\nActor: @ceo")).toThrow(RangeError)
})

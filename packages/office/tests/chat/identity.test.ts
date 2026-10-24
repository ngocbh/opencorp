/** Who a person is and who they are talking with, as the inputs their chat flows render. */
import { expect, test } from "bun:test"
import type { Person as PersonSchema } from "@opencorp/protocol"
import type { z } from "zod"
import { personInputs, talkingTo } from "../../src/chat/identity.ts"
import { type CompanyRepo, loadRepo } from "../../src/company/loader.ts"
import { company } from "../company/helpers.ts"

type Person = z.output<typeof PersonSchema>

test("an agent with a manager is named with its company and who it reports to", () => {
  const repo = loadRepo(company())
  expect(personInputs(repo, repo.people.get("minh")!)).toEqual({
    name: "Minh", handle: "minh", title: "Engineer", company: "test-corp",
    reports_to: "You report to Hong Ngoc Bui (@ngocbh).",
  })
})

test("a person without a manager reports to no one", () => {
  const repo = loadRepo(company())
  expect(personInputs(repo, repo.people.get("ngocbh")!).reports_to).toBe("")
})

test("a manager missing from the repo is left out", () => {
  const repo = loadRepo(company())
  const minh = { ...repo.people.get("minh")!, manager: "ghost" }
  expect(personInputs(repo, minh).reports_to).toBe("")
})

test("a repo without a company gives an empty company", () => {
  const repo = { ...loadRepo(company()), company: null }
  expect(personInputs(repo, repo.people.get("minh")!).company).toBe("")
})

/** A human in `repo` with `manager`, as `people/<handle>/person.yaml` would load. */
function human(repo: CompanyRepo, handle: string, name: string, manager: string | null): Person {
  return { ...repo.people.get("ngocbh")!, handle, name, title: "Designer", manager }
}

function withPeople(repo: CompanyRepo, ...people: Person[]): CompanyRepo {
  return { ...repo, people: new Map([...repo.people, ...people.map((p) => [p.handle, p] as const)]) }
}

test("the ceo who is also the manager is both", () => {
  const repo = loadRepo(company())
  const expected = "You're talking with Hong Ngoc Bui (@ngocbh), the CEO and your manager."
  expect(talkingTo(repo, repo.people.get("minh")!, "ngocbh")).toBe(expected)
  // A session that doesn't say falls back to the CEO.
  expect(talkingTo(repo, repo.people.get("minh")!, null)).toBe(expected)
})

test("a manager a direct report a peer and someone else", () => {
  let repo = loadRepo(company())
  repo = withPeople(repo, human(repo, "lan", "Lan", "ngocbh"), human(repo, "kai", "Kai", "minh"),
    human(repo, "ava", "Ava", "lan"))
  const minh = repo.people.get("minh")!
  expect(talkingTo(repo, minh, "lan")).toBe("You're talking with Lan (@lan), your peer.")
  expect(talkingTo(repo, minh, "kai")).toBe("You're talking with Kai (@kai), your direct report.")
  expect(talkingTo(repo, minh, "ava")).toBe("You're talking with Ava (@ava).")
  const reportsToLan = { ...minh, manager: "lan" }
  expect(talkingTo(repo, reportsToLan, "lan")).toBe("You're talking with Lan (@lan), your manager.")
  expect(talkingTo(repo, reportsToLan, "ngocbh")).toBe("You're talking with Hong Ngoc Bui (@ngocbh), the CEO.")
})

test("no one known or the person themselves gives no line", () => {
  const repo = loadRepo(company())
  const minh = repo.people.get("minh")!
  expect(talkingTo(repo, minh, "ghost")).toBe("")
  expect(talkingTo(repo, minh, "minh")).toBe("")
  expect(talkingTo({ ...repo, company: null }, minh, null)).toBe("")
})

test("two people without a manager are not peers", () => {
  let repo = loadRepo(company())
  repo = withPeople(repo, human(repo, "solo", "Solo", null))
  const minh = { ...repo.people.get("minh")!, manager: null }
  expect(talkingTo(repo, minh, "solo")).toBe("You're talking with Solo (@solo).")
})

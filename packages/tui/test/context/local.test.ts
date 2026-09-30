import type { Person, Session } from "@agent-corp/protocol"
import { expect, test } from "bun:test"
import { pickPerson } from "../../src/context/local"

const people = [
  { id: "p-ngocbh", handle: "ngocbh", kind: "human" },
  { id: "p-minh", handle: "minh", kind: "agent" },
  { id: "p-lan", handle: "lan", kind: "agent" },
] as Person[]

test("--person wins, by id or handle", () => {
  expect(pickPerson({ arg: "lan", people, folderPeople: [], sessions: [] })).toBe("p-lan")
  expect(pickPerson({ arg: "p-ngocbh", people, folderPeople: [], sessions: [] })).toBe("p-ngocbh")
})

test("then the newest main session's person in this folder, then folder people, then the first agent", () => {
  const sessions = [
    { person: "p-minh", kind: "side", cwd: "/tmp/proj" },
    { person: "p-ngocbh", kind: "main", cwd: "/tmp/proj" },
    { person: "p-minh", kind: "main", cwd: "/tmp/other" },
  ] as Session[]
  expect(pickPerson({ people, folderPeople: [people[2]], sessions, cwd: "/tmp/proj" })).toBe("p-ngocbh")
  expect(pickPerson({ people, folderPeople: [people[2]], sessions: [], cwd: "/tmp/proj" })).toBe("p-lan")
  expect(pickPerson({ people, folderPeople: [], sessions: [] })).toBe("p-minh")
})

test("an unknown --person falls through; with no agents the first person is picked", () => {
  expect(pickPerson({ arg: "zed", people, folderPeople: [], sessions: [] })).toBe("p-minh")
  expect(pickPerson({ people: [people[0]], folderPeople: [], sessions: [] })).toBe("p-ngocbh")
  expect(pickPerson({ people: [], folderPeople: [], sessions: [] })).toBeUndefined()
})

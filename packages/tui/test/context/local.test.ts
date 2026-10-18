import type { Person, Session } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createHarnessPick, pickPerson } from "../../src/context/local"

const people = [
  { handle: "ngocbh", kind: "human" },
  { handle: "minh", kind: "agent" },
  { handle: "lan", kind: "agent" },
] as Person[]

test("--person wins, by handle with or without the @", () => {
  expect(pickPerson({ arg: "lan", people, folderPeople: [], sessions: [] })).toBe("lan")
  expect(pickPerson({ arg: "@ngocbh", people, folderPeople: [], sessions: [] })).toBe("ngocbh")
})

test("then the newest main session's person in this folder, then folder people, then the first agent", () => {
  const sessions = [
    { person: "minh", kind: "side", cwd: "/tmp/proj" },
    { person: "ngocbh", kind: "main", cwd: "/tmp/proj" },
    { person: "minh", kind: "main", cwd: "/tmp/other" },
  ] as Session[]
  expect(pickPerson({ people, folderPeople: [people[2]], sessions, cwd: "/tmp/proj" })).toBe("ngocbh")
  expect(pickPerson({ people, folderPeople: [people[2]], sessions: [], cwd: "/tmp/proj" })).toBe("lan")
  expect(pickPerson({ people, folderPeople: [], sessions: [] })).toBe("minh")
})

test("an unknown --person falls through; with no agents the first person is picked", () => {
  expect(pickPerson({ arg: "zed", people, folderPeople: [], sessions: [] })).toBe("minh")
  expect(pickPerson({ people: [people[0]], folderPeople: [], sessions: [] })).toBe("ngocbh")
  expect(pickPerson({ people: [], folderPeople: [], sessions: [] })).toBeUndefined()
})

test("a harness pick holds for the person it names; anyone else starts on their first harness", () => {
  const minh = { handle: "minh", kind: "agent", harnesses: ["composer", "codex"] } as Person
  const lan = { handle: "lan", kind: "agent", harnesses: ["composer", "codex"] } as Person
  const [current, setCurrent] = createSignal<Person | undefined>(minh)
  const harness = createHarnessPick(current)
  expect(harness.current()).toBe("composer")
  harness.set("minh", "codex")
  expect(harness.current()).toBe("codex")
  setCurrent(lan)
  expect(harness.current()).toBe("composer")
  setCurrent(minh)
  expect(harness.current()).toBe("codex")
  harness.set("minh", "composer")
  // A pick for someone else (the switch to them was refused) is no pick for the current person.
  harness.set("ghost", "codex")
  expect(harness.current()).toBe("composer")
  setCurrent(undefined)
  expect(harness.current()).toBe("composer")
})

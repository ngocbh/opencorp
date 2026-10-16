import { expect, test } from "bun:test"
import type { Person, Session } from "@agent-corp/protocol"
import path from "node:path"
import { HANDLE, blocks, confirmRequest, harnessesOf, hireRequest, pickerRows } from "../../../src/routes/picker/people"

const person = (handle: string, kind: Person["kind"] = "agent"): Person => ({
  handle,
  name: handle.toUpperCase(),
  kind,
  title: "T",
  manager: null,
})
const main = (p: string, kind: Session["kind"] = "main") => ({ person: p, kind }) as Session
const people = [person("zed"), person("minh"), person("lan"), person("ava"), person("ngocbh", "human")]

test("folder people first, then recent main sessions, then everyone else; each agent once", () => {
  const rows = pickerRows({
    people,
    folderPeople: [person("lan")],
    sessions: [main("minh"), main("lan"), main("zed", "side"), main("ngocbh"), main("gone")],
  })
  expect(rows.map((r) => `${r.group}:${r.person.handle}`)).toEqual([
    "This folder:lan",
    "Recent:minh",
    "Everyone:ava",
    "Everyone:zed",
  ])
})

test("an empty office offers nobody", () => {
  expect(pickerRows({ people: [], folderPeople: [], sessions: [] })).toEqual([])
})

const form = { name: " Lan ", handle: "@lan", title: "QA", manager: "@ngocbh" }

test("the form becomes a preview request; the manager is named by handle, with or without the @", () => {
  expect(hireRequest(form, people)).toEqual({
    request: { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh", confirm: false },
  })
  expect(hireRequest({ ...form, manager: "minh" }, people)).toMatchObject({ request: { manager: "minh" } })
})

test("the form says what to fix", () => {
  expect(hireRequest({ ...form, name: " " }, people)).toEqual({ error: "Name is required" })
  expect(hireRequest({ ...form, handle: "Lan" }, people)).toMatchObject({ error: expect.stringContaining("Handle") })
  expect(hireRequest({ ...form, title: "" }, people)).toEqual({ error: "Title is required" })
  expect(hireRequest({ ...form, manager: "kai" }, people)).toEqual({ error: "No such person: @kai" })
  expect(hireRequest({ ...form, manager: " @ " }, people)).toEqual({ error: "Manager is required" })
})

test("errors block a hire, warnings don't; severity defaults to error", () => {
  expect(blocks([])).toBe(false)
  expect(blocks([{ path: "p", code: "person.no_profile", message: "m", severity: "warning" }])).toBe(false)
  expect(blocks([{ path: "p", code: "person.duplicate_handle", message: "m" }])).toBe(true)
})

test("confirm resends the previewed fields, with no id", () => {
  const previewed = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh", confirm: false }
  expect(confirmRequest(previewed)).toEqual({ ...previewed, confirm: true })
})

test("HANDLE matches the protocol schema's Handle pattern", async () => {
  const schema = await Bun.file(path.join(import.meta.dir, "../../../../protocol/schema/protocol.schema.json")).json()
  expect(HANDLE.source).toBe(schema.$defs.Handle.pattern)
})

test("a person's harnesses: the list, else composer; only those the TUI can open", () => {
  expect(harnessesOf({ ...person("minh"), harnesses: ["composer", "codex"] })).toEqual(["composer", "codex"])
  expect(harnessesOf(person("lan"))).toEqual(["composer"])
  expect(harnessesOf({ ...person("kai"), harnesses: ["codex", "claude"] })).toEqual(["codex"])
})

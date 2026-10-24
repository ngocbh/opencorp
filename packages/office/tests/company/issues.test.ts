/** Repo issues, and company files read as YAML into issues instead of exceptions. */
import { expect, test } from "bun:test"
import { Group, Person, RepoIssue } from "@opencorp/protocol"
import { parseFile, repoIssue, type RepoIssue as Issue } from "../../src/company/issues.ts"

const bytes = (text: string) => new TextEncoder().encode(text)
const PATH = "people/minh/person.yaml"
const PERSON = "handle: minh\nname: Minh\nkind: human\ntitle: Engineer\nmanager: null\n"

/** `text` parsed as a person file, with the issues it gave. */
function parse(text: string | Uint8Array) {
  const issues: Issue[] = []
  const data = typeof text === "string" ? bytes(text) : text
  const value = parseFile(PATH, data, Person, issues)
  return { value, issues }
}

test("a repo issue defaults to an error", () => {
  const issue = repoIssue("company.yaml", "repo.unreadable", "company.yaml is missing")
  expect(issue).toEqual({
    path: "company.yaml",
    code: "repo.unreadable",
    message: "company.yaml is missing",
    severity: "error",
  })
  expect(RepoIssue.parse(issue)).toEqual(issue)
  expect(repoIssue("a.yaml", "x", "y", "warning").severity).toBe("warning")
})

test("a valid file parses with defaults filled", () => {
  const { value, issues } = parse(PERSON)
  expect(issues).toEqual([])
  expect(value?.handle).toBe("minh")
  expect(value?.groups).toEqual([])
  expect(value?.password_hash).toBeNull()
  const groupIssues: Issue[] = []
  const group = parseFile("groups/eng.yaml", bytes("id: eng\nname: Engineering\n"), Group, groupIssues)
  expect(groupIssues).toEqual([])
  expect(group).toEqual({ id: "eng", name: "Engineering", parent: null, head: null })
})

test("a schema error names the field and never the value", () => {
  const kind = parse(PERSON.replace("kind: human", "kind: robot"))
  expect(kind.value).toBeNull()
  expect(kind.issues).toHaveLength(1)
  expect(kind.issues[0]).toMatchObject({ path: PATH, code: "repo.schema", severity: "error" })
  expect(kind.issues[0]!.message).toContain("kind")
  expect(kind.issues[0]!.message).not.toContain("robot")

  const extra = parse(PERSON + "hunter2: x\n")
  expect(extra.value).toBeNull()
  expect(extra.issues[0]!.code).toBe("repo.schema")
  expect(extra.issues[0]!.message).not.toContain("hunter2")

  const hash = parse(PERSON + "password_hash: $SCRYPT$leak\n")
  expect(hash.value).toBeNull()
  expect(hash.issues[0]!.message).toContain("password_hash")
  expect(hash.issues[0]!.message).not.toContain("SCRYPT")
  expect(hash.issues[0]!.message).not.toContain("leak")
})

test("malformed yaml is unreadable with its line only", () => {
  const { value, issues } = parse("handle: x\nname: [unclosed\nkind: human\n")
  expect(value).toBeNull()
  expect(issues).toEqual([repoIssue(PATH, "repo.unreadable", "isn't valid YAML (line 3)")])
})

test("an undefined alias is unreadable", () => {
  const { value, issues } = parse("a: *nope\n")
  expect(value).toBeNull()
  expect(issues).toHaveLength(1)
  expect(issues[0]!.code).toBe("repo.unreadable")
  expect(issues[0]!.message).not.toContain("nope")
})

test("a non utf8 file is unreadable", () => {
  const { value, issues } = parse(new Uint8Array([...bytes("id: "), 0xff, 0xfe]))
  expect(value).toBeNull()
  expect(issues).toEqual([repoIssue(PATH, "repo.unreadable", "isn't valid UTF-8")])
})

test("a deeply nested file is unreadable", () => {
  for (const text of ["[".repeat(100_000), "- ".repeat(7_000) + "x\n- y\n", "? ".repeat(10_000) + "x\n: y\n"]) {
    const { value, issues } = parse(text)
    expect(value).toBeNull()
    expect(issues).toEqual([repoIssue(PATH, "repo.unreadable", "is nested too deeply to read")])
  }
})

test("a file that isnt a mapping is a schema issue", () => {
  for (const text of ["", "- a\n- b\n", "just text\n"]) {
    const { value, issues } = parse(text)
    expect(value).toBeNull()
    expect(issues).toEqual([repoIssue(PATH, "repo.schema", "file: isn't a mapping")])
  }
})

test("yes stays text in a company file", () => {
  const { value, issues } = parse(PERSON.replace("title: Engineer", "title: yes"))
  expect(issues).toEqual([])
  expect(value?.title).toBe("yes")
})

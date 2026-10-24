/** Repo issues, and company files read as YAML into issues instead of exceptions. */
import { expect, test } from "bun:test"
import { Asset, Company, Group, Person, RepoIssue as RepoIssueSchema } from "@opencorp/protocol"
import { parseFile, type RepoIssue, repoIssue } from "../../src/company/issues.ts"

const bytes = (text: string) => new TextEncoder().encode(text)
const PATH = "people/minh/person.yaml"
const PERSON = "handle: minh\nname: Minh\nkind: human\ntitle: Engineer\nmanager: null\n"

/** `text` parsed as a person file, with the issues it gave. */
function parse(text: string | Uint8Array) {
  const issues: RepoIssue[] = []
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
  expect(RepoIssueSchema.parse(issue)).toEqual(issue)
  expect(repoIssue("a.yaml", "x", "y", "warning").severity).toBe("warning")
})

test("a valid file parses with defaults filled", () => {
  const { value, issues } = parse(PERSON)
  expect(issues).toEqual([])
  expect(value?.handle).toBe("minh")
  expect(value?.groups).toEqual([])
  expect(value?.password_hash).toBeNull()
  const groupIssues: RepoIssue[] = []
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
  expect(extra.issues[0]!.message).toBe("an extra field: isn't allowed")
  expect(extra.issues[0]!.message).not.toContain("hunter2")

  // Uppercase because a lowercase `$scrypt$...` is a valid PasswordHash and would raise no issue.
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

const ASSET_PATH = "assets/a.yaml"

/** An asset file whose one grant has `where` written as the YAML text `where`, parsed with its issues. */
function parseAsset(where: string) {
  const issues: RepoIssue[] = []
  const text = `id: a\nkind: k\ntools: {x: {}}\ngrants:\n  - {who: minh, can: [x], where: ${where}}\n`
  const value = parseFile(ASSET_PATH, bytes(text), Asset, issues)
  return { value, issues }
}

test("a proto key at any depth is a schema issue", () => {
  const people: [string, string][] = [
    [PERSON + "__proto__: hunter2\n", "file: has a key named __proto__"],
    [PERSON.replace("title: Engineer", "title: {__proto__: hunter2}"), "title: has a key named __proto__"],
    [PERSON + "groups:\n  - {a: [{__proto__: 1}]}\n", "groups: has a key named __proto__"],
  ]
  for (const [text, message] of people) {
    const { value, issues } = parse(text)
    expect(value).toBeNull()
    expect(issues).toEqual([repoIssue(PATH, "repo.schema", message)])
  }
  const wheres = [
    "{__proto__: [hunter2]}",
    '{"__proto__": [x]}',
    String.raw`{"\x5f_proto__": [x]}`,
    "{!!str __proto__: [x]}",
    "{a: [&k __proto__], *k : [x]}",
    "{<<: {__proto__: [x]}}",
  ]
  for (const where of wheres) {
    const { value, issues } = parseAsset(where)
    expect(value).toBeNull()
    expect(issues).toEqual([repoIssue(ASSET_PATH, "repo.schema", "grants: has a key named __proto__")])
  }
  const groupIssues: RepoIssue[] = []
  expect(parseFile("groups/eng.yaml", bytes("id: eng\nname: {__proto__: x}\n"), Group, groupIssues)).toBeNull()
  expect(groupIssues).toEqual([repoIssue("groups/eng.yaml", "repo.schema", "name: has a key named __proto__")])
  const companyIssues: RepoIssue[] = []
  const company = bytes("name: Acme\nceo: minh\ndefaults: {__proto__: {}}\n")
  expect(parseFile("company.yaml", company, Company, companyIssues)).toBeNull()
  expect(companyIssues).toEqual([repoIssue("company.yaml", "repo.schema", "defaults: has a key named __proto__")])
})

test("an integer outside the safe range is a schema issue", () => {
  const people: [string, string][] = [
    [PERSON.replace("title: Engineer", "title: 9007199254740993"), "title: has an integer too large to read exactly"],
    [PERSON + "extra: 9007199254740993\n", "an extra field: has an integer too large to read exactly"],
    [PERSON + "constructor: 9007199254740993\n", "an extra field: has an integer too large to read exactly"],
  ]
  for (const [text, message] of people) {
    const { value, issues } = parse(text)
    expect(value).toBeNull()
    expect(issues).toEqual([repoIssue(PATH, "repo.schema", message)])
  }
  const wheres = [
    "{nodes: [9007199254740993]}",
    "{nodes: [-9007199254740993]}",
    "{nodes: [0x20000000000001]}",
    "{nodes: [!!int 9007199254740993]}",
    "{nodes: [0o400000000000000001]}",
    "{nodes: [9007199254740992]}",
    "{a: [&n 9007199254740993], b: [*n]}",
  ]
  for (const where of wheres) {
    const { value, issues } = parseAsset(where)
    expect(value).toBeNull()
    expect(issues).toEqual([
      repoIssue(ASSET_PATH, "repo.schema", "grants: has an integer too large to read exactly"),
    ])
  }
})

test("one issue names the first problem only", () => {
  const { value, issues } = parse(PERSON.replace("title: Engineer", "title: 9007199254740993") + "__proto__: x\n")
  expect(value).toBeNull()
  expect(issues).toEqual([repoIssue(PATH, "repo.schema", "title: has an integer too large to read exactly")])
})

test("safe integers and ordinary keys are unaffected", () => {
  const { value, issues } = parseAsset(
    "{nodes: [9007199254740991, -9007199254740991, 9007199254740993.0], constructor: [1], prototype: [2]}",
  )
  expect(issues).toEqual([])
  const where = value!.grants[0]!.where!
  expect(Object.keys(where)).toEqual(["nodes", "constructor", "prototype"])
  expect(where.nodes!.every((n) => typeof n === "number")).toBe(true)
})

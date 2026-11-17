/** The rules files in the company repo: each agent's `people/<handle>/rules.yaml` and the company's `rules.yaml`,
 *  read at HEAD with their source; the office commits an agent's and never the company's. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import { CompanyGit } from "../../src/company/git.ts"
import { lint } from "../../src/company/lint.ts"
import { loadRepo } from "../../src/company/loader.ts"
import {
  addRules, COMPANY_RULES, readRules, removeRule, RulesRefused, rulesPath,
} from "../../src/company/rules.ts"
import { tempDir } from "../helpers.ts"
import { git, makeCompany } from "./helpers.ts"

setDefaultTimeout(30_000)

const AT = "2026-11-20T10:00:00.000Z"
const MINH = rulesPath("minh")

/** A company with `files` on top of the base ones, and a `CompanyGit` on it. */
function setup(files: Record<string, unknown> = {}) {
  const dir = tempDir()
  const root = makeCompany(files, dir)
  return { root, g: new CompanyGit(root, path.join(dir, "worktrees")) }
}

/** A rules file's YAML holding `rules`. */
const file = (...rules: Record<string, unknown>[]) => stringify({ rules })
const subject = (root: string) => git(root, "log", "-1", "--format=%s")
const body = (root: string) => git(root, "log", "-1", "--format=%b")
const count = (root: string) => Number(git(root, "rev-list", "--count", "HEAD"))
/** `rel` as HEAD holds it. */
const atHead = (root: string, rel: string) => git(root, "show", `HEAD:${rel}`)
const allow = (pattern: string) => ({ effect: "allow", kind: "command", pattern }) as const

test("a person's rules file and the company's read as rules with their source, and a missing one as none", async () => {
  const { g } = setup({
    [COMPANY_RULES]: file({ effect: "deny", kind: "command", pattern: "rm -rf *" }),
    [MINH]: file(
      { effect: "allow", kind: "command", pattern: "git status *", by: "ngocbh", at: AT },
      // A hand-written time may leave out the milliseconds.
      { effect: "ask", kind: "input", pattern: "y", at: "2026-11-20T10:00:00Z" },
    ),
  })
  expect(await readRules(g, "minh")).toEqual({
    rules: [
      { effect: "allow", kind: "command", pattern: "git status *", source: "agent", by: "ngocbh", at: AT },
      { effect: "ask", kind: "input", pattern: "y", source: "agent", by: null, at: AT },
      { effect: "deny", kind: "command", pattern: "rm -rf *", source: "company", by: null, at: null },
    ],
    errors: [],
  })
  // The CEO has no rules file: only the company's rules apply.
  expect(await readRules(g, "ngocbh")).toEqual({
    rules: [{ effect: "deny", kind: "command", pattern: "rm -rf *", source: "company", by: null, at: null }],
    errors: [],
  })
})

test("a missing rules file reads as no rules and no error", async () => {
  const { g } = setup()
  expect(await readRules(g, "minh")).toEqual({ rules: [], errors: [] })
  // An empty file, or one with only comments or an empty list, holds no rules either.
  const { g: empty } = setup({ [COMPANY_RULES]: "# none yet\n", [MINH]: "rules:\n" })
  expect(await readRules(empty, "minh")).toEqual({ rules: [], errors: [] })
})

test("adding rules commits the agent's file with who added them", async () => {
  const { root, g } = setup()
  const before = count(root)
  await addRules(g, "minh", [allow("git status *")], "ngocbh")
  expect(count(root)).toBe(before + 1)
  expect(subject(root)).toBe('Rules: allow "git status *" for @minh (from @ngocbh\'s approval)')
  expect(body(root)).toBe("Actor: @ngocbh")
  expect(atHead(root, MINH)).toStartWith("# @minh's rules")
  const [saved] = (await readRules(g, "minh")).rules
  expect(saved).toMatchObject({ ...allow("git status *"), source: "agent", by: "ngocbh" })
  expect(saved!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  // A rule the file has is not added again; a new one joins it, with the ones before kept.
  await addRules(g, "minh", [allow("git status *")], "ngocbh")
  expect(count(root)).toBe(before + 1)
  await addRules(g, "minh", [allow("git status *"), allow("make *"), allow("ls *")], "ngocbh")
  expect(subject(root)).toBe('Rules: allow "make *", "ls *" for @minh (from @ngocbh\'s approval)')
  expect((await readRules(g, "minh")).rules.map((r) => r.pattern)).toEqual(["git status *", "make *", "ls *"])
  expect(git(root, "status", "--porcelain")).toBe("")
})

test("removing a rule commits the agent's file without it", async () => {
  const { root, g } = setup({
    [MINH]: file({ ...allow("git status *"), by: "ngocbh", at: AT }, { effect: "deny", kind: "command", pattern: "rm *" }),
  })
  const before = count(root)
  expect(await removeRule(g, "minh", { ...allow("git status *"), source: "agent" }, "ngocbh")).toBe(true)
  expect(count(root)).toBe(before + 1)
  expect(subject(root)).toBe('Rules: remove allow "git status *" for @minh (by @ngocbh)')
  expect(body(root)).toBe("Actor: @ngocbh")
  expect((await readRules(g, "minh")).rules).toEqual([
    { effect: "deny", kind: "command", pattern: "rm *", source: "agent", by: null, at: null },
  ])
  // A rule the file doesn't hold, with another effect or kind too, removes nothing and commits nothing.
  expect(await removeRule(g, "minh", { ...allow("git status *"), source: "agent" }, "ngocbh")).toBe(false)
  expect(await removeRule(g, "minh", { ...allow("rm *"), source: "agent" }, "ngocbh")).toBe(false)
  expect(await removeRule(g, "minh", { effect: "deny", kind: "input", pattern: "rm *", source: "agent" }, "ngocbh"))
    .toBe(false)
  expect(count(root)).toBe(before + 1)
})

test("the office never writes the company's rules file", async () => {
  const { root, g } = setup({ [COMPANY_RULES]: file({ effect: "deny", kind: "command", pattern: "rm *" }) })
  const company = atHead(root, COMPANY_RULES)
  await addRules(g, "minh", [allow("make *")], "ngocbh")
  const removing = removeRule(g, "minh", { effect: "deny", kind: "command", pattern: "rm *", source: "company" }, "ngocbh")
  const refused = await removing.catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(RulesRefused)
  expect([(refused as RulesRefused).code, (refused as RulesRefused).message]).toEqual([
    "company_rule", "company rules change only by editing rules.yaml in the company repo",
  ])
  expect(atHead(root, COMPANY_RULES)).toBe(company)
  expect(git(root, "log", "--format=%s", "--", COMPANY_RULES)).toBe("init")
  expect((await readRules(g, "minh")).rules.map((r) => [r.source, r.pattern])).toEqual([
    ["agent", "make *"],
    ["company", "rm *"],
  ])
})

test("a malformed rules file reads as an error naming the file and lint's message, and the other file still reads", async () => {
  const { root, g } = setup({
    [COMPANY_RULES]: "rules: [\n",
    [MINH]: file({ effect: "allow", kind: "command", pattern: "ls *" }),
    "people/ngocbh/rules.yaml": file({ effect: "maybe", kind: "command", pattern: "ls *" }),
  })
  const linted = new Map((await lint(loadRepo(root))).map((issue) => [issue.path, issue.message]))
  expect(await readRules(g, "minh")).toEqual({
    rules: [{ effect: "allow", kind: "command", pattern: "ls *", source: "agent", by: null, at: null }],
    errors: [{ source: "company", path: COMPANY_RULES, message: linted.get(COMPANY_RULES)! }],
  })
  expect(linted.get(COMPANY_RULES)).toBe("isn't valid YAML (line 2)")
  expect(await readRules(g, "ngocbh")).toEqual({
    rules: [],
    errors: [
      { source: "agent", path: "people/ngocbh/rules.yaml", message: "rule 1: effect: isn't an allowed value" },
      { source: "company", path: COMPANY_RULES, message: "isn't valid YAML (line 2)" },
    ],
  })
  expect(linted.get("people/ngocbh/rules.yaml")).toBe("rule 1: effect: isn't an allowed value")
  // A folder where a file should be can't be read as one.
  fs.rmSync(path.join(root, COMPANY_RULES))
  fs.mkdirSync(path.join(root, COMPANY_RULES))
  fs.writeFileSync(path.join(root, COMPANY_RULES, "x"), "")
  git(root, "add", "-A")
  git(root, "commit", "-qm", "a folder")
  expect((await readRules(g, "minh")).errors).toEqual([
    { source: "company", path: COMPANY_RULES, message: "can't be read as a file" },
  ])
})

test("adding a rule to an agent's file that doesn't load is refused", async () => {
  const { root, g } = setup({ [MINH]: "rules:\n  - effect: allow\n    kind: command\n" })
  const before = atHead(root, MINH)
  const refused = await addRules(g, "minh", [allow("ls *")], "ngocbh").catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(RulesRefused)
  expect((refused as RulesRefused).message).toBe("fix people/minh/rules.yaml first")
  expect(atHead(root, MINH)).toBe(before)
  expect(fs.readFileSync(path.join(root, MINH), "utf8")).toBe(`${before}\n`)
})

test("adding rules to an agent's file with changes nobody committed is refused, and the changes stay", async () => {
  const { root, g } = setup({ [MINH]: file(allow("ls *")) })
  const edited = file(allow("ls *"), allow("*"))
  fs.writeFileSync(path.join(root, MINH), edited)
  const refused = await addRules(g, "minh", [allow("make *")], "ngocbh").catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(RulesRefused)
  expect((refused as RulesRefused).message).toBe(
    "people/minh/rules.yaml has changes nobody committed; commit or discard them first",
  )
  expect(fs.readFileSync(path.join(root, MINH), "utf8")).toBe(edited)
  expect(subject(root)).toBe("init")
})

test.each([
  ["the company's", COMPANY_RULES],
  ["an agent's", MINH],
])("a rules file edited in the clone but not committed adds no rule [%s]", async (_which, rel) => {
  // One that HEAD doesn't have, and one HEAD has with a rule more in the clone.
  const { root, g } = setup()
  fs.writeFileSync(path.join(root, rel), file(allow("*")))
  expect(await readRules(g, "minh")).toEqual({ rules: [], errors: [] })
  const committed = setup({ [rel]: file(allow("ls *")) })
  fs.writeFileSync(path.join(committed.root, rel), file(allow("ls *"), allow("*")))
  expect((await readRules(committed.g, "minh")).rules.map((r) => r.pattern)).toEqual(["ls *"])
  // A clone file that doesn't load blocks nothing either: HEAD's loads.
  fs.writeFileSync(path.join(committed.root, rel), "rules: [\n")
  expect((await readRules(committed.g, "minh")).errors).toEqual([])
})

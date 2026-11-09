/** The company template and its writer (Python's `tests/company_template/test_writer.py`). */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, setDefaultTimeout, test } from "bun:test"
import { HireRequest } from "@opencorp/protocol"
import { Hiring } from "../../src/chat/hire.ts"
import { readYaml, writeYaml } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { lint } from "../../src/company/lint.ts"
import { loadRepo } from "../../src/company/loader.ts"
import {
  type CompanyState,
  companyState,
  type Damage,
  missingFiles,
  type Owner,
  templateFiles,
  writeCompany,
} from "../../src/company_template/index.ts"
import { git } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"

setDefaultTimeout(30_000)

const TEMPLATE = fileURLToPath(new URL("../../src/company_template/template/", import.meta.url))
const OWNER: Owner = { handle: "ngocbh", name: "Hong Ngoc Bui" }
const PACKAGED_FLOWS = fs
  .readdirSync(path.join(TEMPLATE, "shared", "flows"))
  .filter((name) => name.endsWith(".yaml"))
  .sort()
  .map((name) => `shared/flows/${name}`)
const MANAGER_FLOW = "shared/flows/profile_manager.yaml"

/** Commits every tracked change in `root` with `message`. */
function commitAll(root: string, message: string): void {
  git(root, "commit", "-qam", message)
}

/** A company folder and a worktrees folder in a fresh temp dir. */
function dirs(): { tmp: string; root: string; worktrees: string } {
  const tmp = tempDir()
  return { tmp, root: path.join(tmp, "company"), worktrees: path.join(tmp, "worktrees") }
}

/** The text of `file`, as UTF-8. */
function read(file: string): string {
  return fs.readFileSync(file, "utf8")
}

test("a new company has the owner as ceo and lints clean", async () => {
  const { root, worktrees } = dirs()
  const written = await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  for (const rel of ["company.yaml", "people/ngocbh/person.yaml", "shared/flows/chat.yaml"]) {
    expect(written).toContain(rel)
  }
  const repo = loadRepo(root)
  expect([repo.company?.name, repo.company?.ceo]).toEqual(["Acme", "ngocbh"])
  const owner = repo.people.get("ngocbh")
  expect([owner?.kind, owner?.title, owner?.manager]).toEqual(["human", "CEO", null])
  expect(repo.errors).toEqual([])
  expect(await lint(repo)).toEqual([])
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(git(root, "log", "--format=%s").split("\n")).toEqual(["init: create the company"])
})

test("a new company ignores the .yian folders yian keeps in a memory folder, and gets the ignore file back", async () => {
  const { root, worktrees } = dirs()
  expect(await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })).toContain(".gitignore")
  const journal = "people/ngocbh/memory/.yian/journal.jsonl"
  fs.mkdirSync(path.join(root, path.dirname(journal)), { recursive: true })
  fs.writeFileSync(path.join(root, journal), "{}\n")
  expect(git(root, "check-ignore", journal)).toBe(journal)
  expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("")
  fs.unlinkSync(path.join(root, ".gitignore"))
  commitAll(root, "drop the ignore file")
  expect(missingFiles(root)).toEqual([".gitignore"])
  expect(await writeCompany(root, worktrees)).toEqual([".gitignore"])
})

test("the owners devices are in the first commit", async () => {
  const { root, worktrees } = dirs()
  const mac = { name: "mac", token_sha256: "ab".repeat(32) }
  const owner = { handle: "ngocbh", name: "Hong Ngoc Bui", devices: [mac] }
  await writeCompany(root, worktrees, { company: "Acme", owner })
  expect(loadRepo(root).people.get("ngocbh")?.devices).toEqual([mac])
  const first = readYaml(git(root, "show", "HEAD:people/ngocbh/person.yaml")) as Record<string, unknown>
  expect(first.devices).toEqual([{ name: "mac", token_sha256: "ab".repeat(32) }])
  expect(await lint(loadRepo(root))).toEqual([])
})

test("extra files go in a new companys first commit only", async () => {
  const { root, worktrees } = dirs()
  const extra = { "people/lan/memory/profile.md": Buffer.from("# Lan, QA\n") }
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER, extra })
  expect(git(root, "show", "HEAD:people/lan/memory/profile.md")).toBe("# Lan, QA")
  expect(git(root, "log", "--format=%s").split("\n")).toEqual(["init: create the company"])
  const later = { "people/mai/memory/profile.md": Buffer.from("x") }
  expect(await writeCompany(root, worktrees, { extra: later })).toEqual([])
  expect(fs.existsSync(path.join(root, "people", "mai"))).toBe(false)
})

test("a new company gets every packaged flow so it can chat", async () => {
  const { root, worktrees } = dirs()
  const written = await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  for (const name of ["chat", "side_chat", "profile_manager"]) {
    expect(PACKAGED_FLOWS).toContain(`shared/flows/${name}.yaml`)
  }
  for (const rel of PACKAGED_FLOWS) expect(written).toContain(rel)
  expect(written).not.toContain("shared/flows/debrief.yaml")
  expect(fs.existsSync(path.join(root, "shared/flows/debrief.yaml"))).toBe(false)
  for (const rel of PACKAGED_FLOWS) expect((await loadConfined(root, path.join(root, rel))).name).toBeTruthy()
})

test("names that need quoting survive", async () => {
  const { tmp, root, worktrees } = dirs()
  const owner = { handle: "an", name: 'An: "the boss" #1' }
  await writeCompany(root, worktrees, { company: "Acme: Inc. #2", owner })
  const repo = loadRepo(root)
  expect([repo.company?.name, repo.people.get("an")?.name]).toEqual(["Acme: Inc. #2", 'An: "the boss" #1'])

  // A value holding a placeholder stays literal, and a C1 control character reads back as itself.
  const other = path.join(tmp, "other")
  await writeCompany(other, worktrees, { company: "Acme\u007f\u0085", owner: { handle: "an", name: "A ${title} $x" } })
  const again = loadRepo(other)
  expect([again.company?.name, again.people.get("an")?.name]).toEqual(["Acme\u007f\u0085", "A ${title} $x"])
})

test("a bad handle is refused before anything is written", async () => {
  const { root, worktrees } = dirs()
  const owner = { handle: "Not A Handle", name: "N" }
  const error = await writeCompany(root, worktrees, { company: "Acme", owner }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RangeError)
  const message = (error as RangeError).message
  expect(message).toContain("people/{owner}/person.yaml")
  expect(message).toContain("handle")
  expect(message).not.toContain("Not A Handle")
  expect(fs.existsSync(root)).toBe(false)
})

test("writing again adds only missing template files", async () => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  const company = path.join(root, "company.yaml")
  fs.writeFileSync(company, read(company).replace("Acme", "Acme Two"))
  commitAll(root, "rename")
  expect(await writeCompany(root, worktrees)).toEqual([]) // no owner needed once company.yaml exists
  expect(git(root, "log", "--format=%s").split("\n")).toEqual(["rename", "init: create the company"])

  fs.unlinkSync(path.join(root, "shared/flows/chat.yaml"))
  commitAll(root, "drop chat")
  expect(await writeCompany(root, worktrees)).toEqual(["shared/flows/chat.yaml"])
  expect(git(root, "log", "-1", "--format=%s")).toBe("onboard: add template files")
  expect(loadRepo(root).company?.name).toBe("Acme Two")
})

test("a company from before the profile manager flow gets it and keeps its edits", async () => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  fs.unlinkSync(path.join(root, MANAGER_FLOW))
  const chat = path.join(root, "shared/flows/chat.yaml")
  fs.writeFileSync(chat, read(chat) + "# the owner's edit\n")
  commitAll(root, "an old company")
  expect(await writeCompany(root, worktrees)).toEqual([MANAGER_FLOW])
  expect(read(chat).endsWith("# the owner's edit\n")).toBe(true)
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(await lint(loadRepo(root))).toEqual([])
})

test("uncommitted edits are neither overwritten nor committed", async () => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  fs.unlinkSync(path.join(root, MANAGER_FLOW))
  commitAll(root, "drop the profile manager")
  const company = path.join(root, "company.yaml")
  fs.writeFileSync(company, read(company) + "# not committed\n")
  expect(await writeCompany(root, worktrees)).toEqual([MANAGER_FLOW])
  expect(git(root, "status", "--porcelain")).toBe("M company.yaml")
})

test("a new company needs an owner", async () => {
  const { root, worktrees } = dirs()
  await expect(writeCompany(root, worktrees)).rejects.toThrow(/owner/)
})

test("template files never include python", () => {
  const files = [...templateFiles("Acme", OWNER).keys()]
  expect(files).toContain("company.yaml")
  expect(files).toContain("people/ngocbh/person.yaml")
  expect(files.filter((p) => /\.(?:py|pyc|ts)$/.test(p) || p.includes("__pycache__"))).toEqual([])
  expect(files.filter((p) => p.includes("{owner}"))).toEqual([])
})

test("the first hire into a new company lints clean", async () => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  const hiring = new Hiring(new CompanyGit(root, worktrees))
  const form = { name: "Minh", handle: "minh", title: "Engineer", manager: "ngocbh" }
  const preview = await hiring.hire(HireRequest.parse({ ...form }), "ngocbh")
  expect(preview.issues).toEqual([])
  await hiring.hire(HireRequest.parse({ ...form, confirm: true }), "ngocbh")
  expect(await lint(loadRepo(root))).toEqual([])
})

test("missing files names what writing again would add", async () => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  expect(missingFiles(root)).toEqual([])
  fs.unlinkSync(path.join(root, MANAGER_FLOW))
  commitAll(root, "drop the profile manager")
  expect(missingFiles(root)).toEqual([MANAGER_FLOW])
  expect(await writeCompany(root, worktrees)).toEqual([MANAGER_FLOW])
})

/** Writes every template file into a new repo at `root` without committing, as a first write that stopped. */
function stoppedBeforeTheCommit(root: string, company: string, owner: Owner): void {
  fs.mkdirSync(root, { recursive: true })
  git(root, "init", "-q", "-b", "main")
  for (const [rel, data] of templateFiles(company, owner)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), data)
  }
}

test("a first write that stopped before the owners file is finished", async () => {
  const { root, worktrees } = dirs()
  fs.mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(root, "company.yaml"), templateFiles("Acme", OWNER).get("company.yaml")!)
  const written = await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  for (const rel of ["company.yaml", "people/ngocbh/person.yaml"]) expect(written).toContain(rel)
  expect(await lint(loadRepo(root))).toEqual([])
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(git(root, "log", "--format=%s").split("\n")).toEqual(["init: create the company"])
})

test("a first write that stopped before its commit is committed", async () => {
  const { root, worktrees } = dirs()
  stoppedBeforeTheCommit(root, "Acme", OWNER)
  // still a new company: nothing is committed yet
  await expect(writeCompany(root, worktrees)).rejects.toThrow(/owner/)
  const written = await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  expect(written).toEqual(["company.yaml", "people/ngocbh/person.yaml"]) // the filled files are rewritten
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(git(root, "log", "--format=%s").split("\n")).toEqual(["init: create the company"])
  expect(git(root, "ls-files").split("\n").sort()).toEqual([...templateFiles("Acme", OWNER).keys()].sort())
})

test("a first write that stopped is finished with the new answers", async () => {
  const { root, worktrees } = dirs()
  stoppedBeforeTheCommit(root, "Acme", { handle: "an", name: "An" })
  await writeCompany(root, worktrees, { company: "Beta", owner: { handle: "bo", name: "Bo" } })
  const committed = readYaml(git(root, "show", "HEAD:company.yaml")) as Record<string, unknown>
  expect([committed.name, committed.ceo]).toEqual(["Beta", "bo"])
  const files = git(root, "ls-files").split("\n")
  expect(files).toContain("people/bo/person.yaml")
  expect(files).not.toContain("people/an/person.yaml")
  expect(fs.existsSync(path.join(root, "people", "an"))).toBe(false) // the stopped run's owner, which it wrote
  expect(await lint(loadRepo(root))).toEqual([])
})

test("finishing a first write leaves other people and files alone", async () => {
  const { root, worktrees } = dirs()
  stoppedBeforeTheCommit(root, "Acme", { handle: "an", name: "An" })
  fs.writeFileSync(path.join(root, "people", "an", "notes.md"), "mine\n")
  fs.mkdirSync(path.join(root, "people", "cy"))
  fs.writeFileSync(
    path.join(root, "people", "cy", "person.yaml"),
    templateFiles("Acme", { handle: "cy", name: "Cy" }).get("people/cy/person.yaml")!,
  )
  await writeCompany(root, worktrees, { company: "Beta", owner: { handle: "bo", name: "Bo" } })
  expect(fs.existsSync(path.join(root, "people", "an", "person.yaml"))).toBe(false)
  expect(read(path.join(root, "people", "an", "notes.md"))).toBe("mine\n")
  expect(fs.existsSync(path.join(root, "people", "cy", "person.yaml"))).toBe(true)
})

const OLD_CEOS = ["../../outside", "people/an", ".", "An", ""]

test.each(OLD_CEOS)("an old ceo that isnt an id removes nothing [%s]", async (ceo) => {
  const { tmp, root, worktrees } = dirs()
  stoppedBeforeTheCommit(root, "Acme", { handle: "an", name: "An" })
  fs.mkdirSync(path.join(tmp, "outside"))
  fs.writeFileSync(path.join(tmp, "outside", "person.yaml"), "keep\n")
  fs.writeFileSync(path.join(root, "company.yaml"), writeYaml({ name: "Acme", ceo }))
  await writeCompany(root, worktrees, { company: "Beta", owner: { handle: "bo", name: "Bo" } })
  expect(fs.existsSync(path.join(root, "people", "an", "person.yaml"))).toBe(true)
  expect(read(path.join(tmp, "outside", "person.yaml"))).toBe("keep\n")
})

test("an old ceos directory that is a symlink is left alone", async () => {
  const { tmp, root, worktrees } = dirs()
  stoppedBeforeTheCommit(root, "Acme", { handle: "an", name: "An" })
  const elsewhere = path.join(tmp, "elsewhere")
  fs.renameSync(path.join(root, "people", "an"), elsewhere)
  fs.symlinkSync(elsewhere, path.join(root, "people", "an"))
  await writeCompany(root, worktrees, { company: "Beta", owner: { handle: "bo", name: "Bo" } })
  expect(fs.existsSync(path.join(elsewhere, "person.yaml"))).toBe(true)
})

test("a committed company keeps its old ceos directory", async () => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: { handle: "an", name: "An" } })
  await writeCompany(root, worktrees)
  expect(fs.existsSync(path.join(root, "people", "an", "person.yaml"))).toBe(true)
})

test("a truncated company yaml from a stopped first write is rewritten", async () => {
  const { root, worktrees } = dirs()
  stoppedBeforeTheCommit(root, "Acme", OWNER)
  fs.writeFileSync(path.join(root, "company.yaml"), 'name: "Ac')
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  const expected = templateFiles("Acme", OWNER).get("company.yaml")!.toString("utf8").trim()
  expect(git(root, "show", "HEAD:company.yaml")).toBe(expected)
  expect(await lint(loadRepo(root))).toEqual([])
  expect(git(root, "status", "--porcelain")).toBe("")
})

test("is absent, then unfinished until the first commit, then ok", async () => {
  const { root, worktrees } = dirs()
  expect(await companyState(root)).toEqual({ kind: "absent" })
  fs.mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(root, "company.yaml"), "name: Acme\n")
  expect(await companyState(root)).toEqual({ kind: "unfinished" })
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  expect(await companyState(root)).toEqual({ kind: "ok" })
})

/** A committed company at `root`, made as init makes it. */
async function committed(root: string): Promise<string> {
  await writeCompany(root, path.join(path.dirname(root), "worktrees"), { company: "Acme", owner: OWNER })
  return root
}

/** A company at `root` whose last commit removed company.yaml. */
async function withoutCompanyYaml(root: string): Promise<string> {
  await committed(root)
  git(root, "rm", "-q", "company.yaml")
  git(root, "commit", "-qm", "drop company.yaml")
  return root
}

/** Files of a company at `root`, but no repo. */
function withoutGit(root: string): string {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  return root
}

// Every row has a reason (null unless damaged): bun takes a callback with more parameters than a row as `done`.
const STATES: [string, (tmp: string, root: string) => Promise<unknown> | unknown, CompanyState["kind"], Damage | null][] = [
  ["missing", () => {}, "absent", null],
  ["an empty dir", (_, root) => fs.mkdirSync(root), "absent", null],
  [
    "under a regular file",
    (tmp) => fs.writeFileSync(path.join(tmp, "file"), ""),
    "absent",
    null,
  ],
  [
    "a repo with no commit",
    (_, root) => {
      fs.mkdirSync(root)
      git(root, "init", "-q", "-b", "main")
    },
    "unfinished",
    null,
  ],
  ["a first write that stopped", (_, root) => stoppedBeforeTheCommit(root, "Acme", OWNER), "unfinished", null],
  ["a company", (_, root) => committed(root), "ok", null],
  [
    "a symlink to a company",
    async (tmp, root) => fs.symlinkSync(await committed(path.join(tmp, "real", "company")), root),
    "ok",
    null,
  ],
  ["a regular file", (_, root) => fs.writeFileSync(root, ""), "damaged", "not-a-directory"],
  ["a dangling symlink", (tmp, root) => fs.symlinkSync(path.join(tmp, "gone"), root), "damaged", "not-a-directory"],
  ["files without a repo", (_, root) => withoutGit(root), "damaged", "no-git"],
  ["an empty .git", (_, root) => fs.mkdirSync(path.join(root, ".git"), { recursive: true }), "damaged", "bad-git"],
  [
    "a NUL-filled branch ref",
    async (_, root) => {
      fs.writeFileSync(path.join(await committed(root), ".git", "refs", "heads", "main"), Buffer.alloc(41))
    },
    "damaged",
    "bad-git",
  ],
  [
    "a deleted branch ref",
    async (_, root) => fs.unlinkSync(path.join(await committed(root), ".git", "refs", "heads", "main")),
    "damaged",
    "bad-git",
  ],
  ["no company.yaml in the last commit", (_, root) => withoutCompanyYaml(root), "damaged", "no-company-yaml"],
  [
    "company.yaml deleted from the folder",
    async (_, root) => fs.unlinkSync(path.join(await committed(root), "company.yaml")),
    "damaged",
    "company-yaml-deleted",
  ],
]

test.each(STATES)("the state of %s", async (_, make, kind, reason) => {
  const tmp = tempDir()
  const root = _ === "under a regular file" ? path.join(tmp, "file", "company") : path.join(tmp, "company")
  await make(tmp, root)
  const state = await companyState(root)
  expect(state.kind).toBe(kind)
  if (state.kind === "damaged") {
    expect(state.reason).toBe(reason!)
    expect(state.detail).toContain(root)
  }
})

test("an empty .git inside another repo is damaged, not the outer repo", async () => {
  const tmp = tempDir()
  const outer = await committed(path.join(tmp, "outer"))
  const root = path.join(outer, "company")
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  const state = await companyState(root)
  expect(state.kind === "damaged" && state.reason).toBe("bad-git")
})

test.skipIf(process.geteuid!() === 0)("a company that cant be looked at is damaged", async () => {
  const tmp = tempDir()
  const parent = path.join(tmp, "locked")
  fs.mkdirSync(parent)
  const root = path.join(parent, "company")
  await committed(root)
  fs.chmodSync(parent, 0)
  try {
    const state = await companyState(root)
    expect(state.kind === "damaged" && state.reason).toBe("unreadable")
  } finally {
    fs.chmodSync(parent, 0o700)
  }
})

test("writing refuses a damaged company and changes nothing", async () => {
  const tmp = tempDir()
  const repo = await withoutCompanyYaml(path.join(tmp, "a", "company"))
  const log = git(repo, "log", "--format=%H")
  const status = git(repo, "status", "--porcelain")
  await expect(writeCompany(repo, path.join(tmp, "wt"), { company: "Acme", owner: OWNER })).rejects.toThrow(
    RangeError,
  )
  expect(git(repo, "log", "--format=%H")).toBe(log)
  expect(git(repo, "status", "--porcelain")).toBe(status)
  const bare = withoutGit(path.join(tmp, "b", "company"))
  await expect(writeCompany(bare, path.join(tmp, "wt"), { company: "Acme", owner: OWNER })).rejects.toThrow(
    RangeError,
  )
  expect(fs.readdirSync(bare)).toEqual(["company.yaml"])
})

test.each(PACKAGED_FLOWS)("every packaged flow is found missing and topped up [%s]", async (flow) => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  fs.unlinkSync(path.join(root, flow))
  commitAll(root, `drop ${flow}`)
  expect(missingFiles(root)).toEqual([flow])
  expect(await writeCompany(root, worktrees)).toEqual([flow])
})

test("the template names every file in its folder", () => {
  const walk = (dir: string, prefix = ""): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
  const onDisk = walk(TEMPLATE).map((rel) => rel.replace("people/{owner}", "people/ngocbh"))
  expect(onDisk.sort()).toEqual([...templateFiles("Acme", OWNER).keys()].sort())
})

test("every template flow loads and lints on ts yian", async () => {
  const { root, worktrees } = dirs()
  await writeCompany(root, worktrees, { company: "Acme", owner: OWNER })
  fs.mkdirSync(path.join(root, "people", "minh", "memory"), { recursive: true })
  const minh = {
    handle: "minh",
    name: "Minh",
    kind: "agent",
    title: "Engineer",
    manager: "ngocbh",
    main: "../../shared/flows/chat.yaml",
    sops: [{ flow: "../../shared/flows/side_chat.yaml" }, { flow: "../../shared/flows/profile_manager.yaml" }],
    harnesses: ["composer"],
  }
  fs.writeFileSync(path.join(root, "people", "minh", "person.yaml"), writeYaml(minh))
  fs.writeFileSync(path.join(root, "people", "minh", "memory", "profile.md"), "# Minh, Engineer\n")
  expect(await lint(loadRepo(root))).toEqual([])
  for (const rel of PACKAGED_FLOWS) {
    expect((await loadConfined(root, path.join(root, rel))).name).toBe(path.basename(rel, ".yaml"))
  }
})

/** Hiring: a new agent's files, laid out as the Python office wrote them, and previews of a hire. */
import { expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { HireRequest, Person } from "@opencorp/protocol"
import { agentFiles, HireRefused, Hiring } from "../../src/chat/hire.ts"
import { CompanyGit, type LockedGit } from "../../src/company/git.ts"
import { readYaml } from "../../src/company/flow_yaml.ts"
import { lint } from "../../src/company/lint.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { baseFiles, git as runGit, gitEnv, person, writeRepo } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { CHAT_FILES, CHAT_FLOW } from "./helpers.ts"

setDefaultTimeout(30_000)

const FORM = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }

function req(form: Record<string, unknown>, confirm = false) {
  return HireRequest.parse({ ...form, confirm })
}

function makeGit(files: Record<string, unknown> = { ...baseFiles(), ...CHAT_FILES }) {
  const dir = tempDir()
  return new CompanyGit(writeRepo(path.join(dir, "company"), files), path.join(dir, "worktrees"))
}

// Untrimmed: the helper's trim would eat the leading space of " M ...".
function status(root: string): string {
  return spawnSync("git", ["-C", root, "status", "--porcelain"], { env: gitEnv(), encoding: "utf8" }).stdout
}

/** The `HireRefused` that `promise` rejects with; fails the test if it resolves or rejects otherwise. */
async function refused(promise: Promise<unknown>): Promise<HireRefused> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(HireRefused)
  return error as HireRefused
}

// Dumped from the frozen Python office.
const GOLDEN = {
  "people/lan/person.yaml":
    "handle: lan\nname: Lan\nkind: agent\ntitle: QA\nmanager: ngocbh\n" +
    "main: ../../shared/flows/chat.yaml\nharnesses:\n- composer\nharness_policy:\n  sandbox: workspace-write\n",
  "people/lan/profile.md": "# Lan, QA\n",
}

test("a hires person file is laid out as python wrote it", () => {
  const [person, files] = agentFiles(FORM)
  expect(files).toEqual(GOLDEN)
  expect(Person.parse(readYaml(files["people/lan/person.yaml"]!))).toEqual(person)
})

test("a hostile title reads back as itself and adds no key", () => {
  const keys = Object.keys(readYaml(GOLDEN["people/lan/person.yaml"]) as object)
  const titles = ["QA\nkind: human", "QA\npassword_hash: x", "yes", "0755", "null", "~", "- x", "a: b", "x #y", " lead"]
  for (const title of [...titles, " ", "x".repeat(200)]) {
    const body = readYaml(agentFiles({ ...FORM, title })[1]["people/lan/person.yaml"]!) as Record<string, unknown>
    expect([Object.keys(body), body.title]).toEqual([keys, title])
  }
})

test("a preview writes nothing and a confirm commits", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  const head = await git.head()
  const preview = await hiring.hire(req(FORM), "ngocbh")
  expect([preview.commit, preview.issues, await git.head()]).toEqual([null, [], head])
  expect(fs.existsSync(path.join(git.root, "people/lan"))).toBe(false)
  expect(preview.diff).toContain("+++ b/people/lan/person.yaml")
  expect(preview.diff).toContain("+handle: lan")

  const done = await hiring.hire(req(FORM, true), "ngocbh")
  expect(done.commit).toBe(await git.head())
  expect(done.commit).not.toBe(head)
  expect(done.person).toEqual(preview.person)
  expect(fs.readdirSync(path.join(git.root, "people/lan")).sort()).toEqual(["person.yaml", "profile.md"])
  const repo = loadRepo(git.root)
  const lan = repo.people.get("lan")
  expect([lan?.handle, lan?.main]).toEqual(["lan", "../../shared/flows/chat.yaml"])
  expect((await lint(repo)).filter((i) => i.severity === "error")).toEqual([])
})

test("a new hire gets the m1 defaults", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  await hiring.hire(req(FORM), "ngocbh")
  await hiring.hire(req(FORM, true), "ngocbh")
  const lan = loadRepo(git.root).people.get("lan")!
  expect([lan.kind, lan.harnesses, lan.groups, lan.skills]).toEqual(["agent", ["composer"], [], []])
  expect(lan.harness_policy).toEqual({ sandbox: "workspace-write", network: false })
  expect(fs.readFileSync(path.join(git.root, "people/lan/profile.md"), "utf8")).toBe("# Lan, QA\n")
  expect(runGit(git.root, "log", "-1", "--format=%s")).toBe("hire(@lan): Lan, QA")
})

test("agent files are a hires files with an optional line about the work", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  await hiring.hire(req(FORM), "ngocbh")
  await hiring.hire(req(FORM, true), "ngocbh")
  const [lan, files] = agentFiles(FORM)
  expect(lan).toEqual(loadRepo(git.root).people.get("lan")!)
  const rels = ["people/lan/person.yaml", "people/lan/profile.md"]
  expect(files).toEqual(Object.fromEntries(rels.map((rel) => [rel, fs.readFileSync(path.join(git.root, rel), "utf8")])))
  expect(agentFiles(FORM, "Tests every release.")[1]["people/lan/profile.md"]).toBe(
    "# Lan, QA\n\nTests every release.\n",
  )
})

test("a taken handle is refused and names the clash", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  const head = await git.head()
  const minh = fs.readFileSync(path.join(git.root, "people/minh/person.yaml"), "utf8")
  const preview = await hiring.hire(req({ ...FORM, handle: "minh" }), "ngocbh")
  expect(preview.commit).toBeNull()
  expect(preview.issues.map((i) => [i.path, i.code, i.message, i.severity])).toEqual([
    ["people/minh/person.yaml", "person.duplicate_handle", "@minh is already taken", "error"],
  ])
  expect(preview.diff).toBe("") // the files are there already; nothing would be added
  const error = await refused(hiring.hire(req({ ...FORM, handle: "minh" }, true), "ngocbh"))
  expect([error.code, error.message]).toEqual(["lint_failed", "@minh is already taken"])
  const after = fs.readFileSync(path.join(git.root, "people/minh/person.yaml"), "utf8")
  expect([await git.head(), after]).toEqual([head, minh])
})

test("a folder left by hand takes the handle", async () => {
  const git = makeGit()
  fs.mkdirSync(path.join(git.root, "people/lan"))
  const preview = await new Hiring(git).hire(req(FORM), "ngocbh")
  expect([preview.issues.map((i) => i.code), preview.diff]).toEqual([["person.duplicate_handle"], ""])
})

test("a confirm must repeat the preview", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  const head = await git.head()
  expect((await refused(hiring.hire(req(FORM, true), "ngocbh"))).code).toBe("lint_failed") // never previewed
  await hiring.hire(req(FORM), "ngocbh")
  expect((await refused(hiring.hire(req({ ...FORM, title: "Lead QA" }, true), "ngocbh"))).code).toBe("lint_failed")
  expect(await git.head()).toBe(head)
})

test("an unknown manager is a lint error", async () => {
  const preview = await new Hiring(makeGit()).hire(req({ ...FORM, manager: "kai" }), "ngocbh")
  expect(preview.issues.some((i) => i.severity === "error" && i.message.includes("kai"))).toBe(true)
})

test("a failed commit leaves nothing behind and a retry succeeds", async () => {
  class FlakyGit extends CompanyGit {
    broken = false
    override locked<T>(fn: (git: LockedGit) => Promise<T>): Promise<T> {
      return super.locked((locked) =>
        fn(
          this.broken
            ? { ...locked, commit: () => Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" })) }
            : locked,
        ),
      )
    }
  }
  const dir = tempDir()
  const root = writeRepo(path.join(dir, "company"), { ...baseFiles(), ...CHAT_FILES })
  const git = new FlakyGit(root, path.join(dir, "worktrees"))
  const hiring = new Hiring(git)
  const head = await git.head()
  await hiring.hire(req(FORM), "ngocbh")

  git.broken = true
  await expect(hiring.hire(req(FORM, true), "ngocbh")).rejects.toThrow("disk full")
  expect(fs.existsSync(path.join(root, "people/lan"))).toBe(false)
  expect([status(root), await git.head()]).toEqual(["", head])

  git.broken = false
  expect(await git.locked((locked) => locked.commitHandEdits())).toEqual([]) // nothing left to sweep up as a hand edit
  const done = await hiring.hire(req(FORM, true), "ngocbh")
  expect(done.commit).toBe(await git.head())
  expect(done.commit).not.toBe(head)
})

test("a hire commit names its actor once and a name that skips the schema cant forge another", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  const form = { ...FORM, name: "Lan\n\nActor: @ceo" }
  await hiring.hire({ ...form, confirm: false }, "ngocbh")
  await hiring.hire({ ...form, confirm: true }, "ngocbh")
  const lines = runGit(git.root, "log", "-1", "--format=%B").split("\n")
  expect(lines.filter((line) => line.startsWith("Actor:"))).toEqual(["Actor: @ngocbh"])
  expect(lines[0]).toBe("hire(@lan): Lan Actor: @ceo, QA")
})

test("a newline in the title or name is refused by the schema", () => {
  expect(HireRequest.safeParse({ ...FORM, title: "QA\n\nCommit-Id: forged" }).success).toBe(false)
  expect(HireRequest.safeParse({ ...FORM, name: "Lan\n\nActor: @ceo" }).success).toBe(false)
})

test("the profile heading is one line", () => {
  const files = agentFiles({ ...FORM, name: "Lan\n# Injected", title: "QA\u2028x\0" })[1]
  expect(files["people/lan/profile.md"]).toBe("# Lan # Injected, QA x\n")
})

test("a title that skips the schema commits a one-line subject and cant forge a commit trailer", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  const form = { ...FORM, title: "QA\n\nCommit-Id: forged\0" }
  expect((await hiring.hire({ ...form, confirm: false }, "ngocbh")).issues).toEqual([])
  await hiring.hire({ ...form, confirm: true }, "ngocbh")
  expect(runGit(git.root, "log", "-1", "--format=%B")).toBe("hire(@lan): Lan, QA Commit-Id: forged\n\nActor: @ngocbh")
})

test("an existing lint error is a warning and doesnt block a hire", async () => {
  const files = {
    ...baseFiles(),
    ...CHAT_FILES,
    "people/minh/person.yaml": person("minh", { manager: "kai" }),
  }
  const git = makeGit(files)
  const hiring = new Hiring(git)
  const preview = await hiring.hire(req(FORM), "ngocbh")
  const old = preview.issues.filter((i) => i.path === "people/minh/person.yaml")
  expect(old.length).toBeGreaterThan(0)
  expect(new Set(old.map((i) => i.severity))).toEqual(new Set(["warning"]))
  expect(preview.issues.every((i) => i.severity === "warning")).toBe(true)
  const done = await hiring.hire(req(FORM, true), "ngocbh")
  expect(done.commit).toBe(await git.head())

  const kai = { ...FORM, handle: "kai-fan", manager: "kai" }
  const bad = await hiring.hire(req(kai), "ngocbh") // the same error, new
  expect(bad.issues.some((i) => i.severity === "error" && i.path.startsWith("people/kai-fan/"))).toBe(true)
  await refused(hiring.hire(req(kai, true), "ngocbh"))
})

test("old previews are dropped past the cap", async () => {
  const git = makeGit()
  const hiring = new Hiring(git, 2)
  const forms = ["lan", "kai", "ava"].map((handle) => ({ ...FORM, handle }))
  for (const form of forms) await hiring.hire(req(form), "ngocbh")
  expect((await refused(hiring.hire(req(forms[0]!, true), "ngocbh"))).code).toBe("lint_failed")
  expect((await hiring.hire(req(forms[2]!, true), "ngocbh")).commit).toBe(await git.head())
})

test("a new preview of a handle replaces the old one", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  await hiring.hire(req(FORM), "ngocbh")
  await hiring.hire(req({ ...FORM, title: "Lead QA" }), "ngocbh")
  await refused(hiring.hire(req(FORM, true), "ngocbh"))
  expect((await hiring.hire(req({ ...FORM, title: "Lead QA" }, true), "ngocbh")).commit).toBe(await git.head())
})

test("a preview leaves hand edits alone", async () => {
  const git = makeGit()
  fs.writeFileSync(path.join(git.root, "people/minh/profile.md"), "# Minh, Engineer\n\nLikes tests.\n")
  const head = await git.head()
  await new Hiring(git).hire(req(FORM), "ngocbh")
  expect([await git.head(), status(git.root)]).toEqual([head, " M people/minh/profile.md\n"])
})

test("issue messages name the company repo not the scratch copy", async () => {
  const check =
    "  check:\n    kind: code\n    code: ./nope.ts:fn\n    input:\n      x: ${chat.output.summary}\n    output: str\n"
  const end = "output:\n  summary: ${chat.output.summary}\n"
  const flow = CHAT_FLOW.replace(end, check + end)
  const git = makeGit({ ...baseFiles(), ...CHAT_FILES, "shared/flows/chat.yaml": flow })
  const preview = await new Hiring(git).hire(req(FORM), "ngocbh")
  const named = preview.issues.filter((i) => i.message.includes("nope.ts"))
  expect(named.length).toBeGreaterThan(0)
  for (const issue of named) {
    expect(issue.message).toContain(`${fs.realpathSync(git.root)}/shared/flows`)
    expect(issue.message).not.toContain("opencorp-hire-")
  }
  expect(named.find((i) => i.path === "people/lan/person.yaml")?.severity).toBe("error")
  expect(named.find((i) => i.path === "people/minh/person.yaml")?.severity).toBe("warning")
})

test("a hire is never written outside the repo", async () => {
  const dir = tempDir()
  const root = writeRepo(path.join(dir, "company"), { ...baseFiles(), ...CHAT_FILES })
  const outside = path.join(dir, "outside")
  fs.renameSync(path.join(root, "people"), outside)
  fs.symlinkSync(outside, path.join(root, "people"))
  runGit(root, "add", "-A")
  runGit(root, "commit", "-qm", "people elsewhere")
  const hiring = new Hiring(new CompanyGit(root, path.join(dir, "worktrees")))
  const preview = await hiring.hire(req(FORM), "ngocbh")
  expect(preview.issues.map((i) => [i.code, i.severity])).toEqual([["person.outside_repo", "error"]])
  expect(preview.diff).toBe("")
  expect((await refused(hiring.hire(req(FORM, true), "ngocbh"))).code).toBe("lint_failed")
  expect(fs.existsSync(path.join(outside, "lan"))).toBe(false)
})

test("a relative people link out of the repo counts as outside the repo", async () => {
  const dir = tempDir()
  const root = writeRepo(path.join(dir, "company"), { ...baseFiles(), ...CHAT_FILES })
  const shared = path.join(dir, "shared-people")
  fs.renameSync(path.join(root, "people"), shared)
  fs.symlinkSync("../shared-people", path.join(root, "people"))
  runGit(root, "add", "-A")
  runGit(root, "commit", "-qm", "people elsewhere")
  const hiring = new Hiring(new CompanyGit(root, path.join(dir, "worktrees")))
  const preview = await hiring.hire(req(FORM), "ngocbh")
  expect(preview.issues.map((i) => [i.path, i.code])).toEqual([["people/lan/person.yaml", "person.outside_repo"]])
  expect(preview.issues.map((i) => i.severity)).toEqual(["error"])
  expect(preview.diff).toBe("")
  expect((await refused(hiring.hire(req(FORM, true), "ngocbh"))).code).toBe("lint_failed")
  expect(fs.existsSync(path.join(shared, "lan"))).toBe(false)
})

test("a preview through a symlinked company folder writes nothing in the repo", async () => {
  const dir = tempDir()
  const real = writeRepo(path.join(dir, "real"), { ...baseFiles(), ...CHAT_FILES })
  fs.symlinkSync(real, path.join(dir, "company"))
  const hiring = new Hiring(new CompanyGit(path.join(dir, "company"), path.join(dir, "worktrees")))
  expect((await hiring.hire(req(FORM), "ngocbh")).issues).toEqual([])
  expect(fs.existsSync(path.join(real, "people/lan"))).toBe(false)
  expect(status(real)).toBe("")
  const again = await hiring.hire(req(FORM), "ngocbh")
  expect(again.issues.map((i) => i.code)).not.toContain("person.duplicate_handle")
  expect((await hiring.hire(req(FORM, true), "ngocbh")).commit).toBe(runGit(real, "rev-parse", "HEAD"))
  expect(fs.readdirSync(path.join(real, "people/lan")).sort()).toEqual(["person.yaml", "profile.md"])
})

test("an in repo people link is refused at preview as at confirm", async () => {
  const dir = tempDir()
  const root = writeRepo(path.join(dir, "company"), { ...baseFiles(), ...CHAT_FILES })
  fs.renameSync(path.join(root, "people"), path.join(root, "staff"))
  fs.symlinkSync("staff", path.join(root, "people"))
  runGit(root, "add", "-A")
  runGit(root, "commit", "-qm", "people is staff")
  const hiring = new Hiring(new CompanyGit(root, path.join(dir, "worktrees")))
  const preview = await hiring.hire(req(FORM), "ngocbh")
  expect(preview.issues.map((i) => [i.code, i.severity])).toEqual([["person.outside_repo", "error"]])
  expect(preview.diff).toBe("")
  expect((await refused(hiring.hire(req(FORM, true), "ngocbh"))).code).toBe("lint_failed")
  expect(fs.existsSync(path.join(root, "staff/lan"))).toBe(false)
})

test("a handle folder made after the draft is refused as taken", async () => {
  class RacingGit extends CompanyGit {
    raced = false
    override async head(): Promise<string> {
      if (!this.raced) {
        this.raced = true
        fs.mkdirSync(path.join(this.root, "people/lan"))
      }
      return super.head()
    }
  }
  const dir = tempDir()
  const root = writeRepo(path.join(dir, "company"), { ...baseFiles(), ...CHAT_FILES })
  const head = runGit(root, "rev-parse", "HEAD")
  const hiring = new Hiring(new RacingGit(root, path.join(dir, "worktrees")))
  await hiring.hire(req(FORM), "ngocbh") // a preview doesn't read HEAD; the confirm reads it after its draft
  const error = await refused(hiring.hire(req(FORM, true), "ngocbh"))
  expect([error.code, error.message]).toEqual(["lint_failed", "@lan is already taken"])
  expect(fs.readdirSync(path.join(root, "people/lan"))).toEqual([])
  expect(runGit(root, "rev-parse", "HEAD")).toBe(head)
})

test("a people folder swapped for a link after the draft is never written through", async () => {
  const dir = tempDir()
  const outside = path.join(dir, "outside")
  fs.mkdirSync(outside)
  class SwappingGit extends CompanyGit {
    swapped = false
    override async head(): Promise<string> {
      if (!this.swapped) {
        this.swapped = true
        fs.renameSync(path.join(this.root, "people"), path.join(dir, "moved"))
        fs.symlinkSync(outside, path.join(this.root, "people"))
      }
      return super.head()
    }
  }
  const root = writeRepo(path.join(dir, "company"), { ...baseFiles(), ...CHAT_FILES })
  const head = runGit(root, "rev-parse", "HEAD")
  const hiring = new Hiring(new SwappingGit(root, path.join(dir, "worktrees")))
  await hiring.hire(req(FORM), "ngocbh") // a preview doesn't read HEAD; the confirm reads it after its draft
  expect((await refused(hiring.hire(req(FORM, true), "ngocbh"))).code).toBe("lint_failed")
  expect(fs.readdirSync(outside)).toEqual([])
  expect(runGit(root, "rev-parse", "HEAD")).toBe(head)
})

test("a people folder swapped for a link during the commit is never deleted through", async () => {
  const dir = tempDir()
  const outside = path.join(dir, "outside")
  fs.mkdirSync(path.join(outside, "lan"), { recursive: true })
  fs.writeFileSync(path.join(outside, "lan/keep"), "keep\n")
  class SwappingGit extends CompanyGit {
    override locked<T>(fn: (git: LockedGit) => Promise<T>): Promise<T> {
      const commit = () => {
        fs.renameSync(path.join(this.root, "people"), path.join(dir, "moved"))
        fs.symlinkSync(outside, path.join(this.root, "people"))
        return Promise.reject(new Error("commit failed"))
      }
      return super.locked((locked) => fn({ ...locked, commit }))
    }
  }
  const root = writeRepo(path.join(dir, "company"), { ...baseFiles(), ...CHAT_FILES })
  const hiring = new Hiring(new SwappingGit(root, path.join(dir, "worktrees")))
  await hiring.hire(req(FORM), "ngocbh")
  await expect(hiring.hire(req(FORM, true), "ngocbh")).rejects.toThrow("commit failed")
  expect(fs.existsSync(path.join(outside, "lan/keep"))).toBe(true)
})

test("concurrent confirms commit a hire once", async () => {
  const git = makeGit()
  const hiring = new Hiring(git)
  const head = await git.head()
  await hiring.hire(req(FORM), "ngocbh")
  await hiring.hire(req({ ...FORM, handle: "kai-fan" }), "ngocbh")
  const confirm = (form: Record<string, unknown>) =>
    hiring.hire(req(form, true), "ngocbh").then(
      (done) => done.commit,
      (error: unknown) => {
        if (error instanceof HireRefused) return error.code
        throw error
      },
    )
  const results = await Promise.all([FORM, FORM, { ...FORM, handle: "kai-fan" }].map(confirm))
  expect(results.slice(0, 2).filter((r) => r === "lint_failed").length).toBe(1) // one of the same two lost
  expect(results[2]).not.toBe("lint_failed")
  const commits = runGit(git.root, "log", "--format=%s", `${head}..HEAD`).split("\n")
  expect(commits.sort()).toEqual(["hire(@kai-fan): Lan, QA", "hire(@lan): Lan, QA"])
  const people = loadRepo(git.root).people
  expect([people.has("lan"), people.has("kai-fan")]).toEqual([true, true])
})

test("a hire copies nothing however big the untracked tree", async () => {
  const git = makeGit()
  const data = path.join(git.root, "data")
  fs.mkdirSync(data)
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(data, `${i}.bin`), "x".repeat(1024))
  const mkdtemp = spyOn(fs, "mkdtempSync")
  const cp = spyOn(fs.promises, "cp")
  try {
    const hiring = new Hiring(git)
    expect((await hiring.hire(req(FORM), "ngocbh")).issues).toEqual([])
    expect((await hiring.hire(req(FORM, true), "ngocbh")).commit).toBe(await git.head())
    expect(mkdtemp.mock.calls.filter((call) => String(call[0]).includes("opencorp-hire-"))).toEqual([])
    expect(cp).not.toHaveBeenCalled()
  } finally {
    mkdtemp.mockRestore()
    cp.mockRestore()
  }
})

test.skipIf(process.getuid?.() === 0)("special files the company doesnt reference are never read", async () => {
  const git = makeGit()
  const dir = path.join(git.root, "shared/data")
  fs.mkdirSync(dir)
  expect(spawnSync("mkfifo", [path.join(dir, "pipe")]).status).toBe(0)
  const secret = path.join(dir, "secret")
  fs.writeFileSync(secret, "x")
  fs.chmodSync(secret, 0)
  try {
    const hiring = new Hiring(git)
    expect((await hiring.hire(req(FORM), "ngocbh")).issues).toEqual([])
    expect((await hiring.hire(req(FORM, true), "ngocbh")).commit).toBe(await git.head())
  } finally {
    fs.chmodSync(secret, 0o644)
  }
})

test.skipIf(process.getuid?.() === 0)("an unreadable shared skills folder is a lint error, not a crash", async () => {
  const skill = "---\nname: review\ndescription: Reviews.\n---\nReview.\n"
  const git = makeGit({ ...baseFiles(), ...CHAT_FILES, "shared/skills/review/SKILL.md": skill })
  const skills = path.join(git.root, "shared/skills")
  const head = await git.head()
  fs.chmodSync(skills, 0)
  try {
    const hiring = new Hiring(git)
    const preview = await hiring.hire(req(FORM), "ngocbh")
    expect(preview.issues.map((i) => [i.path, i.code, i.message, i.severity])).toEqual([
      ["shared/skills", "repo.unreadable", "can't be read", "error"],
    ])
    expect(preview.diff).toBe("")
    const error = await refused(hiring.hire(req(FORM, true), "ngocbh"))
    expect([error.code, error.message]).toEqual(["lint_failed", "can't be read"])
    expect(await git.head()).toBe(head)
  } finally {
    fs.chmodSync(skills, 0o755)
  }
})

test("a people file where the folder should be is a lint error, not a crash", async () => {
  const git = makeGit()
  fs.rmSync(path.join(git.root, "people"), { recursive: true })
  fs.writeFileSync(path.join(git.root, "people"), "not a folder\n")
  runGit(git.root, "add", "-A")
  runGit(git.root, "commit", "-qm", "people is a file")
  const hiring = new Hiring(git)
  const preview = await hiring.hire(req(FORM), "ngocbh")
  expect(preview.issues.map((i) => [i.path, i.code, i.severity])).toEqual([["people/lan", "repo.unreadable", "error"]])
  expect((await refused(hiring.hire(req(FORM, true), "ngocbh"))).code).toBe("lint_failed")
})

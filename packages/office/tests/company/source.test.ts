/** The Source view's office side: the ring of served HEADs, the listing, and reading files as stored (Python's
 *  `tests/company/test_source.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import { CompanyGit } from "../../src/company/git.ts"
import { CompanySource, RING, SourceError } from "../../src/company/source.ts"
import { tempDir } from "../helpers.ts"
import { company, git, gitInput, person, recordingGit } from "./helpers.ts"

setDefaultTimeout(30_000)

const HASH = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"
const SHA = "d".repeat(64)
const HUMAN = "people/ngocbh/person.yaml"
const PROFILE = "people/minh/profile.md"

/** A base company, its CompanyGit (worktrees beside it) and a CompanySource on it. */
function setup(options: { treeCap?: number } = {}) {
  const dir = tempDir()
  const root = company(dir)
  const g = new CompanyGit(root, path.join(dir, "worktrees"))
  return { root, g, src: new CompanySource(g, options) }
}

/** Writes (or, for null, deletes) `files` and commits everything; returns the new HEAD. */
function commit(root: string, files: Record<string, string | Uint8Array | null>, message = "edit"): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel)
    if (content === null) {
      fs.unlinkSync(file)
      continue
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  git(root, "add", "-A")
  git(root, "commit", "-q", "--allow-empty", "-m", message)
  return git(root, "rev-parse", "HEAD")
}

/** The SourceError `promise` rejects with; fails if it resolves or rejects with anything else. */
async function refused(promise: Promise<unknown>): Promise<SourceError> {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(SourceError)
  return error as SourceError
}

// The tree

test("tree lists entries breadth first with the commit", async () => {
  const { g, src } = setup()
  const head = await g.head()
  const tree = await src.tree(head)
  const paths = tree.entries.map((e) => e.path)
  const depth = paths.map((p) => p.split("/").length - 1)
  expect(depth).toEqual([...depth].sort((a, b) => a - b))
  expect(paths.slice(0, 3)).toEqual([...paths.slice(0, 3)].sort())
  const kinds = new Map(tree.entries.map((e) => [e.path, [e.type, e.size]]))
  expect(kinds.get("people")).toEqual(["folder", null])
  expect(kinds.get(PROFILE)).toEqual(["file", "# Minh, Engineer\n".length])
  expect([tree.commit.id, tree.commit.subject, tree.commit.author]).toEqual([head, "init", "t"])
  expect([tree.truncated, tree.skipped]).toEqual([false, 0])
})

test("one load per commit however many ask", async () => {
  const { g, src } = setup()
  const head = await g.head()
  const calls: string[] = []
  const real = g.listTree.bind(g)
  g.listTree = async (sha) => {
    calls.push(sha)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return real(sha)
  }
  const [a, b] = await Promise.all([src.tree(head), src.tree(head)])
  await src.tree(head)
  expect(a).toEqual(b)
  expect(calls).toEqual([head])
})

test("truncation is breadth first and a deep link still opens", async () => {
  const { root, src } = setup({ treeCap: 5 })
  const sha = commit(root, { "a/b/c/deep.md": "deep\n" })
  const tree = await src.tree(sha)
  expect(tree.truncated).toBe(true)
  expect(tree.entries.map((e) => e.path)).toEqual(["a", "assets", "company.yaml", "groups", "people"])
  expect((await src.file(sha, "a/b/c/deep.md")).text).toBe("deep\n")
})

test("a non utf8 name is skipped and counted", async () => {
  const { root, g, src } = setup()
  const blob = git(root, "hash-object", "-w", PROFILE)
  const entry = [Buffer.from(`100644 ${blob}\t`), Buffer.from("b\xffd.md", "latin1"), Buffer.from("\n")]
  gitInput(root, Buffer.concat(entry), "update-index", "--add", "--index-info")
  git(root, "commit", "-q", "-m", "odd path")
  const head = await g.head()
  const tree = await src.tree(head)
  expect(tree.skipped).toBe(1)
  expect(tree.entries.every((e) => e.path.isWellFormed())).toBe(true)
  expect(JSON.stringify(tree)).not.toContain("\\udcff") // a lone surrogate would be escaped here
  expect((await refused(src.file(head, "b\udcffd.md"))).code).toBe("no_file")
})

test("dot segments in a crafted tree are skipped and counted", async () => {
  const { root, src } = setup()
  const mktree = (lines: string) => gitInput(root, Buffer.from(lines), "mktree")
  const blob = git(root, "rev-parse", `HEAD:${PROFILE}`)
  const inner = mktree(`100644 blob ${blob}\tok.md\n`)
  const top = mktree(`040000 tree ${inner}\t..\n100644 blob ${blob}\tfine.md\n`)
  const sha = git(root, "commit-tree", top, "-m", "crafted")
  const tree = await src.tree(sha)
  expect(tree.entries.map((e) => e.path)).toEqual(["fine.md"])
  expect(tree.skipped).toBe(2)
})

test("file names and the commit subject are listed as stored", async () => {
  const { root, src } = setup()
  commit(root, { [HUMAN]: stringify(person("ngocbh", { devices: [{ name: "macbook-pro", token_sha256: SHA }] })) })
  const sha = commit(root, { [`notes/${SHA}.md`]: "x\n", "notes/$scrypt$abc$def.md": "y\n" }, `leak ${HASH}`)
  const tree = await src.tree(sha)
  expect(tree.skipped).toBe(0)
  const paths = tree.entries.map((e) => e.path)
  expect(paths).toContain(`notes/${SHA}.md`)
  expect(paths).toContain("notes/$scrypt$abc$def.md")
  expect(tree.commit.subject).toBe(`leak ${HASH}`)
})

// Which commit

test.each(["HEAD", "HEAD@{1}", "stash@{0}", ":/init", "-x", "main", null, "", "HEAD:people/minh/profile.md"])(
  "at must be a served head [%s]",
  async (at) => {
    const { g, src } = setup()
    await src.tree(await g.head())
    const error = await refused(src.file(at, PROFILE))
    expect([error.status, error.code]).toEqual([409, "stale_commit"])
  },
)

test("a short id a dangling sha and an unserved commit are stale", async () => {
  const { root, g, src } = setup()
  const first = await g.head()
  const dangling = git(root, "commit-tree", git(root, "rev-parse", "HEAD^{tree}"), "-m", "dangling")
  const second = commit(root, { [PROFILE]: "# two\n" })
  await src.tree(second)
  for (const at of [second.slice(0, 12), dangling, first, second.toUpperCase()]) {
    expect((await refused(src.file(at, PROFILE))).code).toBe("stale_commit")
  }
})

test("a head that left the ring is stale", async () => {
  const { root, g, src } = setup()
  const first = await g.head()
  await src.tree(first)
  expect((await src.file(first, PROFILE)).text).toBe("# Minh, Engineer\n")
  for (let i = 0; i < RING; i++) await src.tree(commit(root, { [PROFILE]: `# ${i}\n` }))
  expect((await refused(src.file(first, PROFILE))).code).toBe("stale_commit")
})

test("git never sees request input", async () => {
  const dir = tempDir()
  const root = company(dir)
  const recording = recordingGit(dir)
  const g = new CompanyGit(root, path.join(dir, "worktrees"), { git: recording.git })
  const src = new CompanySource(g)
  const sha = await g.head()
  await src.tree(sha)
  const before = recording.calls().length
  for (const [at, p] of [[`${sha}:company.yaml`, "company.yaml"], [sha, `${sha}:company.yaml`], [sha, ":company.yaml"]]) {
    await refused(src.file(at, p))
  }
  expect(recording.calls().slice(before)).toEqual([])
})

// Paths

test.each(["", "/company.yaml", "people/", "people//minh", "people/./minh", "people/../x", "..", ".", "a\0b", null])(
  "malformed paths are bad path [%s]",
  async (p) => {
    const { g, src } = setup()
    const head = await g.head()
    await src.tree(head)
    const error = await refused(src.file(head, p))
    expect([error.status, error.code]).toEqual([400, "bad_path"])
  },
)

test.each(["nope.md", "people", "people/minh", ":people/minh/profile.md", "PEOPLE/minh/profile.md"])(
  "a path not in the listing or a folder is no file [%s]",
  async (p) => {
    const { g, src } = setup()
    const head = await g.head()
    await src.tree(head)
    const error = await refused(src.file(head, p))
    expect([error.status, error.code]).toEqual([404, "no_file"])
  },
)

test("a path named like an object property is no file", async () => {
  const { g, src } = setup()
  const head = await g.head()
  await src.tree(head)
  for (const p of ["constructor", "__proto__"]) {
    const error = await refused(src.file(head, p))
    expect([error.status, error.code]).toEqual([404, "no_file"])
  }
})

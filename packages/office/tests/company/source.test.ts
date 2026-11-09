/** The Source view's office side: the ring of served HEADs, the listing, and reading files as stored (Python's
 *  `tests/company/test_source.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { stringify } from "yaml"
import { CompanyGit } from "../../src/company/git.ts"
import { CompanySource, RING, SourceError } from "../../src/company/source.ts"
import { tempDir } from "../helpers.ts"
import { CHAT, company, git, gitInput, MAIN, person, recordingGit } from "./helpers.ts"

setDefaultTimeout(30_000)

const HASH = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"
const SHA = "d".repeat(64)
const TOKEN = "act_" + "Z".repeat(43)
const HUMAN = "people/ngocbh/person.yaml"
const PROFILE = "people/minh/memory/profile.md"

/** A base company, its CompanyGit (worktrees beside it) and a CompanySource on it. */
function setup(options: { treeCap?: number } = {}) {
  const dir = tempDir()
  const root = company(dir)
  const g = new CompanyGit(root, path.join(dir, "worktrees"))
  return { dir, root, g, src: new CompanySource(g, options) }
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

/** Commits `files`, serves the tree at the new HEAD and reads `file` (default: the first file given). */
async function show(src: CompanySource, root: string, files: Record<string, string | Uint8Array>, file?: string) {
  const sha = commit(root, files)
  await src.tree(sha)
  return src.file(sha, file ?? Object.keys(files)[0])
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

test.each(["HEAD", "HEAD@{1}", "stash@{0}", ":/init", "-x", "main", null, "", "HEAD:people/minh/memory/profile.md"])(
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

test.each(["nope.md", "people", "people/minh", ":people/minh/memory/profile.md", "PEOPLE/minh/profile.md"])(
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

test("uncommitted and staged edits are not shown", async () => {
  const { root, g, src } = setup()
  const sha = await g.head()
  fs.writeFileSync(path.join(root, PROFILE), "# staged\n")
  git(root, "add", PROFILE)
  fs.writeFileSync(path.join(root, "groups/eng.yaml"), "dirty\n")
  fs.writeFileSync(path.join(root, "new.md"), "new\n")
  const tree = await src.tree(sha)
  expect(tree.entries.map((e) => e.path)).not.toContain("new.md")
  expect((await src.file(sha, PROFILE)).text).toBe("# Minh, Engineer\n")
})

// Entry kinds, sizes, text

test("a symlink shows its target and is not followed", async () => {
  const { dir, root, src } = setup()
  const outside = path.join(dir, SHA)
  fs.writeFileSync(outside, `password_hash: ${HASH}\n`)
  fs.symlinkSync(outside, path.join(root, "link"))
  const sha = commit(root, {})
  await src.tree(sha)
  const got = await src.file(sha, "link")
  expect([got.content, got.target, got.text]).toEqual(["symlink", outside, null])
})

test("a submodule has no content", async () => {
  const { root, g, src } = setup()
  git(root, "update-index", "--add", "--cacheinfo", `160000,${await g.head()},vendor/lib`)
  git(root, "commit", "-q", "-m", "a submodule")
  const sha = await g.head()
  const tree = await src.tree(sha)
  expect(tree.entries.map((e) => [e.path, e.type])).toContainEqual(["vendor/lib", "submodule"])
  const got = await src.file(sha, "vendor/lib")
  expect([got.content, got.text, got.target]).toEqual(["submodule", null, null])
})

test("large files are too large without being read", async () => {
  const { root, g, src } = setup()
  const sha = commit(root, {
    "big.bin": Buffer.alloc((1 << 20) + 1, "x"),
    "big.yaml": "a: b\n".repeat((1 << 18) + 1),
    "ok.yaml": "a: b\n".repeat(60 << 10),
  })
  await src.tree(sha)
  const reads: string[] = []
  const real = g.readBlob.bind(g)
  g.readBlob = (blob) => {
    reads.push(blob)
    return real(blob)
  }
  expect((await src.file(sha, "big.bin")).content).toBe("too_large")
  expect((await src.file(sha, "big.yaml")).content).toBe("too_large")
  expect(reads).toEqual([])
  expect((await src.file(sha, "ok.yaml")).content).toBe("text") // YAML isn't parsed: only the 1 MiB cap applies
})

// Byte strings, one char per byte.
test.each(["a\x00b", "bell \x07", "esc \x1b[0m", "\xff\xfe", "caf\xe9"])("binary files [%s]", async (data) => {
  const { root, src } = setup()
  expect((await show(src, root, { "f.txt": Buffer.from(data, "latin1") })).content).toBe("binary")
})

test("text keeps tabs and crlf", async () => {
  const { root, src } = setup()
  const got = await show(src, root, { "f.txt": Buffer.from("a\tb\r\nc\n") })
  expect([got.content, got.text]).toEqual(["text", "a\tb\r\nc\n"])
})

test.each([".env", "deploy/server.pem", ".ssh/id_rsa", ".netrc"])(
  "credential file names are shown as stored [%s]",
  async (name) => {
    const { root, src } = setup()
    const text = `API_KEY=sk-ant-${"a".repeat(40)}\n`
    const got = await show(src, root, { [name]: text })
    expect([got.content, got.text, got.reason]).toEqual(["text", text, null])
  },
)

test("rendered files are cached", async () => {
  const { g, src } = setup()
  const sha = await g.head()
  await src.tree(sha)
  const first = await src.file(sha, PROFILE)
  g.readBlob = () => {
    throw new Error("read again")
  }
  expect(await src.file(sha, PROFILE)).toEqual(first)
})

// Files are shown as stored

test("a humans person yaml is shown byte for byte", async () => {
  const { root, src } = setup()
  const text = "# my file\n" + stringify(person("ngocbh", {
    devices: [{ name: "mac", token_sha256: SHA }],
    password_hash: HASH,
  }))
  const got = await show(src, root, { [HUMAN]: text })
  expect([got.content, got.text, got.rewritten, got.reason]).toEqual(["text", text, false, null])
})

test.each([
  ["assets/keys.yaml", `client_secret: abc\napi_key: sk-ant-${"b".repeat(40)}\n`],
  ["assets/creds.json", `{"token": "${TOKEN}", "password": "hunter2hunter2"}\n`],
  ["assets/broken.yaml", "a: [unclosed\n"],
  ["assets/broken.json", '{"token": "x",}\n'],
  [PROFILE, `see ${HASH} and glued${TOKEN}x and https://bob:hunter22@host/\n`],
  ["notes/copy.md", `old device ${SHA}\n`],
])("secrets in any file are shown as stored [%s]", async (rel, text) => {
  const { root, src } = setup()
  const got = await show(src, root, { [rel]: text })
  expect([got.content, got.text, got.reason]).toEqual(["text", text, null])
})

test("a harmless alias is shown as written", async () => {
  const { root, src } = setup()
  const text = "# shared\ndefaults: &d {model: gpt}\nminh: *d\n"
  const got = await show(src, root, { "assets/alias.yaml": text })
  expect([got.content, got.text]).toEqual(["text", text])
})

/** The `*.yaml` files in each packaged flows folder (a missing folder is empty), by name, and the helpers'
 *  `MAIN` and `CHAT` as stand-ins, so there are always cases. */
function packagedFlows(): [string, string][] {
  const flows: [string, string][] = [["MAIN", MAIN], ["CHAT", CHAT]]
  for (const folder of ["../../src/company_template/template/shared/flows/", "../../src/install/flows/"]) {
    const dir = new URL(folder, import.meta.url)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
      flows.push([name, fs.readFileSync(new URL(name, dir), "utf8")])
    }
  }
  return flows
}

test.each(packagedFlows())("every packaged flow file is shown as written [%s]", async (name, text) => {
  const { root, src } = setup()
  const got = await show(src, root, { [`shared/flows/${name}`]: text })
  expect([got.content, got.text, got.rewritten]).toEqual(["text", text, false])
})

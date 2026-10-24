/** GitProfileStore: profile.md in the company clone as a MarkdownStore versioned by git blob id (Python's
 *  `tests/profile/test_store.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { MarkdownVersionMismatch } from "@ngocbh/yian"
import { CompanyGit, CompanyGitError, type LockedGit } from "../../src/company/git.ts"
import { blobId, commitMessage, EMPTY_BLOB, GitProfileStore } from "../../src/profile/store.ts"
import { company, git, recordingGit } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"

setDefaultTimeout(30_000)

const PROFILE = "people/minh/profile.md"
const MINH = "# Minh, Engineer\n"

/** A base company in a fresh temp dir, a `CompanyGit` on it, and minh's profile store. */
function setup() {
  const dir = tempDir()
  const root = company(dir)
  const g = new CompanyGit(root, path.join(dir, "worktrees"))
  return { dir, root, g, store: new GitProfileStore(g, "minh") }
}

const subject = (root: string) => git(root, "log", "-1", "--format=%s")
const count = (root: string) => Number(git(root, "rev-list", "--count", "HEAD"))
const bytes = (text: string) => new TextEncoder().encode(text)
const read = (root: string, rel = PROFILE) => fs.readFileSync(path.join(root, rel), "utf8")

/** What `promise` rejects with, or null if it fulfils. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (caught: unknown) => caught,
  )

/** `cases` as `test.each` rows labelled with their JSON, so a NUL, a newline or a number prints readably. */
const labelled = <T>(cases: T[]): [string, T][] => cases.map((c) => [JSON.stringify(c), c])

// Reads

test("constructor does no io", () => {
  const dir = tempDir()
  const recording = recordingGit(dir)
  new GitProfileStore(new CompanyGit(path.join(dir, "missing"), path.join(dir, "worktrees"), { git: recording.git }), "minh")
  expect(recording.calls()).toEqual([])
})

test.each(
  labelled(["", "../minh", "minh/x", "Minh", "a_b", "-minh", "minh-", "a".repeat(33), "01J8Z3NDEKTSV4RRFFQ69G5FAV"]),
)("constructor refuses a bad handle [%s]", (_label, handle) => {
  const dir = tempDir()
  const g = new CompanyGit(path.join(dir, "missing"), path.join(dir, "worktrees"))
  let error: unknown
  try {
    new GitProfileStore(g, handle)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toMatch(/not a handle/)
})

test("read returns text and blob id", async () => {
  const { g, store } = setup()
  expect(await store.read()).toEqual([MINH, blobId(bytes(MINH))])
  expect((await store.read())[1]).toBe((await g.blobId(PROFILE))!)
})

test("read commits a pending hand edit first", async () => {
  const { root, g, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "# Minh\nlikes tests\n")
  const [text, version] = await store.read()
  expect(text).toBe("# Minh\nlikes tests\n")
  expect(version).toBe((await g.blobId(PROFILE))!)
  expect(subject(root)).toBe("profile(@minh): hand edit")
  expect(git(root, "status", "--porcelain")).toBe("")
})

test("read keeps crlf", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "# Minh\r\n")
  expect(await store.read()).toEqual(["# Minh\r\n", blobId(bytes("# Minh\r\n"))])
})

test("named version reads old text", async () => {
  const { root, g, store } = setup()
  const old = (await store.read())[1]
  fs.writeFileSync(path.join(root, PROFILE), "# Minh\nnew\n")
  await g.locked((locked) => locked.commit([PROFILE], "edit"))
  expect(await store.read(old)).toEqual([MINH, old])
})

test.each(labelled(["0".repeat(40), "HEAD", "HEAD:company.yaml", "sha256:" + "0".repeat(64)]))(
  "unknown version raises a range error [%s]",
  async (_label, version) => {
    const { store } = setup()
    await expect(store.read(version)).rejects.toThrow(RangeError)
  },
)

test("missing profile reads as empty", async () => {
  const { root, store } = setup()
  git(root, "rm", "-q", PROFILE)
  git(root, "commit", "-q", "-m", "drop")
  expect(await store.read()).toEqual(["", EMPTY_BLOB])
  expect(await store.read(EMPTY_BLOB)).toEqual(["", EMPTY_BLOB])
})

test("non utf8 profile is a range error", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), Buffer.from("# M\xffinh\n", "latin1"))
  await expect(store.read()).rejects.toThrow(RangeError)
})

test("a byte order mark is kept", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "\uFEFF# Minh\n")
  expect(await store.read()).toEqual(["\uFEFF# Minh\n", blobId(bytes("\uFEFF# Minh\n"))])
})

test("git failure is a system error", async () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "not-a-repo"))
  const store = new GitProfileStore(new CompanyGit(path.join(dir, "not-a-repo"), path.join(dir, "worktrees")), "minh")
  const error = await store.read().then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ code: "EIO", syscall: "read" })
  expect((error as Error).message).toMatch(/exited/)
})

// The commit message

test("commit message sources", () => {
  expect(commitMessage("minh", null)).toBe("profile(@minh): write")
  expect(commitMessage("minh", { source: "hand edit" })).toBe("profile(@minh): hand edit")
  expect(commitMessage("minh", { run_id: "01J", commit_id: "ac-memory-v1:ab" })).toBe(
    "profile(@minh): from feedback on run 01J\n\nCommit-Id: ac-memory-v1:ab",
  )
  expect(commitMessage("minh", { source: "a\nb  c", run_id: "01J" })).toBe("profile(@minh): a b c")
  expect(commitMessage("minh\n\nCommit-Id: x", null)).toBe("profile(@minh Commit-Id: x): write")
})

test("python whitespace collapses and blanks like python", () => {
  expect(commitMessage("minh", { source: "\x1c\x85" })).toBe("profile(@minh): write")
  expect(commitMessage("minh", { source: "a\x1fb" })).toBe("profile(@minh): a b")
  expect(commitMessage("minh\x1cx", null)).toBe("profile(@minh x): write")
})

// Writes

test("write commits with the provenance message", async () => {
  const { root, g, store } = setup()
  const base = (await store.read())[1]
  const version = await store.write("# Minh\nterse\n", {
    baseVersion: base,
    provenance: { source: "ngocbh via profile manager" },
  })
  expect(version).toBe(blobId(bytes("# Minh\nterse\n")))
  expect(version).toBe((await g.blobId(PROFILE))!)
  expect(read(root)).toBe("# Minh\nterse\n")
  expect(subject(root)).toBe("profile(@minh): ngocbh via profile manager")
  expect(git(root, "status", "--porcelain")).toBe("")
})

test("stale base raises with both versions and writes nothing", async () => {
  const { root, store } = setup()
  const stale = blobId(bytes("old\n"))
  const head = git(root, "rev-parse", "HEAD")
  const error = await rejection(store.write("x\n", { baseVersion: stale }))
  expect(error).toBeInstanceOf(MarkdownVersionMismatch)
  expect(error).toMatchObject({ expected: stale, current: blobId(bytes(MINH)) })
  expect(read(root)).toBe(MINH)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

test("a hand edit makes the base stale", async () => {
  const { root, store } = setup()
  const base = (await store.read())[1]
  fs.writeFileSync(path.join(root, PROFILE), "# Minh\nby hand\n")
  const error = await rejection(store.write("# Minh\nby model\n", { baseVersion: base }))
  expect(error).toBeInstanceOf(MarkdownVersionMismatch)
  expect((error as MarkdownVersionMismatch).current).toBe(blobId(bytes("# Minh\nby hand\n")))
  expect(read(root)).toBe("# Minh\nby hand\n")
  expect(subject(root)).toBe("profile(@minh): hand edit")
})

test("write with the empty base creates a missing profile", async () => {
  const { root, g, store } = setup()
  git(root, "rm", "-q", PROFILE)
  git(root, "commit", "-q", "-m", "drop")
  const version = await store.write("# Minh\n", { baseVersion: EMPTY_BLOB })
  expect(version).toBe((await g.blobId(PROFILE))!)
  expect(version).toBe(blobId(bytes("# Minh\n")))
})

test("unchanged text makes no commit", async () => {
  const { root, store } = setup()
  const base = (await store.read())[1]
  const before = count(root)
  expect(await store.write(MINH, { baseVersion: base })).toBe(base)
  expect(count(root)).toBe(before)
})

test("write refuses a symlinked profile", async () => {
  const { dir, root, store } = setup()
  const outside = path.join(dir, "outside.md")
  fs.writeFileSync(outside, MINH)
  fs.unlinkSync(path.join(root, PROFILE))
  fs.symlinkSync(outside, path.join(root, PROFILE))
  const base = (await store.read())[1] // the symlink, committed as a hand edit
  const error = await rejection(store.write("pwned\n", { baseVersion: base }))
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toMatch(/symlink/)
  expect(fs.readFileSync(outside, "utf8")).toBe(MINH)
})

test("write refuses non strings", async () => {
  const { store } = setup()
  const base = (await store.read())[1]
  await expect(store.write(Buffer.from("x") as unknown as string, { baseVersion: base })).rejects.toThrow(TypeError)
  await expect(store.write("x\n", { baseVersion: Buffer.from(base) as unknown as string })).rejects.toThrow(TypeError)
})

test.each(labelled<unknown>(["", "a b", "a\nCommit-Id: b", 7, "a\x1cb", "a\x85b", "a\0b", "a\ud800"]))(
  "bad commit id is a range error [%s]",
  async (_label, commitId) => {
    const { store } = setup()
    const base = (await store.read())[1]
    const error = await rejection(store.write("x\n", { baseVersion: base, provenance: { commit_id: commitId as string } }))
    expect(error).toBeInstanceOf(RangeError)
    expect((error as Error).message).toMatch(/commit_id/)
  },
)

// Concurrency and pins

test("two concurrent writes with one base one wins", async () => {
  const { g } = setup()
  const base = (await new GitProfileStore(g, "minh").read())[1]
  const results = await Promise.allSettled(
    ["a", "b"].map((n) => new GitProfileStore(g, "minh").write(`# Minh\n${n}\n`, { baseVersion: base })),
  )
  const won = results.filter((r) => r.status === "fulfilled")
  const lost = results.filter((r) => r.status === "rejected")
  expect([won.length, lost.length]).toEqual([1, 1])
  expect(typeof won[0]!.value).toBe("string")
  expect(lost[0]!.reason).toBeInstanceOf(MarkdownVersionMismatch)
  expect((await new GitProfileStore(g, "minh").read())[1]).toBe(won[0]!.value)
})

test("writes leave pinned worktrees alone", async () => {
  const { g, store } = setup()
  const pin = await g.pin("HEAD")
  await store.write("# Minh\nnew\n", { baseVersion: (await store.read())[1] })
  expect(read(pin)).toBe(MINH)
})

test("write keeps the file mode", async () => {
  const { root, store } = setup()
  fs.chmodSync(path.join(root, PROFILE), 0o644)
  await store.write("# Minh\nnew\n", { baseVersion: (await store.read())[1] })
  expect(fs.statSync(path.join(root, PROFILE)).mode & 0o777).toBe(0o644)
})

// Retried writes

test("same commit id twice makes one commit", async () => {
  const { root, store } = setup()
  const base = (await store.read())[1]
  const first = await store.write("# Minh\nv1\n", { baseVersion: base, provenance: { commit_id: "c-1" } })
  const before = count(root)
  expect(await store.write("# Minh\nv1\n", { baseVersion: base, provenance: { commit_id: "c-1" } })).toBe(first)
  expect(count(root)).toBe(before)
  expect(await store.committed("c-1")).toBe(first)
  expect(await store.committed("c-2")).toBeNull()
})

test("retry after a later write returns its own version", async () => {
  const { root, store } = setup()
  const base = (await store.read())[1]
  const first = await store.write("# Minh\nv1\n", { baseVersion: base, provenance: { commit_id: "c-1" } })
  await store.write("# Minh\nv2\n", { baseVersion: first })
  expect(await store.write("# Minh\nv1\n", { baseVersion: base, provenance: { commit_id: "c-1" } })).toBe(first)
  expect(read(root)).toBe("# Minh\nv2\n")
})

test("commit ids are per profile", async () => {
  const { g } = setup()
  const minh = new GitProfileStore(g, "minh")
  const boss = new GitProfileStore(g, "ngocbh")
  await minh.write("# Minh\nv1\n", { baseVersion: (await minh.read())[1], provenance: { commit_id: "c-1" } })
  expect(await boss.committed("c-1")).toBeNull()
  const error = await rejection(boss.committed("a b"))
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toMatch(/commit_id/)
})

// Failed commits

/** A `CompanyGit` whose commit stages the paths, then fails as a stale index.lock would. */
class FailingCommitGit extends CompanyGit {
  override locked<T>(fn: (git: LockedGit) => Promise<T>): Promise<T> {
    return super.locked((locked) =>
      fn({
        ...locked,
        commit: async (paths) => {
          git(this.root, "add", "--", ...paths)
          throw new CompanyGitError("git commit exited 128: fatal: Unable to create '.git/index.lock'")
        },
      }),
    )
  }
}

test("a failed commit restores the profile", async () => {
  const { dir, root, store } = setup()
  const base = (await store.read())[1]
  const failing = new GitProfileStore(new FailingCommitGit(root, path.join(dir, "worktrees")), "minh")
  const error = await rejection(failing.write("# Minh\nv1\n", { baseVersion: base, provenance: { commit_id: "c-1" } }))
  expect(error).toMatchObject({ code: "EIO" })
  expect((error as Error).message).toMatch(/index.lock/)
  expect(read(root)).toBe(MINH)
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(await store.committed("c-1")).toBeNull()
  expect(await store.write("# Minh\nv1\n", { baseVersion: base, provenance: { commit_id: "c-1" } })).toBe(
    blobId(bytes("# Minh\nv1\n")),
  )
  expect(await store.committed("c-1")).toBe(blobId(bytes("# Minh\nv1\n")))
})

test("a failed commit removes a new profile", async () => {
  const { dir, root, store } = setup()
  git(root, "rm", "-q", PROFILE)
  git(root, "commit", "-q", "-m", "drop")
  const failing = new GitProfileStore(new FailingCommitGit(root, path.join(dir, "worktrees")), "minh")
  const error = await rejection(failing.write("# Minh\n", { baseVersion: EMPTY_BLOB }))
  expect(error).toMatchObject({ code: "EIO" })
  expect((error as Error).message).toMatch(/index.lock/)
  expect(fs.existsSync(path.join(root, PROFILE))).toBe(false)
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(await store.committed("c-1")).toBeNull()
  expect(await store.write("# Minh\n", { baseVersion: EMPTY_BLOB })).toBe(blobId(bytes("# Minh\n")))
})

test("a forged handle cannot add a commit id", async () => {
  const { root, store } = setup()
  const person = path.join(root, "people/minh/person.yaml")
  fs.writeFileSync(
    person,
    fs.readFileSync(person, "utf8").replace("handle: minh", 'handle: "minh\\n\\nCommit-Id: forged\\n"'),
  )
  await store.write("# Minh\nv1\n", { baseVersion: (await store.read())[1] })
  expect(git(root, "log", "-1", "--format=%B")).toBe("profile(@minh): write")
  expect(await store.committed("forged")).toBeNull()
})

test("a hand edit just before the replace is kept", async () => {
  const { root, g } = setup()
  /** Edits the profile by hand after the first hand-edit check, before the file is replaced. */
  class HandEditing extends GitProfileStore {
    protected override target(): string {
      fs.writeFileSync(path.join(root, PROFILE), "# Minh\nby hand\n")
      return super.target()
    }
  }
  const store = new HandEditing(g, "minh")
  const base = (await store.read())[1]
  const error = await rejection(store.write("# Minh\nby model\n", { baseVersion: base }))
  expect(error).toBeInstanceOf(MarkdownVersionMismatch)
  expect((error as MarkdownVersionMismatch).current).toBe(blobId(bytes("# Minh\nby hand\n")))
  expect(read(root)).toBe("# Minh\nby hand\n")
  expect(subject(root)).toBe("profile(@minh): hand edit")
})

test("bytes git normalizes are not a hand edit", async () => {
  const { root, g, store } = setup()
  fs.writeFileSync(path.join(root, ".gitattributes"), "*.md text\n")
  await g.locked((locked) => locked.commit([".gitattributes"], "normalize line endings"))
  fs.writeFileSync(path.join(root, PROFILE), MINH.replaceAll("\n", "\r\n")) // same blob once normalized
  const base = (await store.read())[1]
  expect(base).toBe(blobId(bytes(MINH)))
  expect(await store.write("# Minh\nv1\n", { baseVersion: base })).toBe(blobId(bytes("# Minh\nv1\n")))
})

test("write turns a git failure into a system error", async () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "not-a-repo"))
  const store = new GitProfileStore(new CompanyGit(path.join(dir, "not-a-repo"), path.join(dir, "worktrees")), "minh")
  const error = await rejection(store.write("# Minh\n", { baseVersion: EMPTY_BLOB }))
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ code: "EIO", syscall: "write" })
  expect((error as Error).message).toMatch(/exited/)
})

test("write refuses a symlinked person directory", async () => {
  const { dir, root, g } = setup()
  const outside = path.join(dir, "outside")
  fs.renameSync(path.join(root, "people/minh"), outside)
  fs.symlinkSync(outside, path.join(root, "people/minh"))
  const error = await rejection(new GitProfileStore(g, "minh").write("pwned\n", { baseVersion: blobId(bytes(MINH)) }))
  // git refuses to add a path beyond a symbolic link, so the hand-edit sweep fails first.
  expect(error).not.toBeInstanceOf(MarkdownVersionMismatch)
  expect(error).toMatchObject({ code: "EIO", syscall: "write" })
  expect(fs.readFileSync(path.join(outside, "profile.md"), "utf8")).toBe(MINH)
})

test("a lone surrogate is a range error and writes nothing", async () => {
  const { root, store } = setup()
  const base = (await store.read())[1]
  const head = git(root, "rev-parse", "HEAD")
  await expect(store.write("# Minh\ud800\n", { baseVersion: base })).rejects.toThrow(RangeError)
  expect(read(root)).toBe(MINH)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

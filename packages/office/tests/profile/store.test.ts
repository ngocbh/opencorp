/** GitProfileStore: profile.md in the company clone as a MarkdownStore versioned by git blob id (Python's
 *  `tests/profile/test_store.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { CompanyGit } from "../../src/company/git.ts"
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
const bytes = (text: string) => new TextEncoder().encode(text)

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
  const { g } = setup()
  expect(() => new GitProfileStore(g, handle)).toThrow(RangeError)
  expect(() => new GitProfileStore(g, handle)).toThrow(/not a handle/)
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

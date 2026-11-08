/** GitProfileStore: people/<handle>/memory/ in the company clone as yian's FileMemory, profile.md its index, each
 *  change that applies committed. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { type Author, FileMemory, type MemorySession } from "@ngocbh/yian"
import { CompanyGit, CompanyGitError, CompanyRepoBusy, repoBusy } from "../../src/company/git.ts"
import {
  commitMessage,
  EMPTY_VERSION,
  GitProfileStore,
  ProfileConflict,
  profileHash,
  ProfileRefused,
  PROFILE_MAX_CHARS,
  PROFILE_SETTINGS,
  ProfileUnreadable,
} from "../../src/profile/store.ts"
import { company, failingGit, git, recordingGit, stashPopConflict } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"

setDefaultTimeout(30_000)

const PROFILE = "people/minh/memory/profile.md"
const MINH = "# Minh, Engineer\n"
const OWNER: Author = { kind: "user", name: "ngocbh" }
const SIGNAL = new AbortController().signal

/** A base company in a fresh temp dir, a `CompanyGit` on it, and minh's profile store at the default budget. */
function setup() {
  const dir = tempDir()
  const root = company(dir)
  const g = new CompanyGit(root, path.join(dir, "worktrees"))
  return { dir, root, g, store: new GitProfileStore(g, "minh") }
}

const subject = (root: string) => git(root, "log", "-1", "--format=%s")
const count = (root: string) => Number(git(root, "rev-list", "--count", "HEAD"))
const hash = (text: string) => profileHash(new TextEncoder().encode(text))
const read = (root: string, rel = PROFILE) => fs.readFileSync(path.join(root, rel), "utf8")

/** What `promise` rejects with, or null if it fulfils. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (caught: unknown) => caught,
  )

/** A write by the owner, as the profile routes make one; resolves to the new version. */
const write = async (store: GitProfileStore, text: string, baseVersion: string, changeId = "c-1") =>
  (await store.write(text, { baseVersion, changeId, author: OWNER, source: "ngocbh via profile edit" })).version

/** The change `session` has in its history, newest first, as `[op, path, author]`. */
async function history(session: MemorySession): Promise<unknown[][]> {
  return (await session.history({ limit: 10 })).map((change) => [change.op, change.target.path, change.author])
}

// Settings

test("the settings are fixed, give every cap, and let a profile fill the memory", () => {
  expect(PROFILE_SETTINGS).toEqual({
    maxFileChars: 1_000_000,
    maxRecallChars: 1_000_000,
    maxTotalChars: 1_000_000,
    maxHistoryChars: 1_000_000,
    maxFiles: 1_000,
    maxDepth: 4,
    maxReadChars: 20_000,
    maxResults: 100,
    maxUndo: 100,
    maxChangeIds: 10_000,
    lockTimeoutMs: 30_000,
  })
  expect(PROFILE_MAX_CHARS).toBe(1_000_000)
})

test("the memory is minh's identity with profile.md as its index", async () => {
  const { store } = setup()
  const session = await store.fileMemory().open({ create: true, itemType: null, signal: SIGNAL })
  expect(session.info.identity).toBe("people/minh")
  expect(session.info.settings).toMatchObject({ max_file_chars: 1_000_000n, max_recall_chars: 1_000_000n })
  expect(session.info.settings.index).toBe("profile.md")
  expect((await session.snapshot()).recall).toEqual({ text: MINH, cut: null, hint: null })
  await session.close()
})

// Reads

test("constructor does no io", () => {
  const dir = tempDir()
  const recording = recordingGit(dir)
  const g = new CompanyGit(path.join(dir, "missing"), path.join(dir, "worktrees"), { git: recording.git })
  new GitProfileStore(g, "minh")
  expect(recording.calls()).toEqual([])
})

test.each([[""], ["../minh"], ["minh/x"], ["Minh"], ["a_b"], ["-minh"]])("constructor refuses a bad handle [%s]", (handle) => {
  const g = new CompanyGit(path.join(tempDir(), "missing"), path.join(tempDir(), "worktrees"))
  expect(() => new GitProfileStore(g, handle)).toThrow(/not a handle/)
})

test("read returns the text and its FileMemory hash", async () => {
  const { store } = setup()
  expect(await store.read()).toEqual({ text: MINH, version: hash(MINH) })
})

test("read commits a pending hand edit first", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "# Minh\nlikes tests\n")
  expect(await store.read()).toEqual({ text: "# Minh\nlikes tests\n", version: hash("# Minh\nlikes tests\n") })
  expect(subject(root)).toBe("profile(@minh): hand edit")
  expect(git(root, "status", "--porcelain")).toBe("")
})

test("read keeps crlf and a byte order mark", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "﻿# Minh\r\n")
  expect(await store.read()).toEqual({ text: "﻿# Minh\r\n", version: hash("﻿# Minh\r\n") })
})

test("a missing profile reads as empty", async () => {
  const { root, store } = setup()
  git(root, "rm", "-q", PROFILE)
  git(root, "commit", "-q", "-m", "drop")
  expect(await store.read()).toEqual({ text: "", version: EMPTY_VERSION })
  expect(EMPTY_VERSION).toBe(hash(""))
})

test("a non utf8 profile is unreadable", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), Buffer.from("# M\xffinh\n", "latin1"))
  const error = await rejection(store.read())
  expect(error).toBeInstanceOf(ProfileUnreadable)
  expect((error as Error).message).toBe("people/minh/memory/profile.md is not UTF-8")
})

test("a profile over the memory's file cap is unreadable and says why", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "é".repeat(PROFILE_MAX_CHARS + 1))
  const error = await rejection(store.read())
  expect(error).toBeInstanceOf(ProfileUnreadable)
  expect((error as Error).message).toBe(
    "people/minh/memory/profile.md holds 1000001 characters, more than the 1000000 a profile may hold; " +
      "chats leave it out until it is shortened by hand",
  )
  // Its bytes alone are over: a character takes at most four.
  fs.writeFileSync(path.join(root, PROFILE), "x".repeat(4 * PROFILE_MAX_CHARS + 1))
  expect(((await rejection(store.read())) as Error).message).toMatch(/^people\/minh\/memory\/profile.md holds more than/)
  fs.writeFileSync(path.join(root, PROFILE), "é".repeat(PROFILE_MAX_CHARS))
  expect((await store.read()).text).toHaveLength(PROFILE_MAX_CHARS)
})

test("a hard-linked profile is unreadable", async () => {
  const { dir, root, store } = setup()
  fs.linkSync(path.join(root, PROFILE), path.join(dir, "elsewhere.md"))
  const error = await rejection(store.read())
  expect(error).toBeInstanceOf(ProfileUnreadable)
  expect((error as Error).message).toBe("people/minh/memory/profile.md is a hard link; replace it with a copy")
})

test("read refuses a symlinked profile and commits nothing", async () => {
  const { dir, root, store } = setup()
  const outside = path.join(dir, "outside.md")
  fs.writeFileSync(outside, MINH)
  fs.unlinkSync(path.join(root, PROFILE))
  fs.symlinkSync(outside, path.join(root, PROFILE))
  const head = git(root, "rev-parse", "HEAD")
  const error = await rejection(store.read())
  expect(error).toBeInstanceOf(ProfileUnreadable)
  expect((error as Error).message).toBe("people/minh/memory/profile.md is a symlink, not a regular file")
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

/** Replaces minh's profile.md with a folder holding a file. */
function folderProfile(root: string): void {
  fs.rmSync(path.join(root, PROFILE))
  fs.mkdirSync(path.join(root, PROFILE))
  fs.writeFileSync(path.join(root, PROFILE, "x"), "x\n")
}

test("read and write refuse a folder at profile.md", async () => {
  const { root, store } = setup()
  folderProfile(root)
  for (const call of [store.read(), write(store, "x\n", hash(MINH))]) {
    const error = await rejection(call)
    expect(error).toBeInstanceOf(ProfileUnreadable)
    expect((error as Error).message).toBe("people/minh/memory/profile.md is not a regular file")
  }
})

test.each([
  ["memory", "a symlink", "people/minh/memory is a symlink, not a folder"],
  ["memory", "a file", "people/minh/memory is not a folder"],
  ["person", "a symlink", "people/minh is a symlink, not a folder"],
])("read, write and the memory refuse a %s folder that is %s", async (which, kind, message) => {
  const { dir, root, store } = setup()
  const rel = which === "memory" ? "people/minh/memory" : "people/minh"
  const outside = path.join(dir, "outside")
  fs.renameSync(path.join(root, rel), outside)
  if (kind === "a symlink") fs.symlinkSync(outside, path.join(root, rel))
  else fs.writeFileSync(path.join(root, rel), "x\n")
  const head = git(root, "rev-parse", "HEAD")
  const open = store.memory().open({ create: true, itemType: null, signal: SIGNAL })
  for (const call of [store.read(), write(store, "pwned\n", hash(MINH)), open]) {
    const error = await rejection(call)
    expect(error).toBeInstanceOf(ProfileUnreadable)
    expect((error as Error).message).toBe(message)
  }
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
  const left = which === "memory" ? outside : path.join(outside, "memory")
  expect(fs.readdirSync(left)).toEqual(["profile.md"])
})

test("another person's symlinked memory folder doesn't stop a read or a write", async () => {
  const { dir, root, g } = setup()
  fs.renameSync(path.join(root, "people/minh/memory"), path.join(dir, "elsewhere"))
  fs.symlinkSync(path.join(dir, "elsewhere"), path.join(root, "people/minh/memory"))
  const ngoc = new GitProfileStore(g, "ngocbh")
  expect(await ngoc.read()).toEqual({ text: "", version: EMPTY_VERSION })
  expect(await write(ngoc, "# Ngoc\n", EMPTY_VERSION)).toBe(hash("# Ngoc\n"))
})

test("a git failure passes through", async () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "not-a-repo"))
  const g = new CompanyGit(path.join(dir, "not-a-repo"), path.join(dir, "worktrees"))
  const error = await rejection(new GitProfileStore(g, "minh").read())
  expect(error).toBeInstanceOf(CompanyGitError)
})

// The commit message

test("commit messages are one line", () => {
  expect(commitMessage("minh", "ngocbh via profile edit")).toBe("profile(@minh): ngocbh via profile edit")
  expect(commitMessage("minh\n\nCommit-Id: x", "a\nb  c\x1c\0d")).toBe("profile(@minh Commit-Id: x): a b c d")
})

// Writes

test("a write rewrites the profile as the owner and commits it", async () => {
  const { root, store } = setup()
  const version = await write(store, "# Minh\nterse\n", hash(MINH))
  expect(version).toBe(hash("# Minh\nterse\n"))
  expect(read(root)).toBe("# Minh\nterse\n")
  expect(subject(root)).toBe("profile(@minh): ngocbh via profile edit")
  expect(git(root, "status", "--porcelain")).toBe("")
  // The memory's own files are never committed.
  expect(git(root, "ls-files", "people/minh/memory")).toBe(PROFILE)
  const session = await store.fileMemory().open({ create: false, itemType: null, signal: SIGNAL })
  expect(await history(session)).toEqual([["rewrite", "profile.md", OWNER]])
  await session.close()
})

test("a stale base is a conflict with both versions and writes nothing", async () => {
  const { root, store } = setup()
  const stale = hash("old\n")
  const head = git(root, "rev-parse", "HEAD")
  const error = await rejection(write(store, "x\n", stale))
  expect(error).toBeInstanceOf(ProfileConflict)
  expect(error).toMatchObject({ expected: stale, current: hash(MINH) })
  expect(read(root)).toBe(MINH)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

test("a hand edit makes the base stale and is committed as one", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "# Minh\nby hand\n")
  const error = await rejection(write(store, "# Minh\nby model\n", hash(MINH)))
  expect(error).toMatchObject({ expected: hash(MINH), current: hash("# Minh\nby hand\n") })
  expect(read(root)).toBe("# Minh\nby hand\n")
  expect(subject(root)).toBe("profile(@minh): hand edit")
})

test("a hand edit just before the change is a conflict and is kept", async () => {
  const { root, g } = setup()
  /** Edits the profile by hand after the hand edits are committed, before the memory changes it. */
  class HandEditing extends GitProfileStore {
    override committed<T>(change: () => Promise<T>, changed: (result: T) => string | null, source: string) {
      return super.committed(
        () => {
          fs.writeFileSync(path.join(root, PROFILE), "# Minh\nby hand\n")
          return change()
        },
        changed,
        source,
      )
    }
  }
  const error = await rejection(write(new HandEditing(g, "minh"), "# Minh\nby model\n", hash(MINH)))
  expect(error).toMatchObject({ expected: hash(MINH), current: hash("# Minh\nby hand\n") })
  expect(read(root)).toBe("# Minh\nby hand\n")
  expect(git(root, "status", "--porcelain")).toBe(`M ${PROFILE}`)
})

test("the empty base creates a missing profile and its memory folder", async () => {
  const { root, store } = setup()
  git(root, "rm", "-q", PROFILE)
  git(root, "commit", "-q", "-m", "drop")
  expect(fs.existsSync(path.join(root, "people/minh/memory"))).toBe(false)
  expect(await write(store, "# Minh\n", EMPTY_VERSION)).toBe(hash("# Minh\n"))
  expect(git(root, "show", `HEAD:${PROFILE}`)).toBe("# Minh")
  expect(git(root, "status", "--porcelain")).toBe("")
  // Any other base finds no profile to rewrite.
  git(root, "rm", "-q", PROFILE)
  git(root, "commit", "-q", "-m", "drop again")
  const error = await rejection(write(store, "x\n", hash(MINH), "c-2"))
  expect(error).toMatchObject({ expected: hash(MINH), current: EMPTY_VERSION })
})

test("the empty base rewrites an empty profile", async () => {
  const { root, store } = setup()
  fs.writeFileSync(path.join(root, PROFILE), "")
  expect(await write(store, "# Minh\n", EMPTY_VERSION)).toBe(hash("# Minh\n"))
})

test("unchanged text makes no commit", async () => {
  const { root, store } = setup()
  const before = count(root)
  expect(await write(store, MINH, hash(MINH))).toBe(hash(MINH))
  expect(count(root)).toBe(before)
})

test("a retried change id returns its version and commits nothing, even after a later write", async () => {
  const { root, store } = setup()
  const first = await write(store, "# Minh\nv1\n", hash(MINH), "proposal-1")
  const before = count(root)
  expect(await write(store, "# Minh\nv1\n", hash(MINH), "proposal-1")).toBe(first)
  expect(count(root)).toBe(before)
  await write(store, "# Minh\nv2\n", first, "c-2")
  expect(await write(store, "# Minh\nv1\n", hash(MINH), "proposal-1")).toBe(first)
  expect(read(root)).toBe("# Minh\nv2\n")
})

test("a retried create returns its version once the profile exists", async () => {
  const { root, store } = setup()
  git(root, "rm", "-q", PROFILE)
  git(root, "commit", "-q", "-m", "drop")
  const first = await write(store, "# Minh\n", EMPTY_VERSION, "proposal-1")
  expect(await write(store, "# Minh\n", EMPTY_VERSION, "proposal-1")).toBe(first)
})

test("change ids are per profile", async () => {
  const { g, store } = setup()
  await write(store, "# Minh\nv1\n", hash(MINH), "c-1")
  const boss = new GitProfileStore(g, "ngocbh")
  expect(await write(boss, "# Boss\n", EMPTY_VERSION, "c-1")).toBe(hash("# Boss\n"))
})

test("text over the memory's file cap is refused and writes nothing", async () => {
  const { root, store } = setup()
  const head = git(root, "rev-parse", "HEAD")
  const error = await rejection(write(store, "x".repeat(PROFILE_MAX_CHARS + 1), hash(MINH)))
  expect(error).toBeInstanceOf(ProfileRefused)
  expect((error as Error).message).toBe("`profile.md` would hold 1000001 characters; a file may hold 1000000")
  expect(read(root)).toBe(MINH)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

test("a lone surrogate or a non string is refused and writes nothing", async () => {
  const { root, store } = setup()
  await expect(write(store, "# Minh\ud800\n", hash(MINH))).rejects.toThrow(RangeError)
  await expect(write(store, Buffer.from("x") as unknown as string, hash(MINH))).rejects.toThrow(TypeError)
  await expect(write(store, "x\n", Buffer.from(hash(MINH)) as unknown as string)).rejects.toThrow(TypeError)
  expect(read(root)).toBe(MINH)
})

test("two concurrent writes with one base: one wins", async () => {
  const { g } = setup()
  const stores = ["a", "b"].map(() => new GitProfileStore(g, "minh"))
  const results = await Promise.allSettled(stores.map((s, i) => write(s, `# Minh\n${i}\n`, hash(MINH), `c-${i}`)))
  const won = results.filter((r) => r.status === "fulfilled")
  const lost = results.filter((r) => r.status === "rejected")
  expect([won.length, lost.length]).toEqual([1, 1])
  expect(lost[0]!.reason).toBeInstanceOf(ProfileConflict)
  expect((await stores[0]!.read()).version).toBe(won[0]!.value)
})

test("writes leave pinned worktrees alone", async () => {
  const { g, store } = setup()
  const pin = await g.pin("HEAD")
  await write(store, "# Minh\nnew\n", hash(MINH))
  expect(read(pin)).toBe(MINH)
})

test("a failed commit leaves the change for the hand-edit sweep", async () => {
  const { dir, root, store } = setup()
  const failing = new GitProfileStore(
    new CompanyGit(root, path.join(dir, "worktrees"), {
      git: failingGit(dir, "--cleanup=whitespace", "echo 'fatal: boom' >&2; exit 128"),
    }),
    "minh",
  )
  expect(await write(failing, "# Minh\nv1\n", hash(MINH))).toBe(hash("# Minh\nv1\n"))
  expect(read(root)).toBe("# Minh\nv1\n")
  expect(git(root, "status", "--porcelain")).toBe(`M ${PROFILE}`)
  expect((await store.read()).version).toBe(hash("# Minh\nv1\n"))
  expect(subject(root)).toBe("profile(@minh): hand edit")
})

test("a write to a profile with an unresolved conflict is refused and the conflict kept", async () => {
  const { root, store } = setup()
  stashPopConflict(root, PROFILE)
  const conflicted = fs.readFileSync(path.join(root, PROFILE))
  const error = await rejection(write(store, "# Minh\nv1\n", profileHash(conflicted)))
  expect(error).toBeInstanceOf(CompanyRepoBusy)
  expect(repoBusy(error)?.status).toBe(409)
  expect(git(root, "ls-files", "-u")).toContain(PROFILE)
  expect(fs.readFileSync(path.join(root, PROFILE))).toEqual(conflicted)
})

// The memory a run binds

/** An agent's append to `notes.md` in run r1, as a run's memory tool makes it. */
const AGENT: Author = { kind: "agent", name: "chat#0/reply", run: "r1", node: "chat#0/reply" }
const APPEND = { op: "append", path: "notes.md", text: "likes tests" }

test("a run opens the folder as yian's FileMemory; the office never resets it through the run's memory", async () => {
  const { root, store } = setup()
  const memory = store.memory()
  expect((memory.constructor as typeof FileMemory).contract).toBe(FileMemory.contract)
  const session = await memory.open({ create: true, itemType: null, signal: SIGNAL })
  expect([session.info.identity, (await session.snapshot()).recall.text]).toEqual(["people/minh", MINH])
  await session.close()
  await expect(memory.reset({ signal: SIGNAL })).rejects.toThrow("the office doesn't reset a profile")
  expect(read(root)).toBe(MINH)
})

test("a change the commit missed is picked up as a hand edit", async () => {
  const { root, store } = setup()
  // A crash between a change and its commit: the change is on disk, uncommitted.
  const session = await store.fileMemory().open({ create: true, itemType: null, signal: SIGNAL })
  await session.apply({ id: "a-1", change: APPEND, author: AGENT, signal: SIGNAL })
  await session.close()
  expect(git(root, "status", "--porcelain")).toBe("?? people/minh/memory/notes.md")
  await store.read()
  expect(subject(root)).toBe("profile(@minh): hand edit")
  expect(git(root, "status", "--porcelain")).toBe("")
})

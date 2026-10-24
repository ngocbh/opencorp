/** The office's clone of the company repo (Python's `tests/company/test_git.py`). */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { CompanyGit, CompanyGitError, type CompanyGitOptions } from "../../src/company/git.ts"
import { tempDir } from "../helpers.ts"
import { company, git, gitEnv, gitInput, writeRepo } from "./helpers.ts"

setDefaultTimeout(30_000)

const PROFILE = "people/minh/profile.md"
const OFFICE = "OpenCorp office <office@opencorp.local>"
const GROUP = "id: eng\nname: Eng\nparent: null\nhead: null\n"
const GIT_URL = new URL("../../src/company/git.ts", import.meta.url).href

/** A base company in a fresh temp dir and a `CompanyGit` on it built with `options`. */
function setup(options?: CompanyGitOptions) {
  const tmp = tempDir()
  const root = company(tmp)
  return { tmp, company: root, g: new CompanyGit(root, path.join(tmp, "worktrees"), options) }
}

/** A `git` script in `dir` that logs each call (whether its stdin is `/dev/null`, then its args) to
 *  `dir/calls` and runs the real git. */
function recordingGit(dir: string) {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
  const script = path.join(dir, "git")
  const log = path.join(dir, "calls")
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      "if [ -c /dev/stdin ] && [ ! -t 0 ]; then s=null; else s=other; fi",
      `{ printf '%s' "$s"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}`,
      `exec ${JSON.stringify(real)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return {
    git: script,
    calls(): { stdin: string; args: string[] }[] {
      if (!fs.existsSync(log)) return []
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [stdin, ...args] = line.split("\t")
          return { stdin: stdin!, args }
        })
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("the test helpers git reads only the repos own config and runs no hooks", () => {
  expect(
    gitEnv({ PATH: "/usr/bin:/bin", HOME: "/h", GIT_DIR: "/x", GIT_CONFIG_GLOBAL: "/g", GIT_AUTHOR_NAME: "a" }),
  ).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })

  const root = company()
  const origins = git(root, "config", "--list", "--show-origin").split("\n")
  expect(origins.filter((line) => !/^(file:\.git\/config|command line:)\t/.test(line))).toEqual([])

  fs.mkdirSync(path.join(root, ".git/hooks"), { recursive: true })
  for (const hook of ["pre-commit", "commit-msg"]) {
    fs.writeFileSync(path.join(root, ".git/hooks", hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  }
  git(root, "commit", "-q", "--allow-empty", "-m", "x")
  expect(git(root, "log", "-1", "--format=%s")).toBe("x")

  expect(git(root, "config", "core.excludesFile")).toBe("/dev/null")
  expect(git(root, "config", "core.attributesFile")).toBe("/dev/null")
})

test("git never reads the daemons stdin", () => {
  // Under tmux the daemon's stdin is the pane, and a git that read it would block holding the lock.
  const dir = tempDir()
  const root = company(dir)
  const recording = recordingGit(dir)
  const child = path.join(dir, "child.ts")
  fs.writeFileSync(
    child,
    [
      `import { CompanyGit } from ${JSON.stringify(GIT_URL)}`,
      "const [root, wt, git] = process.argv.slice(2)",
      "const g = new CompanyGit(root, wt, { git })",
      `const id = await g.blobId(${JSON.stringify(PROFILE)})`,
      "if (id === null) throw new Error('no blob')",
      "await g.readBlob(id)",
      `await g.readBlobs([await g.blobId(${JSON.stringify(PROFILE)})])`,
      "",
    ].join("\n"),
  )
  const result = spawnSync(
    process.execPath,
    ["--no-install", "--no-env-file", "--config=/dev/null", child, root, path.join(dir, "wt"), recording.git],
    { input: "daemon stdin\n", env: gitEnv(), timeout: 30_000, encoding: "utf8" },
  )
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  const calls = recording.calls()
  expect(calls).toHaveLength(4)
  for (const call of calls) expect(call.stdin).toBe(call.args.includes("--batch") ? "other" : "null")
  expect(calls.filter((call) => call.args.includes("--batch"))).toHaveLength(1)
})

test("blob id ignores other files", async () => {
  const { company, g } = setup()
  const before = await g.blobId(PROFILE)
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  await g.commit(["groups/eng.yaml"], "edit group")
  expect(await g.blobId(PROFILE)).toBe(before)
  expect(await g.blobId("people/nobody/profile.md")).toBeNull()
})

test("read head follows loose and packed refs and a detached head", async () => {
  const { company, g } = setup()
  expect(await g.readHead()).toBe(await g.head())
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  await g.commit(["groups/eng.yaml"], "edit group")
  expect(await g.readHead()).toBe(await g.head())
  git(company, "pack-refs", "--all")
  expect(fs.existsSync(path.join(company, ".git/refs/heads/main"))).toBe(false)
  expect(await g.readHead()).toBe(await g.head())
  git(company, "checkout", "-q", "--detach", "HEAD~1")
  const head = await g.readHead()
  expect(head).toBe(await g.head())
  expect(head).toBe(git(company, "rev-parse", "HEAD"))
})

test("read head with no commit is a value error", async () => {
  const dir = tempDir()
  git(dir, "init", "-q", "-b", "main")
  await expect(new CompanyGit(dir, path.join(dir, "wt")).readHead()).rejects.toThrow(RangeError)
})

test("read blobs reads several at once and skips what it cant", async () => {
  const { company, g } = setup()
  const profile = (await g.blobId(PROFILE))!
  const person = (await g.blobId("people/minh/person.yaml"))!
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\r\n\n")
  await g.commit([PROFILE], "crlf")
  const crlf = (await g.blobId(PROFILE))!
  const found = await g.readBlobs([profile, await g.head(), crlf, "0".repeat(40), person, "HEAD:company.yaml", profile])
  expect(found).toEqual(
    new Map([
      [profile, (await g.readBlob(profile))!],
      [crlf, Buffer.from("# Minh\r\n\n")],
      [person, (await g.readBlob(person))!],
    ]),
  )
  expect(await g.readBlobs([])).toEqual(new Map())
  // A broken clone that stops before every header is read fails, as Python's `out.index` raised
  const broken = path.join(tempDir(), "git")
  fs.writeFileSync(broken, "#!/bin/sh\necho broken >&2\nexit 1\n", { mode: 0o755 })
  const failing = new CompanyGit(company, path.join(tempDir(), "worktrees"), { git: broken })
  await expect(failing.readBlobs([profile])).rejects.toThrow(CompanyGitError)
  await expect(failing.readBlobs([profile])).rejects.toThrow(/broken/)
})

test("commit with no change returns head", async () => {
  const { company, g } = setup()
  const head = await g.head()
  fs.writeFileSync(path.join(company, PROFILE), "# Minh, Engineer\n") // same text
  expect(await g.commit([PROFILE], "no-op")).toBe(head)
})

test("lock serializes writers", async () => {
  const { company, g } = setup()
  const file = path.join(company, PROFILE)
  const write = (line: string) =>
    g.locked(async (locked) => {
      const text = fs.readFileSync(file, "utf8")
      await sleep(50)
      fs.writeFileSync(file, text + line + "\n")
      await locked.commit([PROFILE], `add ${line}`)
    })
  await Promise.all([write("a"), write("b")])
  expect(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(1).sort()).toEqual(["a", "b"])
  expect(git(company, "log", "--format=%s").split("\n")).toHaveLength(3)
})

test("a locked section calling a locking method throws instead of deadlocking", async () => {
  const { company, g } = setup()
  const edit = (line: string) => fs.appendFileSync(path.join(company, PROFILE), `${line}\n`)
  await expect(
    g.locked(async (locked) => {
      edit("a")
      await locked.commit([PROFILE], "a")
      edit("b")
      return g.commit([PROFILE], "b")
    }),
  ).rejects.toThrow(/not reentrant/)
  expect(await g.locked(async () => 1)).toBe(1)

  let later: Promise<string> | undefined
  await g.locked(async () => {
    later = sleep(50).then(() => {
      edit("c")
      return g.commit([PROFILE], "c")
    })
  })
  await later
  expect(git(company, "log", "--format=%s").split("\n").slice(0, 2)).toEqual(["c", "a"])
})

test("pin is frozen at its commit", async () => {
  const { company, g } = setup()
  const commit = await g.head()
  const pinned = await g.pin(commit)
  fs.writeFileSync(path.join(company, PROFILE), "# changed\n")
  await g.commit([PROFILE], "profile(@minh): test")
  expect(fs.readFileSync(path.join(pinned, PROFILE), "utf8")).toBe("# Minh, Engineer\n")
  expect(await g.pin(commit)).toBe(pinned) // cached
})

test("pin is read only", async () => {
  const { g } = setup()
  const mode = fs.statSync(path.join(await g.pin(await g.head()), "shared/flows/chat.yaml")).mode
  expect(mode & 0o222).toBe(0)
})

test("pin keys by full sha", async () => {
  const { g } = setup()
  const head = await g.head()
  expect(path.basename(await g.pin("HEAD"))).toBe(head)
  expect(path.basename(await g.pin("main"))).toBe(head)
})

test("pin unknown commit raises", async () => {
  const { g } = setup()
  await expect(g.pin("0".repeat(40))).rejects.toThrow(RangeError)
})

test("pin rebuilds a deleted dir", async () => {
  const { g } = setup()
  const pinned = await g.pin("HEAD")
  fs.rmSync(pinned, { recursive: true, force: true })
  expect(fs.statSync(path.join(await g.pin("HEAD"), PROFILE)).isFile()).toBe(true)
})

test("pin rebuilds a dir without marker", async () => {
  const { g } = setup()
  let pinned = await g.pin("HEAD")
  fs.unlinkSync(path.join(pinned, ".opencorp-pin"))
  fs.chmodSync(path.join(pinned, PROFILE), 0o644) // as if the crash came before chmod
  pinned = await g.pin("HEAD")
  expect(fs.statSync(path.join(pinned, PROFILE)).mode & 0o200).toBe(0)
})

test("pin leaves symlink targets alone", async () => {
  const { tmp, company, g } = setup()
  const outside = path.join(tmp, "outside.txt")
  fs.writeFileSync(outside, "mine\n")
  fs.symlinkSync(outside, path.join(company, "link.txt"))
  await g.commit(["link.txt"], "add link")
  await g.pin("HEAD")
  expect(fs.statSync(outside).mode & 0o200).not.toBe(0)
})

test("pin leaves files under a symlinked folder alone and survives a symlink loop", async () => {
  const { tmp, company, g } = setup()
  const outside = path.join(tmp, "outside")
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, "f.txt"), "mine\n", { mode: 0o644 })
  fs.symlinkSync(outside, path.join(company, "linkdir"))
  fs.symlinkSync(".", path.join(company, "loop"))
  await g.commit(["linkdir", "loop"], "links")
  const pinned = await g.pin("HEAD")
  expect(fs.lstatSync(path.join(pinned, "linkdir")).isSymbolicLink()).toBe(true)
  expect(fs.lstatSync(path.join(pinned, "loop")).isSymbolicLink()).toBe(true)
  expect(fs.statSync(path.join(outside, "f.txt")).mode & 0o200).not.toBe(0)
  expect(fs.statSync(path.join(pinned, PROFILE)).mode & 0o222).toBe(0)
})

test("hand edit is committed with handle", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\nlikes tests\n")
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "log", "-1", "--format=%s")).toBe("profile(@minh): hand edit")
  expect(git(company, "status", "--porcelain")).toBe("")
})

test("other dirty files stay dirty", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  expect(await g.commitHandEdits()).toEqual([])
  expect(git(company, "status", "--porcelain")).toBe("M groups/eng.yaml")
})

test("new profile is committed", async () => {
  const { company, g } = setup()
  fs.mkdirSync(path.join(company, "people/ava"))
  fs.writeFileSync(path.join(company, "people/ava/person.yaml"), "handle: ava\n")
  fs.writeFileSync(path.join(company, "people/ava/profile.md"), "# Ava\n")
  expect(await g.commitHandEdits()).toEqual(["people/ava/profile.md"])
  expect(git(company, "log", "-1", "--format=%s")).toBe("profile(@ava): hand edit")
  expect(git(company, "status", "--porcelain")).toBe("?? people/ava/person.yaml")
})

test("deleted profile is committed", async () => {
  const { company, g } = setup()
  fs.unlinkSync(path.join(company, PROFILE))
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "log", "-1", "--format=%s")).toBe("profile(@minh): hand edit")
  expect(git(company, "status", "--porcelain")).toBe("")
})

test("staged rename commits both paths", async () => {
  const { company, g } = setup()
  git(company, "mv", PROFILE, "people/ngocbh/profile.md")
  expect(await g.commitHandEdits()).toEqual([PROFILE, "people/ngocbh/profile.md"])
  expect(git(company, "status", "--porcelain")).toBe("")
  expect(await g.blobId(PROFILE)).toBeNull()
  expect(await g.blobId("people/ngocbh/profile.md")).not.toBeNull()
})

test("git dir in the environment is ignored", async () => {
  const other = writeRepo(path.join(tempDir(), "other"), { "x.txt": "x\n" })
  const { company, g } = setup({ env: { ...process.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other } })
  expect(await g.head()).toBe(git(company, "rev-parse", "HEAD"))
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit")
})

test("author env does not override the office", async () => {
  const leaked = {
    GIT_AUTHOR_NAME: "leaked",
    GIT_AUTHOR_EMAIL: "leaked",
    GIT_COMMITTER_NAME: "leaked",
    GIT_COMMITTER_EMAIL: "leaked",
  }
  const { company, g } = setup({ env: { ...process.env, ...leaked } })
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  expect(git(company, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(`${OFFICE}|${OFFICE}`)
})

test("user git config is ignored", async () => {
  const home = tempDir()
  fs.writeFileSync(path.join(home, ".gitconfig"), "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n")
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")))
  const { company, g } = setup({ env: { ...env, HOME: home } })
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit")
})

test("repo signing config is ignored", async () => {
  const { company, g } = setup()
  git(company, "config", "commit.gpgsign", "true")
  git(company, "config", "gpg.program", "false")
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit")
})

/** A `name` hook in `repo` that refuses whatever it is run for. */
function failingHook(repo: string, name: string) {
  fs.mkdirSync(path.join(repo, ".git/hooks"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".git/hooks", name), "#!/bin/sh\necho refused >&2\nexit 1\n", { mode: 0o755 })
}

test("repo hooks do not run", async () => {
  const { company, g } = setup()
  for (const name of ["pre-commit", "commit-msg", "post-checkout"]) failingHook(company, name)
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit")
  expect(fs.readFileSync(path.join(await g.pin("HEAD"), PROFILE), "utf8")).toBe("# edited\n")
})

test("git failure carries stderr", async () => {
  const { tmp, g } = setup()
  fs.writeFileSync(path.join(tmp, "outside.txt"), "x\n")
  const error = await g.commit(["../outside.txt"], "edit").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CompanyGitError)
  expect((error as Error).message).toMatch(/outside repository/)
})

test("worktree rename commits both paths", async () => {
  const { company, g } = setup()
  fs.mkdirSync(path.join(company, "people/ava"))
  fs.renameSync(path.join(company, PROFILE), path.join(company, "people/ava/profile.md"))
  git(company, "add", "-N", "people/ava/profile.md") // status now reports " R new\0old"
  expect(await g.commitHandEdits()).toEqual(["people/ava/profile.md", PROFILE])
  expect(git(company, "status", "--porcelain")).toBe("")
  expect(await g.blobId(PROFILE)).toBeNull()
  expect(await g.blobId("people/ava/profile.md")).not.toBeNull()
})

test("glob characters in paths are literal", async () => {
  const { company, g } = setup()
  const odd = "people/[mn]inh/profile.md"
  fs.mkdirSync(path.join(company, "people/[mn]inh"))
  fs.writeFileSync(path.join(company, odd), "# odd\n")
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([odd], "odd")
  expect(git(company, "show", "--name-only", "--format=", "HEAD")).toBe(odd)
  expect(git(company, "status", "--porcelain")).toBe(`M ${PROFILE}`)
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "show", "--name-only", "--format=", "HEAD")).toBe(PROFILE)
})

test("commit of no paths is a no op", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  git(company, "add", "groups/eng.yaml")
  const head = await g.head()
  expect(await g.commit([], "nothing")).toBe(head)
  expect(await g.locked((locked) => locked.commit([], "nothing"))).toBe(head)
  expect(git(company, "status", "--porcelain")).toBe("M  groups/eng.yaml")
})

test("broken symlink is committed not deleted", async () => {
  const { company, g } = setup()
  const link = path.join(company, "link")
  fs.symlinkSync("nowhere", link)
  await g.commit(["link"], "add link")
  expect(await g.blobId("link")).not.toBeNull()
  fs.unlinkSync(link)
  fs.symlinkSync("elsewhere", link)
  await g.commit(["link"], "move link")
  expect(git(company, "cat-file", "-p", "HEAD:link")).toBe("elsewhere")
})

test("non utf8 paths round trip", async () => {
  const { company, g } = setup()
  const odd = "people/b\udcffd/profile.md" // the byte 0xff, surrogate-escaped; APFS cannot hold it
  const blob = git(company, "hash-object", "-w", PROFILE)
  const entry = [Buffer.from(`100644 ${blob}\t`), Buffer.from("people/b\xffd/profile.md", "latin1"), Buffer.from("\n")]
  gitInput(company, Buffer.concat(entry), "update-index", "--add", "--index-info")
  git(company, "commit", "-q", "-m", "odd path")
  expect(await g.commitHandEdits()).toEqual([odd]) // absent from disk, so a deletion
  expect(await g.blobId(odd)).toBeNull()
  // quotePath prints the name as "people/b\377d/profile.md", so it is gone if no line holds people/b
  expect(git(company, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("people/b")
  expect(git(company, "status", "--porcelain")).toBe("")
})

test("handle falls back to id on non utf8 person", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, "people/minh/person.yaml"), Buffer.from("handle: m\xffinh\n", "latin1"))
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "log", "-1", "--format=%s")).toBe("profile(@minh): hand edit")
})

test("unrelated staged file stays staged", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  git(company, "add", "groups/eng.yaml")
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  fs.writeFileSync(path.join(company, PROFILE), "# edited again\n")
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "log", "-2", "--name-only", "--format=").split(/\s+/)).toEqual([PROFILE, PROFILE])
  expect(git(company, "status", "--porcelain")).toBe("M  groups/eng.yaml")
})

test("read blob returns exact bytes", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\r\nline\r\n")
  await g.commit([PROFILE], "crlf")
  expect(await g.readBlob((await g.blobId(PROFILE))!)).toEqual(Buffer.from("# Minh\r\nline\r\n"))
})

test.each(["0".repeat(40), "HEAD", "HEAD:company.yaml", "--help", "E69DE29BB2D1D6434B8B29AE775AD8C2E48C5391"])(
  "read blob refuses what is not a blob id here [%s]",
  async (ref) => {
    const { g } = setup()
    expect(await g.readBlob(ref)).toBeNull()
  },
)

test("read blob refuses a commit id", async () => {
  const { g } = setup()
  expect(await g.readBlob(await g.head())).toBeNull()
})

test("find commit matches a whole line on the path", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# one\n")
  const first = await g.commit([PROFILE], "profile(@minh): one\n\nCommit-Id: c-1")
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  await g.commit(["groups/eng.yaml"], "group\n\nCommit-Id: c-2")
  expect(await g.findCommit(PROFILE, "Commit-Id: c-1")).toBe(first)
  expect(await g.findCommit(PROFILE, "Commit-Id: c-")).toBeNull() // a prefix is not a match
  expect(await g.findCommit(PROFILE, "Commit-Id: c-2")).toBeNull() // another path's commit
  expect(await g.findCommit("groups/eng.yaml", "Commit-Id: c-2")).toBe(await g.head())
})

test("unstage keeps the working file", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# staged\n")
  git(company, "add", PROFILE)
  await g.unstage([PROFILE])
  expect(git(company, "status", "--porcelain")).toBe("M people/minh/profile.md")
  expect(fs.readFileSync(path.join(company, PROFILE), "utf8")).toBe("# staged\n")
})

test("a hand made directory name cannot forge a trailer", async () => {
  const { company, g } = setup()
  const rel = "people/m\n\nCommit-Id: c-1/profile.md"
  fs.mkdirSync(path.dirname(path.join(company, rel)))
  fs.writeFileSync(path.join(company, rel), "# M\n")
  expect(await g.commitHandEdits()).toEqual([rel])
  expect(git(company, "log", "-1", "--format=%B").trim()).toBe("profile(@m Commit-Id: c-1): hand edit")
})

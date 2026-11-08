/** The office's clone of the company repo (Python's `tests/company/test_git.py`). */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { stamp } from "@opencorp/protocol"
import { CompanyGit, CompanyGitError, type CompanyGitOptions, CompanyRepoBusy, oneLine } from "../../src/company/git.ts"
import { tempDir } from "../helpers.ts"
import {
  company,
  envGit,
  failingGit,
  GIT_FAILURES,
  git,
  gitEnv,
  gitInput,
  gitStatus,
  recordingGit,
  sequencerOnly,
  startCherryPick,
  startMerge,
  startRebaseStop,
  startRevert,
  stashPopConflict,
  writeRepo,
} from "./helpers.ts"

setDefaultTimeout(30_000)

const PROFILE = "people/minh/memory/profile.md"
const OFFICE = "OpenCorp office <office@opencorp.local>"
const GROUP = "id: eng\nname: Eng\nparent: null\nhead: null\n"
const GIT_URL = new URL("../../src/company/git.ts", import.meta.url).href

/** A base company in a fresh temp dir and a `CompanyGit` on it built with `options`. */
function setup(options?: CompanyGitOptions) {
  const tmp = tempDir()
  const root = company(tmp)
  return { tmp, company: root, g: new CompanyGit(root, path.join(tmp, "worktrees"), options) }
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
  expect(await g.blobId("people/nobody/memory/profile.md")).toBeNull()
})

test.each(GIT_FAILURES)("blob id throws when git fails instead of reporting a missing file [%s]", async (failure) => {
  const dir = tempDir()
  const root = company(dir)
  const g = new CompanyGit(root, path.join(dir, "worktrees"), { git: failingGit(dir, `:${PROFILE}`, failure) })
  await expect(g.blobId(PROFILE)).rejects.toThrow(CompanyGitError)
  expect(await g.blobId("company.yaml")).not.toBeNull()
  expect(await g.blobId("people/nobody/memory/profile.md")).toBeNull()
})

test("blob id with no commit yet is null", async () => {
  const dir = tempDir()
  git(dir, "init", "-q", "-b", "main")
  expect(await new CompanyGit(dir, path.join(dir, "wt")).blobId(PROFILE)).toBeNull()
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

test("files lists blobs under a folder at a commit", async () => {
  const { company, g } = setup()
  const head = await g.head()
  fs.mkdirSync(path.join(company, "people/ava"))
  fs.writeFileSync(path.join(company, "people/ava/person.yaml"), "handle: ava\n")
  await g.commit(["people/ava/person.yaml"], "add ava")
  const atHead = await g.files("people", head)
  expect([...atHead.keys()].sort()).toEqual([
    "people/minh/memory/profile.md",
    "people/minh/person.yaml",
    "people/ngocbh/person.yaml",
  ])
  expect(atHead.get(PROFILE)).toBe((await g.blobId(PROFILE))!)
  expect((await g.files("people")).has("people/ava/person.yaml")).toBe(true)
  expect(await g.files("nowhere")).toEqual(new Map())
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

test("a pinned full sha needs no git", async () => {
  const recording = recordingGit(tempDir())
  const { g } = setup({ git: recording.git })
  const head = await g.head()
  const dir = await g.pin(head)
  const n = recording.calls().length
  expect(await g.pin(head)).toBe(dir)
  expect(recording.calls().slice(n)).toEqual([])
  // Anything but a full lowercase sha is resolved first: on a case-insensitive volume an uppercase sha would
  // find the lowercase pin's marker.
  const others = ["HEAD", head.slice(0, 12), head.toUpperCase()]
  for (const commit of others) await g.pin(commit).catch(() => {})
  const revParses = recording.calls().slice(n).filter((c) => c.args.includes("rev-parse"))
  expect(revParses.map((c) => c.args.at(-1))).toEqual(others.map((commit) => `${commit}^{commit}`))
})

test("pinning an existing pin doesn't wait for the lock", async () => {
  const { g } = setup()
  const head = await g.head()
  const dir = await g.pin(head)
  let release!: () => void
  const held = g.locked(() => new Promise<void>((resolve) => (release = resolve)))
  expect(await g.pin(head)).toBe(dir)
  release()
  await held
}, 10_000)

test("pin inside a locked section rejects even when the pin exists", async () => {
  const { g } = setup()
  const head = await g.head()
  await g.pin(head)
  await expect(g.locked(() => g.pin(head))).rejects.toThrow(/not reentrant/)
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

/** Moves HEAD off its commit with a profile commit through `g`; returns the new HEAD. */
async function moveHead(company: string, g: CompanyGit, line: string): Promise<string> {
  fs.appendFileSync(path.join(company, PROFILE), `${line}\n`)
  return g.commit([PROFILE], `profile(@minh): ${line}`)
}

/** A pin of `commit` built through another `CompanyGit` on the same clone, so `g` has no stamp for it. */
function prebuilt(company: string, worktrees: string, commit: string): Promise<string> {
  return new CompanyGit(company, worktrees).pin(commit)
}

test("a cached pin refreshes its stamp", async () => {
  let t = 0
  const { company, g } = setup({ clock: () => t })
  const sha = await g.head()
  const dir = await g.pin(sha)
  await moveHead(company, g, "a")
  t = 600
  expect(await g.pin(sha)).toBe(dir) // cached
  t = 1100
  expect(await g.prune(() => [], { graceMs: 1000 })).toEqual({ removed: [], retryInMs: 500 })
  expect(fs.existsSync(dir)).toBe(true)
  t = 1600
  expect(await g.prune(() => [], { graceMs: 1000 })).toEqual({ removed: [sha], retryInMs: null })
  expect(fs.existsSync(dir)).toBe(false)
})

test("prune removes an unkept pin and unregisters it", async () => {
  const { company, g } = setup()
  const a = await g.head()
  const dir = await prebuilt(company, g.worktrees, a)
  await moveHead(company, g, "a")
  expect(git(company, "worktree", "list", "--porcelain")).toContain(dir)
  expect(await g.prune(() => [])).toEqual({ removed: [a], retryInMs: null })
  expect(fs.existsSync(dir)).toBe(false)
  expect(git(company, "worktree", "list", "--porcelain")).not.toContain(dir)
})

test("prune keeps a kept sha, head and a recently pinned sha", async () => {
  let t = 0
  const { company, g } = setup({ clock: () => t })
  const k = await g.head()
  await prebuilt(company, g.worktrees, k)
  const r = await moveHead(company, g, "r")
  await g.pin(r) // stamped at 0
  const h = await moveHead(company, g, "h")
  await prebuilt(company, g.worktrees, h)
  t = 10
  expect(await g.prune(() => [k], { graceMs: 1000 })).toEqual({ removed: [], retryInMs: 990 })
  for (const sha of [k, r, h]) expect(fs.existsSync(path.join(g.worktrees, sha, ".opencorp-pin"))).toBe(true)

  t = 5000 // r's window is over: only k and HEAD stay, and neither sets a retry
  expect(await g.prune(() => [k], { graceMs: 1000 })).toEqual({ removed: [r], retryInMs: null })
  expect(fs.readdirSync(g.worktrees).sort()).toEqual([k, h].sort())
})

test("prune leaves non-sha entries alone", async () => {
  const { company, g } = setup()
  const a = await g.head()
  await prebuilt(company, g.worktrees, a)
  await moveHead(company, g, "a")
  const others = ["notes", "ABCDEF".padEnd(40, "0"), "a".repeat(39)]
  for (const name of others) fs.mkdirSync(path.join(g.worktrees, name))
  fs.writeFileSync(path.join(g.worktrees, "b".repeat(40)), "a file named like a sha\n")
  expect((await g.prune(() => [])).removed).toEqual([a])
  expect(fs.readdirSync(g.worktrees).sort()).toEqual([...others, "b".repeat(40)].sort())
})

test("prune unlinks a sha-named symlink and keeps its target", async () => {
  const { tmp, g } = setup()
  const outside = path.join(tmp, "outside")
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, "f.txt"), "mine\n")
  fs.mkdirSync(g.worktrees)
  const link = path.join(g.worktrees, "c".repeat(40))
  fs.symlinkSync(outside, link)
  expect((await g.prune(() => [])).removed).toEqual(["c".repeat(40)])
  expect(fs.existsSync(link)).toBe(false)
  expect(fs.readFileSync(path.join(outside, "f.txt"), "utf8")).toBe("mine\n")
})

test("prune leaves symlink targets inside a removed pin alone", async () => {
  const { tmp, company, g } = setup()
  const outside = path.join(tmp, "outside")
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, "f.txt"), "mine\n", { mode: 0o644 })
  fs.symlinkSync(outside, path.join(company, "linkdir"))
  await g.commit(["linkdir"], "links")
  const dir = await prebuilt(company, g.worktrees, await g.head())
  await moveHead(company, g, "a")
  expect((await g.prune(() => [])).removed).toEqual([path.basename(dir)])
  expect(fs.existsSync(dir)).toBe(false)
  expect(fs.readFileSync(path.join(outside, "f.txt"), "utf8")).toBe("mine\n")
  expect(fs.statSync(path.join(outside, "f.txt")).mode & 0o777).toBe(0o644)
})

test("a pruned sha is rebuilt by pin", async () => {
  const { company, g } = setup()
  const a = await g.head()
  const dir = await g.pin(a)
  await moveHead(company, g, "a")
  expect((await g.prune(() => [], { graceMs: 0 })).removed).toEqual([a])
  expect(await g.pin(a)).toBe(dir)
  expect(fs.readFileSync(path.join(dir, ".opencorp-pin"), "utf8")).toBe(`${a}\n`)
  expect(fs.readFileSync(path.join(dir, PROFILE), "utf8")).toBe("# Minh, Engineer\n")
  expect(fs.statSync(path.join(dir, PROFILE)).mode & 0o222).toBe(0)
})

test("prune with no worktrees dir is a no op", async () => {
  const { g } = setup()
  expect(fs.existsSync(g.worktrees)).toBe(false)
  expect(await g.prune(() => [])).toEqual({ removed: [], retryInMs: null })
})

test("prune and pin of the same sha serialize on the lock", async () => {
  const { company, g } = setup()
  const a = await g.head()
  const dir = await prebuilt(company, g.worktrees, a)
  await moveHead(company, g, "a")
  // Whichever takes the lock first, the pin handed out is whole.
  const [pinned] = await Promise.all([g.pin(a), g.prune(() => [])])
  expect(pinned).toBe(dir)
  expect(fs.readFileSync(path.join(dir, ".opencorp-pin"), "utf8")).toBe(`${a}\n`)
  expect(fs.readFileSync(path.join(dir, PROFILE), "utf8")).toBe("# Minh, Engineer\n")
})

test("a cached pin raced against a prune hands out a whole dir", async () => {
  let t = 0
  let onClock: (() => void) | undefined
  const { company, g } = setup({
    clock: () => {
      onClock?.()
      return t
    },
  })
  const a = await g.head()
  const dir = await g.pin(a)
  await moveHead(company, g, "a")
  const whole = () =>
    fs.readFileSync(path.join(dir, ".opencorp-pin"), "utf8") === `${a}\n` &&
    fs.readFileSync(path.join(dir, PROFILE), "utf8") === "# Minh, Engineer\n"
  // The cached pin starts inside prune's section before its window check (so it is spared), just after the
  // check while the removal begins (so it waits and rebuilds), or after the prune (so it rebuilds).
  const cases = [
    ["before the check", []],
    ["after the check", [a]],
    ["after the prune", [a]],
  ] as const
  for (const [when, removed] of cases) {
    await g.pin(a)
    t += 5000 // past the window, so only the race can spare the pin
    const started = Promise.withResolvers<void>()
    const pruned = g.prune(
      () => {
        if (when === "before the check") started.resolve()
        // The next clock read is prune's window check, which marks the sha as removing in the same step.
        if (when === "after the check") {
          onClock = () => {
            onClock = undefined
            started.resolve()
          }
        }
        return []
      },
      { graceMs: 1000 },
    )
    if (when === "after the prune") await pruned
    else await started.promise
    expect(await g.pin(a)).toBe(dir)
    expect(whole()).toBe(true)
    expect((await pruned).removed).toEqual([...removed])
    expect(whole()).toBe(true)
  }
})

// chflags makes one file undeletable; Linux needs root for its counterpart. The rm visits ".a" before the marker,
// so without the marker going first the rm would stop with ".a/x" gone and the marker still there.
test.skipIf(process.platform !== "darwin")("a prune whose rm fails partway leaves the pin to be rebuilt", async () => {
  let stuck = ""
  // Registered before the temp dir's removal, which runs callbacks in registration order.
  onTestFinished(() => void (stuck && spawnSync("chflags", ["nouchg", stuck])))
  const { company, g } = setup()
  fs.mkdirSync(path.join(company, ".a"))
  for (const name of ["x", "y"]) fs.writeFileSync(path.join(company, ".a", name), `${name}\n`)
  await g.commit([".a"], "dot files")
  const a = await g.head()
  const dir = await prebuilt(company, g.worktrees, a)
  await moveHead(company, g, "a")
  stuck = path.join(dir, ".a", "y")
  expect(spawnSync("chflags", ["uchg", stuck]).status).toBe(0)
  await expect(g.prune(() => [])).rejects.toThrow()
  expect(spawnSync("chflags", ["nouchg", stuck]).status).toBe(0)
  expect(await g.pin(a)).toBe(dir)
  expect(fs.readFileSync(path.join(dir, ".a", "x"), "utf8")).toBe("x\n")
  expect(fs.readFileSync(path.join(dir, PROFILE), "utf8")).toBe("# Minh, Engineer\n")
})

test("prune stops at an aborted signal", async () => {
  const { company, g } = setup()
  const a = await g.head()
  const dir = await prebuilt(company, g.worktrees, a)
  await moveHead(company, g, "a")
  expect(await g.prune(() => [], { signal: AbortSignal.abort() })).toEqual({ removed: [], retryInMs: null })
  expect(fs.existsSync(dir)).toBe(true)
})

test("prune reads keep under the lock", async () => {
  const { company, g } = setup()
  const a = await g.head()
  await prebuilt(company, g.worktrees, a)
  await moveHead(company, g, "a")
  const order: string[] = []
  const held = g.locked(async () => {
    await sleep(50)
    order.push("held")
  })
  const pruned = g.prune(() => {
    order.push("keep")
    return [a]
  })
  await Promise.all([held, pruned])
  expect(order).toEqual(["held", "keep"])
  expect((await pruned).removed).toEqual([])
})

test("hand edit is committed with handle", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\nlikes tests\n")
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "log", "-1", "--format=%s")).toBe("profile(@minh): hand edit")
  expect(git(company, "status", "--porcelain")).toBe("")
})

test("any file in a memory folder is a hand edit named by the persons handle", async () => {
  const { company, g } = setup()
  const notes = "people/minh/memory/notes/tests.md"
  fs.mkdirSync(path.join(company, "people/minh/memory/notes"))
  fs.writeFileSync(path.join(company, notes), "Likes tests.\n")
  expect(await g.commitHandEdits()).toEqual([notes])
  expect(git(company, "log", "-1", "--format=%s")).toBe("profile(@minh): hand edit")
})

test("yian's .yian folders and files outside a memory folder are never hand edits", async () => {
  const { company, g } = setup()
  // Even in a clone that doesn't ignore .yian/, as a company's .gitignore does.
  fs.writeFileSync(path.join(company, ".git", "info", "exclude"), "")
  const tracked = "people/minh/memory/.yian/identity"
  fs.mkdirSync(path.join(company, "people/minh/memory/.yian"))
  fs.writeFileSync(path.join(company, tracked), "a\n")
  git(company, "add", "-f", tracked)
  git(company, "commit", "-q", "-m", "track a .yian file")
  fs.writeFileSync(path.join(company, tracked), "b\n")
  const untracked = ["people/minh/memory/.yian/journal.jsonl", "people/minh/memory/notes/.yian/lock"]
  fs.mkdirSync(path.join(company, "people/minh/memory/notes/.yian"), { recursive: true })
  for (const rel of untracked) fs.writeFileSync(path.join(company, rel), "x\n")
  const outside = "people/minh/profile.md"
  fs.writeFileSync(path.join(company, outside), "# Minh\n")
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\nedited\n")
  const head = await g.head()
  expect(await g.pending()).toEqual({ handEdits: [PROFILE], uncommitted: [tracked, ...untracked, outside].sort() })
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "rev-list", "--count", `${head}..HEAD`)).toBe("1")
  expect(git(company, "show", `HEAD:${tracked}`)).toBe("a")
})

test("other dirty files stay dirty", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  expect(await g.commitHandEdits()).toEqual([])
  expect(git(company, "status", "--porcelain")).toBe("M groups/eng.yaml")
})

test("new profile is committed", async () => {
  const { company, g } = setup()
  fs.mkdirSync(path.join(company, "people/ava/memory"), { recursive: true })
  fs.writeFileSync(path.join(company, "people/ava/person.yaml"), "handle: ava\n")
  fs.writeFileSync(path.join(company, "people/ava/memory/profile.md"), "# Ava\n")
  expect(await g.commitHandEdits()).toEqual(["people/ava/memory/profile.md"])
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
  fs.mkdirSync(path.join(company, "people/ngocbh/memory"))
  git(company, "mv", PROFILE, "people/ngocbh/memory/profile.md")
  expect(await g.commitHandEdits()).toEqual([PROFILE, "people/ngocbh/memory/profile.md"])
  expect(git(company, "status", "--porcelain")).toBe("")
  expect(await g.blobId(PROFILE)).toBeNull()
  expect(await g.blobId("people/ngocbh/memory/profile.md")).not.toBeNull()
})

test("git dir in the environment is ignored", async () => {
  const other = writeRepo(path.join(tempDir(), "other"), { "x.txt": "x\n" })
  const { company, g } = setup({ env: { ...process.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other } })
  expect(await g.head()).toBe(git(company, "rev-parse", "HEAD"))
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit")
})

test("init creates the repo on main with a clean env", async () => {
  const dir = tempDir()
  const other = writeRepo(path.join(tempDir(), "other"), { "x.txt": "x\n" })
  const before = git(other, "rev-parse", "HEAD")
  await new CompanyGit(dir, dir, { env: { ...process.env, GIT_DIR: path.join(other, ".git") } }).init()
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(true)
  expect([git(other, "rev-parse", "HEAD"), git(other, "status", "--porcelain")]).toEqual([before, ""])
  expect(git(dir, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
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

/** Rewrites HEAD in `root` as the same commit with a (fake) PGP signature; returns the new id. */
function signHead(root: string): string {
  const raw = git(root, "cat-file", "commit", "HEAD")
  const signature = "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----"
  const signed = raw.replace(/^(committer .*)$/m, `$1\n${signature}`) + "\n"
  const id = gitInput(root, Buffer.from(signed), "hash-object", "-t", "commit", "-w", "--stdin")
  git(root, "update-ref", "HEAD", id)
  return id
}

test("find commit and commit info never run a repo gpg program", async () => {
  const { tmp, company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "profile(@minh): x\n\nCommit-Id: c-1")
  const signed = signHead(company)
  const wire = tripwire(tmp, "exit 1")
  for (const key of ["gpg.program", "gpg.openpgp.program", "gpg.ssh.program", "gpg.x509.program"]) {
    git(company, "config", key, wire.script)
  }
  git(company, "config", "log.showSignature", "true")
  expect(await g.findCommit(PROFILE, "Commit-Id: c-1")).toBe(signed)
  expect((await g.commitInfo(signed)).subject).toBe("profile(@minh): x")
  expect(wire.tripped()).toBe(false)
})

/** The git subcommand of a recorded call: the first argument after `-C <root>` and the global options. */
function subcommand(args: string[]): string {
  let at = 2
  while (args[at]?.startsWith("--work-tree") || args[at] === "-c") at += args[at] === "-c" ? 2 : 1
  return args[at]!
}

test("every call but init pins the work tree, and reads never show a signature", async () => {
  const dir = tempDir()
  const recording = recordingGit(dir)
  const { company, g } = setup({ git: recording.git })
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  const head = await g.commit([PROFILE], "edit")
  await g.findCommit(PROFILE, "edit")
  await g.commitInfo(head)
  await g.pin(head)
  fs.mkdirSync(path.join(dir, "fresh"))
  await new CompanyGit(path.join(dir, "fresh"), dir, { git: recording.git }).init()
  const calls = recording.calls().map((call) => call.args)
  for (const args of calls) {
    expect(args.slice(0, 1)).toEqual(["-C"])
    expect(args[2] === "--work-tree=.").toBe(subcommand(args) !== "init")
  }
  expect(calls.filter((args) => subcommand(args) === "init")).not.toHaveLength(0)
  const logs = calls.filter((args) => subcommand(args) === "log")
  expect(logs).toHaveLength(2) // findCommit and commitInfo
  for (const args of logs) expect(args).toContain("--no-show-signature")
  expect(calls.find((args) => subcommand(args) === "commit")).toContain("--cleanup=whitespace")
})

test("a repo commit cleanup cannot strip the commit id trailer", async () => {
  const message = "profile(@minh): x\n\nCommit-Id: c-1"
  const plain = setup()
  const { company, g } = setup()
  git(company, "config", "commit.cleanup", "strip")
  git(company, "config", "core.commentChar", "C")
  for (const { company: root, g: each } of [plain, { company, g }]) {
    fs.writeFileSync(path.join(root, PROFILE), "# edited\n")
    await each.commit([PROFILE], message)
  }
  expect(await g.findCommit(PROFILE, "Commit-Id: c-1")).toBe(await g.head())
  const body = (root: string) => git(root, "cat-file", "commit", "HEAD").split("\n\n").slice(1).join("\n\n")
  expect(body(company)).toBe(message)
  expect(body(company)).toBe(body(plain.company))
})

test.each([[["core.bare", "false"]], [["core.bare", "true"]]])(
  "a repo core.worktree does not move the work tree [%j]",
  async (extra) => {
    const { tmp, company, g } = setup()
    const elsewhere = path.join(tmp, "elsewhere")
    fs.mkdirSync(path.join(elsewhere, "people/minh/memory"), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, PROFILE), "# elsewhere\n")
    git(company, "config", extra[0]!, extra[1]!)
    git(company, "config", "core.worktree", elsewhere)
    fs.writeFileSync(path.join(company, PROFILE), "# root\n")
    const head = await g.commit([PROFILE], "edit")
    expect((await g.readBlob((await g.blobId(PROFILE, head))!))!.toString()).toBe("# root\n")
    expect(fs.readFileSync(path.join(await g.pin("HEAD"), PROFILE), "utf8")).toBe("# root\n")
    expect(fs.readdirSync(elsewhere)).toEqual(["people"])
    expect(fs.readFileSync(path.join(elsewhere, PROFILE), "utf8")).toBe("# elsewhere\n")
  },
)

test("a repo commit and log encoding do not change what the office writes or reads", async () => {
  const { company, g } = setup()
  git(company, "config", "i18n.commitEncoding", "ISO-8859-1")
  git(company, "config", "i18n.logOutputEncoding", "ISO-8859-1")
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  const head = await g.commit([PROFILE], "profile(@minh): café\n\nCommit-Id: naïve")
  expect(git(company, "cat-file", "commit", "HEAD")).not.toMatch(/^encoding /m)
  expect((await g.commitInfo(head)).subject).toBe("profile(@minh): café")
  expect(await g.findCommit(PROFILE, "Commit-Id: naïve")).toBe(head)
})

/** A script in `dir` that leaves a mark each time it runs, then runs the shell `then`. */
function tripwire(dir: string, then: string) {
  const mark = path.join(dir, "tripped")
  const script = path.join(dir, "tripwire")
  fs.writeFileSync(script, `#!/bin/sh\necho x >> ${JSON.stringify(mark)}\n${then}\n`, { mode: 0o755 })
  return { script, tripped: () => fs.existsSync(mark) }
}

/** A `CompanyGit` on `root` whose `git commit` fails after its paths are staged; its stub lives in `dir`. */
function refusingCommit(dir: string, root: string): CompanyGit {
  return new CompanyGit(root, path.join(dir, "worktrees"), { git: failingGit(dir, "--cleanup=whitespace", "exit 1") })
}

test("a repo fsmonitor does not run", async () => {
  const { tmp, company, g } = setup()
  const wire = tripwire(tmp, "exit 1")
  git(company, "config", "core.fsmonitor", wire.script)
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  await g.commit(["groups/eng.yaml"], "edit group")
  // A commit that fails after staging resets what it staged.
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), `${GROUP}# again\n`)
  await expect(refusingCommit(tmp, company).commit(["groups/eng.yaml"], "again")).rejects.toThrow(CompanyGitError)
  expect(git(company, "-c", "core.fsmonitor=false", "diff", "--cached", "--name-only")).toBe("")
  await g.pin("HEAD")
  expect(wire.tripped()).toBe(false)
})

test.each(["clean", "smudge", "process"])("a repo filter driver does not run [%s]", async (key) => {
  const { tmp, company, g } = setup()
  const wire = tripwire(tmp, "exec cat")
  // A subsection may hold dots, `=` and capitals, which `-c name=value` can't carry, or be empty.
  for (const name of ["evil", "Evil.a=b", ""]) {
    git(company, "config", `filter.${name}.${key}`, wire.script)
    git(company, "config", `filter.${name}.required`, "true")
  }
  fs.mkdirSync(path.join(company, ".git/info"), { recursive: true })
  const attributes = "*.md filter=evil\n*.yaml filter=Evil.a=b\n*.txt filter=\n"
  fs.writeFileSync(path.join(company, ".git/info/attributes"), attributes)
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  fs.writeFileSync(path.join(company, "notes.txt"), "notes\n")
  await g.commit(["groups/eng.yaml", "notes.txt"], "edit group")
  const pinned = await g.pin("HEAD")
  // A commit that fails after staging resets what it staged.
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), `${GROUP}# again\n`)
  fs.writeFileSync(path.join(company, "notes.txt"), "notes again\n")
  const failing = refusingCommit(tmp, company)
  await expect(failing.commit(["groups/eng.yaml", "notes.txt"], "again")).rejects.toThrow(CompanyGitError)
  expect(git(company, "diff", "--cached", "--name-only")).toBe("")
  expect(wire.tripped()).toBe(false)
  expect(fs.readFileSync(path.join(pinned, PROFILE), "utf8")).toBe("# edited\n")
  expect(fs.readFileSync(path.join(pinned, "groups/eng.yaml"), "utf8")).toBe(GROUP)
  expect(fs.readFileSync(path.join(pinned, "notes.txt"), "utf8")).toBe("notes\n")
})

test("a filter driver whose name isnt utf8 is refused", async () => {
  const { tmp, company, g } = setup()
  const wire = tripwire(tmp, "exec cat")
  const name = Buffer.from("ev\xffl", "latin1")
  const config = path.join(company, ".git/config")
  fs.appendFileSync(config, Buffer.concat([Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = ${wire.script}\n`)]))
  fs.mkdirSync(path.join(company, ".git/info"), { recursive: true })
  const attributes = Buffer.concat([Buffer.from("*.md filter="), name, Buffer.from("\n")])
  fs.writeFileSync(path.join(company, ".git/info/attributes"), attributes)
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  const error = await g.commit([PROFILE], "edit").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CompanyGitError)
  expect((error as Error).message).toMatch(/isn't UTF-8/)
  expect(wire.tripped()).toBe(false)
})

test("the users xdg git attributes and ignore files are not read", async () => {
  const home = tempDir()
  const xdg = path.join(home, "xdg")
  for (const config of [path.join(xdg, "git"), path.join(home, ".config/git")]) {
    fs.mkdirSync(config, { recursive: true })
    fs.writeFileSync(path.join(config, "attributes"), "*.md text\n")
    fs.writeFileSync(path.join(config, "ignore"), "profile.md\n")
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("XDG_")))
  for (const extra of [{}, { XDG_CONFIG_HOME: xdg }]) {
    const { company, g } = setup({ env: { ...env, HOME: home, ...extra } })
    const added = "people/new/memory/profile.md"
    const crlf = "# New\r\n"
    fs.mkdirSync(path.join(company, "people/new/memory"), { recursive: true })
    fs.writeFileSync(path.join(company, added), crlf)
    expect(await g.commitHandEdits()).toEqual([added])
    const id = createHash("sha1").update(`blob ${crlf.length}\0${crlf}`).digest("hex")
    expect(await g.blobId(added)).toBe(id) // committed as is, not normalized to LF
  }
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
  fs.mkdirSync(path.join(company, "people/ava/memory"), { recursive: true })
  fs.renameSync(path.join(company, PROFILE), path.join(company, "people/ava/memory/profile.md"))
  git(company, "add", "-N", "people/ava/memory/profile.md") // status now reports " R new\0old"
  expect(await g.commitHandEdits()).toEqual(["people/ava/memory/profile.md", PROFILE])
  expect(git(company, "status", "--porcelain")).toBe("")
  expect(await g.blobId(PROFILE)).toBeNull()
  expect(await g.blobId("people/ava/memory/profile.md")).not.toBeNull()
})

test("glob characters in paths are literal", async () => {
  const { company, g } = setup()
  const odd = "people/[mn]inh/memory/profile.md"
  fs.mkdirSync(path.join(company, "people/[mn]inh/memory"), { recursive: true })
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
  const odd = "people/b\udcffd/memory/profile.md" // the byte 0xff, surrogate-escaped; APFS cannot hold it
  const blob = git(company, "hash-object", "-w", PROFILE)
  const name = Buffer.from("people/b\xffd/memory/profile.md", "latin1")
  const entry = [Buffer.from(`100644 ${blob}\t`), name, Buffer.from("\n")]
  gitInput(company, Buffer.concat(entry), "update-index", "--add", "--index-info")
  git(company, "commit", "-q", "-m", "odd path")
  expect(await g.commitHandEdits()).toEqual([odd]) // absent from disk, so a deletion
  expect(await g.blobId(odd)).toBeNull()
  // quotePath prints the name as "people/b\377d/memory/profile.md", so it is gone if no line holds people/b
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

test("a commit that fails after staging leaves nothing staged and keeps the working files", async () => {
  const { tmp, company } = setup()
  const g = refusingCommit(tmp, company)
  const failed = async (paths: string[]) => {
    const error = await g.commit(paths, "edit").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CompanyGitError)
    expect(error).not.toBeInstanceOf(CompanyRepoBusy)
    expect(git(company, "diff", "--cached", "--name-only")).toBe("")
  }
  fs.writeFileSync(path.join(company, PROFILE), "# changed\n")
  await failed([PROFILE])
  expect(fs.readFileSync(path.join(company, PROFILE), "utf8")).toBe("# changed\n")
  fs.writeFileSync(path.join(company, "new.md"), "# new\n")
  await failed(["new.md"])
  expect(fs.readFileSync(path.join(company, "new.md"), "utf8")).toBe("# new\n")
  fs.unlinkSync(path.join(company, "company.yaml"))
  await failed(["company.yaml"])
  expect(git(company, "diff", "--name-only").split("\n")).toEqual(["company.yaml", PROFILE])
  expect(git(company, "ls-files", "--others")).toBe("new.md")
})

test("a reset that fails after a failed commit is logged and the commit's error is the one thrown", async () => {
  const { tmp, company } = setup()
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
  const stub = path.join(tmp, "stub-git")
  const script = [
    "#!/bin/sh",
    'for a in "$@"; do case "$a" in',
    '  --cleanup=whitespace) echo "commit refused" >&2; exit 1;;',
    "  reset) exit 1;;",
    "esac; done",
    `exec ${JSON.stringify(real)} "$@"`,
    "",
  ]
  fs.writeFileSync(stub, script.join("\n"), { mode: 0o755 })
  const logged: string[] = []
  const g = new CompanyGit(company, path.join(tmp, "worktrees"), { git: stub, log: (line) => logged.push(line) })
  fs.writeFileSync(path.join(company, PROFILE), "# changed\n")
  await expect(g.commit([PROFILE], "edit")).rejects.toThrow(/commit refused/)
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain(JSON.stringify([PROFILE]))
})

test("a path holding a nul or starting with a slash is refused before git runs", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  git(company, "add", "groups/eng.yaml")
  const head = await g.head()
  // A NUL would end the `:(literal)` entry on stdin and start an unprefixed pathspec.
  await expect(g.commit([PROFILE, "x\0:(glob)**"], "x")).rejects.toBeInstanceOf(RangeError)
  await expect(g.commit(["/etc/hosts"], "x")).rejects.toBeInstanceOf(RangeError)
  expect(await g.head()).toBe(head)
  expect(git(company, "status", "--porcelain")).toBe("M  groups/eng.yaml")
})

test("a hand made directory name cannot forge a trailer", async () => {
  const { company, g } = setup()
  const rel = "people/m\n\nCommit-Id: c-1/memory/profile.md"
  fs.mkdirSync(path.dirname(path.join(company, rel)), { recursive: true })
  fs.writeFileSync(path.join(company, rel), "# M\n")
  expect(await g.commitHandEdits()).toEqual([rel])
  expect(git(company, "log", "-1", "--format=%B").trim()).toBe("profile(@m Commit-Id: c-1): hand edit")
})

/** The entries of the tree at `commit` (default HEAD), by path. */
async function entries(g: CompanyGit, commit?: string) {
  return new Map((await g.listTree(commit ?? (await g.head()))).map((entry) => [entry.path, entry]))
}

test("list tree lists every entry with its kind blob and size", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, "run.sh"), "echo hi\n")
  fs.chmodSync(path.join(company, "run.sh"), 0o755)
  fs.symlinkSync("people/minh/memory/profile.md", path.join(company, "link"))
  await g.commit(["run.sh", "link"], "more kinds")
  git(company, "update-index", "--add", "--cacheinfo", `160000,${await g.head()},vendor/lib`)
  git(company, "commit", "-q", "-m", "a submodule")
  const found = await entries(g)
  expect([found.get("people")!.type, found.get("people")!.size]).toEqual(["folder", null])
  expect([found.get("people/minh")!.type, found.get(PROFILE)!.type]).toEqual(["folder", "file"])
  expect(found.get(PROFILE)!.size).toBe("# Minh, Engineer\n".length)
  expect(found.get(PROFILE)!.blob).toBe((await g.blobId(PROFILE))!)
  expect([found.get("run.sh")!.type, found.get("link")!.type]).toEqual(["file", "symlink"])
  expect(found.get("link")!.size).toBe("people/minh/memory/profile.md".length)
  expect([found.get("vendor/lib")!.type, found.get("vendor/lib")!.size]).toEqual(["submodule", null])
})

test("list tree is at the commit not the working tree or index", async () => {
  const { company, g } = setup()
  const head = await g.head()
  fs.writeFileSync(path.join(company, PROFILE), "# staged\n")
  git(company, "add", PROFILE)
  fs.writeFileSync(path.join(company, "new.md"), "x\n")
  const found = await entries(g, head)
  expect(found.has("new.md")).toBe(false)
  expect(found.get(PROFILE)!.blob).not.toBe(git(company, "rev-parse", `:${PROFILE}`))
})

test("list tree keeps non utf8 names as surrogates", async () => {
  const { company, g } = setup()
  const blob = git(company, "hash-object", "-w", PROFILE)
  const names = [
    Buffer.from("b\xffd.md", "latin1"),
    Buffer.concat([Buffer.of(0xc3, 0xa9, 0xed, 0xa0, 0x80, 0xff), Buffer.from(".md")]),
  ]
  const lines = names.flatMap((name) => [Buffer.from(`100644 ${blob}\t`), name, Buffer.from("\n")])
  gitInput(company, Buffer.concat(lines), "update-index", "--add", "--index-info")
  git(company, "commit", "-q", "-m", "odd path")
  const found = await entries(g)
  expect(found.has("b\udcffd.md")).toBe(true)
  // a UTF-8 e-acute stays text; the encoded surrogate ed a0 80 is not UTF-8, so each of its bytes is escaped
  expect(found.has("é\udced\udca0\udc80\udcff.md")).toBe(true)
})

test.each(["HEAD", "HEAD~1", "main", "-x", "0".repeat(39), "HEAD:company.yaml", ":/init"])(
  "list tree and commit info take only a full hex id [%s]",
  async (ref) => {
    const { g } = setup()
    await expect(g.listTree(ref)).rejects.toThrow(RangeError)
    await expect(g.commitInfo(ref)).rejects.toThrow(RangeError)
  },
)

test("commit info never shows a signature", async () => {
  // Repo-local config still applies, and log.showSignature would put gpg's output into the format.
  const recording = recordingGit(tempDir())
  const { company, g } = setup({ git: recording.git })
  git(company, "config", "log.showSignature", "true")
  const head = git(company, "rev-parse", "HEAD")
  expect((await g.commitInfo(head)).subject).toBe("init")
  const calls = recording.calls()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.args).toContain("--no-show-signature")
})

test("commit info has the subject author name and time", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  const sha = await g.commit([PROFILE], "edit the profile\n\nA body line.")
  const info = await g.commitInfo(sha)
  expect([info.id, info.subject, info.author]).toEqual([sha, "edit the profile", "OpenCorp office"])
  const ct = Number(git(company, "log", "-1", "--format=%ct", sha))
  expect(info.time).toBe(stamp(new Date(ct * 1000)))
  expect(JSON.stringify(info)).not.toContain("@")
})

test("git runs in the C locale whatever the office's", async () => {
  const recording = envGit(tempDir())
  const env = { ...process.env, LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", LANGUAGE: "de" }
  const { company, g } = setup({ git: recording.git, env })
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  await g.commit([PROFILE], "edit")
  const envs = recording.envs()
  expect(envs.length).toBeGreaterThan(3)
  for (const each of envs) expect([each.get("LC_ALL"), each.has("LANGUAGE")]).toEqual(["C", false])
})

const INDEX_LOCKED = "the company repo is locked by .git/index.lock; if no git command is running there, remove it"

test("a stale index lock is a 503 within a bound, stages nothing and is never removed", async () => {
  const recording = recordingGit(tempDir())
  const { company, g } = setup({ git: recording.git })
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  const lock = path.join(company, ".git/index.lock")
  fs.writeFileSync(lock, "")
  const head = await g.head()
  const start = performance.now()
  const error = await g.commit([PROFILE], "edit").catch((e: unknown) => e)
  const took = performance.now() - start
  expect(error).toBeInstanceOf(CompanyRepoBusy)
  expect([(error as CompanyRepoBusy).status, (error as CompanyRepoBusy).code]).toEqual([503, "company_repo_busy"])
  expect((error as Error).message).toBe(INDEX_LOCKED)
  expect(took).toBeGreaterThan(1400)
  expect(took).toBeLessThan(6000) // the waits add to 1.55 s; the rest is git under load
  expect(fs.existsSync(lock)).toBe(true)
  expect(recording.calls().filter((call) => subcommand(call.args) === "reset")).toEqual([])
  fs.unlinkSync(lock)
  expect(git(company, "diff", "--cached", "--name-only")).toBe("")
  expect(await g.head()).toBe(head)
})

test("an index lock removed while the commit waits lets it land", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  const lock = path.join(company, ".git/index.lock")
  fs.writeFileSync(lock, "")
  const head = await g.head()
  setTimeout(() => fs.unlinkSync(lock), 200)
  expect(await g.commit([PROFILE], "edit")).not.toBe(head)
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit")
})

test("a stale ref lock is a 503 and leaves nothing staged", async () => {
  const { company, g } = setup()
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  fs.writeFileSync(path.join(company, ".git/refs/heads/main.lock"), "")
  const head = await g.head()
  const error = await g.commit([PROFILE], "edit").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CompanyRepoBusy)
  expect((error as CompanyRepoBusy).status).toBe(503)
  expect((error as Error).message).toBe(
    "the company repo is locked by a stale git lock file; " +
      "if no git command is running there, remove the .lock file under .git",
  )
  expect(await g.head()).toBe(head)
  expect(git(company, "diff", "--cached", "--name-only")).toBe("")
  expect(fs.readFileSync(path.join(company, PROFILE), "utf8")).toBe("# edited\n")
})

/** Each operation a human can leave the company repo in: its name, how to start it (any conflict on
 *  company.yaml), what the refusal says is in progress, and how to abort it. */
const CHERRY = "a cherry-pick or revert"
const OPERATIONS: [string, (root: string) => void, string, string[]][] = [
  ["merge", (root) => startMerge(root, "company.yaml"), "a merge", ["merge", "--abort"]],
  ["rebase", startRebaseStop, "a rebase", ["rebase", "--abort"]],
  ["cherry-pick", (root) => startCherryPick(root, "company.yaml"), CHERRY, ["cherry-pick", "--abort"]],
  ["revert", (root) => startRevert(root, "company.yaml"), CHERRY, ["revert", "--abort"]],
  ["sequencer", (root) => sequencerOnly(root, "company.yaml"), CHERRY, ["cherry-pick", "--quit"]],
]

/** The refusal `promise` rejects with: a 409 `CompanyRepoBusy` with `message`. */
async function expectRefused(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CompanyRepoBusy)
  expect([(error as CompanyRepoBusy).status, (error as Error).message]).toEqual([409, message])
}

test.each(OPERATIONS)("a commit during a %s is refused before anything is staged", async (_, start, what, abort) => {
  const { company, g } = setup()
  start(company)
  const index = git(company, "ls-files", "-s")
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  const message = `the company repo has ${what} in progress; finish or abort it`
  await expectRefused(g.commit(["groups/eng.yaml"], "edit group"), message)
  expect(git(company, "ls-files", "-s")).toBe(index)
  expect(gitStatus(company, ...abort)).toBe(0)
})

test("a commit that changes nothing during a merge is refused too", async () => {
  const { company, g } = setup()
  startMerge(company, "company.yaml")
  const message = "the company repo has a merge in progress; finish or abort it"
  await expectRefused(g.commit(["groups/eng.yaml"], "no-op"), message)
})

test("a merge in a linked worktree is found", async () => {
  const { tmp, company } = setup()
  const linked = path.join(tmp, "linked")
  git(company, "worktree", "add", "-q", linked, "-b", "linked")
  startMerge(linked, "company.yaml")
  const g = new CompanyGit(linked, path.join(tmp, "worktrees"))
  fs.writeFileSync(path.join(linked, "groups/eng.yaml"), GROUP)
  const message = "the company repo has a merge in progress; finish or abort it"
  await expectRefused(g.commit(["groups/eng.yaml"], "edit group"), message)
  expect(await g.commitHandEdits()).toEqual([])
})

test("a root without .git never writes to an enclosing repo", async () => {
  const tmp = tempDir()
  const outer = writeRepo(path.join(tmp, "outer"), { "readme.md": "outer\n" })
  const inner = path.join(outer, "inner")
  fs.mkdirSync(path.join(inner, "people/minh/memory"), { recursive: true })
  fs.writeFileSync(path.join(inner, "x.txt"), "x\n")
  fs.writeFileSync(path.join(inner, PROFILE), "# Minh\n")
  const state = () => [git(outer, "ls-files"), git(outer, "status", "--porcelain"), git(outer, "rev-parse", "HEAD")]
  const before = state()
  const g = new CompanyGit(inner, path.join(tmp, "worktrees"))
  await expect(g.commit(["x.txt"], "x")).rejects.toBeInstanceOf(CompanyGitError)
  await expect(g.commitHandEdits()).rejects.toBeInstanceOf(CompanyGitError)
  expect(state()).toEqual(before)
})

test("a symlinked root still finds its own repo", async () => {
  const { tmp, company } = setup()
  const link = path.join(tmp, "link")
  fs.symlinkSync(company, link)
  const g = new CompanyGit(link, path.join(tmp, "worktrees"))
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  await g.commit(["groups/eng.yaml"], "edit group")
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit group")
  expect(git(company, "status", "--porcelain")).toBe("")
})

test("a path with an unresolved conflict is refused and kept, other paths still commit", async () => {
  const { company, g } = setup()
  stashPopConflict(company, PROFILE)
  const conflicted = fs.readFileSync(path.join(company, PROFILE))
  const message =
    `${JSON.stringify(PROFILE)} has an unresolved merge conflict in the company repo; resolve it and commit`
  await expectRefused(g.commit([PROFILE], "edit"), message)
  await expectRefused(g.commit(["people/minh"], "edit"), message)
  expect(git(company, "ls-files", "-u")).toContain(PROFILE)
  expect(fs.readFileSync(path.join(company, PROFILE))).toEqual(conflicted)
  fs.writeFileSync(path.join(company, "groups/eng.yaml"), GROUP)
  await g.commit(["groups/eng.yaml"], "edit group")
  expect(git(company, "log", "-1", "--format=%s")).toBe("edit group")
  expect(git(company, "ls-files", "-u")).toContain(PROFILE)
})

test("hand edits skip a profile with an unresolved conflict and say so once", async () => {
  const logged: string[] = []
  const { company, g } = setup({ log: (line) => logged.push(line) })
  stashPopConflict(company, PROFILE)
  const other = "people/ngocbh/memory/profile.md"
  fs.mkdirSync(path.join(company, "people/ngocbh/memory"))
  fs.writeFileSync(path.join(company, other), "# Ngoc\n")
  expect(await g.commitHandEdits()).toEqual([other])
  expect(git(company, "show", `HEAD:${PROFILE}`)).not.toContain("<<<<<<<")
  expect(git(company, "ls-files", "-u")).toContain(PROFILE)
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain(JSON.stringify(PROFILE))
  expect(await g.commitHandEdits()).toEqual([])
  expect(logged).toHaveLength(1)
})

test.each(["people/minh/memory", "people/minh"])(
  "a profile under a symlinked folder is skipped and said once, and other hand edits still commit [%s]",
  async (folder) => {
    const logged: string[] = []
    const { tmp, company, g } = setup({ log: (line) => logged.push(line) })
    // Moved elsewhere and linked back: git lists the profile as deleted, but lstat finds it through the link.
    fs.renameSync(path.join(company, folder), path.join(tmp, "elsewhere"))
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(company, folder))
    const other = "people/ngocbh/memory/profile.md"
    fs.mkdirSync(path.join(company, "people/ngocbh/memory"))
    fs.writeFileSync(path.join(company, other), "# Ngoc\n")
    expect((await g.pending()).handEdits).toEqual([other])
    expect(await g.commitHandEdits()).toEqual([other])
    expect(git(company, "show", `HEAD:${PROFILE}`)).toBe("# Minh, Engineer")
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(`${JSON.stringify([PROFILE])}: a folder on its path is a symlink`)
    expect(await g.commitHandEdits()).toEqual([])
    expect(logged).toHaveLength(1)
  },
)

test("a .yian file or symlink in a memory folder is never a hand edit", async () => {
  const { tmp, company, g } = setup()
  fs.writeFileSync(path.join(company, "people/minh/memory/.yian"), "x\n")
  fs.mkdirSync(path.join(company, "people/minh/memory/notes"))
  fs.symlinkSync(tmp, path.join(company, "people/minh/memory/notes/.yian"))
  expect(await g.pending()).toEqual({
    handEdits: [],
    uncommitted: ["people/minh/memory/.yian", "people/minh/memory/notes/.yian"],
  })
  expect(await g.commitHandEdits()).toEqual([])
})

test("a nested git repo in a memory folder is never a hand edit, new, changed or deleted; said once", async () => {
  const logged: string[] = []
  const { company, g } = setup({ log: (line) => logged.push(line) })
  const notes = "people/minh/memory/notes"
  fs.mkdirSync(path.join(company, notes))
  fs.writeFileSync(path.join(company, notes, "a.md"), "a\n")
  const nested = (...args: string[]) => git(path.join(company, notes), ...args)
  nested("init", "-q", "-b", "main")
  nested("add", "a.md")
  nested("commit", "-qm", "a")
  const head = await g.head()
  expect(await g.commitHandEdits()).toEqual([])
  expect(await g.head()).toBe(head)
  const skipped = JSON.stringify([`${notes}/`])
  expect(logged).toEqual([`hand edits skip ${skipped}: a nested git repo; only files are committed`])
  // One a human committed as a gitlink: a new commit in it, then its removal.
  git(company, "add", notes)
  git(company, "commit", "-qm", "a gitlink")
  fs.writeFileSync(path.join(company, notes, "a.md"), "b\n")
  nested("commit", "-qam", "b")
  expect(await g.pending()).toEqual({ handEdits: [], uncommitted: [notes] })
  expect(await g.commitHandEdits()).toEqual([])
  fs.rmSync(path.join(company, notes), { recursive: true })
  expect(await g.commitHandEdits()).toEqual([])
  expect(git(company, "ls-files", "-s", notes)).toStartWith("160000 ")
  expect(logged).toHaveLength(2)
  expect(logged[1]).toContain(JSON.stringify([notes]))
})

test.each(OPERATIONS)("hand edits wait while a %s is in progress", async (_, start, what, abort) => {
  const logged: string[] = []
  const { company, g } = setup({ log: (line) => logged.push(line) })
  start(company)
  const head = await g.head()
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  expect(await g.commitHandEdits()).toEqual([])
  expect(await g.commitHandEdits()).toEqual([])
  expect(await g.head()).toBe(head)
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain(what)
  expect(gitStatus(company, ...abort)).toBe(0)
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n") // a rebase's abort resets the work tree
  expect(await g.commitHandEdits()).toEqual([PROFILE])
  expect(git(company, "show", `HEAD:${PROFILE}`)).toBe("# edited")
})

const DANA = "people/dana/person.yaml"

/** Writes and commits dana's person file in `root` with `name`; returns the new HEAD. */
function hire(root: string, name = "Dana"): string {
  fs.mkdirSync(path.join(root, "people/dana"), { recursive: true })
  fs.writeFileSync(path.join(root, DANA), `handle: dana\nname: ${name}\nkind: human\ntitle: Eng\nmanager: ngocbh\n`)
  git(root, "add", DANA)
  git(root, "commit", "-q", "-m", `hire ${name}`)
  return git(root, "rev-parse", "HEAD")
}

/** Deletes and commits dana's person file in `root`; returns the new HEAD. */
function fire(root: string): string {
  git(root, "rm", "-q", DANA)
  git(root, "commit", "-q", "-m", "remove dana")
  return git(root, "rev-parse", "HEAD")
}

/** Commits `text` to `file`, not dana's, in `root`; returns the new HEAD. */
function other(root: string, text: string, file = "notes.md"): string {
  fs.writeFileSync(path.join(root, file), `${text}\n`)
  git(root, "add", file)
  git(root, "commit", "-q", "-m", text)
  return git(root, "rev-parse", "HEAD")
}

test("gone since is false for an untouched file, and for the same commit without running git", async () => {
  const recording = recordingGit(tempDir())
  const { company, g } = setup({ git: recording.git })
  const hired = hire(company)
  expect(await g.goneSince(DANA, hired, hired)).toBe(false)
  expect(recording.calls()).toHaveLength(0)
  const later = other(company, "unrelated")
  fs.appendFileSync(path.join(company, DANA), "groups: []\n")
  git(company, "commit", "-q", "-am", "edit dana")
  expect(await g.goneSince(DANA, hired, later)).toBe(false)
  expect(await g.goneSince(DANA, hired, git(company, "rev-parse", "HEAD"))).toBe(false)
})

test("gone since is true for a delete, and for a delete then a re-add", async () => {
  const { company, g } = setup()
  const hired = hire(company)
  const fired = fire(company)
  expect(await g.goneSince(DANA, hired, fired)).toBe(true)
  const again = hire(company)
  expect(await g.goneSince(DANA, hired, again)).toBe(true)
  expect(await g.goneSince(DANA, hired, other(company, "later"))).toBe(true)
  expect(await g.goneSince(DANA, again, other(company, "later still"))).toBe(false)
})

test("gone since is true when the file was a symlink at a commit between", async () => {
  const { company, g } = setup()
  const hired = hire(company)
  const file = path.join(company, DANA)
  const text = fs.readFileSync(file)
  fs.rmSync(file)
  fs.symlinkSync("../ngocbh/person.yaml", file)
  git(company, "add", DANA)
  git(company, "commit", "-q", "-m", "dana is a link")
  fs.rmSync(file)
  fs.writeFileSync(file, text)
  git(company, "add", DANA)
  git(company, "commit", "-q", "-m", "dana is a file again")
  expect(await g.goneSince(DANA, hired, git(company, "rev-parse", "HEAD"))).toBe(true)
})

test("gone since sees a delete and re-add on a side branch that was merged", async () => {
  const { company, g } = setup()
  const hired = hire(company)
  git(company, "checkout", "-q", "-b", "side")
  fire(company)
  hire(company)
  git(company, "checkout", "-q", "main")
  other(company, "on main")
  git(company, "merge", "-q", "--no-ff", "--no-edit", "side")
  expect(await g.goneSince(DANA, hired, git(company, "rev-parse", "HEAD"))).toBe(true)
})

test.each([["on"], ["first-parent"], ["combined"], ["follow"]])(
  "gone since sees a delete made only by a merge whatever the repos log config [%s]",
  async (setting) => {
    const { company, g } = setup()
    if (setting === "follow") git(company, "config", "log.follow", "true")
    else git(company, "config", "log.diffMerges", setting)
    const hired = hire(company)
    git(company, "checkout", "-q", "-b", "side")
    other(company, "on side", "side.md")
    git(company, "checkout", "-q", "main")
    other(company, "on main")
    git(company, "merge", "-q", "--no-ff", "--no-commit", "side")
    git(company, "rm", "-q", DANA)
    git(company, "commit", "-q", "-m", "merge side, removing dana")
    expect(await g.goneSince(DANA, hired, git(company, "rev-parse", "HEAD"))).toBe(true)
  },
)

test.each([["on"], ["first-parent"], ["combined"]])(
  "gone since sees a merge drop a file only its merged branch had, whatever the repos log config [%s]",
  async (setting) => {
    const { company, g } = setup()
    git(company, "config", "log.diffMerges", setting)
    git(company, "checkout", "-q", "-b", "side")
    const hired = hire(company)
    git(company, "checkout", "-q", "main")
    other(company, "on main")
    git(company, "merge", "-q", "--no-ff", "--no-commit", "side")
    git(company, "rm", "-qf", DANA)
    git(company, "commit", "-q", "-m", "merge side without dana")
    expect(await g.goneSince(DANA, hired, git(company, "rev-parse", "HEAD"))).toBe(true)
  },
)

test("gone since is false after merging a branch forked before the file was added, either way", async () => {
  const { company, g } = setup()
  const base = git(company, "rev-parse", "HEAD")
  const hired = hire(company)
  git(company, "checkout", "-q", "-b", "side", base)
  other(company, "on side")
  git(company, "checkout", "-q", "main")
  git(company, "merge", "-q", "--no-ff", "--no-edit", "side")
  expect(await g.goneSince(DANA, hired, git(company, "rev-parse", "HEAD"))).toBe(false)
  git(company, "checkout", "-q", "side")
  git(company, "merge", "-q", "--no-ff", "--no-edit", hired)
  expect(await g.goneSince(DANA, hired, git(company, "rev-parse", "HEAD"))).toBe(false)
})

test("gone since is false after a rebase over upstream commits when the add was upstream", async () => {
  const { company, g } = setup()
  hire(company)
  const local = other(company, "local")
  git(company, "branch", "upstream", "HEAD~1")
  git(company, "checkout", "-q", "upstream")
  other(company, "upstream", "upstream.md")
  git(company, "checkout", "-q", "main")
  git(company, "rebase", "-q", "upstream")
  const rebased = git(company, "rev-parse", "HEAD")
  expect(rebased).not.toBe(local)
  expect(await g.goneSince(DANA, local, rebased)).toBe(false)
})

test("gone since is true after a reset to before the add and an add again", async () => {
  const { company, g } = setup()
  const hired = hire(company)
  git(company, "reset", "-q", "--hard", "HEAD~1")
  const again = hire(company, "Dana Two")
  expect(await g.goneSince(DANA, hired, again)).toBe(true)
})

test("gone since is true after a reset back to before a delete, from the re-add", async () => {
  const { company, g } = setup()
  const hired = hire(company)
  fire(company)
  const again = hire(company, "Dana Two")
  git(company, "reset", "-q", "--hard", hired)
  const back = other(company, "after the reset")
  expect(await g.goneSince(DANA, again, back)).toBe(true)
})

test("gone since is false back to an older commit that still holds the file", async () => {
  const { company, g } = setup()
  const hired = hire(company)
  const later = other(company, "later")
  expect(await g.goneSince(DANA, later, hired)).toBe(false)
})

test("gone since is true from a commit the clone lacks, and across unrelated histories", async () => {
  const { company, g } = setup()
  const hired = hire(company)
  expect(await g.goneSince(DANA, "f".repeat(40), hired)).toBe(true)
  git(company, "checkout", "-q", "--orphan", "fresh")
  const unrelated = hire(company)
  expect(await g.goneSince(DANA, hired, unrelated)).toBe(true)
})

test("gone since takes only full commit ids and a relative path with no nul", async () => {
  const recording = recordingGit(tempDir())
  const { company, g } = setup({ git: recording.git })
  const hired = hire(company)
  for (const [from, to] of [
    ["HEAD", hired],
    [hired, "HEAD"],
    [hired, `${hired}~1`],
    [hired.slice(0, 12), hired],
  ]) {
    await expect(g.goneSince(DANA, from!, to!)).rejects.toBeInstanceOf(RangeError)
  }
  await expect(g.goneSince(`/${DANA}`, hired, hired)).rejects.toBeInstanceOf(RangeError)
  await expect(g.goneSince(`${DANA}\0x`, hired, hired)).rejects.toBeInstanceOf(RangeError)
  expect(recording.calls()).toHaveLength(0)
})

test("gone since matches a glob looking path literally", async () => {
  const { company, g } = setup()
  hire(company)
  const glob = "people/*/person.yaml"
  fs.mkdirSync(path.join(company, "people/*"))
  fs.writeFileSync(path.join(company, glob), "not a person\n")
  git(company, "add", "--", `:(literal)${glob}`)
  git(company, "commit", "-q", "-m", "a folder named *")
  const before = git(company, "rev-parse", "HEAD")
  expect(await g.goneSince(glob, before, fire(company))).toBe(false)
})

test.each(
  ["^{commit}", "--all", DANA].flatMap((match) => GIT_FAILURES.map((failure) => [match, failure] as const)),
)("gone since throws when git fails instead of answering [%s: %s]", async (match, failure) => {
  const dir = tempDir()
  const root = company(dir)
  const hired = hire(root)
  const later = other(root, "later")
  const g = new CompanyGit(root, path.join(dir, "worktrees"), { git: failingGit(dir, match, failure) })
  await expect(g.goneSince(DANA, hired, later)).rejects.toThrow(CompanyGitError)
})

test.each(GIT_FAILURES.filter((failure) => failure !== "exit 0"))(
  "gone since throws when its log fails [%s]",
  async (failure) => {
    const dir = tempDir()
    const root = company(dir)
    const hired = hire(root)
    const later = other(root, "later")
    const g = new CompanyGit(root, path.join(dir, "worktrees"), { git: failingGit(dir, "--diff-filter=D", failure) })
    await expect(g.goneSince(DANA, hired, later)).rejects.toThrow(CompanyGitError)
  },
)

test("the repo state is unborn until the first commit, then committed", async () => {
  const root = path.join(tempDir(), "repo")
  fs.mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  const g = new CompanyGit(root, root)
  expect(await g.repoState()).toBe("unborn")
  git(root, "commit", "-q", "--allow-empty", "-m", "first")
  expect(await g.repoState()).toBe("committed")
})

test("a repo git can't read has no state", async () => {
  const root = path.join(tempDir(), "repo")
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  await expect(new CompanyGit(root, root).repoState()).rejects.toThrow(CompanyGitError)
})

test("a broken repo inside another is not taken for the outer one", async () => {
  const outer = path.join(tempDir(), "outer")
  fs.mkdirSync(outer)
  git(outer, "init", "-q", "-b", "main")
  git(outer, "commit", "-q", "--allow-empty", "-m", "first")
  const inner = path.join(outer, "inner")
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true })
  const error = await new CompanyGit(inner, inner).repoState().then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CompanyGitError)
  expect((error as Error).message).toContain("not a git repository")
  expect((error as Error).message).not.toContain(outer)
})

/** A repo at a new temp dir with one commit on main. */
function repoWithHistory(): string {
  const root = path.join(tempDir(), "repo")
  fs.mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  git(root, "commit", "-q", "--allow-empty", "-m", "first")
  return root
}

test("a repo whose branch ref is NUL-filled has no state", async () => {
  const root = repoWithHistory()
  // Git skips a broken ref with a warning, so the repo would otherwise look like it had no refs.
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), Buffer.alloc(41))
  await expect(new CompanyGit(root, root).repoState()).rejects.toThrow(CompanyGitError)
})

test("a repo whose branch ref was deleted has no state while HEAD has a reflog", async () => {
  const root = repoWithHistory()
  fs.unlinkSync(path.join(root, ".git", "refs", "heads", "main"))
  expect(fs.existsSync(path.join(root, ".git", "logs", "HEAD"))).toBe(true)
  await expect(new CompanyGit(root, root).repoState()).rejects.toThrow(CompanyGitError)
})

test("a detached head that names a missing commit has no state", async () => {
  const root = path.join(tempDir(), "repo")
  fs.mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `${"1".repeat(40)}\n`)
  await expect(new CompanyGit(root, root).repoState()).rejects.toThrow(CompanyGitError)
})

test("a head that names no commit while refs exist has no state", async () => {
  const root = path.join(tempDir(), "repo")
  fs.mkdirSync(root)
  git(root, "init", "-q", "-b", "main")
  git(root, "commit", "-q", "--allow-empty", "-m", "first")
  git(root, "tag", "v1")
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"0".repeat(40)}\n`)
  await expect(new CompanyGit(root, root).repoState()).rejects.toThrow(CompanyGitError)
})

test("one line drops NULs and turns each run of whitespace or line breaks into one space", () => {
  expect(oneLine("a\0b \n\u2028 c\t")).toBe("ab c")
  expect(oneLine(" \r\n ")).toBe("")
})

/** The bytes of `root`'s index, its worktrees and its refs, which a read-only method must leave alone. */
function cloneState(root: string): { index: Buffer; worktrees: string; refs: string } {
  return {
    index: fs.readFileSync(path.join(root, ".git/index")),
    worktrees: git(root, "worktree", "list", "--porcelain"),
    refs: git(root, "for-each-ref"),
  }
}

/** Points the temp dir at a new folder for the rest of the test, so what another process puts in the shared one
 *  can't show up in it; returns that folder. */
function privateTmp(): string {
  const dir = tempDir()
  const saved = process.env.TMPDIR
  process.env.TMPDIR = dir
  onTestFinished(() => {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  })
  return dir
}

test("pending sorts profile hand edits from other uncommitted changes", async () => {
  const { company, g } = setup()
  fs.mkdirSync(path.join(company, "people/ngocbh/memory"))
  fs.writeFileSync(path.join(company, "people/ngocbh/memory/profile.md"), "# Ngoc\n")
  git(company, "add", "people/ngocbh/memory/profile.md")
  git(company, "commit", "-q", "-m", "profile")
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\nedited\n")
  fs.unlinkSync(path.join(company, "people/ngocbh/memory/profile.md"))
  fs.mkdirSync(path.join(company, "people/ava/memory"), { recursive: true })
  fs.writeFileSync(path.join(company, "people/ava/memory/profile.md"), "# Ava\n")
  fs.writeFileSync(path.join(company, "shared/flows/chat.yaml"), "id: chat\n")
  fs.writeFileSync(path.join(company, "shared/b.txt"), "b\n")
  expect(await g.pending()).toEqual({
    handEdits: ["people/ava/memory/profile.md", PROFILE, "people/ngocbh/memory/profile.md"],
    uncommitted: ["shared/b.txt", "shared/flows/chat.yaml"],
  })
})

test("pending lays no hand edit over the commit while a human operation is in progress", async () => {
  const { company, g } = setup()
  startMerge(company, "company.yaml")
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\nedited\n")
  expect(await g.pending()).toEqual({ handEdits: [], uncommitted: ["company.yaml", PROFILE] })
})

test("pending counts a conflicted profile as uncommitted, not as a hand edit", async () => {
  const { company, g } = setup()
  stashPopConflict(company, PROFILE)
  expect(await g.pending()).toEqual({ handEdits: [], uncommitted: [PROFILE] })
})

test("pending of a clean clone is empty", async () => {
  const { g } = setup()
  expect(await g.pending()).toEqual({ handEdits: [], uncommitted: [] })
})

test("pending never writes the index", async () => {
  const { company, g } = setup()
  const before = cloneState(company)
  // A new mtime makes a plain `git status` refresh the index.
  const later = new Date(Date.now() + 10_000)
  fs.utimesSync(path.join(company, "groups/eng.yaml"), later, later)
  fs.writeFileSync(path.join(company, PROFILE), "# edited\n")
  expect((await g.pending()).handEdits).toEqual([PROFILE])
  expect(cloneState(company)).toEqual(before)
})

test("export tree writes the commit with the overlay from the working tree and nothing in the clone", async () => {
  const { tmp, company, g } = setup()
  const scratch = privateTmp()
  const before = cloneState(company)
  const committed = fs.readFileSync(path.join(company, "shared/flows/chat.yaml"), "utf8")
  fs.writeFileSync(path.join(company, "shared/flows/chat.yaml"), "id: edited\n")
  fs.writeFileSync(path.join(company, PROFILE), "# Minh\nedited\n")
  fs.mkdirSync(path.join(company, "people/ava/memory"), { recursive: true })
  fs.writeFileSync(path.join(company, "people/ava/memory/profile.md"), "# Ava\n")
  fs.symlinkSync("memory/profile.md", path.join(company, "people/ava/linked.md"))
  const dir = path.join(tmp, "export")
  await g.exportTree("HEAD", dir, [PROFILE, "people/ava/linked.md", "people/gone/memory/profile.md"])
  expect(fs.readFileSync(path.join(dir, "shared/flows/chat.yaml"), "utf8")).toBe(committed)
  expect(fs.readFileSync(path.join(dir, PROFILE), "utf8")).toBe("# Minh\nedited\n")
  expect(fs.readlinkSync(path.join(dir, "people/ava/linked.md"))).toBe("memory/profile.md")
  expect(fs.existsSync(path.join(dir, "people/ava/memory/profile.md"))).toBe(false)
  expect(fs.existsSync(path.join(dir, "people/gone"))).toBe(false)
  expect(fs.readFileSync(path.join(dir, "company.yaml"), "utf8")).toContain("test-corp")
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false)
  expect(cloneState(company)).toEqual(before)
  expect(fs.readdirSync(scratch).filter((name) => name.startsWith("opencorp-index-"))).toEqual([])
})

test("export tree removes an overlay path gone from the working tree", async () => {
  const { tmp, company, g } = setup()
  fs.unlinkSync(path.join(company, PROFILE))
  const dir = path.join(tmp, "export")
  await g.exportTree("HEAD", dir, [PROFILE])
  expect(fs.existsSync(path.join(dir, PROFILE))).toBe(false)
  expect(fs.existsSync(path.join(dir, "people/minh/person.yaml"))).toBe(true)
})

test("export tree runs no filter driver", async () => {
  const { tmp, company, g } = setup()
  const wire = tripwire(tmp, "exec cat")
  fs.writeFileSync(path.join(company, ".gitattributes"), "* filter=x\n")
  git(company, "add", ".gitattributes")
  git(company, "commit", "-q", "-m", "attributes")
  git(company, "config", "filter.x.smudge", wire.script)
  git(company, "config", "filter.x.required", "true")
  const dir = path.join(tmp, "export")
  await g.exportTree("HEAD", dir)
  expect(wire.tripped()).toBe(false)
  expect(fs.readFileSync(path.join(dir, PROFILE), "utf8")).toBe("# Minh, Engineer\n")
})

test("export tree of an unknown commit is a range error", async () => {
  const { tmp, g } = setup()
  await expect(g.exportTree("0".repeat(40), path.join(tmp, "export"))).rejects.toThrow(RangeError)
})

/** Whether names in the temp dir are case-insensitive, as on a default macOS volume. */
function foldsCase(): boolean {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "a"), "")
  return fs.existsSync(path.join(dir, "A"))
}

test.each([
  ["x", "same case"],
  ["X", "other case"],
])("export tree never writes through a symlink the commit put in the export [%s, %s]", async (committed) => {
  if (committed !== "x" && !foldsCase()) return
  const { tmp, company, g } = setup()
  const outside = path.join(tmp, "outside")
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, "sentinel"), "keep\n")
  fs.symlinkSync(outside, path.join(company, "people", committed))
  git(company, "add", `people/${committed}`)
  git(company, "commit", "-q", "-m", "link")
  fs.unlinkSync(path.join(company, "people", committed))
  fs.mkdirSync(path.join(company, "people/x/memory"), { recursive: true })
  fs.writeFileSync(path.join(company, "people/x/memory/profile.md"), "# X\n")
  const dir = path.join(tmp, "export")
  await g.exportTree("HEAD", dir, ["people/x/memory/profile.md"])
  expect(fs.readdirSync(outside)).toEqual(["sentinel"])
  expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n")
  expect(fs.lstatSync(path.join(dir, "people", committed)).isSymbolicLink()).toBe(true)
})

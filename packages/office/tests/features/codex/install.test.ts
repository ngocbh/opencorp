/** Codex as a thread's sandbox can run it: as installed, or, installed in a folder an employee's permission denies
 *  (the standalone installer's `~/.codex`), from the office's private copy of its install in the owner's cache folder,
 *  shared per Codex, mended in place when a file goes missing, and swept unless it is the current Codex's, was used
 *  within a day, or is in use. */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { copiesFolder, threadCodex } from "../../../src/features/codex/install.ts"
import { harnessTemp, sandboxArgs, threadEnv } from "../../../src/features/codex/thread.ts"
import { type EmployeePermission, codexThread } from "../../../src/runtime/sandbox/harness_profile.ts"
import { fenceIn, freshFolder } from "../../../src/runtime/sandbox/harness_temp.ts"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { nativeCodex, threadLoad } from "../../../src/tools/codex/codex.ts"
import { tempDir, waitFor } from "../../helpers.ts"
import { sandboxAvailable, standaloneCodex } from "../../runtime/sandbox/helpers.ts"

setDefaultTimeout(30_000)

/** A temp home with an office home and `.codex` in it, a workspace, the harness folder with a fresh temp folder and
 *  the fence, an employee's read-only permission over them, and the copies' folder in the home's cache. */
function layout() {
  const root = fs.realpathSync(tempDir())
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  for (const dir of [path.join(home, ".opencorp"), path.join(home, ".codex"), ws, path.join(root, "tmp")]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(home, ".codex/auth.json"), '{"token": "decoy-codex"}')
  const temp = harnessTemp(path.join(root, "tmp"))
  const p: EmployeePermission = {
    workspace: ws,
    gitRoot: null,
    writable: false,
    network: false,
    tmpdir: freshFolder(temp, "S1"),
    fence: fenceIn(temp),
    folders: [],
    home,
    officeHome: path.join(home, ".opencorp"),
  }
  return { root, home, ws, temp, p, folder: copiesFolder(home, {}) }
}

/** Where Codex's standalone installer puts release `version` in `home`. */
function releaseIn(home: string, version = "0.171.0"): string {
  return path.join(home, `.codex/packages/standalone/releases/${version}-x86_64-unknown-linux-musl`)
}

/** A stand-in Codex install at `install`, laid out as Codex's packages lay theirs out: its binary (no script, or a
 *  copy of `binary`) and another program in `bin`, the bundled bubblewrap and voice resources in `codex-resources`,
 *  `rg` in `codex-path`, and its package file; each folder and file only the user may change. Returns what runs it, as
 *  `nativeCodex` finds it. */
function fakeInstall(install: string, binary?: string): { run: string; install: string } {
  const files: Record<string, string> = {
    "bin/codex": "\x7fELF the codex binary",
    "bin/codex-exec-server": "\x7fELF its exec server",
    "codex-resources/bwrap": "\x7fELF the bundled bubblewrap",
    "codex-resources/voice/bin/voice": "\x7fELF voice",
    "codex-path/rg": "\x7fELF ripgrep",
    "codex-package.json": '{"version": "0.171.0"}',
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(install, rel)), { recursive: true })
    if (rel === "bin/codex" && binary !== undefined) fs.copyFileSync(binary, path.join(install, rel))
    else fs.writeFileSync(path.join(install, rel), text)
    fs.chmodSync(path.join(install, rel), 0o755)
  }
  for (const rel of ["", "bin", "codex-resources", "codex-resources/voice", "codex-resources/voice/bin", "codex-path"]) {
    fs.chmodSync(path.join(install, rel), 0o755)
  }
  return nativeCodex(path.join(install, "bin/codex"))
}

/** Every file under `dir`, as paths in it. */
function filesIn(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((rel) => fs.lstatSync(path.join(dir, rel)).isFile())
    .sort()
}

/** A day and a minute ago. */
const DAY_AGO = () => new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000)

/** Makes the copy `install` last used over a day ago, as its last-used file says. */
function unused(install: string): void {
  fs.utimesSync(path.join(install, "last-used"), DAY_AGO(), DAY_AGO())
}

/** The copies in the copies' folder `folder`: its folders named as copies are. */
function copies(folder: string): string[] {
  if (!fs.existsSync(folder)) return []
  return fs
    .readdirSync(folder)
    .filter((name) => /^install-[0-9a-f]{16}$/.test(name) && fs.lstatSync(path.join(folder, name)).isDirectory())
}

test("the copies' folder is $XDG_CACHE_HOME/opencorp/codex when the office's environment sets an absolute one, else ~/.cache/opencorp/codex", () => {
  expect(copiesFolder("/home/u", {})).toBe("/home/u/.cache/opencorp/codex")
  expect(copiesFolder("/home/u", { XDG_CACHE_HOME: "/data/cache" })).toBe("/data/cache/opencorp/codex")
  expect(copiesFolder("/home/u", { XDG_CACHE_HOME: "cache" })).toBe("/home/u/.cache/opencorp/codex")
  expect(copiesFolder("/home/u", { XDG_CACHE_HOME: "" })).toBe("/home/u/.cache/opencorp/codex")
})

test("a Codex outside every folder an employee's permission denies runs as installed", async () => {
  const { root, home, p, folder } = layout()
  const codex = fakeInstall(path.join(root, "codex-install"))
  expect(await threadCodex(p, codex, folder)).toEqual(codex)
  expect(fs.existsSync(path.join(home, ".cache"))).toBe(false)
})

test("a Codex installed in a folder the permission denies runs from the office's private copy of its install in the owner's cache: its bin, bundled bubblewrap, codex-path and package file", async () => {
  const { home, p, folder } = layout()
  const release = releaseIn(home)
  const codex = fakeInstall(release)
  const copy = await threadCodex(p, codex, folder)
  const [name] = copies(folder)
  expect(name).toMatch(/^install-[0-9a-f]{16}$/)
  expect(copy).toEqual({ run: path.join(folder, name!, "bin/codex"), install: path.join(folder, name!) })
  for (const dir of [path.dirname(folder), folder]) {
    const stat = fs.lstatSync(dir)
    expect([stat.isDirectory(), stat.mode & 0o777], dir).toEqual([true, 0o700])
  }
  expect(filesIn(copy.install)).toEqual(
    [
      "bin/codex",
      "bin/codex-exec-server",
      "codex-package.json",
      "codex-path/rg",
      "codex-resources/bwrap",
      "last-used",
      "source.json",
    ].sort(),
  )
  for (const rel of ["bin/codex", "bin/codex-exec-server", "codex-resources/bwrap", "codex-path/rg", "codex-package.json"]) {
    expect(fs.readFileSync(path.join(copy.install, rel), "utf8"), rel).toBe(fs.readFileSync(path.join(release, rel), "utf8"))
    expect(fs.statSync(path.join(copy.install, rel)).mode & 0o277, rel).toBe(0)
  }
  for (const dir of ["", "bin", "codex-resources", "codex-path"]) {
    const stat = fs.lstatSync(path.join(copy.install, dir))
    expect([stat.isDirectory(), stat.mode & 0o777], dir).toEqual([true, 0o700])
  }
  // The thread's profile reads the copy, and ~/.codex stays denied.
  const filesystem = (codexThread(p, "opencorp-s1", { install: copy.install }).config.permissions as Record<
    string,
    { filesystem: Record<string, string> }
  >)["opencorp-s1"]!.filesystem
  expect(filesystem[copy.install]).toBe("read")
  expect(filesystem[path.join(home, ".codex")]).toBe("deny")
  expect(filesystem[release]).toBeUndefined()
})

test("a copies' folder in a folder the permission denies, in the session's folder or a listed one, under a folder others may change, or reached through a link, is refused before anything is copied", async () => {
  const { root, home, ws, p } = layout()
  const codex = fakeInstall(releaseIn(home))
  const shared = path.join(root, "shared")
  const open = path.join(root, "open")
  for (const dir of [shared, open]) fs.mkdirSync(dir, { mode: 0o755 })
  fs.chmodSync(open, 0o777)
  const refused: [string, EmployeePermission, string, RegExp][] = [
    ["denied", p, path.join(home, ".config/cache"), /lies in .*\/\.config, which the employee's permission denies/],
    ["the session's folder", p, path.join(ws, "cache"), /the session's folder/],
    ["listed", { ...p, folders: [{ path: shared, access: "read" }] }, path.join(shared, "cache"), /a listed folder/],
    ["open to others", p, open, /others than the user may write/],
  ]
  for (const [what, permission, cache, why] of refused) {
    const copied = threadCodex(permission, codex, copiesFolder(home, { XDG_CACHE_HOME: cache }))
    await expect(copied, what).rejects.toBeInstanceOf(UnsafeProfile)
    await expect(threadCodex(permission, codex, copiesFolder(home, { XDG_CACHE_HOME: cache })), what).rejects.toThrow(why)
    expect(copies(copiesFolder(home, { XDG_CACHE_HOME: cache })), what).toEqual([])
  }
  // Nothing was made in the denied folder, the session's folder or the listed one.
  for (const dir of [path.join(home, ".config"), path.join(ws, "cache"), path.join(shared, "cache")]) {
    expect(fs.existsSync(dir), dir).toBe(false)
  }
  // Its opencorp folder a link, or not private.
  const elsewhere = path.join(root, "elsewhere")
  fs.mkdirSync(elsewhere, { mode: 0o700 })
  fs.mkdirSync(path.join(home, ".cache"), { mode: 0o700 })
  fs.symlinkSync(elsewhere, path.join(home, ".cache/opencorp"))
  await expect(threadCodex(p, codex, copiesFolder(home, {}))).rejects.toThrow(/isn't a folder \(a link is refused\)/)
  fs.rmSync(path.join(home, ".cache/opencorp"))
  fs.mkdirSync(path.join(home, ".cache/opencorp"), { mode: 0o755 })
  fs.chmodSync(path.join(home, ".cache/opencorp"), 0o755)
  await expect(threadCodex(p, codex, copiesFolder(home, {}))).rejects.toThrow(/isn't private/)
  expect(fs.readdirSync(elsewhere)).toEqual([])
})

test("sessions share one copy per Codex, made once even when they start together, and an updated Codex gets its own", async () => {
  const { home, p, folder } = layout()
  const codex = fakeInstall(releaseIn(home))
  const [first, again] = await Promise.all([threadCodex(p, codex, folder), threadCodex(p, codex, folder)])
  expect(again).toEqual(first)
  const inode = fs.statSync(first.run).ino
  expect(await threadCodex(p, codex, folder)).toEqual(first)
  expect(fs.statSync(first.run).ino).toBe(inode)
  expect(fs.readdirSync(folder).filter((name) => name.endsWith(".part"))).toEqual([])
  // An update rewrites the binary: the next session gets a copy of the new one, and the old one goes a day after its
  // last use.
  fs.writeFileSync(codex.run, "\x7fELF the updated codex binary")
  const updated = await threadCodex(p, codex, folder)
  expect(updated.install).not.toBe(first.install)
  expect(fs.readFileSync(updated.run, "utf8")).toBe("\x7fELF the updated codex binary")
  expect(copies(folder).sort()).toEqual([path.basename(first.install), path.basename(updated.install)].sort())
  unused(first.install)
  await threadCodex(p, codex, folder)
  expect(copies(folder)).toEqual([path.basename(updated.install)])
})

test("each start from a copy writes its last-used time into it, the user's alone", async () => {
  const { home, p, folder } = layout()
  const codex = fakeInstall(releaseIn(home))
  const before = Date.now()
  const copy = await threadCodex(p, codex, folder)
  const file = path.join(copy.install, "last-used")
  const stat = fs.statSync(file)
  expect(stat.mtimeMs).toBeGreaterThanOrEqual(before - 1000)
  expect(stat.mode & 0o077).toBe(0)
  expect(Date.parse(fs.readFileSync(file, "utf8").trim())).toBeGreaterThanOrEqual(before - 1000)
  unused(copy.install)
  await threadCodex(p, codex, folder)
  expect(fs.statSync(file).mtimeMs).toBeGreaterThanOrEqual(before - 1000)
})

test("a copy of another Codex a session found but hasn't started from is kept: only a copy unused for over a day goes, never the current one", async () => {
  const { home, p, folder } = layout()
  // Another office found its copy of an earlier Codex for a session that hasn't started from it: no program runs
  // from it yet.
  const found = await threadCodex(p, fakeInstall(releaseIn(home, "0.170.0")), folder)
  const stale = await threadCodex(p, fakeInstall(releaseIn(home, "0.171.0")), folder)
  unused(stale.install)
  // One made before copies said when they were used goes by when it last changed.
  const unmarked = await threadCodex(p, fakeInstall(releaseIn(home, "0.169.0")), folder)
  fs.rmSync(path.join(unmarked.install, "last-used"))
  fs.utimesSync(unmarked.install, DAY_AGO(), DAY_AGO())
  const current = fakeInstall(releaseIn(home, "0.172.0"))
  const copy = await threadCodex(p, current, folder)
  expect(copies(folder).sort()).toEqual([path.basename(copy.install), path.basename(found.install)].sort())
  // The current Codex's copy stays however long since its last use; the found one goes once a day has passed.
  unused(copy.install)
  unused(found.install)
  await threadCodex(p, current, folder)
  expect(copies(folder)).toEqual([path.basename(copy.install)])
})

test("a copy that lost a file or had one changed gets it back in place at the next start, so a session running from it goes on", async () => {
  const { home, p, folder } = layout()
  const codex = fakeInstall(releaseIn(home))
  const copy = await threadCodex(p, codex, folder)
  const inodes = () => ["", "codex-path/rg", "codex-resources/bwrap"].map((rel) => fs.statSync(path.join(copy.install, rel)).ino)
  const before = inodes()
  fs.rmSync(copy.run)
  fs.chmodSync(path.join(copy.install, "bin/codex-exec-server"), 0o700)
  fs.writeFileSync(path.join(copy.install, "bin/codex-exec-server"), "x")
  fs.rmSync(path.join(copy.install, "source.json"))
  expect(await threadCodex(p, codex, folder)).toEqual(copy)
  expect(fs.readFileSync(copy.run, "utf8")).toBe("\x7fELF the codex binary")
  expect(fs.readFileSync(path.join(copy.install, "bin/codex-exec-server"), "utf8")).toBe("\x7fELF its exec server")
  expect(fs.statSync(copy.run).mode & 0o777).toBe(0o500)
  expect(fs.existsSync(path.join(copy.install, "source.json"))).toBe(true)
  expect(inodes()).toEqual(before)
  expect(filesIn(copy.install).filter((rel) => rel.endsWith(".part"))).toEqual([])
  // One that isn't a private folder of the user's is refused, saying to remove it.
  fs.chmodSync(copy.install, 0o755)
  await expect(threadCodex(p, codex, folder)).rejects.toThrow(/isn't a private folder of yours; remove it/)
})

test("a Codex in a denied folder that isn't a binary in its install's bin, or with a file or folder others could change, is refused before anything is copied", async () => {
  const { home, p, folder } = layout()
  const codex = fakeInstall(releaseIn(home))
  const script = path.join(home, ".codex/wrapper/bin/codex")
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 })
  for (const dir of [path.dirname(script), path.dirname(path.dirname(script))]) fs.chmodSync(dir, 0o755)
  for (const refused of [nativeCodex(script), { run: path.join(codex.install, "codex-path/rg"), install: codex.install }]) {
    const copied = threadCodex(p, refused, folder)
    await expect(copied).rejects.toBeInstanceOf(UnsafeProfile)
    await expect(copied).rejects.toThrow(/lies in .*\.codex, which an employee's permission denies, and .* isn't a Codex binary in its install's bin folder/)
  }
  for (const open of ["bin", "codex-path", "codex-resources", "codex-resources/bwrap", "codex-path/rg", "codex-package.json"]) {
    const at = path.join(codex.install, open)
    const mode = fs.statSync(at).mode & 0o777
    fs.chmodSync(at, mode | 0o020)
    await expect(threadCodex(p, codex, folder), open).rejects.toThrow(/others than the user may write/)
    fs.chmodSync(at, mode)
  }
  expect(copies(folder)).toEqual([])
})

test("using a copy removes every other copy unused for a day that no program runs from, and folders a process that is gone half made, never a link or a file", async () => {
  const { home, root, p, folder } = layout()
  // A copy a program runs from: another office's live session on an earlier Codex, started over a day ago, say.
  const busy = await threadCodex(p, fakeInstall(releaseIn(home, "0.170.0"), "/bin/sleep"), folder)
  const running = spawn(busy.run, ["30"], { stdio: "ignore" })
  onTestFinished(() => void running.kill("SIGKILL"))
  const old = await threadCodex(p, fakeInstall(releaseIn(home, "0.171.0")), folder)
  for (const install of [busy.install, old.install]) unused(install)
  for (const name of ["install-0000000000000000.999999999.part", `install-1111111111111111.${process.pid}.part`]) {
    fs.mkdirSync(path.join(folder, name), { mode: 0o700 })
  }
  const target = path.join(root, "target")
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, "keep"), "x")
  fs.symlinkSync(target, path.join(folder, "install-2222222222222222"))
  fs.writeFileSync(path.join(folder, "install-3333333333333333"), "x")
  const lines: string[] = []
  const current = fakeInstall(releaseIn(home, "0.172.0"))
  const copy = await threadCodex(p, current, folder, (line) => lines.push(line))
  expect(fs.readdirSync(folder).sort()).toEqual(
    [
      path.basename(copy.install),
      path.basename(busy.install),
      `install-1111111111111111.${process.pid}.part`,
      "install-2222222222222222",
      "install-3333333333333333",
    ].sort(),
  )
  expect(fs.existsSync(old.install)).toBe(false)
  expect(fs.readFileSync(path.join(target, "keep"), "utf8")).toBe("x")
  expect(lines).toEqual([])
  // Once nothing runs from it, the next use removes it too; the installs themselves are left as they are.
  running.kill("SIGKILL")
  await waitFor(() => running.signalCode !== null, { what: "the program to stop" })
  await threadCodex(p, current, folder)
  expect(copies(folder)).toEqual([path.basename(copy.install)])
  expect(fs.existsSync(path.join(releaseIn(home, "0.171.0"), "bin/codex"))).toBe(true)
})

/** The real Codex the opt-in tests run, named by `OPENCORP_TEST_CODEX`. Unset, they skip; under
 *  `OPENCORP_TEST_SANDBOX` they run, and fail without it. They run no model turn. */
const CODEX = process.env.OPENCORP_TEST_CODEX
const NO_CODEX = CODEX === undefined ? !process.env.OPENCORP_TEST_SANDBOX : !sandboxAvailable()

test.skipIf(NO_CODEX)(
  "a real codex its standalone installer put in ~/.codex runs a command in its sandbox from the office's copy, which still can't read ~/.codex",
  async () => {
    if (CODEX === undefined) throw new Error("OPENCORP_TEST_SANDBOX is set: set OPENCORP_TEST_CODEX to a Codex 0.167.0+")
    const { root, home, ws, p, folder } = layout()
    const codex = nativeCodex(standaloneCodex(home, nativeCodex(CODEX).install))
    expect(codex.install.startsWith(path.join(home, ".codex/"))).toBe(true)
    const copy = await threadCodex(p, codex, folder)
    const codexHome = path.join(root, "codex-home")
    fs.mkdirSync(codexHome)
    const load = threadLoad(ws, codexThread(p, "opencorp-t", { install: copy.install }))
    const script = `echo ran; cat ${path.join(home, ".codex/auth.json")}`
    const result = spawnSync(copy.run, sandboxArgs(load, ["/bin/sh", "-c", script]), {
      cwd: ws,
      env: { ...threadEnv({ HOME: home }, p), CODEX_HOME: codexHome },
      encoding: "utf8",
      timeout: 60_000,
    })
    const output = result.stdout + result.stderr
    expect(result.stdout, output).toContain("ran\n")
    expect(output).not.toContain("decoy-codex")
  },
  120_000,
)

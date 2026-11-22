/** Codex as a thread's sandbox can run it: as installed, or, installed in a folder an employee's permission denies
 *  (the standalone installer's `~/.codex`), from the office's private copy of its install, shared per Codex and swept
 *  once its Codex is gone. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { staleCopy, threadCodex } from "../../../src/features/codex/install.ts"
import { harnessTemp, sandboxArgs, threadEnv } from "../../../src/features/codex/thread.ts"
import { type EmployeePermission, codexThread } from "../../../src/runtime/sandbox/harness_profile.ts"
import { fenceIn, freshFolder, sweepTemp } from "../../../src/runtime/sandbox/harness_temp.ts"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { nativeCodex, threadLoad } from "../../../src/tools/codex/codex.ts"
import { tempDir } from "../../helpers.ts"
import { sandboxAvailable, standaloneCodex } from "../../runtime/sandbox/helpers.ts"

setDefaultTimeout(30_000)

/** A temp home with an office home and `.codex` in it, a workspace, the harness folder with a fresh temp folder and
 *  the fence, and an employee's read-only permission over them. */
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
  return { root, home, ws, temp, p }
}

/** A stand-in Codex install at `install`, laid out as Codex's packages lay theirs out: its binary (no script) and
 *  another program in `bin`, the bundled bubblewrap and voice resources in `codex-resources`, `rg` in `codex-path`, and
 *  its package file; each folder and file only the user may change. Returns what runs it, as `nativeCodex` finds it. */
function fakeInstall(install: string): { run: string; install: string } {
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
    fs.writeFileSync(path.join(install, rel), text, { mode: 0o755 })
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

/** The copies in the harness folder `temp`. */
function copies(temp: string): string[] {
  return fs.readdirSync(temp).filter((name) => name.startsWith("install-"))
}

test("a Codex outside every folder an employee's permission denies runs as installed", async () => {
  const { root, temp, p } = layout()
  const codex = fakeInstall(path.join(root, "codex-install"))
  expect(await threadCodex(p, codex, temp)).toEqual(codex)
  expect(copies(temp)).toEqual([])
})

test("a Codex installed in a folder the permission denies runs from the office's private copy of its install: its bin, bundled bubblewrap, codex-path and package file", async () => {
  const { home, temp, p } = layout()
  const release = path.join(home, ".codex/packages/standalone/releases/0.171.0-x86_64-unknown-linux-musl")
  const codex = fakeInstall(release)
  const copy = await threadCodex(p, codex, temp)
  const [name] = copies(temp)
  expect(name).toMatch(/^install-[0-9a-f]{16}$/)
  expect(copy).toEqual({ run: path.join(temp, name!, "bin/codex"), install: path.join(temp, name!) })
  expect(filesIn(copy.install)).toEqual(
    ["bin/codex", "bin/codex-exec-server", "codex-package.json", "codex-path/rg", "codex-resources/bwrap", "source.json"].sort(),
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

test("sessions share one copy per Codex, made once even when they start together, and a changed Codex gets its own", async () => {
  const { home, temp, p } = layout()
  const codex = fakeInstall(path.join(home, ".codex/packages/standalone/releases/0.171.0-x86_64-unknown-linux-musl"))
  const [first, again] = await Promise.all([threadCodex(p, codex, temp), threadCodex(p, codex, temp)])
  expect(again).toEqual(first)
  const inode = fs.statSync(first.run).ino
  expect(await threadCodex(p, codex, temp)).toEqual(first)
  expect(fs.statSync(first.run).ino).toBe(inode)
  expect(fs.readdirSync(temp).filter((name) => name.endsWith(".part"))).toEqual([])
  expect(staleCopy(temp, path.basename(first.install))).toBe(false)
  // An update rewrites the binary: the next session gets a copy of the new one, and the old copy is stale.
  fs.writeFileSync(codex.run, "\x7fELF the updated codex binary")
  const updated = await threadCodex(p, codex, temp)
  expect(updated.install).not.toBe(first.install)
  expect(fs.readFileSync(updated.run, "utf8")).toBe("\x7fELF the updated codex binary")
  expect(staleCopy(temp, path.basename(first.install))).toBe(true)
  expect(staleCopy(temp, path.basename(updated.install))).toBe(false)
})

test("a copy that was changed or left half made is made again", async () => {
  const { home, temp, p } = layout()
  const codex = fakeInstall(path.join(home, ".codex/packages/standalone/releases/0.171.0-x86_64-unknown-linux-musl"))
  const copy = await threadCodex(p, codex, temp)
  fs.chmodSync(copy.run, 0o700)
  fs.writeFileSync(copy.run, "x")
  expect(await threadCodex(p, codex, temp)).toEqual(copy)
  expect(fs.readFileSync(copy.run, "utf8")).toBe("\x7fELF the codex binary")
  fs.rmSync(path.join(copy.install, "codex-resources/bwrap"))
  expect(await threadCodex(p, codex, temp)).toEqual(copy)
  expect(fs.readFileSync(path.join(copy.install, "codex-resources/bwrap"), "utf8")).toBe("\x7fELF the bundled bubblewrap")
})

test("a Codex in a denied folder that isn't a binary in its install's bin, or that others could change, is refused before anything is copied", async () => {
  const { home, temp, p } = layout()
  const codex = fakeInstall(path.join(home, ".codex/packages/standalone/releases/0.171.0-x86_64-unknown-linux-musl"))
  const script = path.join(home, ".codex/wrapper/bin/codex")
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 })
  for (const dir of [path.dirname(script), path.dirname(path.dirname(script))]) fs.chmodSync(dir, 0o755)
  for (const refused of [nativeCodex(script), { run: path.join(codex.install, "codex-path/rg"), install: codex.install }]) {
    const copied = threadCodex(p, refused, temp)
    await expect(copied).rejects.toBeInstanceOf(UnsafeProfile)
    await expect(copied).rejects.toThrow(/lies in .*\.codex, which an employee's permission denies, and .* isn't a Codex binary in its install's bin folder/)
  }
  fs.chmodSync(path.join(codex.install, "bin"), 0o775)
  await expect(threadCodex(p, codex, temp)).rejects.toThrow(/others than the user may write/)
  expect(copies(temp)).toEqual([])
})

test("the office's start sweeps a copy whose Codex is gone or changed, and keeps the others", async () => {
  const { home, temp, p } = layout()
  const releases = path.join(home, ".codex/packages/standalone/releases")
  const [kept] = await Promise.all(
    ["0.170.0", "0.171.0", "0.172.0"].map((v) => threadCodex(p, fakeInstall(path.join(releases, v)), temp)),
  )
  fs.rmSync(path.join(releases, "0.171.0"), { recursive: true })
  fs.writeFileSync(path.join(releases, "0.172.0/codex-resources/bwrap"), "\x7fELF another bubblewrap")
  fs.mkdirSync(path.join(temp, "install-0000000000000000"), { mode: 0o700 }) // no source.json
  sweepTemp(temp, (name) => staleCopy(temp, name), () => {})
  expect(copies(temp).sort()).toEqual([path.basename(kept!.install)])
  expect(fs.existsSync(path.join(temp, "S1"))).toBe(true)
  expect(staleCopy(temp, "S1")).toBe(false)
})

/** The real Codex the opt-in tests run, named by `OPENCORP_TEST_CODEX`. Unset, they skip; under
 *  `OPENCORP_TEST_SANDBOX` they run, and fail without it. They run no model turn. */
const CODEX = process.env.OPENCORP_TEST_CODEX
const NO_CODEX = CODEX === undefined ? !process.env.OPENCORP_TEST_SANDBOX : !sandboxAvailable()

test.skipIf(NO_CODEX)(
  "a real codex its standalone installer put in ~/.codex runs a command in its sandbox from the office's copy, which still can't read ~/.codex",
  async () => {
    if (CODEX === undefined) throw new Error("OPENCORP_TEST_SANDBOX is set: set OPENCORP_TEST_CODEX to a Codex 0.167.0+")
    const { root, home, ws, temp, p } = layout()
    const codex = nativeCodex(standaloneCodex(home, nativeCodex(CODEX).install))
    expect(codex.install.startsWith(path.join(home, ".codex/"))).toBe(true)
    const copy = await threadCodex(p, codex, temp)
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

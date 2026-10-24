/** bubblewrap (Linux) command lines for sandboxed calls. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { command, SYSTEM_DIRS } from "../../src/sandbox/bwrap.ts"
import type { Helper } from "../../src/sandbox/policy.ts"
import { goldenPolicy, makePolicy } from "./helpers.ts"

/** `makePolicy()` with its root as a read-only path (Python's `make` fixture). */
function setup() {
  const { root, make } = makePolicy()
  return {
    root,
    make: (opts: { writable?: boolean; network?: boolean } = {}) => make({ ...opts, readOnly: [root] }),
  }
}

/** The three-item runs of `argv` that start with `flag`. */
function triples(argv: readonly string[], flag: string): string[][] {
  return argv.flatMap((a, i) => (a === flag ? [argv.slice(i, i + 3)] : []))
}

/** The `SYSTEM_DIRS` mounts this host gets: they depend on which of them are links. */
function systemMounts(): string[] {
  return SYSTEM_DIRS.flatMap((p) =>
    fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()
      ? ["--symlink", fs.readlinkSync(p), p]
      : ["--ro-bind-try", p, p],
  )
}

/** `argv` with `items` inserted right before `--remount-ro`. */
function beforeRemount(argv: readonly string[], items: readonly string[]): string[] {
  const i = argv.indexOf("--remount-ro")
  return [...argv.slice(0, i), ...items, ...argv.slice(i)]
}

test("isolation flags", () => {
  const argv = command(setup().make(), ["/bin/true"])
  expect(argv[0]).toBe("bwrap")
  for (const flag of ["--die-with-parent", "--unshare-pid", "--unshare-net", "--new-session"]) {
    expect(argv).toContain(flag)
  }
  expect(argv[argv.indexOf("--proc") + 1]).toBe("/proc")
  expect(argv[argv.indexOf("--remount-ro") + 1]).toBe("/")
  expect(argv.slice(-2)).toEqual(["--", "/bin/true"])
})

test("network keeps the host network", () => {
  expect(command(setup().make({ network: true }), ["/bin/true"])).not.toContain("--unshare-net")
})

test("workspace bind mode", () => {
  const { make } = setup()
  const rw = make()
  const ws = rw.workspace
  expect(triples(command(rw, ["x"]), "--bind")).toContainEqual(["--bind", ws, ws])
  const ro = make({ writable: false })
  const argv = command(ro, ["x"])
  expect(triples(argv, "--ro-bind")).toContainEqual(["--ro-bind", ws, ws])
  expect(triples(argv, "--bind")).not.toContainEqual(["--bind", ws, ws])
})

test("git paths are read only over a writable workspace", () => {
  const policy = setup().make()
  fs.mkdirSync(path.join(policy.workspace, ".git"))
  const argv = command(policy, ["x"])
  const ws = policy.workspace
  const git = path.join(ws, ".git")
  // .git is bound onto itself so it is a mount point, which can't be renamed; binding
  // only .git/hooks and .git/config would still let `mv .git .git2` succeed.
  expect(triples(argv, "--bind")).toContainEqual(["--bind", git, git])
  // Later mounts cover earlier ones: workspace, then .git, then the read-only paths.
  expect(argv.indexOf(ws)).toBeLessThan(argv.indexOf(git))
  for (const p of policy.protectedPaths.slice(1)) {
    expect(triples(argv, "--ro-bind-try")).toContainEqual(["--ro-bind-try", p, p])
    expect(argv.indexOf(p)).toBeGreaterThan(argv.indexOf(git))
  }
})

test("missing git hooks is created so it can be bound", () => {
  const policy = setup().make()
  fs.mkdirSync(path.join(policy.workspace, ".git"))
  command(policy, ["x"])
  expect(fs.statSync(path.join(policy.workspace, ".git/hooks")).isDirectory()).toBe(true)
})

test("git file is read only", () => {
  // A worktree's .git is a file naming the real git dir; it must not be rewritten.
  const policy = setup().make()
  const git = path.join(policy.workspace, ".git")
  fs.writeFileSync(git, "gitdir: /elsewhere\n")
  const argv = command(policy, ["x"])
  expect(triples(argv, "--ro-bind")).toContainEqual(["--ro-bind", git, git])
  expect(triples(argv, "--bind")).not.toContainEqual(["--bind", git, git])
})

test("git symlinks are never bound", () => {
  // bwrap follows symlinks, so binding one would mount its target in the sandbox.
  const { root, make } = setup()
  const secret = path.join(root, "secret")
  fs.mkdirSync(secret)
  const policy = make()
  const git = path.join(policy.workspace, ".git")
  fs.mkdirSync(git)
  fs.symlinkSync(secret, path.join(git, "hooks"))
  fs.symlinkSync(path.join(secret, "key"), path.join(git, "config"))
  const argv = command(policy, ["x"])
  expect(argv).not.toContain(path.join(git, "hooks"))
  expect(argv).not.toContain(path.join(git, "config"))
  fs.unlinkSync(path.join(git, "hooks"))
  fs.unlinkSync(path.join(git, "config"))
  fs.rmdirSync(git)
  fs.symlinkSync(secret, git)
  expect(command(policy, ["x"])).not.toContain(git)
  expect(fs.existsSync(path.join(secret, "hooks"))).toBe(false)
})

test("no git no git binds", () => {
  const policy = setup().make()
  const argv = command(policy, ["x"])
  expect(fs.existsSync(path.join(policy.workspace, ".git"))).toBe(false)
  expect(argv).not.toContain(path.join(policy.workspace, ".git"))
})

test("tmpdir and read only", () => {
  const policy = setup().make()
  const argv = command(policy, ["x"])
  const tmp = policy.tmpdir
  const extra = policy.readOnly[0]!
  expect(triples(argv, "--bind")).toContainEqual(["--bind", tmp, tmp])
  expect(triples(argv, "--ro-bind-try")).toContainEqual(["--ro-bind-try", extra, extra])
  expect(argv[argv.indexOf("--chdir") + 1]).toBe(policy.workspace)
})

test("home is not mounted", () => {
  const argv = command(setup().make(), ["x"])
  expect(argv).not.toContain("/home")
  expect(argv).not.toContain("/root")
  expect(argv.join(" ")).not.toContain("/run/user")
})

/** Line 1 of the Python office's bwrap goldens: a writable, offline workspace with `.git` and `.git/config`. */
function b1(root: string): string[] {
  return [
    "bwrap", "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    "--new-session", "--unshare-net",
    ...systemMounts(),
    "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/pki", "/etc/pki",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/ld.so.conf", "/etc/ld.so.conf",
    "--ro-bind-try", "/etc/ld.so.conf.d", "/etc/ld.so.conf.d",
    "--ro-bind-try", "/etc/localtime", "/etc/localtime",
    "--ro-bind-try", "/etc/passwd", "/etc/passwd",
    "--ro-bind-try", "/etc/group", "/etc/group",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind-try", "/etc/hosts", "/etc/hosts",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--proc", "/proc",
    "--dev", "/dev",
    "--bind", `${root}/tmp`, `${root}/tmp`,
    "--bind", `${root}/ws`, `${root}/ws`,
    "--bind", `${root}/ws/.git`, `${root}/ws/.git`,
    "--ro-bind-try", `${root}/ws/.git/hooks`, `${root}/ws/.git/hooks`,
    "--ro-bind-try", `${root}/ws/.git/config`, `${root}/ws/.git/config`,
    "--remount-ro", "/",
    "--chdir", `${root}/ws`,
    "--", "/bin/sh", "-c", "ls",
  ]
}

/** Line 2 of the Python office's bwrap goldens: read-only, networked, with a read-only path. */
function b2(): string[] {
  return [
    "bwrap", "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    "--new-session",
    ...systemMounts(),
    "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/pki", "/etc/pki",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/ld.so.conf", "/etc/ld.so.conf",
    "--ro-bind-try", "/etc/ld.so.conf.d", "/etc/ld.so.conf.d",
    "--ro-bind-try", "/etc/localtime", "/etc/localtime",
    "--ro-bind-try", "/etc/passwd", "/etc/passwd",
    "--ro-bind-try", "/etc/group", "/etc/group",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind-try", "/etc/hosts", "/etc/hosts",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
    "--proc", "/proc",
    "--dev", "/dev",
    "--ro-bind-try", "/opt/tools/python", "/opt/tools/python",
    "--bind", "/home/me/.opencorp/office/sessions/s1/tmp", "/home/me/.opencorp/office/sessions/s1/tmp",
    "--ro-bind", "/home/me/project", "/home/me/project",
    "--remount-ro", "/",
    "--chdir", "/home/me/project",
    "--", "/bin/sh", "-c", "ls",
  ]
}

const SHELL = ["/bin/sh", "-c", "ls"]

/** B1's layout: a fresh `makePolicy()` with `.git/` and `.git/config`; `file` creates a file under the root. */
function b1Layout() {
  const { root, ws, make } = makePolicy()
  fs.mkdirSync(path.join(ws, ".git"))
  fs.writeFileSync(path.join(ws, ".git/config"), "")
  const file = (rel: string): string => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, "")
    return p
  }
  return { root, ws, make, file }
}

test("a shell argv equals the Python argv", () => {
  const { root, ws, make } = b1Layout()
  expect(command(make(), SHELL)).toEqual(b1(root))
  expect(fs.statSync(path.join(ws, ".git/hooks")).isDirectory()).toBe(true)
  const policy = goldenPolicy({
    workspace: "/home/me/project",
    writable: false,
    network: true,
    tmpdir: "/home/me/.opencorp/office/sessions/s1/tmp",
    readOnly: ["/opt/tools/python"],
  })
  expect(command(policy, SHELL)).toEqual(b2())
})

test("the compiled helper is bound read only before the root is remounted", () => {
  const { root, ws, make, file } = b1Layout()
  const bin = file("install/bin/opencorp")
  const helper: Helper = { binary: bin }
  expect(command(make({ helper }), SHELL)).toEqual(beforeRemount(b1(root), ["--ro-bind", bin, bin]))
  const argv = command(make({ writable: false, helper }), SHELL)
  const i = argv.indexOf("--remount-ro")
  expect(argv.slice(i - 6, i)).toEqual(["--ro-bind", ws, ws, "--ro-bind", bin, bin])
})

test("the checkout helper binds bun and its entry read only", () => {
  const { root, make, file } = b1Layout()
  const bun = file("bun/bun")
  const entry = file("checkout/packages/office/src/sandbox/fs_helper.ts")
  const argv = command(make({ helper: { bun, entry } }), SHELL)
  expect(argv).toEqual(beforeRemount(b1(root), ["--ro-bind", bun, bun, "--ro-bind", entry, entry]))
})

test("a shell argv binds no helper", () => {
  const { make, file } = b1Layout()
  const helperPaths = [file("install/bin/opencorp"), file("bun/bun")]
  const argv = command(make(), SHELL)
  for (const p of helperPaths) expect(argv).not.toContain(p)
  expect(triples(argv, "--ro-bind")).toEqual([])
})

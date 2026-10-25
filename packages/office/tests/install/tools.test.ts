/** The programs the daemon runs, found on its PATH at start, and the paths every workspace must stay clear of. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { installPaths, resolveTools, workspaceGuards } from "../../src/install/tools.ts"
import { SandboxPolicy, UnsafeWorkspace, checkWorkspace } from "../../src/sandbox/policy.ts"
import { tempDir } from "../helpers.ts"

/** Writes a fake program at `file` (never run), making its folders. */
function fakeTool(file: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "#!/bin/sh\n")
  fs.chmodSync(file, mode)
  return file
}

test("each tool is the absolute path found on the daemon path", () => {
  const root = tempDir()
  const a = path.join(root, "a")
  const b = path.join(root, "b")
  fakeTool(path.join(root, "real", "git-2.47"))
  fs.mkdirSync(a)
  fs.symlinkSync("../real/git-2.47", path.join(a, "git"))
  fakeTool(path.join(a, "ps"))
  fakeTool(path.join(b, "git"))
  expect(resolveTools({ PATH: `${a}:${b}` })).toEqual({
    git: path.join(a, "git"),
    ps: path.join(a, "ps"),
  })
})

test("relative entries directories and files that cant run are skipped", () => {
  const r = tempDir()
  fakeTool(path.join(r, "git"))
  const relative = path.relative(process.cwd(), r)
  expect(path.isAbsolute(relative)).toBe(false)
  const root = tempDir()
  const d1 = path.join(root, "d1")
  const d2 = path.join(root, "d2")
  const d3 = path.join(root, "d3")
  fs.mkdirSync(path.join(d1, "git"), { recursive: true })
  fakeTool(path.join(d2, "git"), 0o644)
  fakeTool(path.join(d3, "git"))
  expect(resolveTools({ PATH: [relative, d1, d2, d3].join(":") }).git).toBe(path.join(d3, "git"))
  expect(resolveTools({ PATH: relative }).git).toBeUndefined()
})

test("the codex override is a path or a name on the path", () => {
  const root = tempDir()
  const bin = path.join(root, "bin")
  const absolute = fakeTool(path.join(root, "abs", "codex-x"))
  fakeTool(path.join(bin, "codex-x"))
  fakeTool(path.join(bin, "codex"))
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: absolute }).codex).toBe(absolute)
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: "codex-x" }).codex).toBe(path.join(bin, "codex-x"))
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: path.join(root, "missing") }).codex).toBeUndefined()
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: "codex-missing" }).codex).toBeUndefined()
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: "./codex" }).codex).toBeUndefined()
  expect(resolveTools({ PATH: bin }).codex).toBe(path.join(bin, "codex"))
})

/** Writes a shell script at `file` printing `body`'s output, making its folders. */
function script(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

test("a linked tool still runs after its target is replaced", () => {
  const root = tempDir()
  const bin = path.join(root, "bin")
  script(path.join(root, "real", "git-2.47"), "echo 2.47")
  fs.mkdirSync(bin)
  fs.symlinkSync("../real/git-2.47", path.join(bin, "git"))
  const tools = resolveTools({ PATH: bin })
  // A package manager's upgrade: a new versioned folder, the old one gone, the link repointed.
  script(path.join(root, "real", "git-2.48"), "echo 2.48")
  fs.rmSync(path.join(root, "real", "git-2.47"))
  fs.unlinkSync(path.join(bin, "git"))
  fs.symlinkSync("../real/git-2.48", path.join(bin, "git"))
  const ran = spawnSync(tools.git!, [], { env: {}, encoding: "utf8", timeout: 5000 })
  expect(ran.status).toBe(0)
  expect(ran.stdout).toBe("2.48\n")
})

test("a multi call tool sees the name it was found by", () => {
  const root = tempDir()
  const bin = path.join(root, "bin")
  script(path.join(root, "box", "busybox"), 'basename "$0"')
  fs.mkdirSync(bin)
  fs.symlinkSync("../box/busybox", path.join(bin, "ps"))
  const ran = spawnSync(resolveTools({ PATH: bin }).ps!, [], { env: {}, encoding: "utf8", timeout: 5000 })
  expect(ran.status).toBe(0)
  expect(ran.stdout).toBe("ps\n")
})

test("repo is this checkout", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url))
  expect(installPaths()).toEqual([fs.realpathSync(root)])
  expect(fs.existsSync(path.join(root, "packages", "cli", "src", "main.ts"))).toBe(true)
})

test("a compiled binary installs as its package and its shim package", () => {
  const hoisted = path.join(tempDir(), "node_modules")
  const pkg = path.join(hoisted, "opencorp-darwin-arm64")
  const binary = fakeTool(path.join(pkg, "bin", "opencorp"))
  const sibling = path.join(hoisted, "opencorp")
  fs.mkdirSync(sibling)
  expect(installPaths([binary])).toEqual([fs.realpathSync(pkg), fs.realpathSync(sibling)])

  const link = path.join(tempDir(), "link", "bin", "opencorp")
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(binary, link)
  expect(installPaths([link])).toEqual([fs.realpathSync(pkg), fs.realpathSync(sibling)])

  const shim = path.join(tempDir(), "node_modules", "opencorp")
  const nested = path.join(shim, "node_modules", "opencorp-linux-x64")
  expect(installPaths([fakeTool(path.join(nested, "bin", "opencorp"))])).toEqual([
    fs.realpathSync(nested),
    fs.realpathSync(shim),
  ])

  const alone = path.join(tempDir(), "node_modules", "opencorp-darwin-arm64")
  expect(installPaths([fakeTool(path.join(alone, "bin", "opencorp"))])).toEqual([fs.realpathSync(alone)])

  // `npm i opencorp` in a project folder that is itself named opencorp: the project is not the shim.
  const project = path.join(tempDir(), "opencorp", "node_modules", "opencorp-darwin-arm64")
  expect(installPaths([fakeTool(path.join(project, "bin", "opencorp"))])).toEqual([fs.realpathSync(project)])

  const x = path.join(tempDir(), "x")
  expect(installPaths([fakeTool(path.join(x, "opencorp"))])).toEqual([fs.realpathSync(x)])
})

test("the workspace guards refuse a tool folder a path entry and the install", () => {
  const root = tempDir()
  const t = path.join(root, "t")
  const p = path.join(root, "p")
  const c = path.join(root, "c")
  const r = path.join(root, "r")
  const sibling = path.join(root, "sibling")
  fakeTool(path.join(t, "bin", "git"))
  fs.mkdirSync(path.join(p, "bin"), { recursive: true })
  fs.mkdirSync(sibling)
  const entry = path.join(c, "packages", "cli", "src", "main.ts")
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, "")
  const bun = fakeTool(path.join(r, "bun"))
  const env = { PATH: `${path.join(p, "bin")}:relative/bin` }
  const guards = workspaceGuards(resolveTools({ PATH: path.join(t, "bin") }), env, [bun, "--no-install", entry])
  for (const ws of [t, p, c, r]) expect(() => checkWorkspace(ws, guards)).toThrow(UnsafeWorkspace)
  expect(() => checkWorkspace(sibling, guards)).not.toThrow()
  expect(guards.tools).toContain(fs.realpathSync(bun))
  expect(guards.path).toEqual([path.join(p, "bin")])
})

test("a workspace containing the tool path or its realpath is refused", () => {
  const root = tempDir()
  const a = path.join(root, "a")
  const real = path.join(root, "real")
  const c = path.join(root, "c")
  const r = path.join(root, "r")
  const sibling = path.join(root, "sibling")
  const target = fakeTool(path.join(real, "git-2.47"))
  fs.mkdirSync(a)
  fs.symlinkSync("../real/git-2.47", path.join(a, "git"))
  fs.mkdirSync(sibling)
  const entry = path.join(c, "packages", "cli", "src", "main.ts")
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, "")
  const bun = fakeTool(path.join(r, "bun"))
  const guards = workspaceGuards(resolveTools({ PATH: a }), { PATH: "" }, [bun, "--no-install", entry])
  const realA = fs.realpathSync(a)
  expect(() => checkWorkspace(a, guards)).toThrow(
    `workspace ${realA} contains ${realA}/git, a program the office runs; use a project folder`,
  )
  const realTarget = fs.realpathSync(target)
  expect(() => checkWorkspace(real, guards)).toThrow(
    `workspace ${fs.realpathSync(real)} contains ${realTarget}, a program the office runs; use a project folder`,
  )
  expect(() => checkWorkspace(sibling, guards)).not.toThrow()
  expect(guards.tools).toContain(path.join(a, "git"))
  expect(guards.tools).toContain(realTarget)

  const policy = new SandboxPolicy({
    workspace: sibling,
    writable: false,
    network: false,
    tmpdir: tempDir(),
    office: guards,
  })
  expect(policy.office.tools).toContain(path.join(a, "git"))
  expect(() => new SandboxPolicy({ ...policy, workspace: a })).toThrow(UnsafeWorkspace)
})

/** The programs the daemon runs, resolved to realpaths at start, and the paths every workspace must stay clear of. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { installPaths, resolveTools, workspaceGuards } from "../../src/install/tools.ts"
import { UnsafeWorkspace, checkWorkspace } from "../../src/sandbox/policy.ts"
import { tempDir } from "../helpers.ts"

/** Writes a fake program at `file` (never run), making its folders. */
function fakeTool(file: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "#!/bin/sh\n")
  fs.chmodSync(file, mode)
  return file
}

test("each tool is resolved on the daemon path to its realpath", () => {
  const root = tempDir()
  const a = path.join(root, "a")
  const b = path.join(root, "b")
  fakeTool(path.join(root, "real", "git-2.47"))
  fs.mkdirSync(a)
  fs.symlinkSync("../real/git-2.47", path.join(a, "git"))
  fakeTool(path.join(a, "ps"))
  fakeTool(path.join(b, "git"))
  expect(resolveTools({ PATH: `${a}:${b}` })).toEqual({
    git: fs.realpathSync(path.join(root, "real", "git-2.47")),
    ps: fs.realpathSync(path.join(a, "ps")),
  })
})

test("relative entries directories and files that cant run are skipped", () => {
  const r = tempDir()
  fakeTool(path.join(r, "git"))
  const relative = path.relative(process.cwd(), r)
  expect(path.isAbsolute(relative)).toBe(false)
  const root = tempDir()
  const [d1, d2, d3] = ["d1", "d2", "d3"].map((d) => path.join(root, d))
  fs.mkdirSync(path.join(d1!, "git"), { recursive: true })
  fakeTool(path.join(d2!, "git"), 0o644)
  fakeTool(path.join(d3!, "git"))
  expect(resolveTools({ PATH: [relative, d1, d2, d3].join(":") }).git).toBe(fs.realpathSync(path.join(d3!, "git")))
  expect(resolveTools({ PATH: relative }).git).toBeUndefined()
})

test("the codex override is a path or a name on the path", () => {
  const root = tempDir()
  const bin = path.join(root, "bin")
  const absolute = fakeTool(path.join(root, "abs", "codex-x"))
  fakeTool(path.join(bin, "codex-x"))
  fakeTool(path.join(bin, "codex"))
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: absolute }).codex).toBe(fs.realpathSync(absolute))
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: "codex-x" }).codex).toBe(
    fs.realpathSync(path.join(bin, "codex-x")),
  )
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: path.join(root, "missing") }).codex).toBeUndefined()
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: "codex-missing" }).codex).toBeUndefined()
  expect(resolveTools({ PATH: bin, OPENCORP_CODEX_BIN: "./codex" }).codex).toBeUndefined()
  expect(resolveTools({ PATH: bin }).codex).toBe(fs.realpathSync(path.join(bin, "codex")))
})

test("repo is this checkout", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url))
  expect(installPaths()).toEqual([fs.realpathSync(root)])
  expect(fs.existsSync(path.join(root, "packages", "cli", "src", "main.ts"))).toBe(true)
})

test("a compiled binary installs as its package and its shim package", () => {
  const hoisted = path.join(tempDir(), "nm")
  const pkg = path.join(hoisted, "opencorp-darwin-arm64")
  const binary = fakeTool(path.join(pkg, "bin", "opencorp"))
  fs.mkdirSync(path.join(hoisted, "opencorp"))
  expect(installPaths([binary])).toEqual([fs.realpathSync(pkg), fs.realpathSync(path.join(hoisted, "opencorp"))])

  const shim = path.join(tempDir(), "nm", "opencorp")
  const nested = path.join(shim, "node_modules", "opencorp-linux-x64")
  fakeTool(path.join(nested, "bin", "opencorp"))
  expect(installPaths([path.join(nested, "bin", "opencorp")])).toEqual([
    fs.realpathSync(nested),
    fs.realpathSync(shim),
  ])

  const x = path.join(tempDir(), "x")
  expect(installPaths([fakeTool(path.join(x, "opencorp"))])).toEqual([fs.realpathSync(x)])
})

test("the workspace guards refuse a tool folder a path entry and the install", () => {
  const root = tempDir()
  const [t, p, c, r, sibling] = ["t", "p", "c", "r", "sibling"].map((d) => path.join(root, d)) as [
    string,
    string,
    string,
    string,
    string,
  ]
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

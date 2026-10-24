import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

setDefaultTimeout(30_000)

const CHECKOUT = fs.realpathSync(fileURLToPath(new URL("../../..", import.meta.url)))
const WRAPPER = path.join(CHECKOUT, "packages/cli/bin/opencorp")
const ENTRY = path.join(CHECKOUT, "packages/cli/src/main.ts")

let tmp = ""
let proj = ""

/** Quotes `s` as one `sh` word. */
const sq = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-entry-")))
  proj = path.join(tmp, "proj")
  // A folder a model could have written: Bun loads them if it reads the folder.
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, ".env"), "PLANTED=1\n")
  fs.writeFileSync(path.join(proj, ".env.local"), "PLANTED_LOCAL=1\n")
  fs.writeFileSync(path.join(proj, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
  fs.writeFileSync(
    path.join(proj, "evil.ts"),
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(path.join(proj, "MARKER"))}, "")\n`,
  )
  const probe = path.join(tmp, "probe.ts")
  fs.writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(path.join(tmp, "seen.json"))}, ` +
      `JSON.stringify({ planted: process.env.PLANTED ?? null, local: process.env.PLANTED_LOCAL ?? null, ` +
      `argv: process.argv.slice(1) }))\n`,
  )
  // A stand-in `bun` that records what the real one saw, so the real wrapper runs the real entry.
  fs.mkdirSync(path.join(tmp, "bin"))
  fs.writeFileSync(path.join(tmp, "bin/bun"), `#!/bin/sh\nexec ${sq(process.execPath)} --preload ${sq(probe)} "$@"\n`, {
    mode: 0o755,
  })
  // The chain `bun link` makes: a link to a link, through a symlinked folder, with spaces.
  fs.mkdirSync(path.join(tmp, "global dir"))
  fs.symlinkSync(path.join(CHECKOUT, "packages/cli"), path.join(tmp, "global dir/opencorp"))
  fs.mkdirSync(path.join(tmp, "my bin/deep"), { recursive: true })
  fs.symlinkSync("../../global dir/opencorp/bin/opencorp", path.join(tmp, "my bin/deep/opencorp"))
  fs.mkdirSync(path.join(tmp, "links"))
  fs.symlinkSync(path.join(tmp, "my bin/deep/opencorp"), path.join(tmp, "links/opencorp"))
  fs.mkdirSync(path.join(proj, "link"))
  fs.symlinkSync(path.relative(path.join(proj, "link"), WRAPPER), path.join(proj, "link/opencorp"))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Runs `command` in the planted folder with only `env` (and HOME); returns what Bun saw. */
function run(command: string, args: string[], env: Record<string, string>) {
  const marker = path.join(proj, "MARKER")
  const seenFile = path.join(tmp, "seen.json")
  fs.rmSync(marker, { force: true })
  fs.rmSync(seenFile, { force: true })
  const result = spawnSync(command, args, { cwd: proj, env: { HOME: tmp, ...env }, encoding: "utf8", timeout: 20_000 })
  if (!fs.existsSync(seenFile))
    throw new Error(`Bun never ran (status ${result.status}, ${result.error ?? "no spawn error"}):\n${result.stderr}`)
  const seen = JSON.parse(fs.readFileSync(seenFile, "utf8")) as {
    planted: string | null
    local: string | null
    argv: string[]
  }
  return { result, seen, marker: fs.existsSync(marker) }
}

test("the wrapper is an executable sh script that execs Bun with the no-autoload flags on the entry", () => {
  expect(fs.statSync(WRAPPER).mode & 0o111).toBe(0o111)
  const text = fs.readFileSync(WRAPPER, "utf8")
  expect(text.split("\n")[0]).toBe("#!/bin/sh")
  expect(text).toContain(
    'exec "${OPENCORP_BUN:-bun}" --no-install --no-env-file --config=/dev/null "$checkout/packages/cli/src/main.ts" "$@"',
  )
  const pkg = JSON.parse(fs.readFileSync(path.join(CHECKOUT, "packages/cli/package.json"), "utf8")) as {
    bin: { opencorp: string }
  }
  expect(pkg.bin.opencorp).toBe("bin/opencorp")
})

test("plain bun from a folder holding .env and a bunfig.toml preload loads both", () => {
  const { seen, marker } = run(path.join(tmp, "bin/bun"), [ENTRY, "--help"], { PATH: "/usr/bin:/bin" })
  expect(seen.planted).toBe("1")
  expect(seen.local).toBe("1")
  expect(marker).toBe(true)
})

test("opencorp --help from a folder holding .env and a bunfig.toml preload sees neither", () => {
  const { result, seen, marker } = run(WRAPPER, ["--help"], { PATH: `${path.join(tmp, "bin")}:/usr/bin:/bin` })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("Usage: opencorp [command] [options]")
  expect(seen.planted).toBeNull()
  expect(seen.local).toBeNull()
  expect(marker).toBe(false)
  expect(seen.argv).toEqual([ENTRY, "--help"])
})

test("opencorp through a bun link symlink chain with OPENCORP_BUN gets args with spaces intact", () => {
  const { result, seen, marker } = run(path.join(tmp, "links/opencorp"), ["--help", "x y", "", "$HOME *"], {
    PATH: "/usr/bin:/bin",
    OPENCORP_BUN: path.join(tmp, "bin/bun"),
  })
  expect(result.status).toBe(0)
  expect(seen.argv).toEqual([ENTRY, "--help", "x y", "", "$HOME *"])
  expect(seen.planted).toBeNull()
  expect(seen.local).toBeNull()
  expect(marker).toBe(false)
})

test("opencorp run by a relative path with CDPATH set still finds the checkout", () => {
  const { result, seen } = run("/bin/sh", ["-c", 'link/opencorp "$@"', "sh", "--help"], {
    PATH: "/usr/bin:/bin",
    OPENCORP_BUN: path.join(tmp, "bin/bun"),
    CDPATH: proj,
  })
  expect(result.status).toBe(0)
  expect(seen.argv).toEqual([ENTRY, "--help"])
  expect(seen.planted).toBeNull()
  expect(seen.local).toBeNull()
})

const SHIM = path.join(CHECKOUT, "packages/cli/bin/opencorp-npm")
const OS = process.platform === "darwin" ? "darwin" : "linux"
const PLATFORM = `opencorp-${OS}-${process.arch === "arm64" ? "arm64" : "x64"}`

/** Lays out opencorp as `layout` installs it from npm under `root`, with `binary` put at the platform
 *  package's bin/opencorp by `place` (a copy or a hard link); returns the bin link and that binary. */
function npmInstall(
  root: string,
  layout: "nested" | "hoisted" | "pnpm",
  binary: string,
  place: (from: string, to: string) => void = fs.copyFileSync,
) {
  const dir = path.join(root, layout)
  const store = path.join(dir, "node_modules/.pnpm")
  let pkg: string
  let platform: string
  let link: string
  let target: string
  if (layout === "pnpm") {
    pkg = path.join(store, "opencorp@0.0.0/node_modules/opencorp")
    platform = path.join(store, `${PLATFORM}@0.0.0/node_modules/${PLATFORM}`)
    link = path.join(dir, "node_modules/.bin/opencorp")
    target = "../opencorp/bin/opencorp"
  } else {
    pkg = path.join(dir, "lib/node_modules/opencorp")
    platform = path.join(layout === "nested" ? pkg : path.join(dir, "lib"), "node_modules", PLATFORM)
    link = path.join(dir, "bin/opencorp")
    target = "../lib/node_modules/opencorp/bin/opencorp"
  }
  for (const folder of [path.join(pkg, "bin"), path.join(platform, "bin"), path.dirname(link)])
    fs.mkdirSync(folder, { recursive: true })
  fs.copyFileSync(SHIM, path.join(pkg, "bin/opencorp"))
  place(binary, path.join(platform, "bin/opencorp"))
  if (layout === "pnpm") {
    const sibling = path.join(store, "opencorp@0.0.0/node_modules", PLATFORM)
    fs.symlinkSync(`../../${PLATFORM}@0.0.0/node_modules/${PLATFORM}`, sibling)
    fs.symlinkSync(".pnpm/opencorp@0.0.0/node_modules/opencorp", path.join(dir, "node_modules/opencorp"))
  }
  fs.symlinkSync(target, link)
  return { link, binary: path.join(platform, "bin/opencorp") }
}

/** Runs `command` in the planted folder with only HOME, a system PATH and `env`. */
const runShim = (command: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(command, args, {
    cwd: proj,
    env: { HOME: tmp, PATH: "/usr/bin:/bin", ...env },
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
  })

test("the npm shim is an executable sh script that never runs bun or node", () => {
  expect(fs.statSync(SHIM).mode & 0o111).toBe(0o111)
  const text = fs.readFileSync(SHIM, "utf8")
  expect(text.split("\n")[0]).toBe("#!/bin/sh")
  const lines = text.split("\n").filter((line) => !line.trim().startsWith("#"))
  expect(lines.filter((line) => /\b(bun|node)\b/.test(line.replaceAll("node_modules", "")))).toEqual([])
  expect(text).toContain('"$pkg/node_modules/$name/bin/opencorp" "$pkg/../$name/bin/opencorp"')
  expect(text).toContain('exec "$bin" "$@"')
})

test(
  "the npm shim finds the platform package in the npm nested, npm and bun hoisted, and pnpm layouts",
  () => {
    const root = fs.mkdtempSync(path.join(tmp, "npm-"))
    // A stand-in binary that prints how it was run, NUL-separated.
    const standIn = path.join(root, "stand-in")
    fs.writeFileSync(standIn, "#!/bin/sh\nprintf '%s\\0' \"$0\" \"$@\"\n", { mode: 0o755 })
    const args = ["--help", "x y", "", "$HOME *"]
    const check = (result: ReturnType<typeof runShim>, binary: string) => {
      expect(result.status, result.stderr).toBe(0)
      const [arg0, ...rest] = result.stdout.split("\0").slice(0, -1)
      expect(fs.realpathSync(arg0!)).toBe(fs.realpathSync(binary))
      expect(rest).toEqual(args)
    }
    const installs = (["nested", "hoisted", "pnpm"] as const).map((layout) => npmInstall(root, layout, standIn))
    for (const { link, binary } of installs) check(runShim(link, args), binary)
    // Run by a relative path that CDPATH also reaches, so a plain `cd` would print the folder into the package path.
    fs.symlinkSync(path.join(root, "nested"), path.join(proj, "npm-nested"))
    const relative = runShim("/bin/sh", ["-c", 'npm-nested/bin/opencorp "$@"', "sh", ...args], { CDPATH: proj })
    check(relative, installs[0]!.binary)
  },
  90_000,
)

test("the npm shim never searches above the package and names the missing package", () => {
  const root = fs.mkdtempSync(path.join(tmp, "npm-"))
  const pkg = path.join(root, "missing/node_modules/opencorp")
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
  fs.copyFileSync(SHIM, path.join(pkg, "bin/opencorp"))
  // A platform package where Node's module search would look next, which the shim must not reach.
  const marker = path.join(root, "DECOY_RAN")
  fs.mkdirSync(path.join(root, "node_modules", PLATFORM, "bin"), { recursive: true })
  fs.writeFileSync(path.join(root, "node_modules", PLATFORM, "bin/opencorp"), `#!/bin/sh\n: > ${sq(marker)}\n`, {
    mode: 0o755,
  })
  const result = runShim(path.join(pkg, "bin/opencorp"), ["--help"])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(PLATFORM)
  expect(result.stderr).toBe(`opencorp: the package ${PLATFORM} is not installed next to ${pkg}; reinstall opencorp\n`)
  expect(fs.existsSync(marker)).toBe(false)
})

test("the npm shim refuses an unsupported OS", () => {
  const fake = fs.mkdtempSync(path.join(tmp, "uname-"))
  fs.writeFileSync(path.join(fake, "uname"), "#!/bin/sh\necho FreeBSD\n", { mode: 0o755 })
  const result = runShim(SHIM, ["--help"], { PATH: `${fake}:/usr/bin:/bin` })
  expect(result.status).toBe(1)
  expect(result.stderr).toBe("opencorp: unsupported OS FreeBSD\n")
})

/** The lines of `text` that are neither blank nor a `//` comment. */
const code = (text: string) => text.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//"))

test("the entry has no shebang, is not executable, and its first statement dispatches the internal modes", () => {
  const text = fs.readFileSync(ENTRY, "utf8")
  expect(text.split("\n")[0]!.startsWith("#!")).toBe(false)
  expect(fs.statSync(ENTRY).mode & 0o111).toBe(0)
  expect(code(text).slice(0, 2)).toEqual([
    'const internal = import.meta.main && (process.argv[2] === "__fs-helper" || process.argv[2] === "__worker")',
    'if (internal) process.exitCode = await (await import("@opencorp/office")).officeMain(process.argv.slice(2))',
  ])
})

const IMPORT = /^\s*import\b(?!\s+type\b)(?!\s*[(.])/m
const REEXPORT = /^\s*export\s*(?!type\b)(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']/m

test("the entry and the office entry have no static imports, which would load before the dispatch", () => {
  for (const sample of ['import fs from "node:fs"', 'import "x"', 'import { a } from "b"', 'import * as m from "m"'])
    expect(sample).toMatch(IMPORT)
  for (const sample of [
    'export * from "x"',
    'export { a } from "b"',
    'export * as ns from "x"',
    'export {\n  a,\n} from "b"',
  ])
    expect(sample).toMatch(REEXPORT)
  for (const sample of [
    'import type { A } from "b"',
    'const m = await import("x")',
    '  await import("y")',
    "importer.run()",
    "import.meta.main",
    'export type { A } from "b"',
    "export const from = 1",
  ]) {
    expect(sample).not.toMatch(IMPORT)
    expect(sample).not.toMatch(REEXPORT)
  }
  for (const file of [ENTRY, path.join(CHECKOUT, "packages/office/src/main.ts")]) {
    const text = fs.readFileSync(file, "utf8")
    expect(IMPORT.test(text), `${file} has a static import`).toBe(false)
    expect(REEXPORT.test(text), `${file} has a re-export`).toBe(false)
  }
})

test("the fs helper imports only node builtins", () => {
  // The helper runs inside the sandbox, where nothing but the runtime's own builtins is there to load.
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const imports = (text: string) => transpiler.scanImports(text).map((entry) => entry.path)
  for (const sample of ['import "x"', 'export * from "x"', 'require("x")']) expect(imports(sample)).toEqual(["x"])
  const helper = fs.readFileSync(path.join(CHECKOUT, "packages/office/src/sandbox/fs_helper.ts"), "utf8")
  const found = imports(helper)
  expect(found.length).toBeGreaterThan(0)
  expect(found.filter((name) => !name.startsWith("node:"))).toEqual([])
})

test("the CODE worker shim only imports the code-worker entry of yian", () => {
  const shim = path.join(CHECKOUT, "packages/cli/src/nodes/code/worker.ts")
  expect(fs.existsSync(shim)).toBe(true)
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  expect(transpiler.scanImports(fs.readFileSync(shim, "utf8")).map((entry) => entry.path)).toEqual([
    "@ngocbh/yian/code-worker",
  ])
  const resolved = Bun.resolveSync("@ngocbh/yian/code-worker", path.join(CHECKOUT, "packages/cli"))
  expect(fs.realpathSync(resolved)).toBe(path.join(CHECKOUT, "packages/yian/ts/src/nodes/code/worker.ts"))
})

test(
  "opencorp __worker and __fs-helper reach the office's modes",
  () => {
    for (const mode of ["__worker", "__fs-helper"]) {
      fs.rmSync(path.join(proj, "MARKER"), { force: true })
      const result = spawnSync(WRAPPER, [mode], {
        cwd: proj,
        env: { HOME: tmp, PATH: "/usr/bin:/bin", OPENCORP_BUN: process.execPath },
        input: "",
        encoding: "utf8",
        timeout: 20_000,
      })
      expect(result.error).toBeUndefined()
      if (mode === "__worker") {
        expect(result.stderr).toContain("opencorp __worker: not built yet")
        expect(result.stdout).toBe("")
      } else {
        expect(result.stdout, result.stderr).toBe('{"ok": false, "error": "request is not JSON"}')
      }
      expect(result.status).toBe(1)
      expect(fs.existsSync(path.join(proj, "MARKER"))).toBe(false)
    }
  },
  60_000,
)

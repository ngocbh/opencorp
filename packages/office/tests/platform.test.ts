/** The office's one Bun-specific module, and the lints that keep Bun APIs and self-spawns inside it. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, setDefaultTimeout, test } from "bun:test"
import { embedded, selfCommand, selfSpawnEnv, threadEntry } from "../src/platform.ts"
import { tempDir } from "./helpers.ts"

setDefaultTimeout(30_000)

const CHECKOUT = fs.realpathSync(fileURLToPath(new URL("../../..", import.meta.url)))
const ENTRY = path.join(CHECKOUT, "packages/cli/src/main.ts")
const WRAPPER = path.join(CHECKOUT, "packages/cli/bin/opencorp")
const SRC = path.join(CHECKOUT, "packages/office/src")
const PLATFORM_URL = pathToFileURL(path.join(SRC, "platform.ts")).href
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

test("selfCommand in a checkout is this Bun with the no-autoload flags on the CLI entry", () => {
  expect(selfCommand()).toEqual([process.execPath, ...BUN_FLAGS, ENTRY])
})

test("selfCommand runs the same command line as the opencorp wrapper", () => {
  const dir = tempDir()
  const stub = path.join(dir, "bun")
  fs.writeFileSync(stub, "#!/bin/sh\nprintf '%s\\0' \"$@\"\n", { mode: 0o755 })
  const result = spawnSync(WRAPPER, ["__worker", "a b"], {
    env: { PATH: "/usr/bin:/bin", HOME: dir, OPENCORP_BUN: stub },
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.status).toBe(0)
  expect(result.stdout.split("\0").slice(0, -1)).toEqual([...selfCommand().slice(1), "__worker", "a b"])
})

test("selfSpawnEnv drops BUN, NODE_OPTIONS, NODE_PATH, LD and DYLD variables and keeps the rest", () => {
  const input = {
    PATH: "/bin",
    HOME: "/h",
    LANG: "C",
    BUN_OPTIONS: "--preload x",
    BUN_INSTALL: "/b",
    NODE_OPTIONS: "--require x",
    NODE_PATH: "/n",
    LD_PRELOAD: "/l.so",
    LD_LIBRARY_PATH: "/l",
    DYLD_INSERT_LIBRARIES: "/d",
    MY_BUN_THING: "kept",
    UNSET: undefined,
  }
  const copy = { ...input }
  expect(selfSpawnEnv(input)).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", MY_BUN_THING: "kept" })
  expect(input).toEqual(copy)
})

test("selfSpawnCwd is the real path of the home dir", () => {
  const dir = tempDir()
  const real = path.join(dir, "real")
  fs.mkdirSync(real)
  const link = path.join(dir, "link")
  fs.symlinkSync(real, link)
  const child = path.join(dir, "child.ts")
  fs.writeFileSync(child, `import { selfSpawnCwd } from "${PLATFORM_URL}"\nconsole.log(selfSpawnCwd())\n`)
  const result = spawnSync(process.execPath, [...BUN_FLAGS, child], {
    env: { PATH: "/usr/bin:/bin", HOME: link },
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.stderr).toBe("")
  expect(result.stdout.trim()).toBe(fs.realpathSync(real))
})

test("reexec replaces the process in place with only the given env and cwd", () => {
  const dir = tempDir()
  const target = path.join(dir, "target")
  fs.mkdirSync(target)
  const child = path.join(dir, "child.ts")
  fs.writeFileSync(
    child,
    [
      `import { reexec } from "${PLATFORM_URL}"`,
      "console.log(process.pid)",
      `reexec(["/bin/sh", "-c", 'echo "$$"; pwd -P; /usr/bin/env'], { KEPT: "1" }, process.argv[2]!)`,
      "",
    ].join("\n"),
  )
  const result = spawnSync(process.execPath, [...BUN_FLAGS, child, target], {
    env: { PATH: "/usr/bin:/bin", HOME: dir, DROPPED: "x" },
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.stderr).toBe("")
  const lines = result.stdout.trimEnd().split("\n")
  expect(lines[0]).toMatch(/^\d+$/)
  expect(lines[1]).toBe(lines[0]!)
  expect(lines[2]).toBe(fs.realpathSync(target))
  const env = lines.slice(3)
  expect(env).toContain("KEPT=1")
  expect(env.filter((line) => line.startsWith("DROPPED=") || line.startsWith("HOME="))).toEqual([])
})

test("threadEntry in a checkout is the shim under the CLI's src", () => {
  expect(fileURLToPath(threadEntry("runs_indexer"))).toBe(path.join(CHECKOUT, "packages/cli/src/runs_indexer.ts"))
})

test("embedded reads the bytes of the file a file import names", () => {
  // In a checkout a `with { type: "file" }` import gives the file's absolute path, as here.
  const bytes = Buffer.from([0, 1, 255, 10])
  const file = path.join(tempDir(), "x.bin")
  fs.writeFileSync(file, bytes)
  expect(embedded(file)).toEqual(bytes)
})

/** Every `*.ts` under the office's src, as paths relative to it. */
function sourceFiles(): string[] {
  return fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"))
}

/** The text of `name`, relative to the office's src. */
function source(name: string): string {
  return fs.readFileSync(path.join(SRC, name), "utf8")
}

// The patterns read source text, so they can't see a specifier built at run time or in a template
// literal, `globalThis["Bu" + "n"]`, or a cast; review catches those. They also scan comments, so a
// comment outside platform.ts says "Bun's" or "the Bun runtime", never "Bun" then a dot and a name.
const BUN_API = /(?<![\w$])Bun\s*(?:\?\.|[.[])|=\s*Bun\b/
const BUN_MODULE = /\b(?:from|import|require)\s*\(?\s*["']bun(?::[\w-]+)?["']/

test("no Bun or bun: API outside platform.ts", () => {
  for (const sample of ["Bun.spawn(", 'globalThis.Bun["file"]', "Bun?.file(p)", "const { spawn } = Bun"])
    expect(sample).toMatch(BUN_API)
  for (const sample of [
    'import { Database } from "bun:sqlite"',
    "await import('bun:ffi')",
    'import { file } from "bun"',
    'require("bun:test")',
  ])
    expect(sample).toMatch(BUN_MODULE)
  for (const sample of ["type F = BunFile", "// Bun reads .env", 'import { x } from "./bun.ts"']) {
    expect(sample).not.toMatch(BUN_API)
    expect(sample).not.toMatch(BUN_MODULE)
  }
  const files = sourceFiles()
  expect(files).toContain("platform.ts")
  expect(files).toContain("main.ts")
  expect(source("platform.ts")).toMatch(BUN_API)
  for (const name of files) {
    if (name === "platform.ts") continue
    const text = source(name)
    expect(BUN_API.test(text), `${name} uses a Bun API`).toBe(false)
    expect(BUN_MODULE.test(text), `${name} imports a bun module`).toBe(false)
  }
})

// Any mention is refused, so no spawn form can slip past: `child_process.fork()` spawns
// process.execPath with the parent's whole env and cwd, and `process.execve` is reexec's job.
const SELF =
  /process\.(?:execPath|argv0|execve)\b|process\.argv\[0\]|\{[^}]*\bexecPath\b[^}]*\}\s*=\s*process\b|\bfork\s*\(/

test("no spawn of process.execPath outside platform.ts", () => {
  for (const sample of [
    "process.argv[0]",
    "const { execPath } = process",
    'fork("./x.ts")',
    "child_process.fork(m)",
    'process.execve("/bin/sh")',
  ])
    expect(sample).toMatch(SELF)
  expect(source("platform.ts")).toMatch(SELF)
  for (const name of sourceFiles()) {
    if (name === "platform.ts") continue
    expect(SELF.test(source(name)), `${name} names the office's own executable`).toBe(false)
  }
})

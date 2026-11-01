import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import type net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
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
  fs.writeFileSync(path.join(proj, ".env"), `PLANTED=1\nOPENCORP_HOME=${path.join(proj, "ph")}\n`)
  // An identity only the planted .env points at: `opencorp whoami` shows it only if the .env loaded.
  fs.mkdirSync(path.join(proj, "ph"))
  fs.writeFileSync(path.join(proj, "ph/identity.json"), '{"handle":"planted","device":"d","token":"t"}', { mode: 0o600 })
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

test("opencorp --version through the wrapper prints the package's version", () => {
  const { result } = run(WRAPPER, ["--version"], { PATH: `${path.join(tmp, "bin")}:/usr/bin:/bin` })
  const pkg = JSON.parse(fs.readFileSync(path.join(CHECKOUT, "packages/cli/package.json"), "utf8")) as { version: string }
  expect(result.stdout).toBe(`${pkg.version}\n`)
  expect(result.status).toBe(0)
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
const HOST_OS = process.platform === "darwin" ? "darwin" : "linux"
const PLATFORM = `opencorp-${HOST_OS}-${process.arch === "arm64" ? "arm64" : "x64"}`

/** Lays out opencorp as `layout` installs it from npm under `root`, with `source` put at the platform
 *  package's bin/opencorp by `place` (a copy or a hard link); returns the bin link and that binary. */
function npmInstall(
  root: string,
  layout: "nested" | "hoisted" | "pnpm",
  source: string,
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
  place(source, path.join(platform, "bin/opencorp"))
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
    'const internal = import.meta.main && (process.argv[2] === "__fs-helper" || process.argv[2] === "__worker" || process.argv[2] === "daemon" || process.argv[2] === "install")',
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
  expect(fs.realpathSync(resolved)).toBe(path.join(CHECKOUT, "packages/yian/src/nodes/code/worker.ts"))
})

test("the runs indexer shim only imports the run index thread of the office", () => {
  const shim = path.join(CHECKOUT, "packages/cli/src/runs_indexer.ts")
  expect(fs.existsSync(shim)).toBe(true)
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  expect(transpiler.scanImports(fs.readFileSync(shim, "utf8")).map((entry) => entry.path)).toEqual([
    "@opencorp/office/runs/index_thread",
  ])
  const resolved = Bun.resolveSync("@opencorp/office/runs/index_thread", path.join(CHECKOUT, "packages/cli"))
  expect(fs.realpathSync(resolved)).toBe(path.join(CHECKOUT, "packages/office/src/runs/index_thread.ts"))
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
        expect(result.stderr).toContain("no office channel on fd 3")
        expect(result.stdout).toBe("")
        expect(result.status).toBe(3)
      } else {
        expect(result.stdout, result.stderr).toBe('{"ok": false, "error": "request is not JSON"}')
        expect(result.status).toBe(1)
      }
      expect(fs.existsSync(path.join(proj, "MARKER"))).toBe(false)
    }
  },
  60_000,
)

test(
  "opencorp daemon reaches the office daemon mode",
  () => {
    fs.rmSync(path.join(proj, "MARKER"), { force: true })
    const home = fs.mkdtempSync(path.join(tmp, "home-"))
    const result = spawnSync(WRAPPER, ["daemon", "--home", home], {
      cwd: proj,
      env: { HOME: home, PATH: "/usr/bin:/bin", OPENCORP_BUN: process.execPath },
      input: "",
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toContain("no company repo at")
    expect(result.status).toBe(1)
    // The company is checked before the office dir or its lock is made. (The home is also $HOME, where Bun may
    // keep a cache.)
    expect(fs.existsSync(path.join(home, "office"))).toBe(false)
    expect(fs.existsSync(path.join(proj, "MARKER"))).toBe(false)
  },
  60_000,
)

test(
  "opencorp install reaches the office install mode",
  () => {
    fs.rmSync(path.join(proj, "MARKER"), { force: true })
    const home = fs.mkdtempSync(path.join(tmp, "home-"))
    const result = spawnSync(WRAPPER, ["install", "start"], {
      cwd: proj,
      env: { HOME: home, PATH: "/usr/bin:/bin", OPENCORP_BUN: process.execPath },
      input: "",
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(result.error).toBeUndefined()
    // `tmp` is already a realpath, so this is the home the office names; the planted .env's would end in /ph.
    expect(result.stderr).toContain(`no office at ${path.join(home, ".opencorp")}`)
    expect(result.stderr).not.toContain("/ph")
    expect(result.status).toBe(3)
    expect(fs.existsSync(path.join(proj, "MARKER"))).toBe(false)
  },
  60_000,
)

const CLI = path.join(CHECKOUT, "packages/cli")

test("the build refuses to replace a folder it did not write", () => {
  // `opencorp` is also the default clone name, so an outdir above a checkout would otherwise delete it.
  const out = path.join(fs.mkdtempSync(path.join(tmp, "build-")), "out")
  const checkout = path.join(out, "opencorp")
  fs.mkdirSync(checkout, { recursive: true })
  fs.writeFileSync(path.join(checkout, "package.json"), '{"name":"opencorp-workspace"}')
  fs.writeFileSync(path.join(checkout, "keep.txt"), "")
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", "--config=/dev/null", "script/build.ts", "--outdir", out],
    { cwd: CLI, env: process.env, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
  )
  expect(result.status, result.stderr).toBe(1)
  expect(result.stderr.trimEnd().split("\n")).toHaveLength(1)
  expect(result.stderr).toContain("refusing to replace")
  expect(fs.existsSync(path.join(checkout, "keep.txt"))).toBe(true)
  expect(fs.readFileSync(path.join(checkout, "package.json"), "utf8")).toBe('{"name":"opencorp-workspace"}')
  expect(fs.existsSync(path.join(out, PLATFORM))).toBe(false)
}, 90_000)

/** Kills the process group `pid` leads; a group already gone is fine. */
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (e) {
    // macOS answers EPERM for a group left with only an unreaped zombie.
    const code = (e as NodeJS.ErrnoException).code
    if (code !== "ESRCH" && code !== "EPERM") throw e
  }
}

/** The start time `ps` shows for `pid`, "" once it is gone: with the pid it names one process, since pids are
 *  reused. */
function lstart(pid: number): string {
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 5000,
  })
  return ps.status === 0 ? ps.stdout.trim() : ""
}

/** `value` as one worker frame: a 4-byte big-endian length, then the UTF-8 JSON. */
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/**
 * Calls `onFrame` with each frame read from `stream`, parsed; tags such as a bigint's stay as written. A frame that
 * isn't JSON goes to `onBadFrame` and ends the reading, since the stream's framing can't be trusted after it.
 */
function readFrames(
  stream: Readable,
  onFrame: (frame: Record<string, unknown>) => void,
  onBadFrame: (error: Error) => void,
) {
  let buffered = Buffer.alloc(0)
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
      const end = 4 + buffered.readUInt32BE(0)
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(buffered.subarray(4, end).toString("utf8")) as Record<string, unknown>
      } catch (e) {
        stream.off("data", onData)
        onBadFrame(e as Error)
        return
      }
      buffered = buffered.subarray(end)
      onFrame(parsed)
    }
  }
  stream.on("data", onData)
}

/**
 * Runs `argv` in its own process group (`groups` gets its pid, for cleanup) and resolves to its exit and output
 * once it closes. After `limit` ms its group is killed and the run rejects with what it printed. Stdin stays open
 * until the end unless `input` is given (written, then closed). When its stdout satisfies `until`, its group is
 * killed and the result says `reached`.
 */
function runDetached(
  argv: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    limit: number
    groups: Set<number>
    input?: string
    until?: (stdout: string) => boolean
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; reached: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, detached: true, stdio: "pipe" })
    child.on("error", reject)
    const pid = child.pid
    // A spawn that failed has no pid and emits `error`, which rejects above.
    if (pid === undefined) return
    options.groups.add(pid)
    let stdout = ""
    let stderr = ""
    let reached = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(pid)
    }, options.limit)
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
      if (!reached && options.until?.(stdout)) {
        reached = true
        killGroup(pid)
      }
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    // A child that exits without reading its stdin makes a write fail with EPIPE.
    child.stdin.on("error", () => {})
    if (options.input !== undefined) child.stdin.end(options.input)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      child.stdin.destroy()
      // Reap anything the run left in its group, then forget the pid: once the group is empty the system may give
      // it to an unrelated group leader, which a later kill(-pid) would hit.
      killGroup(pid)
      options.groups.delete(pid)
      if (timedOut)
        reject(new Error(`${argv.join(" ")} ran past ${options.limit} ms (exit ${code}, ${signal}):\n${stdout}\n${stderr}`))
      else resolve({ code, signal, stdout, stderr, reached })
    })
  })
}

type NodeAssets = { getNodeAssets(target: { platform: string; arch: string }): readonly { key: string; source: string }[] }

describe("the built binary", () => {
  let built = ""
  let npmOut = ""
  let bin = ""
  let home = ""
  const groups = new Set<number>()
  // Group leaders spawned outside runDetached, each with its start time.
  const leaders: { pid: number; started: string }[] = []
  const cleanups: (() => void | Promise<void>)[] = []
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI, "package.json"), "utf8")) as { version: string; license: string }
  const description = "OpenCorp: run a company of AI employees on your machine"
  const cpu = PLATFORM.split("-")[2]!

  beforeAll(async () => {
    built = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-built-")))
    npmOut = path.join(built, "npm")
    bin = path.join(npmOut, PLATFORM, "bin/opencorp")
    home = path.join(built, "home")
    fs.mkdirSync(home)
    const build = await runDetached(
      [process.execPath, "--no-env-file", "--config=/dev/null", "script/build.ts", "--outdir", npmOut],
      { cwd: CLI, env: process.env, limit: 600_000, groups },
    )
    if (build.code !== 0) throw new Error(`the build exited ${build.code}:\n${build.stdout}\n${build.stderr}`)
    // The first run of a fresh binary can take minutes on macOS while the system scans it.
    const warm = await runDetached([bin, "--help"], {
      cwd: built,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      limit: 300_000,
      groups,
    })
    if (warm.code !== 0) throw new Error(`the binary's --help exited ${warm.code}:\n${warm.stdout}\n${warm.stderr}`)
  }, 960_000)

  /** Kills each leader's group while its pid still names the process that was spawned. */
  const killLeaders = () => {
    for (const { pid, started } of leaders.splice(0)) if (started !== "" && lstart(pid) === started) killGroup(pid)
  }

  afterEach(async () => {
    for (const pid of groups) killGroup(pid)
    groups.clear()
    killLeaders()
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  afterAll(() => {
    for (const pid of groups) killGroup(pid)
    killLeaders()
    fs.rmSync(built, { recursive: true, force: true })
  })

  /** A fresh empty folder for one spawn's TMPDIR and BUN_TMPDIR. */
  const freshTmp = () => fs.mkdtempSync(path.join(built, "tmpdir-"))

  /** Runs `argv` for at most 60 s, by default in the planted folder (its MARKER removed first), with only HOME, a
   *  system PATH, a private TMPDIR (also BUN_TMPDIR) and `env`. */
  function runBuilt(
    argv: string[],
    options: {
      env?: Record<string, string>
      cwd?: string
      tmpdir?: string
      input?: string
      until?: (stdout: string) => boolean
    } = {},
  ) {
    const { env = {}, cwd = proj, tmpdir = freshTmp(), input, until } = options
    fs.rmSync(path.join(proj, "MARKER"), { force: true })
    return runDetached(argv, {
      cwd,
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmpdir, BUN_TMPDIR: tmpdir, ...env },
      limit: 60_000,
      groups,
      input,
      until,
    })
  }

  /** Checks that `command` loaded neither the planted folder's .env nor its bunfig.toml preload. */
  async function expectSeesNeither(command: string) {
    const whoami = await runBuilt([command, "whoami"])
    expect(whoami.stdout, whoami.stderr).toContain("This device has no identity")
    expect(whoami.stdout).not.toContain("as @planted")
    expect(fs.existsSync(path.join(proj, "MARKER"))).toBe(false)
    const extra = await runBuilt([command, "whoami", "x y"])
    expect(extra.stderr).toContain("Unexpected argument 'x y'")
    expect(fs.existsSync(path.join(proj, "MARKER"))).toBe(false)
  }

  /** Serves a fake office on `<home>/office/office.sock` that answers only `GET /health`; returns that home. */
  async function fakeOffice() {
    // A short folder: macOS caps a socket path at 104 bytes.
    const short = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
    fs.mkdirSync(path.join(short, "office"))
    const server = http.createServer((req, res) => {
      // Bun's unix-socket fetch sends the absolute form (`http://office/health`) as the request target.
      const health = req.method === "GET" && new URL(req.url ?? "/", "http://office").pathname === "/health"
      res.writeHead(health ? 200 : 404, { "content-type": "application/json" })
      res.end(health ? '{"ok": true}' : '{"error": "not found"}')
    })
    cleanups.push(async () => {
      server.closeAllConnections()
      // The socket closes before its folder is removed.
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(short, { recursive: true, force: true })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path.join(short, "office/office.sock"), resolve)
    })
    return short
  }

  /**
   * Runs `argv` in a pseudo-terminal (stdin, stdout and stderr all it) for at most 60 s, in the planted folder with
   * the env `runBuilt` gives; resolves to its exit and everything it wrote. The pty makes the child a session leader,
   * so its group is its pid (`groups` gets it): killed once the output satisfies `until` (the result says
   * `reached`), on the time limit, and when it exits.
   */
  function runPty(
    argv: string[],
    options: { env?: Record<string, string>; tmpdir?: string; until?: (out: string) => boolean },
  ): Promise<{ code: number | null; out: string; reached: boolean }> {
    const { env = {}, tmpdir = freshTmp(), until } = options
    const decoder = new TextDecoder()
    let out = ""
    let reached = false
    let timedOut = false
    const proc = Bun.spawn(argv, {
      cwd: proj,
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmpdir, BUN_TMPDIR: tmpdir, ...env },
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, chunk) {
          out += decoder.decode(chunk, { stream: true })
          if (!reached && until?.(out)) {
            reached = true
            killGroup(proc.pid)
          }
        },
      },
    })
    groups.add(proc.pid)
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(proc.pid)
    }, 60_000)
    return proc.exited.then((code) => {
      clearTimeout(timer)
      proc.terminal?.close()
      killGroup(proc.pid)
      groups.delete(proc.pid)
      if (timedOut) throw new Error(`${argv.join(" ")} ran past 60000 ms (exit ${code}):\n${out}`)
      return { code, out, reached }
    })
  }

  /** The env `command tui` gets: a fake office's home and a terminal type; `extra` is added. */
  const tuiEnv = async (extra: Record<string, string> = {}) => ({
    OPENCORP_HOME: await fakeOffice(),
    TERM: "xterm",
    ...extra,
  })

  /** Runs `command tui` in a pty against a fake office with a fresh TMPDIR until the renderer switches to the
   *  alternate screen (its native library loaded), or the process exits; `extra` is added to its env. */
  async function runTui(command: string, extra: Record<string, string> = {}) {
    const tmpdir = freshTmp()
    const until = (out: string) => out.includes("\x1b[?1049h")
    return { ...(await runPty([command, "tui"], { env: await tuiEnv(extra), tmpdir, until })), tmpdir }
  }

  test("the build writes the opencorp package with the npm shim and the platform package with the binary and every TUI asset", async () => {
    const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(npmOut, file), "utf8"))
    const { version, license } = pkg
    expect(readJson("opencorp/package.json")).toEqual({
      name: "opencorp",
      version,
      description,
      license,
      bin: { opencorp: "bin/opencorp" },
      files: ["bin", "LICENSE"],
      optionalDependencies: {
        "opencorp-darwin-arm64": version,
        "opencorp-darwin-x64": version,
        "opencorp-linux-arm64": version,
        "opencorp-linux-x64": version,
      },
    })
    expect(readJson(`${PLATFORM}/package.json`)).toEqual({
      name: PLATFORM,
      version,
      description,
      license,
      os: [HOST_OS],
      cpu: [cpu],
      files: ["bin", "assets", "LICENSE"],
    })
    const shim = path.join(npmOut, "opencorp/bin/opencorp")
    expect(fs.readFileSync(shim).equals(fs.readFileSync(SHIM))).toBe(true)
    expect(fs.statSync(shim).mode & 0o777).toBe(0o755)
    expect(fs.statSync(bin).mode & 0o111).toBe(0o111)

    const nodeAssets = Bun.resolveSync(
      "@opentui/core/node-assets",
      path.dirname(fileURLToPath(import.meta.resolve("@opencorp/tui"))),
    )
    const expected = ((await import(nodeAssets)) as NodeAssets).getNodeAssets({
      platform: process.platform,
      arch: process.arch,
    })
    const assets = path.join(npmOut, PLATFORM, "assets")
    const shipped = (fs.readdirSync(assets, { recursive: true }) as string[])
      .filter((file) => fs.statSync(path.join(assets, file)).isFile() && path.basename(file) !== "LICENSE")
      .sort()
    expect(shipped).toEqual(expected.map((asset) => asset.key).sort())
    for (const { key, source } of expected)
      expect(fs.readFileSync(path.join(assets, key)).equals(fs.readFileSync(source)), key).toBe(true)
    for (const owner of ["@opentui/core", `@opentui/core-${HOST_OS}-${cpu}`, "web-tree-sitter"])
      expect(fs.statSync(path.join(assets, owner, "LICENSE")).isFile(), owner).toBe(true)
    const repoLicense = fs.readFileSync(path.join(CHECKOUT, "LICENSE"))
    for (const folder of ["opencorp", PLATFORM])
      expect(fs.readFileSync(path.join(npmOut, folder, "LICENSE")).equals(repoLicense), folder).toBe(true)
  })

  test("the entry sets the TUI asset root only in the compiled binary", () => {
    expect(code(fs.readFileSync(ENTRY, "utf8")).slice(2, 6)).toEqual([
      'if (!internal && !import.meta.url.endsWith(".ts")) {',
      '  const { dirname, join } = await import("node:path")',
      '  process.env.OTUI_ASSET_ROOT = join(dirname(process.execPath), "..", "assets")',
      "}",
    ])
  })

  test("plain bun from a folder holding .env shows the planted identity", async () => {
    const result = await runBuilt([process.execPath, ENTRY, "whoami"])
    expect(result.stdout, result.stderr).toContain("as @planted")
  }, 90_000)

  test("the binary from a folder holding .env and a bunfig.toml preload sees neither", async () => {
    await expectSeesNeither(bin)
  }, 150_000)

  test("opencorp through the npm shim from a folder holding .env and a bunfig.toml preload sees neither", async () => {
    // Hard links: the same file as the warmed-up binary, so no second first-run scan.
    const root = fs.mkdtempSync(path.join(built, "npm-"))
    await expectSeesNeither(npmInstall(root, "nested", bin, fs.linkSync).link)
    for (const layout of ["hoisted", "pnpm"] as const) {
      const result = await runBuilt([npmInstall(root, layout, bin, fs.linkSync).link, "--help"])
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain("Usage: opencorp [command] [options]")
    }
  }, 300_000)

  test("the binary runs the fs helper in its compiled form", async () => {
    const empty = fs.mkdtempSync(path.join(built, "empty-"))
    const helper = await runBuilt([bin, "__fs-helper"], { cwd: empty, input: '{"op":"list","path":"."}' })
    expect(helper.stdout, helper.stderr).toBe('{"ok": true, "output": "(empty)"}')
    expect(helper.code).toBe(0)
  }, 150_000)

  test("the built binary worker runs a company CODE node that imports a sibling file", async () => {
    const pin = fs.mkdtempSync(path.join(built, "pin-"))
    const files = {
      "flows/flow.yaml":
        "id: compiled\nname: compiled\ninput:\n  n: !int\nnodes:\n  double:\n    kind: code\n" +
        '    input: {n: "${input.n}"}\n    output: int\n    code: |\n      const two: number = 2\n' +
        "      return inputs.n * two\n  triple:\n    kind: code\n" +
        '    input: {n: "${double.output}"}\n    output: int\n    code: ./helpers.ts:triple\n' +
        "output: ${triple.output}\n",
      "flows/helpers.ts":
        'import { three } from "./lib.ts"\n' +
        "export function triple(inputs: { n: number }): number {\n  return inputs.n * three\n}\n",
      "flows/lib.ts": "export const three: number = 3\n",
    }
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(pin, rel)), { recursive: true })
      fs.writeFileSync(path.join(pin, rel), text)
    }
    const runs = fs.mkdtempSync(path.join(built, "runs-"))
    const tmpdir = freshTmp()
    const child = spawn(bin, ["__worker"], {
      cwd: fs.mkdtempSync(path.join(built, "cwd-")),
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmpdir, BUN_TMPDIR: tmpdir },
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr!.setEncoding("utf8").on("data", (text: string) => (stderr += text))
    child.stdout!.resume()
    // `exit` can come before the last of stderr is read.
    const stderrEnded = new Promise<void>((resolve) => child.stderr!.once("close", () => resolve()))
    const exited = new Promise<number | null>((resolve, reject) => {
      // A spawn that failed emits `error` instead of `exit`; with no listener it would crash the runner.
      child.once("error", reject)
      child.once("exit", (code) => void stderrEnded.then(() => resolve(code)))
    })
    if (child.pid === undefined) {
      await exited
      throw new Error("the worker did not start")
    }
    leaders.push({ pid: child.pid, started: lstart(child.pid) })
    const office = child.stdio[3] as net.Socket
    // A write to a worker that already died fails; its exit is reported below instead.
    office.on("error", () => {})
    cleanups.push(() => void office.destroy())
    const last = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no result within 60 s:\n${stderr}`)), 60_000)
      readFrames(
        office,
        (frame) => {
          if (frame.type !== "result" && frame.type !== "error") return
          clearTimeout(timer)
          resolve(frame)
        },
        (error) => {
          clearTimeout(timer)
          reject(new Error(`the worker sent a frame that isn't JSON (${error.message}):\n${stderr}`))
        },
      )
      exited.then(
        (code) => {
          clearTimeout(timer)
          reject(new Error(`the worker exited ${code} before its result:\n${stderr}`))
        },
        (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
    const job = {
      kind: "chat",
      session_id: "s1",
      run_id: "r1",
      person: "minh",
      pin,
      flow: "flows/flow.yaml",
      log: path.join(runs, "r1/log.jsonl"),
      inputs: { n: 2 },
    }
    office.write(frame({ type: "start", job }))
    const result = await last
    expect(result.type, `${result.message}\n${stderr}`).toBe("result")
    expect(result.status, stderr).toBe("succeeded")
    // The worker's codec writes a bigint as a tag.
    expect(result.output).toEqual(typeof result.output === "number" ? 12 : { $v: "bigint", s: "12" })
    office.end()
    expect(await exited, stderr).toBe(0)
    expect(stderr).not.toContain("Cannot find module")
  }, 120_000)

  test("the binary starts the run index thread at the daemon start", async () => {
    // A short folder: macOS caps a socket path at 104 bytes.
    const short = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
    // Outside `built`, so afterAll's removal doesn't cover it.
    cleanups.push(() => fs.rmSync(short, { recursive: true, force: true }))
    const files = {
      "company.yaml": "name: test-corp\nceo: ngocbh\ndefaults:\n  cost_cap_usd: 5\n  max_turns: 500\n",
      "people/ngocbh/person.yaml": "handle: ngocbh\nname: Hong Ngoc Bui\nkind: human\ntitle: CEO\nmanager: null\n",
    }
    const company = path.join(short, "company")
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(company, rel)), { recursive: true })
      fs.writeFileSync(path.join(company, rel), text)
    }
    const gitEnv = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    }
    for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) {
      const git = spawnSync("git", ["-C", company, "-c", "commit.gpgsign=false", ...args], {
        env: gitEnv,
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(git.status, `git ${args[0]}: ${git.stderr}`).toBe(0)
    }
    const office = path.join(short, "office")
    fs.mkdirSync(path.join(office, "runs"), { recursive: true, mode: 0o700 })
    fs.chmodSync(office, 0o700)
    fs.writeFileSync(path.join(office, "hq.json"), '{"tcp": false}')

    const errFile = path.join(built, `daemon-${path.basename(short)}.err`)
    const errFd = fs.openSync(errFile, "w")
    const tmpdir = freshTmp()
    const child = spawn(bin, ["daemon", "--home", short], {
      cwd: fs.mkdtempSync(path.join(built, "cwd-")),
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmpdir, BUN_TMPDIR: tmpdir },
      detached: true,
      stdio: ["ignore", "ignore", errFd],
    })
    fs.closeSync(errFd)
    const exited = new Promise<number | null>((resolve, reject) => {
      // A spawn that failed emits `error` instead of `exit`; with no listener it would crash the runner.
      child.once("error", reject)
      child.once("exit", (code) => resolve(code))
    })
    // An `error` while the test waits below must not be an unhandled rejection; the waits check the exit themselves.
    exited.catch(() => {})
    const pid = child.pid
    if (pid === undefined) {
      await exited
      throw new Error("the daemon did not start")
    }
    // The daemon re-execs itself with the same pid and start time, so the group stays the one spawned here.
    leaders.push({ pid, started: lstart(pid) })
    const stderr = () => fs.readFileSync(errFile, "utf8")

    /** Whether the office socket answers `GET /health` with 200. */
    const healthy = () =>
      new Promise<boolean>((resolve) => {
        const req = http.get({ socketPath: path.join(office, "office.sock"), path: "/health", timeout: 2000 }, (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        })
        req.on("timeout", () => req.destroy())
        req.on("error", () => resolve(false))
      })
    // Longer than the daemon's own bound on the start's index update, so a slow update that succeeds still passes.
    const deadline = Date.now() + 90_000
    while (!(await healthy())) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`the daemon exited before it served:\n${stderr()}`)
      if (Date.now() > deadline) throw new Error(`the daemon did not serve within 90 s:\n${stderr()}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // The socket listens only after the start's index update, and yian makes the index before it reads the folder.
    expect(fs.existsSync(path.join(office, "runs/index.sqlite")), stderr()).toBe(true)
    expect(stderr()).not.toContain("run index thread stopped")
    process.kill(pid, "SIGTERM")
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the daemon did not stop within 30 s of SIGTERM:\n${stderr()}`)),
        30_000,
      )
    })
    try {
      await Promise.race([exited, stopped])
    } finally {
      clearTimeout(timer)
    }
    // Once the leader is reaped the cleanup can't match its start, so anything left in its group goes now.
    killGroup(pid)
  }, 150_000)

  test("the binary loads the TUI assets from beside it and extracts nothing to TMPDIR", async () => {
    const result = await runTui(bin)
    expect(result.reached, `exited ${result.code} first:\n${result.out}`).toBe(true)
    expect(fs.readdirSync(result.tmpdir)).toEqual([])
  }, 90_000)

  test("the binary prints its version", async () => {
    const result = await runBuilt([bin, "--version"])
    expect([result.code, result.stdout, result.stderr]).toEqual([0, `${pkg.version}\n`, ""])
  }, 90_000)

  /** A hard link of the binary at `<built>/<folder>/bin/opencorp`, not a symlink: through a symlink
   *  process.execPath would be the real binary, beside its assets. */
  const linked = (folder: string) => {
    const at = path.join(built, folder, "bin/opencorp")
    fs.mkdirSync(path.dirname(at), { recursive: true })
    fs.linkSync(bin, at)
    return at
  }

  test("without the assets beside it the binary refuses to start the TUI in one line", async () => {
    const bare = linked("bare")
    // A caller's OTUI_ASSET_ROOT naming a full asset set is ignored: the caller's env must not choose the native
    // library the binary loads. The folder is checked before the terminal is, so this needs no pty.
    const tmpdir = freshTmp()
    const env = await tuiEnv({ OTUI_ASSET_ROOT: path.join(npmOut, PLATFORM, "assets") })
    const result = await runBuilt([bare, "tui"], { env, tmpdir, until: (out) => out.includes("\x1b[") })
    expect(result.reached, result.stdout).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(
      `opencorp: this binary's assets folder is missing (${path.join(built, "bare/assets")}); reinstall opencorp, ` +
        "or keep bin/ and assets/ together\n",
    )
    expect(fs.readdirSync(tmpdir)).toEqual([])
    const doctor = await runBuilt([bare, "doctor"])
    expect(doctor.stdout, doctor.stderr).toContain(`fail  tui assets   missing ${path.join(built, "bare/assets")}: `)
    const full = await runBuilt([bin, "doctor"])
    expect(full.stdout, full.stderr).toContain(`ok    tui assets   found at ${path.join(npmOut, PLATFORM, "assets")}`)
  }, 150_000)

  test("with an empty assets folder OpenTUI refuses and extracts nothing to TMPDIR", async () => {
    const bare = linked("bare2")
    fs.mkdirSync(path.join(built, "bare2/assets"))
    const result = await runTui(bare, { OTUI_ASSET_ROOT: path.join(npmOut, PLATFORM, "assets") })
    expect(result.reached, result.out).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.out).toContain("Missing OpenTUI asset")
    expect(result.out).toContain(path.join(built, "bare2/assets"))
    expect(fs.readdirSync(result.tmpdir)).toEqual([])
  }, 90_000)
})

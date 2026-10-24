import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
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

const CLI = path.join(CHECKOUT, "packages/cli")

/** Kills the process group `pid` leads; a group already gone is fine. */
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e
  }
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
  const cleanups: (() => void)[] = []
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

  afterEach(() => {
    for (const pid of groups) killGroup(pid)
    groups.clear()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  afterAll(() => {
    for (const pid of groups) killGroup(pid)
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
    cleanups.push(() => {
      server.closeAllConnections()
      server.close()
      fs.rmSync(short, { recursive: true, force: true })
    })
    await new Promise<void>((resolve) => server.listen(path.join(short, "office/office.sock"), resolve))
    return short
  }

  /** Runs `command tui` against a fake office with a fresh TMPDIR until the renderer writes an escape sequence
   *  (its native library loaded), or the process exits. */
  async function runTui(command: string) {
    const tmpdir = freshTmp()
    const env = { OPENCORP_HOME: await fakeOffice(), TERM: "xterm" }
    return { ...(await runBuilt([command, "tui"], { env, tmpdir, until: (out) => out.includes("\x1b[") })), tmpdir }
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

  test("the binary runs the fs helper in its compiled form and reaches the worker stub", async () => {
    const empty = fs.mkdtempSync(path.join(built, "empty-"))
    const helper = await runBuilt([bin, "__fs-helper"], { cwd: empty, input: '{"op":"list","path":"."}' })
    expect(helper.stdout, helper.stderr).toBe('{"ok": true, "output": "(empty)"}')
    expect(helper.code).toBe(0)
    const worker = await runBuilt([bin, "__worker"])
    expect(worker.stderr).toContain("opencorp __worker: not built yet")
    expect(worker.code).toBe(1)
  }, 150_000)

  test("the binary loads the TUI assets from beside it and extracts nothing to TMPDIR", async () => {
    const result = await runTui(bin)
    expect(result.reached, `exited ${result.code} first:\n${result.stdout}\n${result.stderr}`).toBe(true)
    expect(fs.readdirSync(result.tmpdir)).toEqual([])
  }, 90_000)

  test("without the assets beside it the binary refuses to start the TUI", async () => {
    // A hard link, not a symlink: through a symlink process.execPath would be the real binary, beside its assets.
    const bare = path.join(built, "bare/bin/opencorp")
    fs.mkdirSync(path.dirname(bare), { recursive: true })
    fs.linkSync(bin, bare)
    const result = await runTui(bare)
    expect(result.reached, result.stdout).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Missing OpenTUI asset")
    expect(fs.readdirSync(result.tmpdir)).toEqual([])
  }, 90_000)
})

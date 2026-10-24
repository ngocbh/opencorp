/** The office's one Bun-specific module, and the lints that keep Bun APIs and self-spawns inside it. */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { templateFiles } from "../src/company_template/index.ts"
import {
  embedded,
  helperCommand,
  listAllPids,
  procStartTime,
  sandboxCheck,
  selfCommand,
  selfSpawnEnv,
  threadEntry,
} from "../src/platform.ts"
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

test("helperCommand in a checkout runs fs_helper.ts with the no-autoload flags", () => {
  const bun = fs.realpathSync(process.execPath)
  const entry = path.join(SRC, "sandbox/fs_helper.ts")
  expect(helperCommand()).toEqual({ argv: [bun, ...BUN_FLAGS, entry], helper: { bun, entry } })
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

test(
  "a self-spawn from a folder holding .env and a bunfig.toml preload with BUN_OPTIONS set loads none of them",
  () => {
    const dir = tempDir()
    const proj = path.join(dir, "proj")
    fs.mkdirSync(proj)
    const marker = path.join(proj, "MARKER")
    const optsMarker = path.join(dir, "OPTS_MARKER")
    fs.writeFileSync(path.join(proj, ".env"), "PLANTED=1\n")
    fs.writeFileSync(path.join(proj, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
    fs.writeFileSync(
      path.join(proj, "evil.ts"),
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "")\n`,
    )
    const opts = path.join(dir, "opts.ts")
    fs.writeFileSync(
      opts,
      `import { writeFileSync } from "node:fs"\n` +
        `writeFileSync(${JSON.stringify(optsMarker)}, JSON.stringify({ planted: process.env.PLANTED ?? null }))\n`,
    )
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: dir,
      BUN_OPTIONS: `--preload ${opts}`,
      NODE_OPTIONS: `--require ${opts}`,
    }
    const [cmd, ...args] = selfCommand()
    const spawn = (spawnEnv: Record<string, string>) =>
      spawnSync(cmd, [...args, "__worker"], { cwd: proj, env: spawnEnv, encoding: "utf8", timeout: 20_000 })

    const result = spawn(selfSpawnEnv(env))
    expect(result.error).toBeUndefined()
    expect(result.stderr).toContain("opencorp __worker: not built yet")
    expect(result.status).toBe(1)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.existsSync(optsMarker)).toBe(false)

    // The control: with the raw env the BUN_OPTIONS preload runs, so the check above can see one.
    const raw = spawn(env)
    expect(raw.error).toBeUndefined()
    expect(fs.existsSync(optsMarker)).toBe(true)
    expect(JSON.parse(fs.readFileSync(optsMarker, "utf8"))).toEqual({ planted: null })
    expect(fs.existsSync(marker)).toBe(false)
  },
  60_000,
)

test(
  "selfSpawnEnv drops BUN, NODE_OPTIONS, NODE_PATH, NODE_PRESERVE_SYMLINKS, LD and DYLD variables and keeps the rest",
  () => {
    const input = {
      PATH: "/bin",
      HOME: "/h",
      LANG: "C",
      BUN_OPTIONS: "--preload x",
      BUN_INSTALL: "/b",
      NODE_OPTIONS: "--require x",
      NODE_PATH: "/n",
      NODE_PRESERVE_SYMLINKS: "1",
      NODE_PRESERVE_SYMLINKS_MAIN: "1",
      LD_PRELOAD: "/l.so",
      LD_LIBRARY_PATH: "/l",
      DYLD_INSERT_LIBRARIES: "/d",
      MY_BUN_THING: "kept",
      UNSET: undefined,
    }
    const copy = { ...input }
    expect(selfSpawnEnv(input)).toStrictEqual({ PATH: "/bin", HOME: "/h", LANG: "C", MY_BUN_THING: "kept" })
    expect(input).toStrictEqual(copy)
  },
)

test("selfSpawnEnv drops a name a spawn cant pass as given", () => {
  expect(selfSpawnEnv({ "A=B": "x", "": "y", "C\0D": "z", KEEP: "k" })).toStrictEqual({ KEEP: "k" })
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
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
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
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
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

/** Kills the process group `pid` leads; one already gone is fine. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    // macOS answers EPERM for a group left with only an unreaped zombie.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH" && code !== "EPERM") throw error
  }
}

/** Runs `argv` in its own process group and resolves to its exit and output once it closes; after `limit` ms
 *  the group is killed and the run rejects. The group is also killed when the current test finishes. */
function runDetached(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; limit: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, detached: true, stdio: "pipe" })
    child.on("error", reject)
    const pid = child.pid
    // A failed spawn has no pid; its `error` event rejects.
    if (pid === undefined) return
    let closed = false
    onTestFinished(() => {
      // Once closed and reaped, the pid may lead an unrelated group.
      if (!closed) killGroup(pid)
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(pid)
    }, options.limit)
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    child.stdin.end()
    child.on("close", (code) => {
      clearTimeout(timer)
      // Anything the run left in its group goes with it.
      killGroup(pid)
      closed = true
      if (timedOut) reject(new Error(`${argv.join(" ")} ran past ${options.limit} ms:\n${stdout}\n${stderr}`))
      else resolve({ code, stdout, stderr })
    })
  })
}

/** The sha256 of `bytes`, in hex. */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

test(
  "selfCommand, helperCommand, threadEntry and embedded work in a compiled binary",
  async () => {
    // A small probe compiled with the binary's flags stands in for the real binary. It is written here, importing
    // the office's files by absolute path, so no checked-in file imports across packages.
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, "probe"))
    const migration = path.join(SRC, "store/migrations/0001_initial.sql")
    const owner = { handle: "casey", name: "Casey" }
    fs.writeFileSync(
      path.join(dir, "probe/main.ts"),
      [
        `import { createHash } from "node:crypto"`,
        `import { Worker } from "node:worker_threads"`,
        `import { embedded, helperCommand, selfCommand, threadEntry } from ${JSON.stringify(path.join(SRC, "platform.ts"))}`,
        `import { templateFiles } from ${JSON.stringify(path.join(SRC, "company_template/index.ts"))}`,
        `import file from ${JSON.stringify(migration)} with { type: "file" }`,
        `const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")`,
        `const entry = threadEntry("runs_indexer")`,
        `const worker = new Worker(entry)`,
        `const threadReply = await new Promise((resolve, reject) => {`,
        `  worker.once("message", resolve)`,
        `  worker.once("error", reject)`,
        `  worker.once("exit", (code) => reject(new Error("the thread exited " + code)))`,
        `})`,
        // Ends the thread, so the probe exits on its own.
        `await worker.terminate()`,
        `const template = {}`,
        `for (const [rel, data] of templateFiles("Acme", ${JSON.stringify(owner)})) template[rel] = sha(data)`,
        `console.log(JSON.stringify({`,
        `  self: selfCommand(),`,
        `  helper: helperCommand(),`,
        `  thread: entry.href,`,
        `  threadReply,`,
        `  file,`,
        `  sha: sha(embedded(file)),`,
        `  template,`,
        `}))`,
        "",
      ].join("\n"),
    )
    // A one-line thread stands in for the CLI's runs_indexer shim, which isn't built yet; the real build's second
    // entry is nodes/code/worker.ts.
    fs.writeFileSync(
      path.join(dir, "probe/runs_indexer.ts"),
      `import { parentPort } from "node:worker_threads"\nparentPort.postMessage("thread ok")\n`,
    )
    const build = await runDetached(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "probe/main.ts",
        "probe/runs_indexer.ts",
        "--outfile",
        "out/probe",
      ],
      { cwd: dir, env: process.env, limit: 300_000 },
    )
    expect(build.code, build.stdout + build.stderr).toBe(0)

    const bin = path.join(dir, "out/probe")
    const elsewhere = path.join(dir, "elsewhere")
    fs.mkdirSync(elsewhere)
    // The first run of a fresh binary can take minutes on macOS while the system scans it.
    const run = await runDetached([bin], { cwd: elsewhere, env: { PATH: "/usr/bin:/bin", HOME: dir }, limit: 300_000 })
    expect(run.code, run.stdout + run.stderr).toBe(0)
    const probe = JSON.parse(run.stdout)
    expect(probe.self).toEqual([bin])
    expect(probe.helper).toEqual({ argv: [bin, "__fs-helper"], helper: { binary: bin } })
    expect(probe.thread).toBe("file:///$bunfs/root/runs_indexer.js")
    expect(probe.threadReply).toBe("thread ok")
    expect(probe.file).toStartWith("/$bunfs/")
    expect(probe.sha).toBe(sha256(fs.readFileSync(migration)))
    const template = Object.fromEntries([...templateFiles("Acme", owner)].map(([rel, data]) => [rel, sha256(data)]))
    // Keeps the toEqual below from passing on two empty maps.
    expect(template).toHaveProperty(["people/casey/person.yaml"])
    expect(probe.template).toEqual(template)
  },
  660_000,
)

test.skipIf(process.platform !== "darwin")("listAllPids includes this process and a child", () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" })
  onTestFinished(() => {
    child.kill("SIGKILL")
  })
  const pids = listAllPids()
  expect(pids).toContain(process.pid)
  expect(pids).toContain(child.pid!)
})

test.skipIf(process.platform !== "darwin")("procStartTime reads a running child and is null for an exited one", async () => {
  const child = spawn("/bin/sleep", ["61"], { stdio: "ignore" })
  onTestFinished(() => {
    // Our own child, unreaped until its exit event: once reaped, the runtime no longer signals its pid.
    child.kill("SIGKILL")
  })
  const started = procStartTime(child.pid!)
  expect(started).not.toBeNull()
  expect(Math.abs(started! - Date.now() / 1000)).toBeLessThan(5)
  expect(procStartTime(child.pid!)).toBe(started)
  expect(procStartTime(process.pid)!).toBeLessThan(started!)
  const done = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" })
  await new Promise((resolve) => done.once("exit", resolve))
  expect(procStartTime(done.pid!)).toBeNull()
})

test.skipIf(process.platform !== "darwin")("sandboxCheck answers for this process", () => {
  // 1 under a sandboxed parent (Claude Code's), 0 elsewhere; -1 would mean the call failed (library or symbol not loaded).
  expect([0, 1]).toContain(sandboxCheck(process.pid, null))
})

/** Every JS or TS file under the office's src, as paths relative to it. */
function sourceFiles(): string[] {
  return fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((name) => /\.[cm]?[jt]sx?$/.test(name))
}

/** The text of `name`, relative to the office's src. */
function source(name: string): string {
  return fs.readFileSync(path.join(SRC, name), "utf8")
}

// The patterns read source text, so they can't see a specifier built at run time,
// `globalThis["Bu" + "n"]`, or a cast other than `(Bun as T)`; review catches those. They also scan
// comments, so a comment outside platform.ts says "Bun's" or "the Bun runtime", never "Bun" then a dot
// and a name. BUN_MODULE refuses any string literal naming the bun module or a bun: module.
const BUN_API =
  /(?<![\w$])Bun\s*(?:\?\.|[.[])|=\s*Bun\b|\bglobalThis\s*\??\.\s*Bun\b|\bglobalThis\s*\[\s*["'`]Bun\b|\(\s*Bun\s+as\b/
const BUN_MODULE = /["'`]bun(?::[\w-]+)?["'`]/

test("no Bun or bun: API outside platform.ts", () => {
  for (const sample of [
    "Bun.spawn(",
    'globalThis.Bun["file"]',
    "Bun?.file(p)",
    "const { spawn } = Bun",
    "const B = globalThis.Bun",
    'globalThis["Bun"].spawn',
    "(Bun as any).spawn",
  ])
    expect(sample).toMatch(BUN_API)
  for (const sample of [
    'import { Database } from "bun:sqlite"',
    "await import('bun:ffi')",
    'import { file } from "bun"',
    'require("bun:test")',
    "import(`bun:ffi`)",
  ])
    expect(sample).toMatch(BUN_MODULE)
  for (const sample of [
    "type F = BunFile",
    "// Bun reads .env",
    'import { x } from "./bun.ts"',
    "// the file. Bun loads it",
    "// Bun's loader",
  ]) {
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

// Refuses any mention of execPath, argv0 or execve, `process.argv[0]` (also by `.at(0)` or
// destructuring) and `fork` (a call, or a name in braces): `child_process.fork()` spawns process.execPath
// with the parent's whole env and cwd, and `process.execve` is reexec's job. It can't see a spawn of bun by
// name from PATH (BUN_MODULE refuses only a bare "bun" literal) or a name built at run time; review catches
// those.
const SELF =
  /\b(?:execPath|argv0|execve)\b|process\.argv\s*(?:\[\s*0\s*\]|\.at\s*\(\s*0\s*\))|\[[^\]]*\]\s*=\s*process\.argv\b|\bfork\s*\(|\{[^}]*(?<![\w-])fork\b[^}]*\}/

test("no spawn of process.execPath outside platform.ts", () => {
  for (const sample of [
    "process.argv[0]",
    "const { execPath } = process",
    'fork("./x.ts")',
    "child_process.fork(m)",
    'process.execve("/bin/sh")',
    'import { execPath } from "node:process"',
    "proc.execPath",
    'process["execPath"]',
    "const [bin] = process.argv",
    "process.argv.at(0)",
    'import { fork as f } from "node:child_process"',
  ])
    expect(sample).toMatch(SELF)
  for (const sample of [
    "process.argv[2]",
    "process.argv.slice(2)",
    "selfCommand()",
    "forked(x)",
    "forkSession(id)",
    `{ "(allow process-exec process-fork)" }`,
  ])
    expect(sample).not.toMatch(SELF)
  expect(source("platform.ts")).toMatch(SELF)
  for (const name of sourceFiles()) {
    if (name === "platform.ts") continue
    expect(SELF.test(source(name)), `${name} names the office's own executable`).toBe(false)
  }
})

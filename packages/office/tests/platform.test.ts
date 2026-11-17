/** The office's one Bun-specific module: how it runs its own code, the helper and threads, its process calls and
 *  its terminals. */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { templateFiles } from "../src/company/template.ts"
import {
  embedded,
  helperCommand,
  listAllPids,
  liveGroupMembers,
  pipe,
  procStartTime,
  sandboxCheck,
  selfCommand,
  selfSpawnEnv,
  spawnPty,
  threadEntry,
} from "../src/platform.ts"
import { args, noSuchProcess } from "../src/util/proc.ts"
import { NO_GROUP, ps, psStat, startGroup, tempDir, waitFor } from "./helpers.ts"

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
  const entry = path.join(SRC, "runtime/sandbox/fs_helper.ts")
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
    expect(result.stderr).toContain("opencorp __worker: no office channel on fd 3")
    expect(result.status).toBe(3)
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
    const migration = path.join(SRC, "runtime/store/migrations/0001_initial.sql")
    const owner = { handle: "casey", name: "Casey" }
    fs.writeFileSync(
      path.join(dir, "probe/main.ts"),
      [
        `import { createHash } from "node:crypto"`,
        `import { Worker } from "node:worker_threads"`,
        `import { embedded, helperCommand, selfCommand, threadEntry } from ${JSON.stringify(path.join(SRC, "platform.ts"))}`,
        `import { templateFiles } from ${JSON.stringify(path.join(SRC, "company/template.ts"))}`,
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
    // A one-line thread stands in for the CLI's runs_indexer shim, so this checks threadEntry() in a compiled layout
    // on its own, apart from the office's thread module.
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

test.skipIf(process.platform !== "darwin")("liveGroupMembers lists a detached groups leader and grandchild", async () => {
  const g = startGroup("/bin/sleep 61 & echo $!; exec /bin/sleep 61")
  const grand = Number(await g.line())
  g.track(grand, procStartTime(grand))
  expect(liveGroupMembers(g.pid).sort((a, b) => a - b)).toEqual([g.pid, grand].sort((a, b) => a - b))
})

test.skipIf(process.platform !== "darwin")("liveGroupMembers leaves out a zombie member", async () => {
  // As in "startTime reads a zombie": the subshell exits once the gate exists, after sh has exec'd the sleep 61,
  // which never reaps it.
  const gate = path.join(tempDir(), "gate")
  const g = startGroup(`(while [ ! -e '${gate}' ]; do /bin/sleep 0.05; done) & echo $!; exec /bin/sleep 61`)
  const z = Number(await g.line())
  g.track(z, procStartTime(z))
  await waitFor(() => args(g.pid, ps()) === "/bin/sleep 61", { timeout: 10_000, what: "the exec" })
  expect(liveGroupMembers(g.pid)).toContain(z)
  fs.writeFileSync(gate, "")
  await waitFor(() => psStat(z).startsWith("Z"), { timeout: 10_000, what: "a zombie" })
  // A sleep 0.05 the loop started last may still be exiting.
  await waitFor(() => liveGroupMembers(g.pid).length === 1, { timeout: 10_000, what: "only the leader live" })
  expect(liveGroupMembers(g.pid)).toEqual([g.pid])
})

test.skipIf(process.platform !== "darwin")("liveGroupMembers is empty for a group that does not exist", () => {
  expect(liveGroupMembers(NO_GROUP)).toEqual([])
})

test.skipIf(process.platform !== "linux")("pipe gives a close-on-exec fifo pair", () => {
  const [r, w] = pipe()
  try {
    for (const fd of [r, w]) {
      expect(fs.fstatSync(fd).isFIFO()).toBe(true)
      const flags = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^flags:\s*([0-7]+)$/m)
      expect(flags).not.toBeNull()
      // O_CLOEXEC on Linux.
      expect(Number.parseInt(flags![1]!, 8) & 0o2000000).toBe(0o2000000)
    }
    expect(fs.writeSync(w, "x")).toBe(1)
    const read = Buffer.alloc(1)
    expect(fs.readSync(r, read)).toBe(1)
    expect(read.toString()).toBe("x")
  } finally {
    fs.closeSync(r)
    fs.closeSync(w)
  }
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

/** Runs `argv` on a new 80 × 24 terminal in a temp folder, with `PATH` and `TERM` only, collecting what it prints.
 *  The test's end kills the terminal's group (a no-op once its leader exited) and closes it. */
function onTerminal(argv: string[]) {
  let output = ""
  const decoder = new TextDecoder()
  const pty = spawnPty(argv, {
    cwd: tempDir(),
    env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    onData: (chunk) => {
      output += decoder.decode(chunk, { stream: true })
    },
  })
  onTestFinished(() => {
    pty.kill("SIGKILL")
    pty.close()
  })
  return {
    pty,
    output: () => output,
    shows: (text: string) => waitFor(() => output.includes(text), { timeout: 5_000, what: JSON.stringify(text) }),
  }
}

test("a process on a terminal sees a terminal, and its echo goes off at a password prompt", async () => {
  const t = onTerminal(["/bin/sh", "-c", "tty; printf 'Password: '; stty -echo; read x; stty echo; echo got=$x"])
  await t.shows("Password: ")
  await waitFor(() => !t.pty.modes().echo, { timeout: 2_000, what: "echo off" })
  expect(t.pty.modes()).toEqual({ echo: false, canonical: true })
  if (process.platform === "linux") {
    // It leads a session of its own, so its controlling terminal is the new one, never the office's. Field 6 of
    // /proc/<pid>/stat, counted after the comm's last ")".
    const stat = fs.readFileSync(`/proc/${t.pty.pid}/stat`, "utf8")
    expect(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3])).toBe(t.pty.pid)
  }
  t.pty.write("typed\n")
  expect(await t.pty.exited).toBe(0)
  await t.shows("got=typed")
  expect(t.output().split("\r\n")[0]).toStartWith("/dev/")
  // With echo off, the typed line shows only where the program printed it.
  expect(t.output().replace("got=typed", "")).not.toContain("typed")
})

test("a terminal's size reaches its program, and a resize too", async () => {
  const t = onTerminal(["/bin/sh", "-c", "stty size; read x; stty size"])
  await t.shows("24 80\r\n")
  t.pty.resize(100, 40)
  t.pty.write("\n")
  await t.shows("40 100\r\n")
  expect(await t.pty.exited).toBe(0)
})

test("killing a terminal's process signals its whole group", async () => {
  // The background sleep ignores SIGHUP, so only the group's SIGTERM can end it: the hangup the kernel sends the
  // terminal's foreground group when its session leader dies doesn't.
  const t = onTerminal(["/bin/sh", "-c", "(trap '' HUP; exec sleep 300) & echo bg=$!; wait"])
  const bg = Number((await waitFor(() => t.output().match(/bg=(\d+)\r\n/), { timeout: 5_000, what: "bg=" }))[1])
  onTestFinished(() => {
    if (!noSuchProcess(bg)) process.kill(bg, "SIGKILL")
  })
  t.pty.kill("SIGTERM")
  expect(await t.pty.exited).toBeNull()
  await waitFor(() => noSuchProcess(bg), { timeout: 5_000, what: "the background sleep to go" })
})

test("a signal-ended terminal process exits with null", async () => {
  const t = onTerminal(["/bin/sh", "-c", "echo ready; exec sleep 300"])
  await t.shows("ready")
  t.pty.kill("SIGTERM")
  expect(await t.pty.exited).toBeNull()
})

test("keys written at once, 4096 bytes of them, all reach the program", async () => {
  const file = path.join(tempDir(), "keys")
  // Printable lines, so no byte is a control key and no line outgrows the terminal's line buffer.
  const keys = Array.from({ length: 64 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(61)}\n`).join("")
  expect(keys.length).toBe(4096)
  const t = onTerminal(["/bin/sh", "-c", 'echo ready; exec cat > "$0"', file])
  await t.shows("ready")
  t.pty.write(keys)
  // Ctrl-D at the start of a line: end of input.
  t.pty.write("\x04")
  expect(await t.pty.exited).toBe(0)
  expect(fs.readFileSync(file, "utf8")).toBe(keys)
})

test("killing a terminal's process after it exited signals nothing", async () => {
  const t = onTerminal(["/bin/sh", "-c", "exit 0"])
  expect(await t.pty.exited).toBe(0)
  // Its group id may be another process's by now.
  const kill = spyOn(process, "kill")
  try {
    t.pty.kill("SIGKILL")
    expect(kill).not.toHaveBeenCalled()
  } finally {
    kill.mockRestore()
  }
})

/** This process's descriptors open on a PTY's master or slave side. Linux only. */
function ptyFds(): string[] {
  return fs.readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return /^\/dev\/(ptmx|pts\/)/.test(fs.readlinkSync(`/proc/self/fd/${fd}`))
    } catch {
      // Closed since the listing.
      return false
    }
  })
}

/** Starts `argv` on a terminal, as `onTerminal` does, and returns it with the descriptors it opened here. */
function trackedTerminal(argv: string[]) {
  const open = new Set(ptyFds())
  const t = onTerminal(argv)
  const own = ptyFds().filter((fd) => !open.has(fd))
  expect(own.length).toBeGreaterThan(0)
  return { ...t, released: () => !ptyFds().some((fd) => own.includes(fd)) }
}

test.skipIf(process.platform !== "linux")(
  "a terminal's descriptors are released once its process has exited and its output has drained",
  async () => {
    for (let i = 0; i < 5; i++) {
      const t = trackedTerminal(["/bin/sh", "-c", `echo done${i}`])
      expect(await t.pty.exited).toBe(0)
      // `exited` comes after the output.
      expect(t.output()).toBe(`done${i}\r\n`)
      await waitFor(t.released, { timeout: 5_000, what: "the terminal's descriptors to close" })
      // Closed, with no call to close.
      expect(() => t.pty.write("x")).toThrow()
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "a terminal a background process still holds is released soon after its leader exits",
  async () => {
    const t = trackedTerminal(["/bin/sh", "-c", "(trap '' HUP; exec sleep 300) & echo bg=$!"])
    const bg = Number((await waitFor(() => t.output().match(/bg=(\d+)\r\n/), { timeout: 5_000, what: "bg=" }))[1])
    onTestFinished(() => {
      if (!noSuchProcess(bg)) process.kill(bg, "SIGKILL")
    })
    const start = performance.now()
    expect(await t.pty.exited).toBe(0)
    expect(performance.now() - start).toBeLessThan(5_000)
    await waitFor(t.released, { timeout: 5_000, what: "the terminal's descriptors to close" })
    expect(() => t.pty.write("x")).toThrow()
  },
)

test("a terminal in a folder that isn't there fails to start rather than starting elsewhere", () => {
  const cwd = path.join(tempDir(), "gone")
  const start = () =>
    spawnPty(["/bin/pwd"], { cwd, env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24, onData: () => {} })
  expect(start).toThrow(/ENOENT/)
})

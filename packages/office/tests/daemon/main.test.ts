/** The daemon process: a 0600 socket, one daemon per home, clean shutdown. */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isLocked } from "@ngocbh/yian/platform"
import { afterAll, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import {
  AlreadyRunning,
  PidFile,
  type Write,
  buildOffice,
  crashReport,
  main,
  officeLogger,
  trackRequests,
} from "../../src/daemon/main.ts"
import { OfficePaths } from "../../src/daemon/office.ts"
import { OfficeStartError, listenUnix, makeOfficeDir } from "../../src/daemon/sockets.ts"
import type { Extension } from "../../src/extensions/index.ts"
import { launch as officeLaunch, resolveHome } from "../../src/install/launch.ts"
import { args, killGroup, sameProcess, startTime } from "../../src/install/proc.ts"
import { selfCommand, selfSpawnEnv } from "../../src/platform.ts"
import { Store } from "../../src/store/store.ts"
import { company, recordingGit } from "../company/helpers.ts"
import { isGone, ps, shortDir, startGroup, tempDir, waitFor } from "../helpers.ts"
import { makeOffice, request, served } from "./helpers.ts"

setDefaultTimeout(60_000)

/** A pidfile and lock file in a fresh temp dir. */
function paths(): { dir: string; pid: string; lock: string } {
  const dir = tempDir()
  return { dir, pid: path.join(dir, "office.pid"), lock: path.join(dir, "office.lock") }
}

/** A `PidFile` released when the test finishes, so a failed assertion can't leave the lock or fd held. */
function pidFile(pid: string, lock: string): PidFile {
  const file = new PidFile(pid, lock)
  onTestFinished(() => file.release())
  return file
}

test("second pidfile lock is refused", async () => {
  const { pid, lock } = paths()
  const first = pidFile(pid, lock)
  await first.acquire()
  const error = await pidFile(pid, lock).acquire().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(AlreadyRunning)
  expect((error as AlreadyRunning).pid).toBe(process.pid)
  first.release()
  const again = pidFile(pid, lock)
  await again.acquire()
  again.release()
})

test("a symlinked pidfile is refused and its target untouched", async () => {
  const { dir, pid, lock } = paths()
  const victim = path.join(dir, "victim.txt")
  fs.writeFileSync(victim, "precious\n")
  fs.symlinkSync(victim, pid)
  const error = await pidFile(pid, lock).acquire().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OfficeStartError)
  expect((error as Error).message).toMatch(/symlink/)
  expect(fs.readFileSync(victim, "utf8")).toBe("precious\n")
  expect(isLocked(lock)).toBe(false)
})

test("release removes the pidfile and frees the lock", async () => {
  const { pid, lock } = paths()
  const file = pidFile(pid, lock)
  await file.acquire()
  expect(fs.readFileSync(pid, "utf8")).toBe(`${process.pid}\n`)
  expect(fs.statSync(pid).mode & 0o777).toBe(0o600)
  file.release()
  expect(fs.existsSync(pid)).toBe(false)
  expect(isLocked(lock)).toBe(false)
  file.release()
})

test("a pidfile left by a dead office is taken over", async () => {
  const { pid, lock } = paths()
  fs.writeFileSync(pid, "99999999\n", { mode: 0o600 })
  const file = pidFile(pid, lock)
  await file.acquire()
  expect(fs.readFileSync(pid, "utf8")).toBe(`${process.pid}\n`)
  file.release()
})

test("a pidfile that is a hard link or loose is made private or refused", async () => {
  const { dir, pid, lock } = paths()
  fs.writeFileSync(pid, "99999999\n", { mode: 0o644 })
  fs.chmodSync(pid, 0o644)
  const file = pidFile(pid, lock)
  await file.acquire()
  expect(fs.statSync(pid).mode & 0o777).toBe(0o600)
  file.release()

  const other = path.join(dir, "other.txt")
  fs.writeFileSync(other, "precious\n", { mode: 0o644 })
  fs.linkSync(other, pid)
  const error = await pidFile(pid, lock).acquire().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OfficeStartError)
  expect((error as Error).message).toBe(`the pidfile ${pid} is not a regular file`)
  expect(fs.readFileSync(other, "utf8")).toBe("precious\n")
  expect(fs.statSync(other).mode & 0o777).toBe(0o644)
  expect(isLocked(lock)).toBe(false)
})

test("a lock file that is not private is refused", async () => {
  const { pid, lock } = paths()
  fs.writeFileSync(lock, "")
  fs.chmodSync(lock, 0o644)
  const error = await pidFile(pid, lock).acquire().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OfficeStartError)
  expect(error).not.toBeInstanceOf(AlreadyRunning)
  expect((error as Error).message).toContain(lock)
  expect(fs.existsSync(pid)).toBe(false)
})

/** A home for `main()`: the base company at `company/`, `office/` made 0700, and HQ's TCP listener off. */
function home(): string {
  const dir = shortDir()
  company(dir)
  fs.mkdirSync(path.join(dir, "office"), { mode: 0o700 })
  fs.writeFileSync(path.join(dir, "office", "hq.json"), '{"tcp": false}')
  return dir
}

/** A `Write` that keeps what it is given. */
function collect(): { write: Write; text(): string } {
  let text = ""
  return { write: (t) => void (text += t), text: () => text }
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/** Runs an in-process `main()` call and checks it left no signal listener on the test runner. */
async function inProcess<T>(fn: () => Promise<T>): Promise<T> {
  const before = STOP_SIGNALS.map((sig) => process.listenerCount(sig))
  const result = await fn()
  expect(STOP_SIGNALS.map((sig) => process.listenerCount(sig))).toEqual(before)
  return result
}

/** Checks the home's lock and pidfile are free: a new holder takes them. */
async function released(paths: OfficePaths): Promise<void> {
  const file = pidFile(paths.pidfile, paths.lock)
  await file.acquire()
  file.release()
}

class RuntimeError extends Error {}

test.each(["dir", "missing"])("a symlinked office dir stops the daemon start [%s]", async (target) => {
  const dir = shortDir()
  const elsewhere = path.join(dir, "elsewhere")
  if (target === "dir") fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, path.join(dir, "office"))
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write }))).toBe(1)
  expect(out.text()).toContain(path.join(dir, "office"))
  expect(!fs.existsSync(elsewhere) || fs.readdirSync(elsewhere).length === 0).toBe(true)
})

test("a directory at the socket path exits 1", async () => {
  const dir = home()
  const paths = new OfficePaths(dir)
  fs.mkdirSync(paths.socket, { recursive: true })
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write }))).toBe(1)
  expect(out.text()).toContain(`${paths.socket} exists and is not a socket`)
  await released(paths)
})

test("missing company repo exits 1", async () => {
  const dir = shortDir()
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write }))).toBe(1)
  expect(out.text()).toContain(`no company repo at ${path.join(dir, "company")}`)
  expect(fs.existsSync(path.join(dir, "office", "store.sqlite"))).toBe(false)
})

test("failing extension stops start up", async () => {
  const dir = home()
  const boom: Extension = {
    name: "boom",
    register() {
      throw new RuntimeError("bad config")
    },
  }
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write, extensions: [boom] }))).toBe(1)
  expect(out.text()).toContain("extension boom: bad config")
  expect(fs.existsSync(new OfficePaths(dir).socket)).toBe(false)
})

test("failing start hook exits 1 and cleans up", async () => {
  const dir = home()
  const hook: Extension = {
    name: "hook",
    register(office) {
      office.onStart.push(() => {
        throw new RuntimeError("no model key")
      })
    },
  }
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write, extensions: [hook] }))).toBe(1)
  expect(out.text()).toContain("the office failed to start")
  const paths = new OfficePaths(dir)
  expect(fs.existsSync(paths.socket)).toBe(false)
  await released(paths)
})

/** Extension `a`, whose start and stop are recorded, and `b`, whose start throws `RuntimeError("no model key")`. */
function startedThenFailed(): { a: Extension; b: Extension; seen: { started: boolean; stopped: boolean } } {
  const seen = { started: false, stopped: false }
  const a: Extension = {
    name: "a",
    register(office) {
      office.onStart.push(() => void (seen.started = true))
      office.onStop.push(() => void (seen.stopped = true))
    },
  }
  const b: Extension = {
    name: "b",
    register(office) {
      office.onStart.push(() => {
        throw new RuntimeError("no model key")
      })
    },
  }
  return { a, b, seen }
}

test("failing start hook stops what earlier hooks started", async () => {
  const dir = home()
  const { a, b, seen } = startedThenFailed()
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write, extensions: [a, b] }))).toBe(1)
  expect(seen).toEqual({ started: true, stopped: true })
})

test("a failing stop hook does not stop the others", async () => {
  const dir = home()
  const { a, b, seen } = startedThenFailed()
  const c: Extension = {
    name: "c",
    register(office) {
      office.onStop.push(() => {
        throw new RuntimeError("c never started")
      })
    },
  }
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write, extensions: [a, b, c] }))).toBe(1)
  expect(seen.stopped).toBe(true)
  const text = out.text()
  const lines = text.split("\n")
  const at = lines.findIndex((line) => line.endsWith("the office failed to start: RuntimeError"))
  expect(at).toBeGreaterThanOrEqual(0)
  expect(lines[at + 1]).toStartWith("    at ")
  expect(lines.some((line) => line.endsWith("office on_stop callback failed: RuntimeError"))).toBe(true)
  expect(text).not.toContain("no model key")
  expect(text).not.toContain("c never started")
})

test("served over a real socket", async () => {
  const { sock } = await served(makeOffice())
  const r = await request(sock, "GET", "/people")
  expect(r.status).toBe(200)
  expect((r.json() as { handle: string }[]).map((p) => p.handle)).toEqual(["minh", "ngocbh"])
  expect(fs.statSync(sock).mode & 0o777).toBe(0o600)
})

test("office logging sends opencorp info lines to stderr in the office format", () => {
  const out = collect()
  officeLogger(out.write)("INFO", "opencorp.hq.login")("sign-in for @ngocbh throttled")
  expect(out.text()).toMatch(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO opencorp\.hq\.login: sign-in for @ngocbh throttled\n$/,
  )
})

test("the crash report names the error type and its frames never its message", () => {
  class Leaky extends Error {}
  function leak(): never {
    throw new Leaky("sk-secret-123\n    at fake (secret.ts:1:1)")
  }
  let thrown: unknown
  try {
    leak()
  } catch (error) {
    thrown = error
  }
  const report = crashReport(thrown)
  expect(report).toEndWith("\n")
  const [first, ...frames] = report.slice(0, -1).split("\n")
  expect(first).toEndWith("office crashed: Leaky")
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) expect(frame).toMatch(/^\s+at /)
  for (const secret of ["sk-secret-123", "fake", "secret.ts"]) expect(report).not.toContain(secret)

  const plain = crashReport("plain text")
  expect(plain.slice(0, -1).split("\n")).toHaveLength(1)
  expect(plain).toEndWith("office crashed: string\n")
  expect(plain).not.toContain("plain text")

  const hidden = new Error("hidden words")
  Object.defineProperty(hidden, "message", {
    get() {
      throw new Error("no reading this")
    },
  })
  class Named extends Error {
    override name = "N\n    at leak (y:1:1)"
  }
  const named = crashReport(new Named("m-secret"))
  expect(named).not.toContain("leak")
  expect(named).not.toContain("m-secret")

  const fallback = crashReport(hidden)
  expect(fallback).toMatch(/office crashed: \w+\n$/)
  expect(fallback).not.toContain("hidden words")
})

test("build office reaps workers left by an earlier office", async () => {
  const paths = new OfficePaths(home())
  const store = new Store(paths.store, { log: () => {} })
  const group = startGroup("sleep 30")
  try {
    store.recordWorker("S1", { pid: group.pid, pgid: group.pid, startTime: group.started! })
  } finally {
    store.close()
  }
  const rec = recordingGit(tempDir())
  const office = buildOffice(paths, { tools: { git: rec.git }, guards: {}, write: collect().write })
  try {
    await waitFor(() => isGone(group.pid, group.started), { what: "the left worker to be killed" })
    expect(office.store.listWorkers()).toEqual([])
  } finally {
    office.store.close()
  }
})

test("the office gets the tools the daemon resolved and its company git runs that git", async () => {
  const paths = new OfficePaths(home())
  const rec = recordingGit(tempDir())
  const tools = { git: rec.git, ps: "/bin/ps" }
  const guards = { tools: [rec.git] }
  const office = buildOffice(paths, { tools, guards, write: collect().write })
  try {
    expect(office.tools).toEqual(tools)
    expect(office.guards).toEqual(guards)
    await office.git.head()
    expect(rec.calls().length).toBeGreaterThan(0)
  } finally {
    office.store.close()
  }
})

test("the daemon refuses to start without git on its path", async () => {
  const dir = home()
  const paths = new OfficePaths(dir)
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { tools: {}, write: out.write }))).toBe(1)
  expect(out.text()).toContain("no git on the office's PATH")
  expect(fs.existsSync(paths.socket)).toBe(false)
  await released(paths)
})

test("bad arguments exit 2", async () => {
  const dir = shortDir()
  const out = collect()
  expect(await inProcess(() => main(["--home", path.join(dir, "h"), "--bogus"], { write: out.write }))).toBe(2)
  expect(out.text()).toStartWith("opencorp office:")
  expect(fs.existsSync(path.join(dir, "h"))).toBe(false)
})

test("a home that does not exist yet resolves through its real parent", () => {
  const d = shortDir()
  fs.mkdirSync(path.join(d, "real"))
  fs.symlinkSync(path.join(d, "real"), path.join(d, "link"))
  expect(resolveHome(path.join(d, "link", "new"))).toBe(path.join(fs.realpathSync(d), "real", "new"))
})

test("a home that cannot be resolved exits 1", async () => {
  const d = shortDir()
  fs.symlinkSync(path.join(d, "b"), path.join(d, "a"))
  fs.symlinkSync(path.join(d, "a"), path.join(d, "b"))
  const out = collect()
  const home = path.join(d, "a", "home")
  expect(await inProcess(() => main(["--home", home], { write: out.write }))).toBe(1)
  expect(out.text()).toStartWith(`opencorp office: can't resolve the home ${home}: `)
  expect(out.text()).not.toContain("office crashed")
})

test("the stop waits for running handlers but not for ever", async () => {
  const req = {} as IncomingMessage
  const res = {} as ServerResponse
  let finish!: () => void
  const running = trackRequests(() => new Promise<void>((resolve) => (finish = resolve)))
  const handled = running.listener(req, res)
  let done = false
  const settled = running.settled(5000).then(() => void (done = true))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(done).toBe(false)
  finish()
  await handled
  await settled
  expect(done).toBe(true)

  const stuck = trackRequests(() => new Promise<void>(() => {}))
  void stuck.listener(req, res)
  const start = performance.now()
  await stuck.settled(100)
  const took = performance.now() - start
  expect(took).toBeGreaterThanOrEqual(90)
  expect(took).toBeLessThan(2000)
})

test("the office holds the company snapshots and the secret store", () => {
  const office = makeOffice()
  expect(office.snapshots.git).toBe(office.git)
  expect(office.secrets.root).toBe(office.paths.secrets)
  expect(office.paths.lock).toBe(path.join(office.paths.home, "office", "office.lock"))
})

/** How a process exited. */
type Exit = { code: number | null; signal: NodeJS.Signals | null }

/** A daemon process a test started, leading its own process group. */
interface Daemon {
  child: ChildProcess
  pid: number
  /** Resolves with the exit code and signal once it exits. */
  exited: Promise<Exit>
}

/** Every daemon this file started, with its home and the start time read right after the spawn. */
const launched: { home: string; pid: number; started: number | null }[] = []

/** SIGKILLs the group of `d` if its leader still has its recorded start time; never by name or pattern. */
function killDaemon(d: { pid: number; started: number | null }): void {
  if (d.started !== null && sameProcess(d.pid, d.started)) killGroup(d.pid)
}

// Runs when `bun test` exits normally or through process.exit, not when the runner is killed by a signal.
process.once("exit", () => {
  for (const d of launched) killDaemon(d)
})

afterAll(async () => {
  // Under load a just-killed process can take a moment to show as gone.
  await waitFor(() => launched.every((d) => isGone(d.pid, d.started)), {
    timeout: 15_000,
    what: "every test daemon gone",
  })
  expect(launched.filter((d) => !isGone(d.pid, d.started))).toEqual([])
})

/** A `home()` whose daemons are killed when the test finishes, before the home is removed. */
function daemonHome(): string {
  let dir = ""
  // Registered before home()'s removal: onTestFinished runs callbacks in registration order.
  onTestFinished(() => {
    for (const d of launched) if (d.home === dir) killDaemon(d)
  })
  dir = home()
  return dir
}

/** Runs `argv` detached (its own group) in `cwd` (default `<home>/office`) with `env` (default the self-spawn env
 *  with HOME set to `home`), its output in `<home>/daemon.log`, and records it for the cleanup. */
function launch(
  home: string,
  [bin, ...args]: readonly [string, ...string[]],
  { env, cwd }: { env?: Record<string, string>; cwd?: string } = {},
): Daemon {
  // A file: an unread pipe fills up and blocks the daemon's writes.
  const fd = fs.openSync(path.join(home, "daemon.log"), "w")
  let child: ChildProcess
  try {
    child = spawn(bin, args, {
      cwd: cwd ?? path.join(home, "office"),
      env: env ?? selfSpawnEnv({ ...process.env, HOME: home }),
      detached: true,
      stdio: ["ignore", fd, fd],
    })
  } finally {
    fs.closeSync(fd)
  }
  if (child.pid === undefined) {
    // The spawn error is also emitted as an event; a listener keeps it from becoming an uncaught exception.
    child.on("error", () => {})
    throw new Error(`can't start ${bin}`)
  }
  const pid = child.pid
  const exited = new Promise<Exit>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })))
  const started = startTime(pid)
  if (started === null && child.exitCode === null) {
    // Without a start time the cleanup could not tell it from a reused pid, so it must not run on.
    child.kill("SIGKILL")
    throw new Error(`can't read the start time of ${bin} (pid ${pid})`)
  }
  launched.push({ home, pid, started })
  return { child, pid, exited }
}

/** The argv of `opencorp daemon --home <home>`. */
function daemonCommand(home: string): [string, ...string[]] {
  const [bin, ...pre] = selfCommand()
  return [bin, ...pre, "daemon", "--home", home]
}

/** Starts `opencorp daemon` on `home`. */
function startDaemon(home: string): Daemon {
  return launch(home, daemonCommand(home))
}

function daemonLog(home: string): string {
  return fs.readFileSync(path.join(home, "daemon.log"), "utf8")
}

/** Whether GET /health on `sock` answers 200 with `{ ok: true }` within 2 s; a slower request is destroyed, so a
 *  half-up daemon can't hang the poll. */
function healthy(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer)
      resolve(ok)
    }
    const req = http.get({ socketPath: sock, path: "/health", agent: false }, (res) => {
      let text = ""
      res.setEncoding("utf8")
      res.on("data", (part: string) => (text += part))
      res.on("error", () => done(false))
      res.on("end", () => {
        try {
          done(res.statusCode === 200 && Bun.deepEquals(JSON.parse(text), { ok: true }))
        } catch {
          done(false)
        }
      })
    })
    const timer = setTimeout(() => {
      req.destroy()
      resolve(false)
    }, 2000)
    req.on("error", () => done(false))
  })
}

/** Waits until the daemon of `home` is healthy on its socket; fails with its log if it exits or after 30 s. */
async function waitUntilServing(home: string, d: Daemon): Promise<void> {
  const sock = new OfficePaths(home).socket
  const deadline = performance.now() + 30_000
  while (!(await healthy(sock))) {
    if (d.child.exitCode !== null || d.child.signalCode !== null)
      throw new Error(`daemon exited (${d.child.exitCode ?? d.child.signalCode}):\n${daemonLog(home)}`)
    if (performance.now() >= deadline) throw new Error(`daemon is not serving on ${sock}:\n${daemonLog(home)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** How `d` exited, waiting up to `ms`; fails with the log of `home` if it is still running then. */
async function exitWithin(home: string, d: Daemon, ms: number): Promise<Exit> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still running after ${ms} ms:\n${daemonLog(home)}`)), ms)
  })
  try {
    return await Promise.race([d.exited, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Sends `signal` to the daemon and checks it exits 0 within 15 s. */
async function stopDaemon(home: string, d: Daemon, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!d.child.kill(signal)) throw new Error(`daemon already exited:\n${daemonLog(home)}`)
  expect(await exitWithin(home, d, 15_000), daemonLog(home)).toEqual({ code: 0, signal: null })
}

test(
  "daemon serves turns away a second and stops cleanly",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    expect(fs.statSync(paths.socket).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(paths.pidfile, "utf8")).toBe(`${d.pid}\n`)
    const [bin, ...args] = daemonCommand(dir)
    const second = spawnSync(bin, args, {
      cwd: paths.office,
      env: selfSpawnEnv({ ...process.env, HOME: dir }),
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    })
    // Exit 0, so a service manager that restarts on failure doesn't retry the duplicate forever.
    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toContain(`office already running (pid ${d.pid})`)
    await stopDaemon(dir, d)
    expect(fs.existsSync(paths.socket)).toBe(false)
    expect(fs.existsSync(paths.pidfile)).toBe(false)
    expect(isLocked(paths.lock)).toBe(false)
  },
  120_000,
)

test.each(["SIGINT", "SIGHUP"] as const)(
  "sigint and sighup stop the daemon cleanly [%s]",
  async (signal) => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    await stopDaemon(dir, d, signal)
    expect(fs.existsSync(paths.socket)).toBe(false)
    await released(paths)
  },
  120_000,
)

test(
  "stale socket file is replaced",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const left = net.createServer()
    await listenUnix(left, paths.socket)
    left.close() // close leaves the file, as a crash does
    expect(fs.lstatSync(paths.socket).isSocket()).toBe(true)
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    await stopDaemon(dir, d)
  },
  120_000,
)

test(
  "the daemons info lines reach its log in the office format",
  async () => {
    const dir = daemonHome()
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    await stopDaemon(dir, d)
    const sock = new OfficePaths(dir).socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(daemonLog(dir)).toMatch(new RegExp(`^\\S+Z INFO opencorp\\.daemon\\.main: office serving on ${sock}$`, "m"))
  },
  120_000,
)

const DAEMON_MAIN = fileURLToPath(new URL("../../src/daemon/main.ts", import.meta.url))

/** Writes `script` into `home` and runs it with this Bun (no autoloads), as `launch` runs the daemon, with the
 *  home and `mode` as its arguments. */
function runScript(home: string, script: string, mode = ""): Daemon {
  const file = path.join(home, "daemon.ts")
  fs.writeFileSync(file, script)
  return launch(home, [process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", file, home, mode])
}

test.each(["throw", "reject"])(
  "an uncaught error in the daemon is logged as office crashed [%s]",
  async (mode) => {
    const dir = daemonHome()
    const d = runScript(
      dir,
      `import { exitOnCrash, main } from ${JSON.stringify(DAEMON_MAIN)}
class Leaky extends Error {}
exitOnCrash()
const fail = () => {
  const e = new Leaky("sk-secret-123")
  if (process.argv[3] === "reject") void Promise.reject(e)
  else throw e
}
process.exit(await main(["--home", process.argv[2]!], {
  extensions: [{ name: "crash", register: (office) => void office.onStart.push(() => void setTimeout(fail, 200)) }],
}))
`,
      mode,
    )
    expect(await exitWithin(dir, d, 30_000)).toEqual({ code: 1, signal: null })
    const log = daemonLog(dir)
    const lines = log.split("\n")
    expect(lines.some((line) => line.endsWith("office crashed: Leaky")), log).toBe(true)
    expect(lines.some((line) => line.startsWith("    at ")), log).toBe(true)
    expect(log).not.toContain("sk-secret-123")
  },
  120_000,
)

test(
  "a signal during the start stops the office once it has started",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const d = runScript(
      dir,
      `import { exitOnCrash, main } from ${JSON.stringify(DAEMON_MAIN)}
exitOnCrash()
const stopTwice = () => {
  process.kill(process.pid, "SIGTERM")
  process.kill(process.pid, "SIGTERM")
}
process.exit(await main(["--home", process.argv[2]!], {
  extensions: [{ name: "signal", register: (office) => void office.onStart.push(stopTwice) }],
}))
`,
    )
    expect(await exitWithin(dir, d, 30_000), daemonLog(dir)).toEqual({ code: 0, signal: null })
    expect(fs.existsSync(paths.socket)).toBe(false)
    expect(fs.existsSync(paths.pidfile)).toBe(false)
    expect(isLocked(paths.lock)).toBe(false)
    expect(daemonLog(dir)).toContain(`office serving on ${paths.socket}`)
  },
  120_000,
)

/** The names in the env `pid` was started with (or re-exec'd into): Linux `/proc/<pid>/environ`; macOS what
 *  `ps -E` prints after the command. */
function envNames(pid: number): string[] {
  if (process.platform === "linux")
    return fs
      .readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => entry.slice(0, entry.indexOf("=")))
  const read = (flags: string[]) =>
    execFileSync(ps(), [...flags, "-ww", "-o", "command=", "-p", String(pid)], {
      env: { LC_ALL: "C.UTF-8" },
      encoding: "utf8",
      timeout: 5000,
    }).trimEnd()
  const command = read([])
  const withEnv = read(["-E"])
  if (!withEnv.startsWith(command)) throw new Error(`ps -E of ${pid} doesn't start with its command`)
  return [...withEnv.slice(command.length).matchAll(/(?:^| )([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]!)
}

/** The cwd of `pid`: Linux `/proc/<pid>/cwd`; macOS lsof's `n` line. */
function cwdOf(pid: number): string {
  if (process.platform === "linux") return fs.readlinkSync(`/proc/${pid}/cwd`)
  const out = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
    env: { LC_ALL: "C.UTF-8" },
    encoding: "utf8",
    timeout: 10_000,
  })
  const line = out.split("\n").find((l) => l.startsWith("n"))
  if (line === undefined) throw new Error(`lsof shows no cwd for ${pid}`)
  return line.slice(1)
}

/** How many times `--reexeced` is an argument of `pid`. */
function reexecMarks(pid: number): number {
  const line = args(pid, ps())
  if (line === null) throw new Error(`can't read the arguments of ${pid}`)
  return line.split(" ").filter((arg) => arg === "--reexeced").length
}

const NOT_A_KEY = "sk-test-not-a-key-0000"

test(
  "opencorp daemon from a shell re-execs into the office env and folder",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const proj = tempDir()
    // What a project folder could plant: a `.env`, a bunfig preload, and the user's own BUN_OPTIONS preload.
    fs.writeFileSync(path.join(proj, ".env"), "PLANTED=1\n")
    fs.writeFileSync(path.join(proj, "bunfig.toml"), 'preload = ["./mark.ts"]\n')
    const append = (file: string) =>
      `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(path.join(proj, file))}, "ran\\n")\n`
    fs.writeFileSync(path.join(proj, "mark.ts"), append("MARKS"))
    fs.writeFileSync(path.join(proj, "opt.ts"), append("OPTS"))
    const env = {
      ...selfSpawnEnv({ ...process.env, HOME: dir }),
      OPENAI_API_KEY: NOT_A_KEY,
      BUN_OPTIONS: `--preload ${path.join(proj, "opt.ts")}`,
      PWD: proj,
    }
    const d = launch(dir, daemonCommand(dir), { env, cwd: proj })
    await waitUntilServing(dir, d)
    const names = envNames(d.pid)
    expect(names).toContain("PATH")
    expect(names).toContain("HOME")
    for (const name of ["OPENAI_API_KEY", "BUN_OPTIONS", "PLANTED", "PWD"]) expect(names).not.toContain(name)
    expect(cwdOf(d.pid)).toBe(fs.realpathSync(paths.office))
    expect(args(d.pid, ps())).toEndWith(" --reexeced")
    expect(reexecMarks(d.pid)).toBe(1)
    expect(fs.readFileSync(paths.pidfile, "utf8")).toBe(`${d.pid}\n`)
    expect(fs.existsSync(path.join(proj, "MARKS"))).toBe(false)
    // The first image ran the user's own preload; the re-exec'd one didn't.
    expect(fs.readFileSync(path.join(proj, "OPTS"), "utf8")).toBe("ran\n")
    await stopDaemon(dir, d)
  },
  120_000,
)

test(
  "the launch command env and folder start the daemon without a re-exec from a poisoned caller",
  async () => {
    const dir = daemonHome()
    const proj = tempDir()
    const l = officeLaunch(dir, {
      environ: {
        ...selfSpawnEnv(process.env),
        HOME: dir,
        OPENAI_API_KEY: NOT_A_KEY,
        BUN_OPTIONS: "--preload /nonexistent.ts",
        PWD: proj,
      },
    })
    for (const name of ["OPENAI_API_KEY", "BUN_OPTIONS", "PWD"]) expect(Object.keys(l.env)).not.toContain(name)
    makeOfficeDir(l.office)
    const d = launch(dir, l.argv, { env: { ...l.env }, cwd: l.cwd })
    await waitUntilServing(dir, d)
    expect(reexecMarks(d.pid)).toBe(0)
    const names = envNames(d.pid)
    expect(names).toContain("PATH")
    expect(names).toContain("HOME")
    expect(new Set(names)).toEqual(new Set(Object.keys(l.env)))
    expect(cwdOf(d.pid)).toBe(fs.realpathSync(l.office))
    await stopDaemon(dir, d)
  },
  120_000,
)

test(
  "under a service the daemon re-execs once",
  async () => {
    const dir = daemonHome()
    const l = officeLaunch(dir, { environ: { ...selfSpawnEnv(process.env), HOME: dir } })
    // What launchd and systemd add to a service's env.
    const env = { ...l.env, XPC_SERVICE_NAME: "com.opencorp.test", INVOCATION_ID: "0123" }
    const d = launch(dir, l.argv, { env, cwd: l.cwd })
    await waitUntilServing(dir, d)
    expect(reexecMarks(d.pid)).toBe(1)
    const names = envNames(d.pid)
    expect(names).toContain("PATH")
    expect(names).toContain("HOME")
    expect(names).not.toContain("XPC_SERVICE_NAME")
    expect(names).not.toContain("INVOCATION_ID")
    await stopDaemon(dir, d)
  },
  120_000,
)

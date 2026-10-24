/** The daemon process: a 0600 socket, one daemon per home, clean shutdown. */
import fs from "node:fs"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import { isLocked } from "@ngocbh/yian/platform"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import {
  AlreadyRunning,
  PidFile,
  type Write,
  buildOffice,
  crashReport,
  main,
  officeLogger,
  resolveHome,
  trackRequests,
} from "../../src/daemon/main.ts"
import { OfficePaths } from "../../src/daemon/office.ts"
import { OfficeStartError } from "../../src/daemon/sockets.ts"
import type { Extension } from "../../src/extensions/index.ts"
import { Store } from "../../src/store/store.ts"
import { company } from "../company/helpers.ts"
import { isGone, shortDir, startGroup, tempDir, waitFor } from "../helpers.ts"
import { CEO, makeOffice, request, served } from "./helpers.ts"

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
  const r = await request(sock, "GET", "/whoami")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ person: CEO, device: null })
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
  const office = buildOffice(paths, { write: collect().write })
  try {
    await waitFor(() => isGone(group.pid, group.started), { what: "the left worker to be killed" })
    expect(office.store.listWorkers()).toEqual([])
  } finally {
    office.store.close()
  }
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

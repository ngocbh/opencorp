/** The daemon process: a 0600 socket, one daemon per home, clean shutdown. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { isLocked, openSqlite } from "@ngocbh/yian/platform"
import { readRunIndex, updateRunIndex } from "@ngocbh/yian/run"
import { Database } from "bun:sqlite"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { Identity, identityPath, writeIdentity } from "../../src/auth/identity.ts"
import { newToken } from "../../src/auth/tokens.ts"
import { ChatHarness } from "../../src/chat/harness.ts"
import { Hooks } from "../../src/chat/hooks.ts"
import { Provider } from "../../src/chat/provider.ts"
import { HarnessError } from "../../src/chat/state.ts"
import { Transcript } from "../../src/chat/transcript.ts"
import { HANDLER_WAIT_MS, trackRequests } from "../../src/daemon/http.ts"
import { LiveRelay } from "../../src/daemon/live.ts"
import {
  AlreadyRunning,
  PidFile,
  type Write,
  buildOffice,
  crashReport,
  main,
  officeLogger,
} from "../../src/daemon/main.ts"
import { type Office, OfficePaths } from "../../src/daemon/office.ts"
import { OfficeStartError, listenUnix, makeOfficeDir } from "../../src/daemon/sockets.ts"
import type { Extension } from "../../src/extensions/index.ts"
import { register } from "../../src/extensions/questions.ts"
import { CodexSessions } from "../../src/harness/sessions.ts"
import { daemonEnv, launch as officeLaunch, resolveHome } from "../../src/install/launch.ts"
import { args, killGroup, sameProcess, startTime } from "../../src/install/proc.ts"
import { resolveTools } from "../../src/install/tools.ts"
import { selfCommand, selfSpawnEnv } from "../../src/platform.ts"
import { OFFICE_STOPPED } from "../../src/runs/outcomes.ts"
import { latestVersion } from "../../src/store/migrate.ts"
import { Store, newId } from "../../src/store/store.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { EXIT_GRACE_MS, RegistryClosed, WorkerRegistry } from "../../src/worker/spawn.ts"
import { CHAT_FILES, fakeLlm } from "../chat/helpers.ts"
import { company, makeCompany, recordingGit } from "../company/helpers.ts"
import { cwdOf, envNames, isGone, ps, reexecMarks, shortDir, startGroup, tempDir, waitFor } from "../helpers.ts"
import { freePort } from "../hq/helpers.ts"
import { RUN, chatLog, committed, runStarted, started, succeeded } from "../runs/helpers.ts"
import { question, session } from "../store/helpers.ts"
import { Recorder, base, makeJob } from "../worker/helpers.ts"
import { type Frame, frames, makeOffice, request, served, take, within } from "./helpers.ts"

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
  expect(file.release()).toBe(true)
  expect(fs.existsSync(pid)).toBe(false)
  expect(isLocked(lock)).toBe(false)
  file.release()
})

test("a check that refuses after the lock leaves the pidfile and frees the lock", async () => {
  const { pid, lock } = paths()
  fs.writeFileSync(pid, "999\n", { mode: 0o600 })
  const ino = fs.statSync(pid).ino
  let seen: number | null | undefined
  const error = await pidFile(pid, lock)
    .acquire(async (named) => {
      seen = named
      // The lock is ours while the check runs.
      expect(isLocked(lock)).toBe(true)
      throw new AlreadyRunning(named)
    })
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(AlreadyRunning)
  expect(seen).toBe(999)
  expect(fs.readFileSync(pid, "utf8")).toBe("999\n")
  expect(fs.statSync(pid).ino).toBe(ino)
  expect(isLocked(lock)).toBe(false)
})

test("release leaves a pidfile that was replaced", async () => {
  const { pid, lock } = paths()
  const file = pidFile(pid, lock)
  await file.acquire()
  fs.unlinkSync(pid)
  fs.writeFileSync(pid, "4242\n", { mode: 0o600 })
  expect(file.release()).toBe(false)
  expect(fs.readFileSync(pid, "utf8")).toBe("4242\n")
  expect(isLocked(lock)).toBe(false)
  const gone = pidFile(pid, lock)
  fs.rmSync(pid)
  await gone.acquire()
  fs.rmSync(pid)
  expect(gone.release()).toBe(true)
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
  company(dir)
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

/** Runs the daemon's start on `dir` and returns its exit code and what it wrote. */
async function startOn(dir: string): Promise<{ code: number; text: string }> {
  const out = collect()
  const code = await inProcess(() => main(["--home", dir], { write: out.write }))
  return { code, text: out.text() }
}

const MOVE_ASIDE =
  "move it aside (the office then starts with an empty store and its records are lost) or restore it from a backup"

test("a store that isnt a database stops the start and says so without a crash", async () => {
  const dir = home()
  const paths = new OfficePaths(dir)
  fs.writeFileSync(paths.store, Buffer.alloc(8192, 0x5a))
  const got = await startOn(dir)
  expect(got.code).toBe(1)
  expect(got.text).toContain(
    `opencorp office: the store ${paths.store} isn't a SQLite database (SQLITE_NOTADB); ${MOVE_ASIDE}\n`,
  )
  expect(got.text).not.toContain("office crashed")
  expect(got.text).not.toContain("file is not a database")
  await released(paths)
})

test("a directory at the store path stops the start and says so", async () => {
  const dir = home()
  const paths = new OfficePaths(dir)
  fs.mkdirSync(paths.store)
  const got = await startOn(dir)
  expect(got.code).toBe(1)
  expect(got.text).toContain(`opencorp office: store file ${paths.store} is not a regular file; ${MOVE_ASIDE}\n`)
  expect(got.text).not.toContain("office crashed")
})

test("a store newer than the code stops the start with both versions", async () => {
  const dir = home()
  const paths = new OfficePaths(dir)
  new Store(paths.store).close()
  const db = openSqlite(paths.store)
  db.exec(`PRAGMA user_version = ${latestVersion() + 1}`)
  db.close()
  const got = await startOn(dir)
  expect(got.code).toBe(1)
  expect(got.text).toContain(
    `opencorp office: the store ${paths.store}: store is at version ${latestVersion() + 1}, newer than this code` +
      ` (${latestVersion()}); run a newer opencorp or restore a backup\n`,
  )
})

test.skipIf(process.getuid?.() === 0)("a store it may not read is an os error not a crash", async () => {
  const dir = home()
  const paths = new OfficePaths(dir)
  new Store(paths.store).close()
  fs.chmodSync(paths.store, 0o000)
  let got: { code: number; text: string }
  try {
    got = await startOn(dir)
  } finally {
    fs.chmodSync(paths.store, 0o600)
  }
  expect(got.code).toBe(1)
  expect(got.text).toContain(`opencorp office: can't open the store ${paths.store}: Permission denied\n`)
  expect(got.text).not.toContain("move it aside")
})

test("missing company repo exits 1", async () => {
  const dir = shortDir()
  const out = collect()
  expect(await inProcess(() => main(["--home", dir], { write: out.write }))).toBe(1)
  expect(out.text()).toContain(`no company repo at ${path.join(resolveHome(dir), "company")}`)
  // Checked before anything is made: no office dir, no lock.
  expect(fs.readdirSync(dir)).toEqual([])
})

test("main without a home uses OPENCORP_HOME", async () => {
  const dir = shortDir()
  const old = process.env.OPENCORP_HOME
  onTestFinished(() => {
    if (old === undefined) delete process.env.OPENCORP_HOME
    else process.env.OPENCORP_HOME = old
  })
  process.env.OPENCORP_HOME = dir
  // A stand-in user home, so a daemon that ignored OPENCORP_HOME could never reach the owner's ~/.opencorp.
  const userHome = shortDir()
  const homedir = spyOn(os, "homedir").mockReturnValue(userHome)
  onTestFinished(() => homedir.mockRestore())
  const out = collect()
  expect(await inProcess(() => main([], { write: out.write }))).toBe(1)
  expect(out.text()).toContain(`no company repo at ${path.join(resolveHome(dir), "company")}`)
  expect(fs.readdirSync(dir)).toEqual([])
  expect(fs.readdirSync(userHome)).toEqual([])
})

test("a missing nested home leaves nothing behind", async () => {
  const dir = shortDir()
  const out = collect()
  expect(await inProcess(() => main(["--home", path.join(dir, "a", "b")], { write: out.write }))).toBe(1)
  expect(out.text()).toContain(`no company repo at ${path.join(resolveHome(dir), "a", "b", "company")}`)
  expect(fs.existsSync(path.join(dir, "a"))).toBe(false)
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

test("build office runs the chat harness", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const rec = recordingGit(tempDir())
  office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  const harness = office.harness as ChatHarness
  expect(harness).toBeInstanceOf(ChatHarness)
  expect(office.workers).toBe(harness)
  expect(harness.office.connections).toBe(office.connections)
  expect(harness.hooks).toBe(office.codex!.hooks)
  expect(office.models.connections).toBe(office.connections)
  expect(office.logins.connections).toBe(office.connections)
  expect(office.connections.office).toBe(office.paths.office)
  const started: string[] = []
  const update = office.runIndex.update.bind(office.runIndex)
  // The start sweep brings the run index up to date first.
  spyOn(office.runIndex, "update").mockImplementation(() => {
    started.push("sweep")
    return update()
  })
  const restore = harness.restore.bind(harness)
  spyOn(harness, "restore").mockImplementation(() => {
    started.push("restore")
    return restore()
  })
  // Never settles: start must not wait for the warm-up.
  spyOn(office.models, "warm").mockImplementation(() => {
    started.push("warm")
    return new Promise(() => {})
  })
  const logins = spyOn(office.logins, "closeAll").mockResolvedValue(undefined)
  // Calls through, so the harness really closes.
  const closed = spyOn(harness, "closeAll")
  let timer: ReturnType<typeof setTimeout> | undefined
  const held = new Promise((resolve) => (timer = setTimeout(() => resolve("held"), 2000)))
  const result = await Promise.race([office.start().then(() => "started"), held])
  clearTimeout(timer)
  expect(result).toBe("started")
  expect(started).toEqual(["sweep", "restore", "warm"])
  expect([logins.mock.calls.length, closed.mock.calls.length]).toEqual([0, 0])
  await office.stop()
  expect([logins.mock.calls.length, closed.mock.calls.length]).toEqual([1, 1])
})

test("a bad provider file fails sessions resumed at start but the office starts", async () => {
  let office: Office | undefined
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const dir = shortDir()
  makeCompany(CHAT_FILES, dir)
  fs.mkdirSync(path.join(dir, "office", "connections"), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.join(dir, "office"), 0o700)
  fs.writeFileSync(path.join(dir, "office", "hq.json"), '{"tcp": false}')
  // Not private: loading the provider refuses it.
  fs.writeFileSync(path.join(dir, "office", "connections", "office.json"), "{}", { mode: 0o644 })
  const out = collect()
  const git = recordingGit(tempDir()).git
  office = buildOffice(new OfficePaths(dir), { tools: { git }, guards: {}, write: out.write })
  const cwd = fs.realpathSync(tempDir())
  const head = await office.git.head()
  const made: Record<string, string> = {}
  for (const left of ["busy", "idle"] as const) {
    made[left] = office.store.createSession(session({ cwd, repo_commit: head, status: left })).id
  }
  // Cut mid-reply: its run must be advanced now.
  office.store.addSessionRun(made.busy!, RUN)
  const log = path.join(office.paths.runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(log, Buffer.concat([runStarted(0), started(1, "chat#0/reply")]))
  // Its run never started: it sleeps until its next message.
  office.store.addSessionRun(made.idle!, newId())
  await office.start()
  expect(office.store.getSession(made.busy!)!.status).toBe("failed")
  expect(out.text()).toContain(`session ${made.busy}: a worker can't start at restore (ProviderError)`)
  expect(office.store.getSession(made.idle!)!.status).toBe("idle")
  expect((office.harness as ChatHarness).registry.get(made.idle!)).toBeUndefined()
  await office.stop()
})

test("build office gives the office a worker registry that stops with it", async () => {
  const rec = recordingGit(tempDir())
  const office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  try {
    const workers = (office.harness as ChatHarness).registry
    expect(workers).toBeInstanceOf(WorkerRegistry)
    await office.start()
    await office.stop()
    const where = base()
    const spawning = workers.spawn(makeJob(where), path.join(where.root, "sessions", "s1"), new Recorder())
    await expect(spawning).rejects.toBeInstanceOf(RegistryClosed)
    expect(office.store.listWorkers()).toEqual([])
  } finally {
    office.store.close()
  }
})

test("build office puts the live relay on the office", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const rec = recordingGit(tempDir())
  office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  expect(office.transcript).toBeInstanceOf(Transcript)
  expect(office.live).toBeInstanceOf(LiveRelay)
  const close = spyOn(office.live!, "close")
  await office.stop()
  expect(close).toHaveBeenCalledTimes(1)
})

test("build office runs codex sessions closed on stop", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const rec = recordingGit(tempDir())
  office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  const codex = office.codex!
  expect(codex).toBeInstanceOf(CodexSessions)
  expect(codex.hooks).toBeInstanceOf(Hooks)
  spyOn(office.models, "warm").mockImplementation(() => new Promise(() => {}))
  // Calls through, so the sessions really close.
  const close = spyOn(codex, "closeAll")
  const harness = spyOn(office.harness as ChatHarness, "closeAll")
  await office.start()
  expect(close).not.toHaveBeenCalled()
  await office.stop()
  // Once, by the harness's stop.
  expect([close.mock.calls.length, harness.mock.calls.length]).toEqual([1, 1])
  const row = office.store.createSession(
    session({
      harness: "codex",
      status: "starting",
      cwd: tempDir(),
      repo_commit: await office.git.head(),
      opened_by: "ngocbh",
    }),
  )
  await codex.start(row)
  expect(codex.get(row.id)).toBeUndefined()
  expect(office.store.listWorkers()).toEqual([])
})

test("the office runs codex sessions on the harness hooks", async () => {
  const rec = recordingGit(tempDir())
  const office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  try {
    expect(office.harness!.hooks).toBe(office.codex!.hooks)
    // A check added on the harness hooks, as the questions extension adds its own, is one the Codex sessions run.
    office.harness!.hooks.answerCheck.push(() => "refused by the harness hooks")
    const row = office.store.createSession(
      session({ harness: "codex", status: "busy", repo_commit: await office.git.head(), opened_by: "ngocbh" }),
    )
    const card = office.store.addQuestion(question(row.id, { source: "harness", options: ["Approve"] }))
    await expect(office.codex!.answer(card.id, "Approve", "option")).rejects.toMatchObject({
      status: 422,
      code: "invalid_answer",
      message: "refused by the harness hooks",
    })
    expect(office.store.getQuestion(card.id)!.status).toBe("open")
  } finally {
    office.store.close()
  }
})

test("build office restores codex sessions on start before the cards sweep", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const rec = recordingGit(tempDir())
  office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  spyOn(office.models, "warm").mockImplementation(() => new Promise(() => {}))
  const head = await office.git.head()
  const busy = office.store.createSession(
    session({
      harness: "codex",
      status: "busy",
      repo_commit: head,
      opened_by: "ngocbh",
      harness_session_id: "thr_1",
      cwd: tempDir(),
    }),
  )
  const card = office.store.addQuestion(
    question(busy.id, { source: "harness", run_id: "turn_1", node_id: "1", options: ["Approve"] }),
  )
  const ended = office.store.createSession(session({ status: "ended", repo_commit: head }))
  const asked = office.store.addQuestion(question(ended.id, { source: "ask_user" }))
  // As loadExtensions does.
  register(office)
  const order: string[] = []
  const codex = office.codex!
  const restore = codex.restore.bind(codex)
  spyOn(codex, "restore").mockImplementation(async () => {
    order.push("restore")
    await restore()
  })
  const cards = office.cards!
  const sweep = cards.sweep.bind(cards)
  // The start callback looks the method up when it runs, so the spy sees it.
  spyOn(cards, "sweep").mockImplementation(() => {
    order.push("sweep")
    sweep()
  })
  await office.start()
  expect(order).toEqual(["restore", "sweep"])
  expect(office.store.getSession(busy.id)!.status).toBe("idle")
  expect(office.store.getQuestion(card.id)!.status).toBe("stale")
  expect(codex.get(busy.id)).toBeDefined()
  const turn = codex.currentTurn(busy.id)
  expect(turn.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))).toEqual(["[interrupted]"])
  expect(office.store.getQuestion(asked.id)!.status).toBe("stale")
  expect(office.store.listWorkers()).toEqual([])
})

test("office stop waits for the send backs queued on the office harness and returns", async () => {
  const rec = recordingGit(tempDir())
  const office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  let stopping: Promise<unknown> | undefined
  try {
    spyOn(office.models, "warm").mockImplementation(() => new Promise(() => {}))
    register(office)
    await office.start()
    const s = office.store.createSession(session({ status: "waiting", repo_commit: await office.git.head() }))
    const discussion = [{ role: "user" as const, text: "why?" }]
    const q1 = office.store.addQuestion(question(s.id, { source: "ask_user", discussion }))
    const q2 = office.store.addQuestion(question(s.id, { source: "ask_user", discussion }))
    const order: string[] = []
    // Each send-back is answered or refused by the stop, never left hanging.
    const settled = [q1, q2].map((q, i) =>
      office.cards!.sendBack(q.id, "use sqlite", { by: "ngocbh" }).then(
        () => void order.push(`sent ${i}`),
        (error: unknown) => {
          expect(error).toBeInstanceOf(HarnessError)
          expect([(error as HarnessError).status, (error as HarnessError).code]).toEqual([503, "stopping"])
          order.push(`refused ${i}`)
        },
      ),
    )
    stopping = office.stop().then(() => order.push("stopped"))
    await Promise.race([
      stopping,
      sleep(5000).then(() => {
        throw new Error("stop hung")
      }),
    ])
    await Promise.all(settled)
    expect(order).toHaveLength(3)
    expect(order.at(-1)).toBe("stopped")
    for (const [i, q] of [q1, q2].entries()) {
      if (!order.includes(`sent ${i}`)) continue
      const got = office.store.getQuestion(q.id)!
      expect([got.status, got.answer_kind, got.answered_by]).toEqual(["answered", "sent_back", "ngocbh"])
    }
  } finally {
    // A failure before the stop must not leave the office running; the happy path stops it once.
    try {
      await (stopping ?? office.stop())
    } finally {
      office.store.close()
    }
  }
})

test("build office checks a model in a worker of its registry", async () => {
  const fake = await fakeLlm()
  const key = "sk-test-check-5d1e7a93"
  const rec = recordingGit(tempDir())
  const office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  try {
    await office.start()
    const provider = Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: key }, env: fake.env() })
    fake.script({ content: "OK" })
    expect(await office.checkModel(provider)).toBeNull()
    expect(fake.authorizations()).toEqual([`Bearer ${key}`])
    await office.stop()
    await expect(office.checkModel(provider)).rejects.toBeInstanceOf(RegistryClosed)
  } finally {
    // A failed assert leaves no worker behind; a second stop after the test's own is harmless.
    await office.stop()
    office.store.close()
  }
})

test("an add whose check the office stop cuts answers 503 and the stop skips the grace", async () => {
  // An endpoint that lists no models and never answers a request: the one-reply check holds until the stop.
  let held!: () => void
  const reached = new Promise<void>((resolve) => (held = resolve))
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method === "POST") held()
    else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const endpoint = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`
  const paths = new OfficePaths(home())
  const rec = recordingGit(tempDir())
  const office = buildOffice(paths, { tools: { git: rec.git }, guards: {}, write: collect().write })
  try {
    await writeIdentity(identityPath(paths.home), new Identity("ngocbh", "mac", newToken()))
    const { sock } = await served(office)
    const body = { provider: "openai", endpoint, api_key: "sk-test-stop-4c9e1b", model: "held" }
    const adding = request(sock, "POST", "/connections", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    // An add answered before its check reached the endpoint fails here with its reply.
    expect(await Promise.race([reached.then(() => null), adding])).toBeNull()
    const start = performance.now()
    await office.stop()
    expect(performance.now() - start).toBeLessThan(EXIT_GRACE_MS)
    const r = await adding
    expect([r.status, (r.json() as { error: string }).error]).toEqual([503, "stopping"])
  } finally {
    await office.stop()
    office.store.close()
  }
}, 90_000)

test("build office brings the run index up to date and sweeps on start", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const paths = new OfficePaths(home())
  const log = path.join(paths.runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(log, Buffer.concat([runStarted(0), started(1, "a"), committed(2, "a", {}), succeeded(3, "a", 2)]))
  const rec = recordingGit(tempDir())
  office = buildOffice(paths, { tools: { git: rec.git }, guards: {}, write: collect().write })
  spyOn(office.models, "warm").mockImplementation(() => new Promise(() => {}))
  const open = newId()
  const ended = office.store.createSession(session({ status: "ended", run_ids: [open] }))
  office.store.addRun({
    runId: open,
    sessionId: ended.id,
    driver: "minh",
    flow: "chat",
    flowPath: "shared/flows/chat.yaml",
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: ended.created_at,
  })
  const codex = office.codex!
  const restore = codex.restore.bind(codex)
  const store = office.store
  let atRestore: string | null | undefined
  // The sweep goes first: the open run is already ended when the restore runs.
  spyOn(codex, "restore").mockImplementation(async () => {
    atRestore = store.getRun(open)?.endReason
    await restore()
  })
  await office.start()
  expect(atRestore).toBe(OFFICE_STOPPED)
  expect(readRunIndex(paths.runs).map((row) => row.runId)).toEqual([RUN])
  const got = office.store.getRun(open)!
  expect([got.endReason, got.endedAt]).toEqual([OFFICE_STOPPED, null])
})

test("build office updates the run index when a worker exits", async () => {
  const fake = await fakeLlm()
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const rec = recordingGit(tempDir())
  office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: collect().write })
  await office.start()
  // After the start, so its own update isn't counted.
  const update = spyOn(office.runIndex, "update")
  const provider = Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: "sk-test-index-0b7e" }, env: fake.env() })
  fake.script({ content: "OK" })
  expect(await office.checkModel(provider)).toBeNull()
  await waitFor(() => update.mock.calls.length > 0, { what: "a run index update on the worker's exit" })
})

test("a failing start sweep does not stop the office start", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const key = "sk-test-sweep-3c9f61a2"
  const out = collect()
  const rec = recordingGit(tempDir())
  office = buildOffice(new OfficePaths(home()), { tools: { git: rec.git }, guards: {}, write: out.write })
  spyOn(office.models, "warm").mockImplementation(() => new Promise(() => {}))
  spyOn(office.store, "openRuns").mockImplementation(() => {
    throw new Error(`index broken: ${key}`)
  })
  await office.start()
  expect(out.text()).toContain("the start sweep failed: Error")
  expect(out.text()).not.toContain(key)
})

/** An office over `paths` with one ended session whose run is still open in the store, and the run's id. */
function officeWithOpenRun(paths: OfficePaths, write: (line: string) => void): { office: Office; open: string } {
  const rec = recordingGit(tempDir())
  const office = buildOffice(paths, { tools: { git: rec.git }, guards: {}, write })
  spyOn(office.models, "warm").mockImplementation(() => new Promise(() => {}))
  const open = newId()
  const ended = office.store.createSession(session({ status: "ended", run_ids: [open] }))
  office.store.addRun({
    runId: open,
    sessionId: ended.id,
    driver: "minh",
    flow: "chat",
    flowPath: "shared/flows/chat.yaml",
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: ended.created_at,
  })
  return { office, open }
}

test("a damaged index is rebuilt at the start, and the start sweep runs", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const paths = new OfficePaths(home())
  fs.mkdirSync(paths.runs, { recursive: true })
  fs.writeFileSync(path.join(paths.runs, "index.sqlite"), "not a database, only garbage\n".repeat(64))
  const out = collect()
  const built = officeWithOpenRun(paths, out.write)
  office = built.office
  await office.start()
  expect(out.text()).toContain("run index unusable (SQLITE_NOTADB), rebuilding it")
  expect(out.text()).not.toContain("the start sweep was skipped")
  // SQLite's message names the damage and must not reach the log; the code name is logged on purpose.
  expect(out.text()).not.toMatch(/not a database|malformed/)
  expect(office.store.getRun(built.open)!.endReason).not.toBeNull()
})

test("an index whose table doesn't fit yian's layout is rebuilt at the start, and the start sweep runs", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const paths = new OfficePaths(home())
  fs.mkdirSync(paths.runs, { recursive: true })
  updateRunIndex(paths.runs)
  // The layout version stays, so yian trusts a table that isn't there.
  const db = new Database(path.join(paths.runs, "index.sqlite"))
  db.exec("DROP TABLE runs")
  db.close()
  const out = collect()
  const built = officeWithOpenRun(paths, out.write)
  office = built.office
  await office.start()
  expect(out.text()).toContain("run index unusable (SQLITE_ERROR), rebuilding it")
  expect(out.text()).not.toContain("the start sweep was skipped")
  expect(out.text()).not.toMatch(/no such table/)
  expect(office.store.getRun(built.open)!.endReason).not.toBeNull()
})

test("an index that stays broken skips the start sweep and does not stop the office start", async () => {
  let office: Office | undefined
  // Registered before home()'s removal, as in makeOffice: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      office?.store.close()
    }
  })
  const paths = new OfficePaths(home())
  // A folder in the index's place: SQLite can't open it, and it isn't damage the update rebuilds.
  fs.mkdirSync(path.join(paths.runs, "index.sqlite"), { recursive: true })
  const out = collect()
  const built = officeWithOpenRun(paths, out.write)
  office = built.office
  await office.start()
  expect(out.text()).toContain("run index update failed (SQLITE_CANTOPEN)")
  expect(out.text()).toContain("the start sweep was skipped (the run index is not up to date)")
  expect(fs.statSync(path.join(paths.runs, "index.sqlite")).isDirectory()).toBe(true)
  expect(out.text()).not.toContain("rebuilding it")
  expect(out.text()).not.toMatch(/unable to open|not a database|malformed/)
  expect(office.store.getRun(built.open)!.endReason).toBeNull()
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

/** A second, in-process start on `home` with the tools a daemon would resolve (ps by its absolute path): its exit
 *  code and what it wrote. */
async function secondStart(home: string): Promise<{ code: number; text: string }> {
  const tools = resolveTools(daemonEnv(process.env))
  expect(path.isAbsolute(tools.ps!)).toBe(true)
  const out = collect()
  const code = await inProcess(() => main(["--home", home], { write: out.write, tools }))
  return { code, text: out.text() }
}

/** The inode of `file`, not following a link. */
function ino(file: string): bigint {
  return fs.lstatSync(file, { bigint: true }).ino
}

test(
  "office lock deleted while an office serves: a second start exits 0 and touches nothing",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    const store = new Store(paths.store, { log: () => {} })
    const group = startGroup("sleep 30")
    try {
      store.recordWorker("S1", { pid: group.pid, pgid: group.pid, startTime: group.started! })
    } finally {
      store.close()
    }
    const before = { sock: ino(paths.socket), hq: ino(paths.hqSocket), pid: ino(paths.pidfile) }
    fs.rmSync(paths.lock)
    const second = await secondStart(dir)
    expect(second.code).toBe(0)
    expect(second.text).toBe(`opencorp office: office already running (pid ${d.pid})\n`)
    expect({ sock: ino(paths.socket), hq: ino(paths.hqSocket), pid: ino(paths.pidfile) }).toEqual(before)
    expect(fs.readFileSync(paths.pidfile, "utf8")).toBe(`${d.pid}\n`)
    expect(await healthy(paths.socket)).toBe(true)
    // Nothing reaped: the refusal comes before the store opens.
    expect(isGone(group.pid, group.started)).toBe(false)
    await stopDaemon(dir, d)
  },
  120_000,
)

test(
  "any one of office pid, office sock and hq sock still naming a live office refuses a second start",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    const files = [paths.pidfile, paths.socket, paths.hqSocket]
    const before = files.map(ino)
    // Each case moves the other two files away (a rename keeps the inode, so they come back as they were) and
    // deletes the lock, which a refused start makes again.
    for (const [kept, named] of [
      [paths.pidfile, `pid ${d.pid}`],
      [paths.socket, "pid unknown"],
      [paths.hqSocket, "pid unknown"],
    ] as const) {
      const away = files.filter((file) => file !== kept)
      for (const file of away) fs.renameSync(file, `${file}.away`)
      fs.rmSync(paths.lock, { force: true })
      const second = await secondStart(dir)
      for (const file of away) fs.renameSync(`${file}.away`, file)
      expect(second, kept).toEqual({ code: 0, text: `opencorp office: office already running (${named})\n` })
      expect(files.map(ino)).toEqual(before)
    }
    expect(await healthy(paths.socket)).toBe(true)
    await stopDaemon(dir, d)
    // Its own files, so the stop removed them.
    expect(fs.existsSync(paths.socket)).toBe(false)
    expect(fs.existsSync(paths.hqSocket)).toBe(false)
    expect(fs.existsSync(paths.pidfile)).toBe(false)
  },
  120_000,
)

test.skipIf(process.getuid?.() === 0)("an hq sock nobody can connect to stops the start with exit 1", async () => {
  const dir = home()
  const paths = new OfficePaths(dir)
  const left = net.createServer()
  await listenUnix(left, paths.hqSocket)
  await new Promise<void>((resolve) => left.close(() => resolve()))
  fs.chmodSync(paths.hqSocket, 0o000)
  const second = await secondStart(dir)
  expect(second.code).toBe(1)
  const real = new OfficePaths(resolveHome(dir))
  expect(second.text).toBe(`opencorp office: can't tell whether ${real.hqSocket} is in use\n`)
  expect(fs.existsSync(paths.pidfile)).toBe(false)
  expect(fs.existsSync(paths.store)).toBe(false)
  await released(paths)
})

test(
  "a stopping office leaves an office sock, hq sock and office pid that replaced its own",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    for (const sock of [paths.socket, paths.hqSocket]) {
      fs.unlinkSync(sock)
      const other = net.createServer()
      await listenUnix(other, sock)
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
    fs.unlinkSync(paths.pidfile)
    fs.writeFileSync(paths.pidfile, "4242\n", { mode: 0o600 })
    const files = [paths.socket, paths.hqSocket, paths.pidfile]
    const before = files.map(ino)
    await stopDaemon(dir, d)
    expect(files.map(ino)).toEqual(before)
    expect(fs.readFileSync(paths.pidfile, "utf8")).toBe("4242\n")
    const warnings = daemonLog(dir)
      .split("\n")
      .filter((line) => line.includes(" WARNING "))
    const real = new OfficePaths(resolveHome(dir))
    for (const file of [real.socket, real.hqSocket, real.pidfile])
      expect(warnings.some((line) => line.includes(`left ${file}`))).toBe(true)
  },
  120_000,
)

test(
  "a killed offices surviving children dont make its sockets look live",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const kids = path.join(dir, "kids")
    const a = runScript(
      dir,
      `import { spawn } from "node:child_process"
import fs from "node:fs"
import { main } from ${JSON.stringify(DAEMON_MAIN)}
const home = process.argv[2]!
// One child in its own group, one in the office's, as workers and tools are started.
const spawnBoth = () => {
  const detached = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
  const inGroup = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
  fs.writeFileSync(${JSON.stringify(kids)}, \`\${detached.pid} \${inGroup.pid}\`)
}
process.exit(await main(["--home", home], {
  extensions: [{ name: "kids", register: (office) => void office.onStart.push(() => void setTimeout(spawnBoth, 1000)) }],
}))
`,
    )
    await waitUntilServing(dir, a)
    await waitFor(() => fs.existsSync(kids), { what: "the office's children" })
    const pids = fs.readFileSync(kids, "utf8").split(" ").map(Number)
    const sleeps = pids.map((pid) => ({ pid, started: startTime(pid) }))
    onTestFinished(() => {
      for (const kid of sleeps) if (kid.started !== null && sameProcess(kid.pid, kid.started)) process.kill(kid.pid, "SIGKILL")
    })
    a.child.kill("SIGKILL")
    expect(await exitWithin(dir, a, 15_000)).toEqual({ code: null, signal: "SIGKILL" })
    expect(sleeps.every((kid) => !isGone(kid.pid, kid.started))).toBe(true)
    const b = startDaemon(dir)
    await waitUntilServing(dir, b)
    expect(daemonLog(dir)).not.toContain("already running")
    expect(fs.readFileSync(paths.pidfile, "utf8")).toBe(`${b.pid}\n`)
    await stopDaemon(dir, b)
  },
  120_000,
)

/** GET /hq on the office socket of `home`: HQ's status. */
async function hqStatus(home: string) {
  const reply = await request(new OfficePaths(home).socket, "GET", "/hq")
  return reply.json() as { tcp: { enabled: boolean; listening: boolean } }
}

/** POST /hq/pair `{}` on the office socket of `home`: the one-time link's path. */
async function pairPath(home: string): Promise<string> {
  const headers = { "content-type": "application/json" }
  const r = await request(new OfficePaths(home).socket, "POST", "/hq/pair", { headers, body: "{}" })
  expect(r.status, r.text).toBe(200)
  return (r.json() as { path: string }).path
}

test(
  "the daemon attaches hq after the extensions",
  async () => {
    const dir = daemonHome()
    const d = startDaemon(dir)
    await waitUntilServing(dir, d)
    expect((await hqStatus(dir)).tcp.enabled).toBe(false)
    expect(await pairPath(dir)).toStartWith("/pair#")
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
    const code = (await pairPath(dir)).split("#")[1]!
    await stopDaemon(dir, d)
    const log = daemonLog(dir)
    const sock = new OfficePaths(dir).socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(log).toMatch(new RegExp(`^\\S+Z INFO opencorp\\.daemon\\.main: office serving on ${sock}$`, "m"))
    expect(log).toMatch(/^\S+Z INFO opencorp\.hq\.pairing: pairing code minted for @/m)
    expect(log).not.toContain(code)
  },
  120_000,
)

/** A request to 127.0.0.1:`port` on a fresh connection; resolves with the response, whose data events stream.
 *  The request is destroyed when the test finishes. */
function overTcp(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string>,
  body?: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent: false }, (res) => {
      // The cleanup's destroy cuts an unfinished response, which then errors with nobody reading it.
      res.on("error", () => {})
      resolve(res)
    })
    onTestFinished(() => req.destroy())
    req.on("error", reject)
    req.end(body)
  })
}

test(
  "a restart with an open web stream rebinds the port at once",
  async () => {
    const dir = daemonHome()
    const port = await freePort()
    fs.writeFileSync(path.join(dir, "office", "hq.json"), JSON.stringify({ tcp: true, port }))
    const listening = async (ms: number) => {
      const deadline = performance.now() + ms
      while (performance.now() < deadline) {
        if ((await hqStatus(dir)).tcp.listening) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return false
    }

    let d = startDaemon(dir)
    await waitUntilServing(dir, d)
    expect(await listening(3000)).toBe(true)
    const code = (await pairPath(dir)).split("#")[1]!
    const origin = `http://127.0.0.1:${port}`
    const json = { origin, "content-type": "application/json" }
    const paired = await overTcp(port, "POST", "/api/pair", json, JSON.stringify({ code }))
    paired.resume()
    expect(paired.statusCode).toBe(200)
    const cookie = paired.headers["set-cookie"]![0]!.split(";")[0]!
    const stream = frames(await overTcp(port, "GET", "/api/events", { origin, cookie }))
    expect(await take(stream, 1)).toEqual([["comment", null, "connected"]])
    await stopDaemon(dir, d) // SIGTERM with the stream open: the server side closes first, into TIME_WAIT
    await within(Array.fromAsync(stream)) // read to EOF, so closing sends a FIN, not a RST that clears TIME_WAIT

    // Unlike Python's, this never skips: node:net always sets SO_REUSEADDR, so it can't probe TIME_WAIT with a
    // plain socket, and the assertion holds either way.
    d = startDaemon(dir)
    await waitUntilServing(dir, d)
    expect(await listening(1500)).toBe(true) // well before the first retry at 5 s: the first bind worked
    await stopDaemon(dir, d)
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

const SPAWN = fileURLToPath(new URL("../../src/worker/spawn.ts", import.meta.url))

test(
  "a request in flight at a stop gets 503 stopping, not a dropped connection",
  async () => {
    // An endpoint that lists no models: an add checks the model it names with one reply.
    const endpoint = http.createServer((req, res) => {
      req.resume()
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve))
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          endpoint.closeAllConnections()
          endpoint.close(() => resolve())
        }),
    )
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    const checking = path.join(dir, "checking")
    // The add's model check holds until the office stops, then fails as a stopping registry fails it: the handler
    // is still running once the office has stopped.
    const d = runScript(
      dir,
      `import fs from "node:fs"
import { exitOnCrash, main } from ${JSON.stringify(DAEMON_MAIN)}
import { RegistryClosed } from ${JSON.stringify(SPAWN)}
exitOnCrash()
const hold = (office) => {
  const { promise: stopped, resolve } = Promise.withResolvers()
  office.onStop.push(() => resolve())
  office.checkModel = async () => {
    fs.writeFileSync(${JSON.stringify(checking)}, "")
    await stopped
    await new Promise((resolve) => setTimeout(resolve, 500))
    throw new RegistryClosed()
  }
}
process.exit(await main(["--home", process.argv[2]!], { extensions: [{ name: "hold", register: hold }] }))
`,
    )
    await waitUntilServing(dir, d)
    const url = `http://127.0.0.1:${(endpoint.address() as net.AddressInfo).port}/v1`
    const body = { provider: "openai", endpoint: url, api_key: "sk-test-stop-7d2f0a", model: "held" }
    const adding = request(paths.socket, "POST", "/connections", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    await waitFor(() => fs.existsSync(checking), { what: "the model check" })
    d.child.kill("SIGTERM")
    const r = await adding
    expect([r.status, (r.json() as { error: string }).error], daemonLog(dir)).toEqual([503, "stopping"])
    expect(await exitWithin(dir, d, 30_000), daemonLog(dir)).toEqual({ code: 0, signal: null })
    expect(fs.existsSync(paths.socket)).toBe(false)
  },
  120_000,
)

/** GET `target` on the office socket of `home`: its frames, once it answered 200. The request is destroyed when the
 *  test finishes. */
function streamed(home: string, target: string): Promise<AsyncGenerator<Frame>> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: new OfficePaths(home).socket, path: target, agent: false }, (res) => {
      // The cleanup's destroy cuts an unfinished response, which then errors with nobody reading it.
      res.on("error", () => {})
      if (res.statusCode === 200) resolve(frames(res))
      else reject(new Error(`GET ${target} answered ${res.statusCode}`))
    })
    onTestFinished(() => req.destroy())
    req.on("error", reject)
  })
}

test(
  "a stop with an open event stream and live stream exits well before the handler wait",
  async () => {
    const dir = daemonHome()
    const paths = new OfficePaths(dir)
    // An ended session's run with a log, which a stand-in worker joins to the live relay once the office started.
    const store = new Store(paths.store, { log: () => {} })
    let joined: { runId: string; sessionId: string; lastSeq: number }
    try {
      const ended = store.createSession(session({ status: "ended" }))
      const runId = newId()
      store.addRun({
        runId,
        sessionId: ended.id,
        driver: "minh",
        flow: "chat",
        flowPath: "shared/flows/chat.yaml",
        connection: null,
        model: null,
        configSha256: null,
        replacesRunId: null,
        createdAt: ended.created_at,
      })
      const log = path.join(paths.runs, runId, "log.jsonl")
      fs.mkdirSync(path.dirname(log), { recursive: true })
      chatLog(log, 2)
      joined = { runId, sessionId: ended.id, lastSeq: 3 + 8 * 2 }
    } finally {
      store.close()
    }
    const d = runScript(
      dir,
      `import path from "node:path"
import { exitOnCrash, main } from ${JSON.stringify(DAEMON_MAIN)}
exitOnCrash()
const { runId, sessionId, lastSeq } = JSON.parse(process.argv[3]!)
const join = (office) => {
  const log = path.join(office.paths.runs, runId, "log.jsonl")
  const worker = { job: { run_id: runId, session_id: sessionId, log }, follow: () => Promise.resolve(true) }
  office.onStart.push(() => office.live.frame(worker, { type: "snapshot", snapshot: { last_seq: lastSeq, calls: [] } }))
}
process.exit(await main(["--home", process.argv[2]!], { extensions: [{ name: "join", register: join }] }))
`,
      JSON.stringify(joined),
    )
    await waitUntilServing(dir, d)
    const events = await streamed(dir, "/events")
    const live = await streamed(dir, `/runs/${joined.runId}/live`)
    expect(await take(events, 1)).toEqual([["comment", null, "connected"]])
    expect(await take(live, 1)).toEqual([["comment", null, "connected"]])
    d.child.kill("SIGTERM")
    // A stream left open would hold the stop for the whole handler wait.
    expect(await exitWithin(dir, d, HANDLER_WAIT_MS - 1500), daemonLog(dir)).toEqual({ code: 0, signal: null })
    expect(fs.existsSync(paths.socket)).toBe(false)
  },
  120_000,
)

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

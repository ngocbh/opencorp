/** The office without a service manager: in a detached tmux session, or as a detached process, and how its
 *  daemon is found and stopped. */
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { makeOfficeDir } from "../../src/daemon/sockets.ts"
import * as fallback from "../../src/install/fallback.ts"
import { type Completed, type Launch, ServiceError, launch, runCommand, which } from "../../src/install/launch.ts"
import { selfSpawnEnv } from "../../src/platform.ts"
import { fifo, isGone, ps, shortDir, startGroup, tempDir, waitFor } from "../helpers.ts"
import { Runner, daemonHost, killedAtEnd, makeHost, ownerLaunch, standIn } from "./helpers.ts"

const SESSION = "opencorp-office"

/** An executable stand-in for the office program, in `dir`. */
function program(dir: string): string {
  const file = path.join(dir, "opencorp")
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o700 })
  return file
}

/** The launch of an office at `<dir>/home` run by `command`. */
function officeAt(dir: string, command: string, environ: Record<string, string> = {}): Launch {
  return launch(path.join(dir, "home"), { command: [command], environ, userHome: dir })
}

/** What `call` threw; fails the test when it returns. */
function refusal(call: () => void): Error {
  try {
    call()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a throw")
}

test("the tmux command runs the daemon with only its env its output to the log and its stdin on the pane", () => {
  expect(fallback.shellCommand(ownerLaunch())).toBe(
    "ulimit -Sn 4096; exec /usr/bin/env -i HOME=/Users/owner PATH=/usr/bin:/bin" +
      " /opt/opencorp/bin/opencorp daemon --home /Users/owner/.opencorp" +
      " >>/Users/owner/.opencorp/office/office.log 2>&1",
  )
})

test("tmux starts a detached session in the office folder", async () => {
  const SOCKET = fallback.socket(ownerLaunch())
  const run = new Runner([[["tmux", "-L", SOCKET, "has-session"], 1, "can't find session"]])
  await fallback.startTmux(ownerLaunch(), makeHost(tempDir(), run))
  expect(run.calls).toEqual([
    ["tmux", "-L", SOCKET, "has-session", "-t", `=${SESSION}`],
    [
      "tmux",
      "-L",
      SOCKET,
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-c",
      ownerLaunch().cwd,
      fallback.shellCommand(ownerLaunch()),
    ],
  ])
  const env = ownerLaunch().env
  expect(run.envs).toEqual([env, env])
})

test("a live tmux session is left alone", async () => {
  const SOCKET = fallback.socket(ownerLaunch())
  const run = new Runner()
  await fallback.startTmux(ownerLaunch(), makeHost(tempDir(), run))
  expect(run.calls).toEqual([["tmux", "-L", SOCKET, "has-session", "-t", `=${SESSION}`]])
})

test("the tmux server is the offices own named by a hash of its home", () => {
  const dir = tempDir()
  const one = fallback.socket(officeAt(dir, "/opt/opencorp/bin/opencorp"))
  expect(one).toMatch(/^opencorp-[0-9a-f]{8}$/)
  expect(fallback.socket(officeAt(dir, "/elsewhere/opencorp", { PATH: "/usr/bin" }))).toBe(one)
  expect(fallback.socket(officeAt(tempDir(), "/opt/opencorp/bin/opencorp"))).not.toBe(one)
  expect(one).not.toBe("default")
})

test.skipIf(which("tmux", process.env.PATH) === null)(
  "a variable planted in setups env reaches neither the tmux server nor the daemon",
  async () => {
    let one: Launch | undefined
    // Registered before the dir is made, so the server is killed before the dir is removed. Only this test's own
    // server: never the default one. tmux leaves its socket file behind, in `/tmp` since `TMUX_TMPDIR` isn't set.
    onTestFinished(async () => {
      if (!one) return
      await runCommand(["tmux", "-L", fallback.socket(one), "kill-server"], { env: one.env })
      fs.rmSync(path.join("/tmp", `tmux-${process.getuid!()}`, fallback.socket(one)), { force: true })
    })
    const dir = shortDir()
    const daemon = path.join(dir, "opencorp")
    fs.writeFileSync(daemon, '#!/bin/sh\n/usr/bin/env > "$3/office/daemon.env"\nexec sleep 60\n', { mode: 0o700 })
    one = launch(path.join(dir, "home"), {
      command: [daemon],
      environ: { PATH: process.env.PATH!, HOME: dir },
      userHome: dir,
    })
    makeOfficeDir(one.office)
    const socket = fallback.socket(one)
    const planted = { ...selfSpawnEnv(process.env), OPENCORP_PLANTED: "planted-0000" }
    // Nothing reaches a tmux server other than this test's own.
    const refused: Completed = { code: 1, stdout: "", stderr: "the test refuses another tmux server" }
    const host = makeHost(dir, {
      run: async (argv, o) =>
        argv[0] === "tmux" && (argv[1] !== "-L" || argv[2] !== socket)
          ? refused
          : runCommand(argv, { env: o?.env ?? planted }),
    })
    await fallback.startTmux(one, host)
    const written = path.join(one.office, "daemon.env")
    const text = await waitFor(
      () => {
        const got = fs.existsSync(written) ? fs.readFileSync(written, "utf8") : ""
        return got.includes("PATH=") ? got : null
      },
      { timeout: 10_000, what: "the daemon's env" },
    )
    expect(text).not.toContain("OPENCORP_PLANTED")
    const server = await runCommand(["tmux", "-L", socket, "show-environment", "-g"], { env: one.env })
    expect(server.stdout).toContain("PATH=")
    expect(server.stdout).not.toContain("OPENCORP_PLANTED")
  },
  30_000,
)

test("a tmux that refuses is a service error", async () => {
  const SOCKET = fallback.socket(ownerLaunch())
  const run = new Runner([
    [["tmux", "-L", SOCKET, "has-session"], 1, ""],
    [["tmux", "-L", SOCKET, "new-session"], 1, "no server running"],
  ])
  const done = fallback.startTmux(ownerLaunch(), makeHost(tempDir(), run))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("no server running")
})

test("background detaches the daemon with its output in a private log", () => {
  const dir = tempDir()
  const got: { argv?: readonly string[]; options?: SpawnOptions; log?: fs.Stats; unref?: boolean } = {}
  const spawn = (argv: readonly [string, ...string[]], options: SpawnOptions): ChildProcess => {
    const stdio = options.stdio as [string, number, number]
    got.argv = argv
    got.options = options
    // The parent closes the log after the spawn, so it is read while the call runs.
    got.log = fs.fstatSync(stdio[1])
    const child = { pid: 4242, unref: () => (got.unref = true) }
    return Object.assign(new EventEmitter(), child) as unknown as ChildProcess
  }
  const one = officeAt(dir, program(dir), { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x" })
  fallback.startBackground(one, makeHost(dir, new Runner(), { spawn }))
  expect(got.argv).toEqual(["/bin/sh", "-c", 'ulimit -Sn 4096; exec "$@"', "sh", ...one.argv])
  expect(got.options!.env).toEqual({ PATH: "/usr/bin" })
  expect(got.options!.cwd).toBe(one.cwd)
  expect(got.options!.detached).toBe(true)
  const stdio = got.options!.stdio as [string, number, number]
  expect(stdio[0]).toBe("ignore")
  expect(stdio[1]).toBe(stdio[2])
  expect(got.log!.mode & 0o777).toBe(0o600)
  expect(got.log!.ino).toBe(fs.statSync(one.log).ino)
  expect(fs.statSync(one.office).mode & 0o777).toBe(0o700)
  expect(got.unref).toBe(true)
  expect(() => fs.fstatSync(stdio[1])).toThrow()
})

test("a spawn that fails is a service error and closes the log", () => {
  const dir = tempDir()
  let fd: number | undefined
  const spawn = (_argv: readonly [string, ...string[]], options: SpawnOptions): ChildProcess => {
    fd = (options.stdio as [string, number, number])[1]
    throw new Error("spawn refused")
  }
  const one = officeAt(dir, program(dir))
  const error = refusal(() => fallback.startBackground(one, makeHost(dir, new Runner(), { spawn })))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toContain("can't start")
  expect(fd).toBeNumber()
  expect(() => fs.fstatSync(fd!)).toThrow("EBADF")
})

test("background refuses a symlinked log", () => {
  const dir = tempDir()
  const one = officeAt(dir, program(dir))
  fs.mkdirSync(one.office, { recursive: true, mode: 0o700 })
  fs.symlinkSync(path.join(dir, "elsewhere"), one.log)
  const error = refusal(() => fallback.startBackground(one, makeHost(dir, new Runner())))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toContain("log")
  expect(fs.existsSync(path.join(dir, "elsewhere"))).toBe(false)
})

test("background refuses a FIFO log without blocking, with or without a reader", () => {
  const dir = tempDir()
  const one = officeAt(dir, program(dir))
  fs.mkdirSync(one.office, { recursive: true, mode: 0o700 })
  fifo(one.log)
  let spawned = false
  const spawn = (): ChildProcess => {
    spawned = true
    throw new Error("not reached")
  }
  const began = performance.now()
  const unread = refusal(() => fallback.startBackground(one, makeHost(dir, new Runner(), { spawn })))
  expect(unread).toBeInstanceOf(ServiceError)
  expect(unread.message).toContain("can't open the office log")
  // With a reader the write open succeeds, so only the fstat check stops it.
  const reader = fs.openSync(one.log, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  try {
    const read = refusal(() => fallback.startBackground(one, makeHost(dir, new Runner(), { spawn })))
    expect(read).toBeInstanceOf(ServiceError)
    expect(read.message).toContain("isn't a regular file")
  } finally {
    fs.closeSync(reader)
  }
  expect(performance.now() - began).toBeLessThan(2000)
  expect(spawned).toBe(false)
})

test("background without the office program is a service error", () => {
  const dir = tempDir()
  const one = officeAt(dir, path.join(dir, "no-such", "opencorp"))
  let spawned = false
  const spawn = (): ChildProcess => {
    spawned = true
    throw new Error("not reached")
  }
  const error = refusal(() => fallback.startBackground(one, makeHost(dir, new Runner(), { spawn })))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toContain("can't start")
  expect(spawned).toBe(false)
})

/** A launch whose program is the script `body` in `dir`, for a background daemon that is only a shell. */
function scripted(dir: string, body: string): Launch {
  const file = path.join(dir, "opencorp")
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  return officeAt(dir, file, { PATH: "/usr/bin:/bin" })
}

test("background hands back the daemons exit and the log size before it started", async () => {
  const spawned = killedAtEnd()
  const dir = tempDir()
  const one = scripted(dir, "echo 'opencorp office: boom' >&2; exit 1")
  makeOfficeDir(one.office)
  fs.writeFileSync(one.log, "0123456789", { mode: 0o600 })
  const child = fallback.startBackground(one, daemonHost(dir, spawned))
  expect(child.pid).toBe(spawned[0]!.pid)
  expect(child.logFrom).toBe(10)
  expect(await child.exited).toEqual({ code: 1, signal: null })
  expect(fs.readFileSync(one.log, "utf8").slice(10)).toBe("opencorp office: boom\n")
})

test("a late spawn error ends the background daemons exit", async () => {
  const dir = tempDir()
  const emitter = Object.assign(new EventEmitter(), { pid: 123, unref() {} })
  const spawn = () => emitter as unknown as ChildProcess
  const child = fallback.startBackground(officeAt(dir, program(dir)), makeHost(dir, new Runner(), { spawn }))
  emitter.emit("error", new Error("EAGAIN"))
  expect(await child.exited).toEqual({ code: null, signal: null, error: true })
})

test("the background daemon doesnt hold up its caller", async () => {
  const spawned = killedAtEnd()
  const dir = tempDir()
  const child = fallback.startBackground(scripted(dir, "exec sleep 30"), daemonHost(dir, spawned))
  let exited = false
  void child.exited.then(() => (exited = true))
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(exited).toBe(false)
  expect(isGone(child.pid, spawned[0]!.started)).toBe(false)
})

/** An office at a fresh home, its office dir made. */
function officeDir(): Launch {
  const dir = tempDir()
  const one = officeAt(dir, "/opt/opencorp/bin/opencorp")
  fs.mkdirSync(one.office, { recursive: true, mode: 0o700 })
  return one
}

test("the daemon is found only by its pid start time and home", async () => {
  const one = officeDir()
  const pidfile = path.join(one.office, "office.pid")
  const live = await standIn(`daemon --home ${one.home}`)
  fs.writeFileSync(pidfile, `${live.pid}\n`)
  expect(fallback.daemon(one, ps())).toEqual({ pid: live.pid, started: live.started! })

  fs.writeFileSync(pidfile, `${process.pid}\n`)
  expect(fallback.daemon(one, ps())).toBeNull()

  for (const tail of [`daemon --home ${one.home} b`, `daemon --home ${one.home}2`]) {
    const other = await standIn(tail)
    fs.writeFileSync(pidfile, `${other.pid}\n`)
    expect(fallback.daemon(one, ps())).toBeNull()
  }

  const target = path.join(one.home, "pid")
  fs.writeFileSync(target, `${live.pid}\n`)
  fs.rmSync(pidfile)
  fs.symlinkSync(target, pidfile)
  expect(fallback.daemon(one, ps())).toBeNull()
  fs.rmSync(pidfile)

  const reexeced = await standIn(`daemon --home ${one.home} --reexeced`)
  fs.writeFileSync(pidfile, `${reexeced.pid}\n`)
  expect(fallback.daemon(one, ps())).toEqual({ pid: reexeced.pid, started: reexeced.started! })
})

test("a pid is verified only as this homes daemon", async () => {
  const one = officeDir()
  const live = await standIn(`daemon --home ${one.home}`)
  expect(fallback.verify(live.pid, one, ps())).toEqual({ pid: live.pid, started: live.started! })
  const other = await standIn(`daemon --home ${one.home}2`)
  expect(fallback.verify(other.pid, one, ps())).toBeNull()
  expect(fallback.verify(process.pid, one, ps())).toBeNull()
  expect(fallback.verify(1, one, ps())).toBeNull()
})

test("stop process signals only the daemon it is given", async () => {
  const one = officeDir()
  const pidfile = path.join(one.office, "office.pid")
  const named = await standIn(`daemon --home ${one.home}`)
  fs.writeFileSync(pidfile, `${named.pid}\n`)
  const given = await standIn(`daemon --home ${one.home}`)
  const found = { pid: given.pid, started: given.started! }
  expect(await fallback.stopProcess(one, { ps: ps(), found })).toEqual({
    pid: given.pid,
    line: `stopped the office (pid ${given.pid})`,
    killed: false,
  })
  expect(isGone(given.pid, given.started)).toBe(true)
  expect(isGone(named.pid, named.started)).toBe(false)
  expect(await fallback.stopProcess(one, { ps: ps(), found: null })).toBeNull()
  expect(isGone(named.pid, named.started)).toBe(false)
})

test("stop process stops the office daemon and nothing else", async () => {
  const one = officeDir()
  const pidfile = path.join(one.office, "office.pid")
  const other = await standIn(`daemon --home ${one.home}2`)
  fs.writeFileSync(pidfile, `${other.pid}\n`)
  expect(await fallback.stopProcess(one, { ps: ps() })).toBeNull()
  expect(isGone(other.pid, other.started)).toBe(false)

  const live = await standIn(`daemon --home ${one.home}`)
  fs.writeFileSync(pidfile, `${live.pid}\n`)
  expect((await fallback.stopProcess(one, { ps: ps() }))?.line).toBe(`stopped the office (pid ${live.pid})`)
  expect(isGone(live.pid, live.started)).toBe(true)
})

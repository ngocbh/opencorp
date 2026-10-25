/** The office without a service manager: in a detached tmux session, or as a detached process, and how its
 *  daemon is found and stopped. */
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import * as fallback from "../../src/install/fallback.ts"
import { type Launch, ServiceError, launch } from "../../src/install/launch.ts"
import { isGone, ps, startGroup, tempDir } from "../helpers.ts"
import { Runner, makeHost, ownerLaunch } from "./helpers.ts"

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
  const run = new Runner([[["tmux", "has-session"], 1, "can't find session"]])
  await fallback.startTmux(ownerLaunch(), makeHost(tempDir(), run))
  expect(run.calls).toEqual([
    ["tmux", "has-session", "-t", `=${SESSION}`],
    ["tmux", "new-session", "-d", "-s", SESSION, "-c", ownerLaunch().cwd, fallback.shellCommand(ownerLaunch())],
  ])
})

test("a live tmux session is left alone", async () => {
  const run = new Runner()
  await fallback.startTmux(ownerLaunch(), makeHost(tempDir(), run))
  expect(run.calls).toEqual([["tmux", "has-session", "-t", `=${SESSION}`]])
})

test("a tmux that refuses is a service error", async () => {
  const run = new Runner([
    [["tmux", "has-session"], 1, ""],
    [["tmux", "new-session"], 1, "no server running"],
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

/** A stand-in daemon: `sh` whose args end with `tail`; a SIGTERM also ends its `sleep`. Resolves once it runs. */
async function standIn(tail: string): Promise<{ pid: number; started: number | null }> {
  const group = startGroup(`trap 'kill $! 2>/dev/null; exit 0' TERM; sleep 60 & echo ready; wait; : ${tail}`)
  expect(await group.line()).toBe("ready")
  return { pid: group.pid, started: group.started }
}

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

test("stop process stops the office daemon and nothing else", async () => {
  const one = officeDir()
  const pidfile = path.join(one.office, "office.pid")
  const other = await standIn(`daemon --home ${one.home}2`)
  fs.writeFileSync(pidfile, `${other.pid}\n`)
  expect(await fallback.stopProcess(one, { ps: ps() })).toBeNull()
  expect(isGone(other.pid, other.started)).toBe(false)

  const live = await standIn(`daemon --home ${one.home}`)
  fs.writeFileSync(pidfile, `${live.pid}\n`)
  expect(await fallback.stopProcess(one, { ps: ps() })).toBe(`stopped the office (pid ${live.pid})`)
  expect(isGone(live.pid, live.started)).toBe(true)
})

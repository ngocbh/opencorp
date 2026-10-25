/** Installing, starting, waiting on, stopping and restarting the office under the best service manager that
 *  works here. Every host is a stand-in: nothing real is installed, started or signalled. */
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { expect, test } from "bun:test"
import * as fallback from "../../src/install/fallback.ts"
import { type Completed, type Launch, ServiceError, defaultHost, launch } from "../../src/install/launch.ts"
import * as launchd from "../../src/install/launchd.ts"
import * as service from "../../src/install/service.ts"
import * as systemd from "../../src/install/systemd.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { Runner, makeHost } from "./helpers.ts"

/** A `which` that finds every program in `/usr/bin`. */
const found = (name: string) => `/usr/bin/${name}`

function recorded(one: Launch): { mode: string; name: string } {
  return JSON.parse(fs.readFileSync(path.join(one.office, "install.json"), "utf8"))
}

/** An executable stand-in for the office program, in `dir`. */
function program(dir: string): string {
  const file = path.join(dir, "opencorp")
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o700 })
  return file
}

/** The office at `<dir>/home` (Python's `one` fixture), and `dir` as the user's home. */
function fixture(): { dir: string; one: Launch } {
  const dir = tempDir()
  const one = launch(path.join(dir, "home"), { command: [program(dir)], environ: { PATH: "/usr/bin" }, userHome: dir })
  return { dir, one }
}

/** A stand-in `spawn` that records each argv and returns a child with a pid that is never started. */
function recorder(): { started: (readonly string[])[]; spawn: (argv: readonly [string, ...string[]]) => ChildProcess } {
  const started: (readonly string[])[] = []
  return {
    started,
    spawn: (argv) => {
      started.push(argv)
      return { pid: 4242, unref() {}, on() {} } as unknown as ChildProcess
    },
  }
}

/** What `startBackground` hands `spawn` for `one`: its argv under `/bin/sh` with room for 4096 open files. */
function background(one: Launch): string[] {
  return ["/bin/sh", "-c", 'ulimit -n 4096; exec "$@"', "sh", ...one.argv]
}

/** What `promise` rejected with; fails the test when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}

test("a mac uses launchd when it works", async () => {
  const { dir, one } = fixture()
  const run = new Runner([[["launchctl", "print"], 113, ""]])
  const got = await service.install(one, makeHost(dir, run))
  expect(got).toEqual({ mode: "launchd", notes: [] })
  expect(recorded(one)).toEqual({ mode: "launchd", name: one.name })
})

test("a failing launchctl falls back to tmux", async () => {
  const { dir, one } = fixture()
  const run = new Runner([
    [["launchctl", "print"], 113, ""],
    [["launchctl", "bootstrap"], 5, "Input/output error"],
    [["tmux", "has-session"], 1, ""],
  ])
  const got = await service.install(one, makeHost(dir, run, { which: found }))
  expect(got.mode).toBe("tmux")
  expect(got.notes[0]).toContain("Input/output error")
  expect(run.calls.at(-1)!.slice(0, 2)).toEqual(["tmux", "new-session"])
  expect(recorded(one).mode).toBe("tmux")
})

test("a loaded agent that wont kickstart is removed before falling back", async () => {
  const { dir, one } = fixture()
  await service.install(one, makeHost(dir, new Runner()))
  const run = new Runner([
    [["launchctl", "kickstart"], 1, "Operation not permitted"],
    [["tmux", "has-session"], 1, ""],
  ])
  const got = await service.install(one, makeHost(dir, run, { which: found }))
  expect(got.mode).toBe("tmux")
  expect(got.notes[0]).toContain("Operation not permitted")
  expect(run.calls).toContainEqual(["launchctl", "bootout", `gui/501/com.opencorp.${one.name}`])
  expect(fs.readdirSync(path.join(dir, "Library", "LaunchAgents"))).toEqual([])
})

test.each([
  ["darwin", "Library/LaunchAgents"],
  ["linux", ".config/systemd/user"],
] as const)("a service file that cant be written falls back to tmux [%s]", async (platform, where) => {
  const { dir, one } = fixture()
  const locked = path.join(dir, where)
  fs.mkdirSync(locked, { recursive: true })
  fs.chmodSync(locked, 0o500)
  const run = new Runner([
    [["launchctl", "print"], 113, ""],
    [["tmux", "has-session"], 1, ""],
  ])
  const got = await service.install(one, makeHost(dir, run, { platform, which: found }))
  expect(got.mode).toBe("tmux")
  expect(got.notes[0]).toContain("can't write")
  expect(got.notes[0]).toContain("Permission denied")
  expect(recorded(one).mode).toBe("tmux")
})

test("linux without a user bus or tmux runs it in the background", async () => {
  const { dir, one } = fixture()
  const { started, spawn } = recorder()
  const run = new Runner([[["systemctl"], 1, "Failed to connect to bus"]])
  const got = await service.install(one, makeHost(dir, run, { platform: "linux", spawn }))
  expect(got.mode).toBe("background")
  expect(got.notes[0]).toContain("Failed to connect to bus")
  expect(started).toEqual([background(one)])
})

test("a newline in the home falls back from systemd to tmux", async () => {
  const dir = tempDir()
  const odd = launch(path.join(dir, "a\nb"), { command: [program(dir)], environ: { PATH: "/usr/bin" }, userHome: dir })
  const run = new Runner([[["tmux", "has-session"], 1, ""]])
  const got = await service.install(odd, makeHost(dir, run, { platform: "linux", which: found }))
  expect(got.mode).toBe("tmux")
  expect(got.notes[0]).toContain("newline")
  expect(run.calls.map((c) => c.slice(0, 2))).toEqual([
    ["tmux", "has-session"],
    ["tmux", "new-session"],
  ])
})

test("a chosen mode that fails is an error not a fallback", async () => {
  const { dir, one } = fixture()
  const run = new Runner([[["systemctl"], 1, "Failed to connect to bus"]])
  const error = await refusal(service.install(one, makeHost(dir, run, { platform: "linux" }), "systemd"))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toContain("Failed to connect to bus")
  expect(fs.existsSync(path.join(one.office, "install.json"))).toBe(false)
})

test("a running office under launchd is only checked not reinstalled", async () => {
  const { dir, one } = fixture()
  await service.install(one, makeHost(dir, new Runner([[["launchctl", "print"], 113, ""]])))
  const plist = path.join(dir, "Library", "LaunchAgents", `com.opencorp.${one.name}.plist`)
  const before = fs.readFileSync(plist)
  const moved = launch(one.home, {
    command: [one.argv[0]],
    environ: { PATH: "/opt/bin", LC_CTYPE: "C" },
    userHome: dir,
  })
  const again = new Runner()
  const host = makeHost(dir, again, { answers: async () => true, which: () => "/usr/bin/tmux" })
  expect(await service.install(moved, host)).toEqual({ mode: "launchd", notes: [] })
  expect(again.calls).toEqual([["launchctl", "print", `gui/501/com.opencorp.${one.name}`]])
  expect(fs.readFileSync(plist).equals(before)).toBe(true)
})

test("a running office under systemd is only checked not restarted", async () => {
  const { dir, one } = fixture()
  await service.install(one, makeHost(dir, new Runner(), { platform: "linux" }))
  const unit = path.join(dir, ".config", "systemd", "user", `opencorp-${one.name}.service`)
  const before = fs.readFileSync(unit, "utf8")
  const moved = launch(one.home, { command: [one.argv[0]], environ: { PATH: "/opt/bin" }, userHome: dir })
  const again = new Runner()
  const host = makeHost(dir, again, { platform: "linux", answers: async () => true })
  expect(await service.install(moved, host)).toEqual({ mode: "systemd", notes: [] })
  expect(again.calls).toEqual([["systemctl", "--user", "is-enabled", `opencorp-${one.name}.service`]])
  expect(fs.readFileSync(unit, "utf8")).toBe(before)
})

test("a running office its service manager lost is an error", async () => {
  const { dir, one } = fixture()
  await service.install(one, makeHost(dir, new Runner(), { platform: "linux" }))
  const run = new Runner([[["systemctl", "--user", "is-enabled"], 1, "Failed to get unit file state: No such file"]])
  const host = makeHost(dir, run, { platform: "linux", answers: async () => true })
  const error = await refusal(service.install(one, host))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toMatch(/No such file[\s\S]*stop the office/)
})

test("a running office in tmux or the background is not started twice", async () => {
  const { dir, one } = fixture()
  const { started, spawn } = recorder()
  await service.install(one, makeHost(dir, new Runner(), { spawn }), "background")
  const running = makeHost(dir, new Runner(), { spawn, answers: async () => true })
  expect(await service.install(one, running)).toEqual({ mode: "background", notes: [] })
  expect(started).toEqual([background(one)])
})

test("a running office is not moved to another service", async () => {
  const { dir, one } = fixture()
  await service.install(one, makeHost(dir, new Runner([[["tmux", "has-session"], 1, ""]])), "tmux")
  const running = makeHost(dir, new Runner(), { answers: async () => true })
  const error = await refusal(service.install(one, running, "launchd"))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toContain("already running under tmux")
})

test("an office started by hand is left running and no service is installed", async () => {
  const { dir, one } = fixture()
  const run = new Runner()
  const got = await service.install(one, makeHost(dir, run, { answers: async () => true }))
  expect(got.mode).toBeNull()
  expect(got.notes[0]).toContain("not started by a service")
  expect(run.calls).toEqual([])
  expect(fs.existsSync(path.join(one.office, "install.json"))).toBe(false)
})

test("start uses the recorded service", async () => {
  const { dir, one } = fixture()
  const run = new Runner([[["systemctl", "--user", "start"], 0, ""]])
  await service.install(one, makeHost(dir, new Runner(), { platform: "linux" }))
  expect(await service.start(one, makeHost(dir, run, { platform: "linux" }))).toEqual({ mode: "systemd", notes: [] })
  expect(run.calls).toEqual([["systemctl", "--user", "start", `opencorp-${one.name}.service`]])
})

test("start falls back to the background when the service wont start", async () => {
  const { dir, one } = fixture()
  const { started, spawn } = recorder()
  await service.install(one, makeHost(dir, new Runner(), { platform: "linux" }))
  const run = new Runner([[["systemctl"], 1, "Unit is masked"]])
  const got = await service.start(one, makeHost(dir, run, { platform: "linux", spawn }))
  expect(got.mode).toBe("background")
  expect(got.notes[0]).toContain("Unit is masked")
  expect(started).toEqual([background(one)])
  expect(recorded(one).mode).toBe("background") // so the doctor doesn't call it a managed service
})

test("start removes a launch agent that wont kickstart before falling back", async () => {
  const { dir, one } = fixture()
  await service.install(one, makeHost(dir, new Runner()))
  const run = new Runner([[["launchctl", "kickstart"], 1, "Operation not permitted"]])
  const got = await service.start(one, makeHost(dir, run, { spawn: recorder().spawn }))
  expect(got.mode).toBe("background")
  expect(got.notes[0]).toContain("Operation not permitted")
  // Left loaded, RunAtLoad would start it under launchd at the next login while the record says background.
  expect(run.calls).toContainEqual(["launchctl", "bootout", `gui/501/com.opencorp.${one.name}`])
  expect(fs.readdirSync(path.join(dir, "Library", "LaunchAgents"))).toEqual([])
  expect(recorded(one).mode).toBe("background")
})

test("start removes a systemd unit that wont start before falling back", async () => {
  const { dir, one } = fixture()
  await service.install(one, makeHost(dir, new Runner(), { platform: "linux" }))
  const units = path.join(dir, ".config", "systemd", "user")
  const name = `opencorp-${one.name}.service`
  fs.mkdirSync(path.join(units, "default.target.wants"))
  // What `systemctl enable` makes.
  fs.symlinkSync(path.join(units, name), path.join(units, "default.target.wants", name))
  const run = new Runner([[["systemctl", "--user", "start"], 1, "Unit is masked"]])
  const got = await service.start(one, makeHost(dir, run, { platform: "linux", spawn: recorder().spawn }))
  expect(got.mode).toBe("background")
  expect(got.notes[0]).toContain("Unit is masked")
  // Left enabled, it would start under systemd at the next login while the record says background.
  expect(fs.existsSync(path.join(units, name))).toBe(false)
  expect(() => fs.lstatSync(path.join(units, "default.target.wants", name))).toThrow("ENOENT")
  expect(recorded(one).mode).toBe("background")
})

test("start without an install runs it in the background", async () => {
  const { dir, one } = fixture()
  const { started, spawn } = recorder()
  const got = await service.start(one, makeHost(dir, new Runner(), { spawn }))
  expect(got.mode).toBe("background")
  expect(started).toEqual([background(one)])
  expect(recorded(one).mode).toBe("background")
})

test("waiting for an office that never answers shows the log", async () => {
  const { dir, one } = fixture()
  fs.mkdirSync(one.office, { recursive: true })
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("")
  fs.writeFileSync(one.log, `${lines}opencorp office: no company repo\n`)
  const error = await refusal(service.wait(one, makeHost(dir, new Runner()), 1000))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toMatch(/did not answer[\s\S]*line 29\nopencorp office: no company repo/)
  expect(error.message).not.toContain("line 9\n")
})

test("waiting on an office that accepts but never answers stops at the deadline", async () => {
  const dir = shortDir()
  const one = launch(dir, { command: [program(dir)], environ: {}, userHome: dir })
  fs.mkdirSync(one.office)
  // The server accepts connections; nothing ever reads or answers.
  const silent = new Set<net.Socket>()
  const hung = net.createServer((conn) => silent.add(conn))
  await new Promise<void>((resolve) => hung.listen(one.socket, resolve))
  try {
    const began = performance.now()
    const error = await refusal(service.wait(one, { ...defaultHost(), run: new Runner().run }, 500))
    expect(error).toBeInstanceOf(ServiceError)
    expect(error.message).toContain("did not answer")
    expect(performance.now() - began).toBeLessThan(1500)
  } finally {
    for (const conn of silent) conn.destroy()
    await new Promise((resolve) => hung.close(resolve))
  }
})

test("a broken record counts as no record", () => {
  const { one } = fixture()
  fs.mkdirSync(one.office, { recursive: true })
  for (const text of ["not json", "[]", '{"mode": "cron"}']) {
    fs.writeFileSync(path.join(one.office, "install.json"), text)
    expect(service.recordedMode(one)).toBeNull()
  }
})

function installedAs(one: Launch, mode: string): void {
  fs.mkdirSync(one.office, { recursive: true })
  fs.writeFileSync(path.join(one.office, "install.json"), JSON.stringify({ mode, name: one.name }))
}

test("uninstalling a launchd office boots it out and removes its plist", async () => {
  const { dir, one } = fixture()
  installedAs(one, "launchd")
  const run = new Runner()
  const host = makeHost(dir, run)
  const plist = launchd.plistPath(one, host)
  fs.mkdirSync(path.dirname(plist), { recursive: true })
  fs.writeFileSync(plist, launchd.plist(one))
  const done = await service.uninstall(one, host)
  expect(run.calls).toEqual([["launchctl", "bootout", `gui/501/${launchd.label(one)}`]])
  expect(fs.existsSync(plist)).toBe(false)
  expect(fs.existsSync(path.join(one.office, "install.json"))).toBe(false)
  expect(done).toEqual([`launchd: booted out ${launchd.label(one)} and removed ${plist}`])
})

test("uninstalling a launchd office that isnt loaded still removes its plist", async () => {
  const { dir, one } = fixture()
  installedAs(one, "launchd")
  const host = makeHost(dir, new Runner([[["launchctl", "bootout"], 3, "Boot-out failed: 3: No such process"]]))
  const plist = launchd.plistPath(one, host)
  fs.mkdirSync(path.dirname(plist), { recursive: true })
  fs.writeFileSync(plist, launchd.plist(one))
  await service.uninstall(one, host)
  expect(fs.existsSync(plist)).toBe(false)
})

test("a recorded launchd office without its plist is still booted out", async () => {
  const { dir, one } = fixture()
  installedAs(one, "launchd")
  const run = new Runner()
  await service.uninstall(one, makeHost(dir, run))
  expect(run.calls).toEqual([["launchctl", "bootout", `gui/501/${launchd.label(one)}`]])
})

test("uninstalling a systemd office disables and stops it and removes its unit", async () => {
  const { dir, one } = fixture()
  installedAs(one, "systemd")
  const run = new Runner()
  const host = makeHost(dir, run, { platform: "linux" })
  const unit = systemd.unitPath(one, host)
  const wants = path.join(path.dirname(unit), "default.target.wants", systemd.unitName(one))
  fs.mkdirSync(path.dirname(wants), { recursive: true })
  fs.writeFileSync(unit, systemd.unit(one))
  fs.symlinkSync(unit, wants)
  const done = await service.uninstall(one, host)
  expect(run.calls).toEqual([
    ["systemctl", "--user", "disable", "--now", systemd.unitName(one)],
    ["systemctl", "--user", "daemon-reload"],
  ])
  expect(fs.existsSync(unit)).toBe(false)
  expect(() => fs.lstatSync(wants)).toThrow("ENOENT")
  expect(done).toEqual([`systemd: disabled and stopped ${systemd.unitName(one)} and removed ${unit}`])
})

test("uninstalling a tmux office kills its session", async () => {
  const { dir, one } = fixture()
  installedAs(one, "tmux")
  const run = new Runner()
  const done = await service.uninstall(one, makeHost(dir, run, { which: found }))
  const session = fallback.session(one)
  expect(run.calls).toEqual([
    ["tmux", "has-session", "-t", `=${session}`],
    ["tmux", "kill-session", "-t", `=${session}`],
  ])
  expect(done).toEqual([`tmux: killed the session ${session}`])
})

test("a tmux office whose session is gone has nothing to kill", async () => {
  const { dir, one } = fixture()
  installedAs(one, "tmux")
  const run = new Runner([[["tmux", "has-session"], 1, "can't find session"]])
  expect(await service.uninstall(one, makeHost(dir, run, { which: found }))).toEqual([])
  expect(run.calls).toEqual([["tmux", "has-session", "-t", `=${fallback.session(one)}`]])
})

test("uninstalling removes another managers leftover file too", async () => {
  // `opencorp start` records "background" when launchd won't start, but the plist stays behind.
  const { dir, one } = fixture()
  installedAs(one, "background")
  const run = new Runner()
  const host = makeHost(dir, run)
  const plist = launchd.plistPath(one, host)
  fs.mkdirSync(path.dirname(plist), { recursive: true })
  fs.writeFileSync(plist, launchd.plist(one))
  await service.uninstall(one, host)
  expect(fs.existsSync(plist)).toBe(false)
  expect(run.calls[0]!.slice(0, 2)).toEqual(["launchctl", "bootout"])
})

test("uninstalling nothing runs nothing", async () => {
  const { dir, one } = fixture()
  const run = new Runner()
  expect(await service.uninstall(one, makeHost(dir, run))).toEqual([])
  expect(run.calls).toEqual([])
})

test("a pidfile naming some other process is left alone", async () => {
  const { dir, one } = fixture()
  installedAs(one, "background")
  fs.writeFileSync(path.join(one.office, "office.pid"), `${process.pid}\n`)
  expect(await service.uninstall(one, makeHost(dir, new Runner()))).toEqual([])
})

test("an office that still answers after uninstalling is an error", async () => {
  const { dir, one } = fixture()
  const error = await refusal(service.uninstall(one, makeHost(dir, new Runner(), { answers: async () => true })))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toContain("still answers")
})

/** An office that answers only after a start command ran, so its old daemon counts as stopped. */
function answersOnceStarted(run: Runner): () => Promise<boolean> {
  const starts = [
    ["launchctl", "kickstart"],
    ["systemctl", "--user"],
    ["tmux", "new-session"],
  ]
  return async () => run.calls.some((argv) => starts.some(([a, b]) => argv[0] === a && argv[1] === b))
}

test("restarting a launchd office kickstarts its agent", async () => {
  const { dir, one } = fixture()
  installedAs(one, "launchd")
  const run = new Runner()
  expect((await service.restart(one, makeHost(dir, run, { answers: answersOnceStarted(run) }))).mode).toBe("launchd")
  expect(run.calls).toEqual([["launchctl", "kickstart", `gui/501/${launchd.label(one)}`]])
})

test("restarting a systemd office starts its unit", async () => {
  const { dir, one } = fixture()
  installedAs(one, "systemd")
  const run = new Runner()
  const host = makeHost(dir, run, { platform: "linux", answers: answersOnceStarted(run) })
  expect((await service.restart(one, host)).mode).toBe("systemd")
  expect(run.calls).toEqual([["systemctl", "--user", "start", systemd.unitName(one)]])
})

test("restarting a tmux office kills a lingering session before starting a new one", async () => {
  const { dir, one } = fixture()
  installedAs(one, "tmux")
  const run = new Runner()
  // The session is there until it is killed.
  let alive = true
  const runner = {
    run: async (argv: readonly [string, ...string[]]): Promise<Completed> => {
      const done = await run.run(argv)
      if (argv[1] === "kill-session") alive = false
      if (argv[1] === "has-session" && !alive) return { code: 1, stdout: "", stderr: "can't find session" }
      return done
    },
  }
  const host = makeHost(dir, runner, { which: found, answers: answersOnceStarted(run) })
  expect((await service.restart(one, host)).mode).toBe("tmux")
  expect(run.calls.map((argv) => argv.slice(0, 2))).toEqual([
    ["tmux", "has-session"],
    ["tmux", "kill-session"],
    ["tmux", "has-session"],
    ["tmux", "new-session"],
  ])
})

test("restarting an office that wont stop is an error and starts nothing", async () => {
  const { dir, one } = fixture()
  installedAs(one, "launchd")
  const run = new Runner()
  const error = await refusal(service.restart(one, makeHost(dir, run, { answers: async () => true })))
  expect(error).toBeInstanceOf(ServiceError)
  expect(error.message).toContain("still answers")
  expect(run.calls).toEqual([])
})

/** The office as a macOS launch agent: its plist, and how it is installed, started and removed with launchctl. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { STOP_TIMEOUT_MS } from "../../src/install/fallback.ts"
import { ServiceError, launch } from "../../src/install/launch.ts"
import * as launchd from "../../src/install/launchd.ts"
import { tempDir } from "../helpers.ts"
import { Runner, makeHost, ownerLaunch } from "./helpers.ts"

const GOLDEN = path.join(import.meta.dirname, "golden")
const SERVICE = "gui/501/com.opencorp.office"
const PLUTIL = "/usr/bin/plutil"
const hasPlutil = fs.existsSync(PLUTIL)

function plistAt(home: string): string {
  return path.join(home, "Library", "LaunchAgents", "com.opencorp.office.plist")
}

test("the plist matches the golden file", () => {
  expect(launchd.plist(ownerLaunch())).toEqual(fs.readFileSync(path.join(GOLDEN, "launchd.plist")))
})

test("the plist gives the daemon longer to stop than the office waits", () => {
  const match = /<key>ExitTimeOut<\/key>\n\t<integer>(\d+)<\/integer>/.exec(launchd.plist(ownerLaunch()).toString("utf8"))
  expect(match).not.toBeNull()
  expect(Number(match![1]) * 1000).toBeGreaterThan(STOP_TIMEOUT_MS)
})

test.skipIf(!hasPlutil)("the golden plist is one launchd accepts", () => {
  execFileSync(PLUTIL, ["-lint", path.join(GOLDEN, "launchd.plist")], { stdio: "pipe" })
})

test("xml special characters and newlines survive the plist", () => {
  const odd = launch("/Users/o <&> \"q\" 'a'\nb/.opencorp", {
    command: ["/opt/a&b<c>/bin/opencorp"],
    environ: { LANG: "<&>]]>" },
    userHome: "/Users/o",
  })
  const bytes = launchd.plist(odd)
  const text = bytes.toString("utf8")
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  for (const value of [...odd.argv, odd.cwd, odd.log]) expect(text).toContain(`<string>${escape(value)}</string>`)
  expect(text).toContain("<key>LANG</key>\n\t\t<string>&lt;&amp;&gt;]]&gt;</string>")
  if (!hasPlutil) return
  const file = path.join(tempDir(), "odd.plist")
  fs.writeFileSync(file, bytes)
  const back = JSON.parse(execFileSync(PLUTIL, ["-convert", "json", "-o", "-", "--", file], { encoding: "utf8" }))
  expect(back.ProgramArguments).toEqual([...odd.argv])
  expect(back.WorkingDirectory).toBe(odd.cwd)
  expect(back.EnvironmentVariables).toEqual({ LANG: "<&>]]>" })
  expect(back.StandardOutPath).toBe(odd.log)
  expect(back.StandardErrorPath).toBe(odd.log)
})

test("the program arguments are read back from the plist", () => {
  const golden = fs.readFileSync(path.join(GOLDEN, "launchd.plist"), "utf8")
  const argv = ["/opt/opencorp/bin/opencorp", "daemon", "--home", "/Users/owner/.opencorp"]
  expect(launchd.programArguments(golden)).toEqual(argv)
  const odd = launch("/Users/o <&> \"q\" 'a'\nb/$x/.opencorp", {
    command: ["/opt/a&amp;b<c>/bin/opencorp", "", "--flag=1 2"],
    environ: { LANG: "<&>" },
    userHome: "/Users/o",
  })
  expect(launchd.programArguments(launchd.plist(odd).toString("utf8"))).toEqual([...odd.argv])
})

test("a plist of another layout has no program arguments", () => {
  const golden = fs.readFileSync(path.join(GOLDEN, "launchd.plist"), "utf8")
  for (const text of ["", "<plist/>", golden.replace("<array>", "<array >"), golden.replace(/\t/g, "  ")]) {
    expect(launchd.programArguments(text)).toBeNull()
  }
})

test("a first install writes the plist and bootstraps it", async () => {
  const home = tempDir()
  const runner = new Runner([[["launchctl", "print"], 113, "Could not find service"]])
  await launchd.install(ownerLaunch(), makeHost(home, runner))
  const file = plistAt(home)
  expect(launchd.plist(ownerLaunch())).toEqual(fs.readFileSync(file))
  expect(runner.calls).toEqual([
    ["launchctl", "print", SERVICE],
    ["launchctl", "bootstrap", "gui/501", file],
  ])
})

test("an unchanged loaded service is only kickstarted", async () => {
  const runner = new Runner()
  const host = makeHost(tempDir(), runner)
  await launchd.install(ownerLaunch(), host)
  runner.calls.length = 0
  await launchd.install(ownerLaunch(), host)
  expect(runner.calls).toEqual([
    ["launchctl", "print", SERVICE],
    ["launchctl", "kickstart", SERVICE],
  ])
})

test("a changed plist replaces the loaded service", async () => {
  const home = tempDir()
  const file = plistAt(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "old")
  const runner = new Runner()
  await launchd.install(ownerLaunch(), makeHost(home, runner))
  expect(runner.calls).toEqual([
    ["launchctl", "print", SERVICE],
    ["launchctl", "bootout", SERVICE],
    ["launchctl", "bootstrap", "gui/501", file],
  ])
  expect(launchd.plist(ownerLaunch())).toEqual(fs.readFileSync(file))
})

test("a bootstrap that keeps failing removes the plist and says why", async () => {
  const home = tempDir()
  const runner = new Runner([
    [["launchctl", "print"], 113, ""],
    [["launchctl", "bootstrap"], 5, "Bootstrap failed: 5: Input/output error"],
  ])
  const done = launchd.install(ownerLaunch(), makeHost(home, runner))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("Input/output error")
  expect(fs.existsSync(plistAt(home))).toBe(false)
  expect(runner.calls.filter((call) => call[1] === "bootstrap")).toHaveLength(launchd.BOOTSTRAP_TRIES)
})

test("a bootstrap outside a gui login says to use terminal or tmux", async () => {
  // launchctl's own hint, to re-run as root, doesn't help: the agent needs the GUI login's session.
  const runner = new Runner([
    [["launchctl", "print"], 113, ""],
    [
      ["launchctl", "bootstrap"],
      5,
      "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n",
    ],
  ])
  const error = await launchd.install(ownerLaunch(), makeHost(tempDir(), runner)).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ServiceError)
  const message = (error as ServiceError).message
  expect(message).toContain("Input/output error")
  expect(message).not.toContain("root")
  expect(message).toContain("from Terminal in your GUI login")
  expect(message).toContain("--service tmux")
})

test("a kickstart that fails boots out and removes the plist", async () => {
  const home = tempDir()
  await launchd.install(ownerLaunch(), makeHost(home, new Runner()))
  const runner = new Runner([[["launchctl", "kickstart"], 1, "Operation not permitted"]])
  const done = launchd.install(ownerLaunch(), makeHost(home, runner))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("launchctl kickstart failed: Operation not permitted")
  expect(runner.calls.at(-1)).toEqual(["launchctl", "bootout", SERVICE])
  expect(fs.existsSync(plistAt(home))).toBe(false)
})

test("no launchctl is a service error", async () => {
  const runner = new Runner([[["launchctl"], 127, "No such file or directory: 'launchctl'"]])
  const done = launchd.install(ownerLaunch(), makeHost(tempDir(), runner))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("launchctl")
})

test("start kickstarts the loaded agent", async () => {
  const runner = new Runner()
  await launchd.start(ownerLaunch(), makeHost(tempDir(), runner))
  expect(runner.calls).toEqual([["launchctl", "kickstart", SERVICE]])
})

test("a control character in a value is a service error", async () => {
  // plistlib refuses these and rewrites CR as a newline; the plist refuses CR too, and a lone surrogate, which
  // can't be encoded.
  for (const value of ["a\u0001b", "a\rb", "a\ud800b"]) {
    const bad = launch("/Users/owner/.opencorp", {
      command: ["/opt/opencorp/bin/opencorp"],
      environ: { PATH: "/usr/bin:/bin", HOME: "/Users/owner", LANG: value },
      userHome: "/Users/owner",
    })
    expect(() => launchd.plist(bad)).toThrow(ServiceError)
    const home = tempDir()
    const runner = new Runner([[["launchctl", "print"], 113, "Could not find service"]])
    await expect(launchd.install(bad, makeHost(home, runner))).rejects.toThrow(ServiceError)
    expect(fs.existsSync(plistAt(home))).toBe(false)
    expect(runner.calls).toEqual([["launchctl", "print", SERVICE]])
  }
})

test("a plist that cant be written is a service error and only the probe ran", async () => {
  const home = tempDir()
  fs.mkdirSync(path.join(home, "Library"))
  fs.writeFileSync(path.join(home, "Library", "LaunchAgents"), "")
  const runner = new Runner([[["launchctl", "print"], 113, "Could not find service"]])
  const done = launchd.install(ownerLaunch(), makeHost(home, runner))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow(`can't write ${plistAt(home)}: Not a directory`)
  expect(runner.calls).toEqual([["launchctl", "print", SERVICE]])
})

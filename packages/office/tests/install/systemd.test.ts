/** The office as a systemd user service: its unit, and how it is installed and started with `systemctl --user`. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { type Completed, ServiceError, launch } from "../../src/install/launch.ts"
import * as systemd from "../../src/install/systemd.ts"
import { tempDir } from "../helpers.ts"
import { Runner, makeHost, ownerLaunch } from "./helpers.ts"

const GOLDEN = path.join(import.meta.dirname, "golden")
const UNIT = "opencorp-office.service"

function unitAt(home: string): string {
  return path.join(home, ".config", "systemd", "user", UNIT)
}

test("the unit matches the golden file", () => {
  expect(systemd.unit(ownerLaunch())).toBe(fs.readFileSync(path.join(GOLDEN, "systemd.service"), "utf8"))
})

test("spaces percents and dollars reach the daemon unchanged", () => {
  const odd = launch("/Users/o w/100%/$HOME/.opencorp", {
    command: ["/opt/a c/bin/opencorp"],
    environ: { LANG: 'say "hi"' },
    userHome: "/Users/o w",
  })
  const text = systemd.unit(odd)
  expect(text).toContain('ExecStart="/opt/a c/bin/opencorp" daemon --home "/Users/o w/100%%/$$HOME/.opencorp"\n')
  expect(text).toContain('Environment="LANG=say \\"hi\\""\n')
  expect(text).toContain("WorkingDirectory=/Users/o w/100%%/$HOME/.opencorp/office\n")
})

test("the exec start words are read back from the unit", () => {
  const golden = fs.readFileSync(path.join(GOLDEN, "systemd.service"), "utf8")
  const argv = ["/opt/opencorp/bin/opencorp", "daemon", "--home", "/Users/owner/.opencorp"]
  expect(systemd.execStart(golden)).toEqual(argv)
  const odd = launch("/Users/o w/100%/$HOME/a\"b\\c;d'e/.opencorp", {
    command: ["/opt/a c/bin/opencorp", "", "$$", "%%", "x\ty"],
    environ: {},
    userHome: "/Users/o w",
  })
  expect(systemd.execStart(systemd.unit(odd))).toEqual([...odd.argv])
})

test("a unit without a readable exec start has no words", () => {
  const golden = fs.readFileSync(path.join(GOLDEN, "systemd.service"), "utf8")
  expect(systemd.execStart(golden.replace(/^ExecStart=.*\n/m, ""))).toBeNull()
  expect(systemd.execStart(golden.replace(/^ExecStart=.*$/m, 'ExecStart="/opt/a b daemon'))).toBeNull()
  expect(systemd.execStart(golden.replace(/^ExecStart=.*$/m, 'ExecStart="/opt/a"b daemon'))).toBeNull()
})

test("a newline in a value is refused", () => {
  const odd = launch("/tmp/a\nb", { command: ["/opt/a/bin/opencorp"], environ: {}, userHome: "/home/o" })
  expect(() => systemd.unit(odd)).toThrow(RangeError)
  expect(() => systemd.unit(odd)).toThrow("newline")
})

test("installing a path with a newline is a service error and writes nothing", async () => {
  const home = tempDir()
  const odd = launch("/tmp/a\nb", { command: ["/opt/a/bin/opencorp"], environ: {}, userHome: "/home/o" })
  const runner = new Runner()
  const done = systemd.install(odd, makeHost(home, runner, { platform: "linux" }))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("newline")
  expect(runner.calls).toEqual([])
  expect(fs.existsSync(path.join(home, ".config"))).toBe(false)
})

test("a first install writes enables and starts the unit", async () => {
  const home = tempDir()
  const runner = new Runner()
  await systemd.install(ownerLaunch(), makeHost(home, runner, { platform: "linux" }))
  expect(fs.readFileSync(unitAt(home), "utf8")).toBe(systemd.unit(ownerLaunch()))
  expect(runner.calls).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", UNIT],
    ["systemctl", "--user", "restart", UNIT],
  ])
})

test("an unchanged unit is only started", async () => {
  const runner = new Runner()
  const host = makeHost(tempDir(), runner, { platform: "linux" })
  await systemd.install(ownerLaunch(), host)
  runner.calls.length = 0
  await systemd.install(ownerLaunch(), host)
  expect(runner.calls).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", UNIT],
    ["systemctl", "--user", "start", UNIT],
  ])
})

test("no user bus removes the unit and says why", async () => {
  const home = tempDir()
  const runner = new Runner([[["systemctl", "--user", "daemon-reload"], 1, "Failed to connect to bus: No medium found"]])
  const done = systemd.install(ownerLaunch(), makeHost(home, runner, { platform: "linux" }))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("Failed to connect to bus")
  expect(fs.existsSync(unitAt(home))).toBe(false)
})

test("a failed start removes the unit and its wants link", async () => {
  const home = tempDir()
  const user = path.dirname(unitAt(home))
  const wants = path.join(user, "default.target.wants", UNIT)
  const enableThenFail = async (argv: readonly [string, ...string[]]): Promise<Completed> => {
    if (argv[2] === "enable") {
      fs.mkdirSync(path.dirname(wants), { recursive: true })
      fs.symlinkSync(path.join(user, UNIT), wants)
    }
    return { code: argv[2] === "restart" ? 1 : 0, stdout: "", stderr: "Job failed" }
  }
  const done = systemd.install(ownerLaunch(), makeHost(home, { run: enableThenFail }, { platform: "linux" }))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("restart")
  expect(fs.existsSync(unitAt(home))).toBe(false)
  expect(() => fs.lstatSync(wants)).toThrow()
})

test("start starts the unit", async () => {
  const runner = new Runner([[["systemctl"], 1, "Unit is masked"]])
  const done = systemd.start(ownerLaunch(), makeHost(tempDir(), runner, { platform: "linux" }))
  await expect(done).rejects.toThrow(ServiceError)
  await expect(done).rejects.toThrow("Unit is masked")
  expect(runner.calls).toEqual([["systemctl", "--user", "start", UNIT]])
})

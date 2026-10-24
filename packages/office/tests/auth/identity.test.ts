/** The device identity file onboarding writes and `opencorp` reads. */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { expect, onTestFinished, test } from "bun:test"
import { Device } from "@opencorp/protocol"
import { Identity, deviceName, identityPath, readIdentity, writeIdentity } from "../../src/auth/identity.ts"
import { newToken } from "../../src/auth/tokens.ts"
import { tempDir } from "../helpers.ts"

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777
}

/** Makes a 0600 FIFO at `p`, with a bounded writer that frees a blocked open after 3 s and exits by itself. */
function fifo(p: string): void {
  execFileSync("mkfifo", [p])
  fs.chmodSync(p, 0o600)
  // A read-write open of a FIFO never blocks, yet counts as a writer for a reader blocked in
  // `open`; so a regression that drops O_NONBLOCK fails the timing check instead of hanging.
  const child = spawn("sh", ["-c", 'sleep 3; : <> "$0"', p], { detached: true, stdio: "ignore" })
  onTestFinished(() => {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
  })
}

test.each([
  ["Ngocs-MacBook-Pro.local", "ngocs-macbook-pro"],
  ["box", "box"],
  ["--Odd Host!", "odd-host-"],
  ["", "device"],
  ["___", "device"],
  ["x".repeat(80) + ".lan", "x".repeat(63)],
])("a device name is the sanitized short hostname [%s]", (host, name) => {
  expect(deviceName(host)).toBe(name)
  Device.parse({ name, token_sha256: "0".repeat(64) }) // the schema takes it
})

test("the identity file is private and reads back", async () => {
  const me = new Identity("ngocbh", "mac", newToken())
  const file = identityPath(tempDir())
  await writeIdentity(file, me)
  expect(mode(file)).toBe(0o600)
  expect(fs.readFileSync(file, "utf8")).toBe(
    `{\n  "handle": "ngocbh",\n  "device": "mac",\n  "token": "${me.token}"\n}\n`,
  )
  expect(await readIdentity(file)).toEqual(me)
  expect(inspect(me)).not.toContain(me.token)
  expect(JSON.stringify(me)).not.toContain(me.token)
  expect(me.headers()).toEqual({ Authorization: `Bearer ${me.token}` })
})

test("a missing or broken file is no identity", async () => {
  const file = identityPath(tempDir())
  expect(await readIdentity(file)).toBeUndefined()
  fs.writeFileSync(file, "{", { mode: 0o600 })
  expect(await readIdentity(file)).toBeUndefined()
})

test("writing an identity makes its folder 0700", async () => {
  const home = path.join(tempDir(), "home")
  await writeIdentity(identityPath(home), new Identity("ngocbh", "mac", newToken()))
  expect(mode(home)).toBe(0o700)
})

const NOT_PRIVATE = [["symlink"], ["fifo"], ["wide mode"]]

test.each(NOT_PRIVATE)("an identity file that isnt private is no identity [%s]", async (kind) => {
  const tmp = tempDir()
  const file = identityPath(tmp)
  if (kind === "symlink") {
    const elsewhere = path.join(tmp, "elsewhere")
    fs.mkdirSync(elsewhere, { mode: 0o700 })
    await writeIdentity(identityPath(elsewhere), new Identity("ngocbh", "mac", newToken()))
    fs.symlinkSync(identityPath(elsewhere), file)
  } else if (kind === "fifo") {
    fifo(file)
  } else {
    await writeIdentity(file, new Identity("ngocbh", "mac", newToken()))
    fs.chmodSync(file, 0o644)
  }
  const start = performance.now()
  expect(await readIdentity(file)).toBeUndefined()
  expect(performance.now() - start).toBeLessThan(2000)
})

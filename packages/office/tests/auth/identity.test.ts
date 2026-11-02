/** The device identity file onboarding writes and `opencorp` reads. */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { expect, onTestFinished, test } from "bun:test"
import { Device } from "@opencorp/protocol"
import { FileLockError } from "@ngocbh/yian/platform"
import {
  Identity,
  IdentityUnreadable,
  deviceName,
  identityPath,
  loadIdentity,
  readIdentity,
  writeIdentity,
} from "../../src/auth/identity.ts"
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

test("a missing identity is none and takes no lock", async () => {
  const home = tempDir()
  expect(await loadIdentity(identityPath(home))).toBeUndefined()
  expect(fs.existsSync(path.join(home, ".lock"))).toBe(false)
  // A home that isn't private holds no identity either; doctor's home line says what's wrong with it.
  fs.chmodSync(home, 0o755)
  expect(await loadIdentity(identityPath(home))).toBeUndefined()
})

/** Makes `<home>/identity.json` as `kind` says; returns the file. */
async function plant(home: string, kind: string): Promise<string> {
  const file = identityPath(home)
  if (kind === "symlink") {
    const elsewhere = path.join(home, "elsewhere")
    fs.mkdirSync(elsewhere, { mode: 0o700 })
    await writeIdentity(identityPath(elsewhere), new Identity("ngocbh", "mac", newToken()))
    fs.symlinkSync(identityPath(elsewhere), file)
  } else if (kind === "fifo") {
    fifo(file)
  } else if (kind === "{") {
    fs.writeFileSync(file, "{", { mode: 0o600 })
  } else if (kind === "missing fields") {
    fs.writeFileSync(file, '{"handle": "ngocbh"}', { mode: 0o600 })
  } else {
    await writeIdentity(file, new Identity("ngocbh", "mac", newToken()))
    if (kind === "file mode 0644") fs.chmodSync(file, 0o644)
    if (kind === "home mode 0755") fs.chmodSync(home, 0o755)
    if (kind === "home mode 0000") fs.chmodSync(home, 0o000)
    if (kind === ".lock mode 0644") fs.chmodSync(path.join(home, ".lock"), 0o644) // writing the identity made it
  }
  return file
}

const UNREADABLE: [string, IdentityUnreadable["reason"], (file: string, home: string) => string[]][] = [
  ["file mode 0644", "file", (file) => [`\`chmod 600 ${file}\``]],
  ["home mode 0755", "folder", (_, home) => [`\`chmod 700 ${home}\``]],
  ["symlink", "file", (file) => [`${file} isn't a regular 0600 file of yours; remove it`, "`opencorp login`"]],
  ["fifo", "file", (file) => [`${file} isn't a regular 0600 file of yours; remove it`]],
  [".lock mode 0644", "lock", (_, home) => [`lock file ${path.join(home, ".lock")} is not private to its owner`]],
  ["{", "invalid", (file) => [`${file} isn't a valid identity; run \`opencorp login --force\``]],
  ["missing fields", "invalid", (file) => [`${file} isn't a valid identity; run \`opencorp login --force\``]],
  ["home mode 0000", "folder", (_, home) => [`\`chmod 700 ${home}\``]],
]

test.each(UNREADABLE)("an identity that can't be read says why and how to fix it [%s]", async (kind, reason, says) => {
  if (kind === "home mode 0000" && process.geteuid!() === 0) return // root reads it anyway
  const home = tempDir()
  const file = await plant(home, kind)
  try {
    const start = performance.now()
    const error = await loadIdentity(file).catch((e: unknown) => e)
    expect(performance.now() - start).toBeLessThan(2000)
    expect(error).toBeInstanceOf(IdentityUnreadable)
    expect((error as IdentityUnreadable).reason).toBe(reason)
    for (const part of says(file, home)) expect((error as Error).message).toContain(part)
    expect(await readIdentity(file)).toBeUndefined()
  } finally {
    fs.chmodSync(home, 0o700) // so the test's cleanup can remove it
  }
})

test("loadIdentity maps every read error", async () => {
  const home = tempDir()
  const file = identityPath(home)
  await writeIdentity(file, new Identity("ngocbh", "mac", newToken()))
  const lock = path.join(home, ".lock")
  const cases: [unknown, IdentityUnreadable["reason"], string][] = [
    [
      new FileLockError(lock, "busy", "is locked by another holder"),
      "lock",
      `another opencorp command holds ${lock}; wait for it, then try again`,
    ],
    [Object.assign(new Error("i/o error"), { code: "EIO" }), "other", `can't read ${file}: i/o error`],
    [Object.assign(new Error("denied"), { code: "EACCES" }), "other", `can't read ${file}: denied`],
    ["boom", "other", `can't read ${file}: boom`],
    [new Error("x"), "other", `can't read ${file}: x`],
  ]
  for (const [thrown, reason, message] of cases) {
    const error = await loadIdentity(file, async () => {
      throw thrown
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IdentityUnreadable)
    expect([(error as IdentityUnreadable).reason, (error as Error).message]).toEqual([reason, message])
  }
})

test("an unreadable identity never shows the file's bytes", async () => {
  const file = identityPath(tempDir())
  const token = newToken()
  fs.writeFileSync(file, `{"handle":"a","device":"b","token":"${token}"`, { mode: 0o600 })
  const error = await loadIdentity(file).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(IdentityUnreadable)
  expect((error as Error).message).not.toContain(token)
  expect(inspect(error)).not.toContain(token)
  expect(await readIdentity(file)).toBeUndefined()
})

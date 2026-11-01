import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEVICE_NAME,
  deviceName,
  newToken,
  readIdentity,
  tokenSha256,
  UnusableToken,
  writeIdentity,
} from "../src/identity"
import { identityPath } from "../src/paths"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aci-"))
  dirs.push(d)
  return d
}
const saved = process.env.OPENCORP_HOME
afterEach(() => {
  if (saved === undefined) delete process.env.OPENCORP_HOME
  else process.env.OPENCORP_HOME = saved
})

test("a token is act_ and 32 random bytes in base64url, and its hash is the hex sha256", () => {
  const tokens = new Set(Array.from({ length: 100 }, newToken))
  expect(tokens.size).toBe(100)
  for (const t of tokens) expect(t).toMatch(/^act_[A-Za-z0-9_-]{43}$/)
  // hashlib.sha256(b"act_x").hexdigest(), as the office computes it
  expect(tokenSha256("act_x")).toBe("ff713c1fa2780465ee119f7a038f99e00dd03d0e67f6898202368b9e7847929a")
})

test("a device name is the sanitized short hostname, as onboarding makes it", () => {
  const cases: [string, string][] = [
    ["Ngocs-MacBook-Pro.local", "ngocs-macbook-pro"],
    ["box", "box"],
    ["--Odd Host!", "odd-host-"],
    ["", "device"],
    ["___", "device"],
    ["x".repeat(80) + ".lan", "x".repeat(63)],
  ]
  for (const [host, name] of cases) {
    expect(deviceName(host)).toBe(name)
    expect(name).toMatch(DEVICE_NAME)
  }
})

test("the identity lives under OPENCORP_HOME", () => {
  process.env.OPENCORP_HOME = "/tmp/ach"
  expect(identityPath()).toBe("/tmp/ach/identity.json")
})

test("the identity file is written 0600, atomically, and reads back", () => {
  const file = path.join(tmp(), "home", "identity.json")
  const me = { handle: "ngocbh", device: "mac", token: newToken() }
  const old = process.umask(0)
  try {
    writeIdentity(file, me)
  } finally {
    process.umask(old)
  }
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  expect(readIdentity(file)).toEqual(me)
  expect(fs.readdirSync(path.dirname(file))).toEqual(["identity.json"]) // no temp file left
})

test("writing replaces a symlink rather than following it", () => {
  const dir = tmp()
  const target = path.join(dir, "elsewhere")
  fs.writeFileSync(target, "keep")
  fs.symlinkSync(target, path.join(dir, "identity.json"))
  writeIdentity(path.join(dir, "identity.json"), { handle: "a", device: "b", token: newToken() })
  expect(fs.readFileSync(target, "utf8")).toBe("keep")
  expect(fs.lstatSync(path.join(dir, "identity.json")).isSymbolicLink()).toBe(false)
})

test("a file others can read loads with a warning that never shows the token", () => {
  const file = path.join(tmp(), "identity.json")
  const me = { handle: "ngocbh", device: "mac", token: newToken() }
  writeIdentity(file, me)
  fs.chmodSync(file, 0o644)
  const warned: string[] = []
  expect(readIdentity(file, (m) => warned.push(m))).toEqual(me)
  expect(warned).toEqual([`warning: ${file} is readable by others (mode 644); run \`chmod 600 ${file}\``])
  fs.chmodSync(file, 0o600)
  expect(readIdentity(file, (m) => warned.push(m))).toEqual(me)
  expect(warned.length).toBe(1)
})

test("no file is no identity; a broken one says to log in again without echoing it", () => {
  const dir = tmp()
  expect(readIdentity(path.join(dir, "identity.json"))).toBeUndefined()
  const token = newToken()
  fs.writeFileSync(path.join(dir, "identity.json"), `{"token": "${token}"`, { mode: 0o600 })
  expect(() => readIdentity(path.join(dir, "identity.json"))).toThrow("run `opencorp login --force`")
  try {
    readIdentity(path.join(dir, "identity.json"))
  } catch (e) {
    expect(String(e)).not.toContain(token)
  }
})

test("a token a header can't carry is UnusableToken, naming the file, the handle and the device but not the token", () => {
  const file = path.join(tmp(), "identity.json")
  for (const token of ["act_a\r\nb", "act_abc ", "act_é"]) {
    fs.writeFileSync(file, JSON.stringify({ handle: "ngocbh", device: "mac", token }), { mode: 0o600 })
    let e: unknown
    try {
      readIdentity(file)
    } catch (error) {
      e = error
    }
    expect(e).toBeInstanceOf(UnusableToken)
    const u = e as UnusableToken
    expect([u.handle, u.device]).toEqual(["ngocbh", "mac"])
    expect(u.message).toBe(`${file} holds a token that can't be sent; run \`opencorp login --force\``)
    expect(Bun.inspect(u)).not.toContain(token)
  }
})

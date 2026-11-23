import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { opencorpHome, defaultSocket, homeDir, socketProblem } from "../src/paths"

// A home folder that is never the real one; the helpers only name paths under it.
const HOME = "/tmp/och-user"

test("the socket lives under OPENCORP_HOME, defaulting to ~/.opencorp", () => {
  expect(defaultSocket({ HOME, OPENCORP_HOME: "/tmp/ach" })).toBe("/tmp/ach/office/office.sock")
  expect(defaultSocket({ HOME })).toBe(`${HOME}/.opencorp/office/office.sock`)
})

test("an empty OPENCORP_HOME means the default, and a leading ~/ is the home directory", () => {
  expect(opencorpHome({ HOME, OPENCORP_HOME: "" })).toBe(`${HOME}/.opencorp`)
  expect(opencorpHome({ HOME, OPENCORP_HOME: "~/offices/acme" })).toBe(`${HOME}/offices/acme`)
  expect(opencorpHome({ HOME, OPENCORP_HOME: "~" })).toBe(HOME)
})

test("the home folder is the env's HOME, or the account's when it is unset or empty", () => {
  expect(homeDir({ HOME })).toBe(HOME)
  expect(homeDir({})).toBe(os.homedir())
  expect(homeDir({ HOME: "" })).toBe(os.homedir())
})

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((f) => f()))

/** A unix socket at `file` with a server on it; resolves to a function that closes the server. */
async function listening(file: string) {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(file, resolve))
  cleanups.unshift(() => server.close())
  return () => new Promise<void>((resolve) => server.close(() => resolve()))
}

test("socketProblem: nothing for no socket; else why a socket there can't be reached", async () => {
  const dir = fs.mkdtempSync("/tmp/ocp-")
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  expect(socketProblem(path.join(dir, "missing.sock"))).toBeUndefined()
  const plain = path.join(dir, "plain")
  fs.writeFileSync(plain, "")
  expect(socketProblem(path.join(plain, "o.sock"))).toBeUndefined() // ENOTDIR
  expect(socketProblem(plain)).toBe(`${plain} isn't a socket`)
  const stale = path.join(dir, "stale.sock")
  const close = await listening(stale)
  fs.renameSync(stale, `${stale}.x`)
  await close()
  fs.renameSync(`${stale}.x`, stale)
  expect(socketProblem(stale)).toBe(`nothing answers on ${stale}; the office may have stopped or crashed`)
})

test("socketProblem: a socket, or its folder, this user may not use is permission denied", async () => {
  if (process.getuid?.() === 0) return // root may use either anyway
  const dir = fs.mkdtempSync("/tmp/ocp-")
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const live = path.join(dir, "live.sock")
  await listening(live)
  fs.chmodSync(live, 0)
  expect(socketProblem(live)).toBe(`permission denied on ${live}`)
  const folder = path.join(dir, "office")
  fs.mkdirSync(folder)
  const inner = path.join(folder, "o.sock")
  await listening(inner)
  fs.chmodSync(folder, 0)
  cleanups.unshift(() => fs.chmodSync(folder, 0o700))
  expect(socketProblem(inner)).toBe(`permission denied on ${inner}`)
})

test("socketProblem: EPERM (a sandbox or an ACL) is permission denied too", async () => {
  const dir = fs.mkdtempSync("/tmp/ocp-")
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const live = path.join(dir, "live.sock")
  await listening(live)
  const eperm = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
  }
  const access = spyOn(fs, "accessSync").mockImplementation(eperm)
  try {
    expect(socketProblem(live)).toBe(`permission denied on ${live}`)
  } finally {
    access.mockRestore()
  }
  const stat = spyOn(fs, "statSync").mockImplementation(eperm)
  try {
    expect(socketProblem(live)).toBe(`permission denied on ${live}`)
  } finally {
    stat.mockRestore()
  }
})

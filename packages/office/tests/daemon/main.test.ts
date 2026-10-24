/** The daemon process: a 0600 socket, one daemon per home, clean shutdown. */
import fs from "node:fs"
import path from "node:path"
import { isLocked } from "@ngocbh/yian/platform"
import { expect, setDefaultTimeout, test } from "bun:test"
import { AlreadyRunning, PidFile } from "../../src/daemon/main.ts"
import { OfficeStartError } from "../../src/daemon/sockets.ts"
import { tempDir } from "../helpers.ts"

setDefaultTimeout(60_000)

/** A pidfile and lock file in a fresh temp dir. */
function paths(): { dir: string; pid: string; lock: string } {
  const dir = tempDir()
  return { dir, pid: path.join(dir, "office.pid"), lock: path.join(dir, "office.lock") }
}

test("second pidfile lock is refused", async () => {
  const { pid, lock } = paths()
  const first = new PidFile(pid, lock)
  await first.acquire()
  const error = await new PidFile(pid, lock).acquire().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(AlreadyRunning)
  expect((error as AlreadyRunning).pid).toBe(process.pid)
  first.release()
  const again = new PidFile(pid, lock)
  await again.acquire()
  again.release()
})

test("a symlinked pidfile is refused and its target untouched", async () => {
  const { dir, pid, lock } = paths()
  const victim = path.join(dir, "victim.txt")
  fs.writeFileSync(victim, "precious\n")
  fs.symlinkSync(victim, pid)
  const error = await new PidFile(pid, lock).acquire().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OfficeStartError)
  expect((error as Error).message).toMatch(/symlink/)
  expect(fs.readFileSync(victim, "utf8")).toBe("precious\n")
  expect(isLocked(lock)).toBe(false)
})

test("release removes the pidfile and frees the lock", async () => {
  const { pid, lock } = paths()
  const file = new PidFile(pid, lock)
  await file.acquire()
  expect(fs.readFileSync(pid, "utf8")).toBe(`${process.pid}\n`)
  expect(fs.statSync(pid).mode & 0o777).toBe(0o600)
  file.release()
  expect(fs.existsSync(pid)).toBe(false)
  expect(isLocked(lock)).toBe(false)
  file.release()
})

test("a pidfile left by a dead office is taken over", async () => {
  const { pid, lock } = paths()
  fs.writeFileSync(pid, "99999999\n", { mode: 0o600 })
  const file = new PidFile(pid, lock)
  await file.acquire()
  expect(fs.readFileSync(pid, "utf8")).toBe(`${process.pid}\n`)
  file.release()
})

test("a lock file that is not private is refused", async () => {
  const { pid, lock } = paths()
  fs.writeFileSync(lock, "")
  fs.chmodSync(lock, 0o644)
  const error = await new PidFile(pid, lock).acquire().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OfficeStartError)
  expect(error).not.toBeInstanceOf(AlreadyRunning)
  expect((error as Error).message).toContain(lock)
  expect(fs.existsSync(pid)).toBe(false)
})

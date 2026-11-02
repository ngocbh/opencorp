/** Office file reads that never follow a link or block on a FIFO, and the atomic service-file write. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { readRegular, tailRegular, writeIfChanged } from "../../src/install/files.ts"
import { fifo, tempDir } from "../helpers.ts"

/** The `.tmp` names in `dir`. */
function temps(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))
}

test("a new file is written with its folders and mode 0644", () => {
  const file = path.join(tempDir(), "a", "b", "svc.plist")
  expect(writeIfChanged(file, "hello\n")).toBe(true)
  expect(fs.readFileSync(file, "utf8")).toBe("hello\n")
  const mode = fs.statSync(file).mode & 0o777
  expect(mode & 0o022).toBe(0)
  expect(mode & 0o600).toBe(0o600)
  expect(temps(path.dirname(file))).toEqual([])
})

test("unchanged bytes leave the file alone and report false", () => {
  const file = path.join(tempDir(), "svc.service")
  writeIfChanged(file, new TextEncoder().encode("same"))
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(file, old, old)
  const before = fs.statSync(file)
  expect(writeIfChanged(file, "same")).toBe(false)
  const after = fs.statSync(file)
  expect(after.ino).toBe(before.ino)
  expect(after.mtimeMs).toBe(before.mtimeMs)
})

test("changed bytes replace the file whole and report true", () => {
  const file = path.join(tempDir(), "svc.service")
  writeIfChanged(file, "old")
  const before = fs.statSync(file)
  expect(writeIfChanged(file, "new")).toBe(true)
  expect(fs.readFileSync(file, "utf8")).toBe("new")
  expect(fs.statSync(file).ino).not.toBe(before.ino)
})

test("a planted temp path is never followed", () => {
  const dir = tempDir()
  const victim = path.join(dir, "victim")
  fs.writeFileSync(victim, "keep")
  const file = path.join(dir, "svc.plist")
  const planted = path.join(dir, `.svc.plist.${process.pid}.tmp`)
  fs.symlinkSync(victim, planted)
  expect(() => writeIfChanged(file, "evil")).toThrow(expect.objectContaining({ code: "EEXIST" }))
  expect(fs.readFileSync(victim, "utf8")).toBe("keep")
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true)
})

test.skipIf(process.getuid?.() === 0)("an unwritable folder throws and leaves no temp file", () => {
  const dir = path.join(tempDir(), "units")
  const file = path.join(dir, "svc.service")
  writeIfChanged(file, "old")
  fs.chmodSync(dir, 0o500)
  try {
    expect(() => writeIfChanged(file, "new")).toThrow(expect.objectContaining({ code: "EACCES" }))
    expect(fs.readFileSync(file, "utf8")).toBe("old")
    expect(temps(dir)).toEqual([])
  } finally {
    fs.chmodSync(dir, 0o700)
  }
})

test("writeIfChanged replaces a FIFO without blocking", () => {
  const file = path.join(tempDir(), "install.json")
  fifo(file)
  const began = performance.now()
  expect(writeIfChanged(file, "new")).toBe(true)
  expect(performance.now() - began).toBeLessThan(2000)
  expect(fs.lstatSync(file).isFile()).toBe(true)
  expect(fs.readFileSync(file, "utf8")).toBe("new")
})

test("writeIfChanged replaces a symlink even when its target holds the same bytes", () => {
  const dir = tempDir()
  const victim = path.join(dir, "victim")
  fs.writeFileSync(victim, "same")
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(victim, old, old)
  const before = fs.statSync(victim)
  const file = path.join(dir, "svc.plist")
  fs.symlinkSync(victim, file)
  expect(writeIfChanged(file, "same")).toBe(true)
  expect(fs.lstatSync(file).isFile()).toBe(true)
  expect(fs.readFileSync(victim, "utf8")).toBe("same")
  expect(fs.statSync(victim).mtimeMs).toBe(before.mtimeMs)
})

test("readRegular reads only a regular file within its cap", () => {
  const dir = tempDir()
  const file = path.join(dir, "f")
  fs.writeFileSync(file, "hello")
  expect(readRegular(file, 5)?.toString("utf8")).toBe("hello")
  expect(readRegular(file, 4)).toBeNull()
  expect(readRegular(path.join(dir, "missing"), 5)).toBeNull()
  const link = path.join(dir, "link")
  fs.symlinkSync(file, link)
  expect(readRegular(link, 5)).toBeNull()
  expect(readRegular(dir, 5)).toBeNull()
  const pipe = path.join(dir, "pipe")
  fifo(pipe)
  const began = performance.now()
  expect(readRegular(pipe, 5)).toBeNull()
  expect(performance.now() - began).toBeLessThan(2000)
})

test.skipIf(process.getuid?.() === 0)("readRegular throws for a file it may not read", () => {
  const file = path.join(tempDir(), "f")
  fs.writeFileSync(file, "x", { mode: 0o000 })
  expect(() => readRegular(file, 5)).toThrow(expect.objectContaining({ code: "EACCES" }))
})

test("tailRegular gives the end of a regular file from its first whole line", () => {
  const dir = tempDir()
  const file = path.join(dir, "log")
  fs.writeFileSync(file, "one\ntwo\nthree\n")
  expect(tailRegular(file, 100)).toBe("one\ntwo\nthree\n")
  expect(tailRegular(file, 8)).toBe("three\n")
  fs.writeFileSync(file, `${"x".repeat(50)}\n`)
  expect(tailRegular(file, 10)).toBe("")
  const link = path.join(dir, "link")
  fs.symlinkSync(file, link)
  expect(tailRegular(link, 100)).toBeNull()
  const pipe = path.join(dir, "pipe")
  fifo(pipe)
  const began = performance.now()
  expect(tailRegular(pipe, 100)).toBeNull()
  expect(performance.now() - began).toBeLessThan(2000)
})

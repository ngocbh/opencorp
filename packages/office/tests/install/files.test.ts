/** writeIfChanged: the atomic service-file write. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { writeIfChanged } from "../../src/install/files.ts"
import { tempDir } from "../helpers.ts"

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

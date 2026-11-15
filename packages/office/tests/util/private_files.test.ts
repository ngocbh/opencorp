/** Private files: 0700 folders and 0600 files, written atomically, read under their folder's lock. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { lockFile } from "@ngocbh/yian/platform"
import { PrivateFileError, readPrivate, writePrivate } from "../../src/util/private_files.ts"
import { fifo, tempDir } from "../helpers.ts"

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777
}

/** Checks that nobody holds `<dir>/.lock`: a failed call must not leave it held. */
function expectUnlocked(dir: string): void {
  lockFile(path.join(dir, ".lock"), { private: true }).release()
}

/** `st` with `uid` replaced. */
function withUid<T extends object>(st: T, uid: number): T {
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid })
}

test("read private refuses a fifo without waiting for a writer", async () => {
  const p = path.join(tempDir(), "fifo")
  fifo(p)
  const start = performance.now()
  const error = await readPrivate(p).catch((e: unknown) => e)
  // A blocked open would take about 3 s, until the bounded writer frees it.
  expect(performance.now() - start).toBeLessThan(2_000)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/must be a regular file/)
})

test("write private makes a 0600 file and replaces a symlink without following it", async () => {
  const tmp = tempDir()
  const file = path.join(tmp, "f.json")
  await writePrivate(file, '{"a":1}')
  expect(fs.readFileSync(file, "utf8")).toBe('{"a":1}')
  expect(mode(file)).toBe(0o600)
  const target = path.join(tmp, "target")
  const link = path.join(tmp, "link")
  fs.writeFileSync(target, "keep")
  fs.symlinkSync(target, link)
  await writePrivate(link, "new")
  expect(fs.lstatSync(link).isFile()).toBe(true)
  expect(mode(link)).toBe(0o600)
  expect(fs.readFileSync(link, "utf8")).toBe("new")
  expect(fs.readFileSync(target, "utf8")).toBe("keep")
  expect(fs.readdirSync(tmp).sort()).toEqual([".lock", "f.json", "link", "target"])
})

test("read private returns the bytes of a private file", async () => {
  const tmp = tempDir()
  const bytes = Buffer.from([0, 1, 2, 0xff, 0x7b])
  for (const [name, fileMode] of [["rw", 0o600], ["ro", 0o400]] as const) {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, bytes)
    fs.chmodSync(file, fileMode)
    const read = await readPrivate(file)
    expect(Buffer.isBuffer(read)).toBe(true)
    expect(read).toEqual(bytes)
  }
})

test("read private refuses a symlink, a directory, a file open to others and a file of another user", async () => {
  const tmp = tempDir()
  const target = path.join(tmp, "target")
  fs.writeFileSync(target, "private-bytes")
  fs.chmodSync(target, 0o600)
  fs.symlinkSync(target, path.join(tmp, "link"))
  const symlinked = await readPrivate(path.join(tmp, "link")).catch((e: unknown) => e)
  expect(symlinked).toBeInstanceOf(PrivateFileError)
  expect((symlinked as Error).message).toMatch(/is a symlink, not a regular file/)
  expect((symlinked as Error).message).not.toContain("private-bytes")

  fs.mkdirSync(path.join(tmp, "dir"))
  const open = path.join(tmp, "open")
  fs.writeFileSync(open, "readable-bytes")
  fs.chmodSync(open, 0o644)
  for (const name of ["dir", "open"]) {
    const error = await readPrivate(path.join(tmp, name)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateFileError)
    expect((error as Error).message).toMatch(/must be a regular file private to its owner/)
    expect((error as Error).message).not.toContain("readable-bytes")
  }
  expectUnlocked(tmp)

  const real = fs.fstatSync
  const spy = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const st = real(fd)
    return st.isFile() ? withUid(st, st.uid + 1) : st
  }) as typeof fs.fstatSync)
  onTestFinished(() => spy.mockRestore())
  const theirs = await readPrivate(target).catch((e: unknown) => e)
  expect(theirs).toBeInstanceOf(PrivateFileError)
  expect((theirs as Error).message).toMatch(/must be a regular file private to its owner/)
  expect((theirs as Error).message).not.toContain("private-bytes")
})

test("write private fsyncs the temp file before renaming it", async () => {
  const tmp = tempDir()
  const calls: string[] = []
  const realFsync = fs.fsyncSync
  const realRename = fs.renameSync
  const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
    calls.push("fsync")
    realFsync(fd)
  })
  const renameSpy = spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
    calls.push("rename")
    realRename(from, to)
  })
  onTestFinished(() => {
    fsyncSpy.mockRestore()
    renameSpy.mockRestore()
  })
  await writePrivate(path.join(tmp, "f"), "x")
  expect(calls).toEqual(["fsync", "rename"])
})

test("read private of a missing file is an enoent error", async () => {
  const error = await readPrivate(path.join(tempDir(), "missing")).catch((e: unknown) => e)
  expect(error).not.toBeInstanceOf(PrivateFileError)
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
})

const NOT_PRIVATE_FOLDERS = [
  ["writePrivate, symlink", (file: string) => writePrivate(file, "x"), "symlink"],
  ["readPrivate, symlink", (file: string) => readPrivate(file), "symlink"],
  ["writePrivate, 0755", (file: string) => writePrivate(file, "x"), "0755"],
  ["readPrivate, 0755", (file: string) => readPrivate(file), "0755"],
] as const

test.each(NOT_PRIVATE_FOLDERS)("the private file calls refuse a folder that is not private [%s]", async (_shown, call, kind) => {
  const tmp = tempDir()
  const real = path.join(tmp, "real")
  fs.mkdirSync(real, { mode: 0o700 })
  let folder = real
  if (kind === "symlink") {
    folder = path.join(tmp, "link")
    fs.symlinkSync(real, folder)
  } else {
    fs.chmodSync(real, 0o755)
  }
  // A `/.` tail would make lstat follow the symlink.
  const files = kind === "symlink" ? [path.join(folder, "f"), `${folder}/./f`] : [path.join(folder, "f")]
  for (const file of files) {
    const error = await call(file).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateFileError)
    expect((error as Error).message).toMatch(kind === "symlink" ? /symlink/ : /0700/)
  }
  expect(fs.readdirSync(real)).toEqual([])
})

test("the private file calls refuse a folder of another user", async () => {
  const folder = path.join(tempDir(), "p")
  fs.mkdirSync(folder, { mode: 0o700 })
  const real = fs.lstatSync
  const spy = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, options?: fs.StatSyncOptions) => {
    const st = real(p, options)
    return p === folder && st ? withUid(st, Number(st.uid) + 1) : st
  }) as typeof fs.lstatSync)
  onTestFinished(() => spy.mockRestore())
  const file = path.join(folder, "f")
  for (const call of [() => writePrivate(file, "x"), () => readPrivate(file)]) {
    const error = await call().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateFileError)
    expect((error as Error).message).toMatch(/belongs to another user/)
  }
  expect(fs.readdirSync(folder)).toEqual([])
})

test("the private file calls refuse the folders lock file", async () => {
  const tmp = tempDir()
  // macOS's default file system ignores case, so these all name `.lock` there; U+212A is KELVIN SIGN.
  for (const name of [".lock", ".LOCK", ".loc\u212A"]) {
    const file = path.join(tmp, name)
    for (const call of [() => writePrivate(file, "junk-junk"), () => readPrivate(file)]) {
      const error = await call().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PrivateFileError)
      expect((error as Error).message).toMatch(/lock file/)
    }
  }
  // Nothing was written and the lock was never taken; a wrongly written `.LOCK` would show here.
  expect(fs.readdirSync(tmp)).toEqual([])
  expectUnlocked(tmp)
})

const LOCKED_CALLS = [
  ["writePrivate", (dir: string) => writePrivate(path.join(dir, "f"), "y")],
  ["readPrivate", (dir: string) => readPrivate(path.join(dir, "f"))],
] as const

test.each(LOCKED_CALLS)("every call waits for the folders lock [%s]", async (_shown, call) => {
  const dir = tempDir()
  await writePrivate(path.join(dir, "f"), "x")
  const lock = lockFile(path.join(dir, ".lock"), { private: true })
  let settled = false
  const pending = call(dir).finally(() => {
    settled = true
  })
  // Marks the rejection handled, so a failed expectation below doesn't leave it unhandled; `await pending`
  // still throws it.
  pending.catch(() => {})
  try {
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(settled).toBe(false)
  } finally {
    lock.release()
  }
  await pending
  expect(settled).toBe(true)
})

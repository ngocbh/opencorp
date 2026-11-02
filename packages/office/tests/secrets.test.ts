/** The office secret store: one 0600 file per secret in a 0700 directory, under the folder's lock. */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { FileLockError, lockFile } from "@ngocbh/yian/platform"
import {
  InvalidSecretError,
  NAME,
  PrivateFileError,
  SecretNotSetError,
  SecretStore,
  readPrivate,
  writePrivate,
} from "../src/secrets.ts"
import { tempDir } from "./helpers.ts"

const KEY = "-----BEGIN KEY-----\nabc\n"

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777
}

/** A store at `<tempDir>/s` holding `token` = `first-value` (Python's `stored` fixture). */
async function stored(): Promise<{ tmp: string; root: string; store: SecretStore }> {
  const tmp = tempDir()
  const root = path.join(tmp, "s")
  const store = new SecretStore(root)
  await store.set("token", "first-value")
  return { tmp, root, store }
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

/** Checks that nobody holds `<dir>/.lock`: a failed call must not leave it held. */
function expectUnlocked(dir: string): void {
  lockFile(path.join(dir, ".lock"), { private: true }).release()
}

/** `st` with `uid` replaced. */
function withUid<T extends object>(st: T, uid: number): T {
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid })
}

test("set and get round trip with private modes", async () => {
  const root = path.join(tempDir(), "office", "secrets")
  const store = new SecretStore(root)
  await store.set("cluster_a_ssh_key", KEY)
  expect(await store.get("cluster_a_ssh_key")).toBe(KEY)
  expect(mode(root)).toBe(0o700)
  expect(mode(path.join(root, "cluster_a_ssh_key"))).toBe(0o600)
})

test("set replaces and keeps the mode", async () => {
  const root = path.join(tempDir(), "s")
  const store = new SecretStore(root)
  await store.set("token", "first-value")
  await store.set("token", "second-value")
  expect(await store.get("token")).toBe("second-value")
  expect(mode(path.join(root, "token"))).toBe(0o600)
  expect(fs.readdirSync(root).sort()).toEqual([".lock", "token"])
})

test("a missing secret is a key error naming it", async () => {
  const error = await new SecretStore(path.join(tempDir(), "s")).get("token").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(SecretNotSetError)
  expect((error as Error).message).toContain("token")
})

test("delete removes the secret", async () => {
  const root = path.join(tempDir(), "s")
  const store = new SecretStore(root)
  await store.set("token", "first-value")
  await store.delete("token")
  expect(fs.readdirSync(root)).toEqual([".lock"])
  for (const call of [() => store.get("token"), () => store.delete("token")]) {
    const error = await call().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SecretNotSetError)
    expect((error as Error).message).toContain("token")
  }
})

test.each(["", "../x", "a/b", ".hidden", "x".repeat(129), "sp ace", "Token", "TOKEN"])("bad names are refused [%p]", async (name) => {
  const store = new SecretStore(path.join(tempDir(), "s"))
  for (const call of [() => store.set(name, "long-enough"), () => store.get(name), () => store.delete(name)]) {
    const error = await call().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidSecretError)
    expect((error as Error).message).toMatch(/secret name/)
    // A name swapped with its value would put a secret in the message; parts of short names occur in the pattern.
    if (name.length >= 3 && !NAME.source.includes(name)) expect((error as Error).message).not.toContain(name)
  }
})

test.each(["", "short", "1234567", "  abc   \n"])("short values are refused without being shown [%p]", async (value) => {
  // Results are scrubbed of every secret value, so a short one would mangle them.
  const root = path.join(tempDir(), "s")
  const error = await new SecretStore(root).set("token", value).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(InvalidSecretError)
  expect((error as Error).message).toMatch(/at least 8 characters/)
  if (value.trim()) expect((error as Error).message).not.toContain(value.trim())
  expect(fs.existsSync(path.join(root, "token"))).toBe(false)
  // A swapped call whose value looks like a valid name must not show it either.
  const swapped = await new SecretStore(root).set("abcdef0123456789abcdef", "token").catch((e: unknown) => e)
  expect(swapped).toBeInstanceOf(InvalidSecretError)
  expect((swapped as Error).message).not.toContain("abcdef0123456789abcdef")
})

test("eight characters are enough", async () => {
  const store = new SecretStore(path.join(tempDir(), "s"))
  await store.set("token", "12345678")
  expect(await store.get("token")).toBe("12345678")
})

test("values never show in repr", async () => {
  const root = path.join(tempDir(), "s")
  const store = new SecretStore(root)
  await store.set("token", "hunter2-hunter2")
  for (const shown of [util.inspect(store), JSON.stringify(store)]) {
    expect(shown).not.toContain("hunter2")
    expect(shown).toContain(root)
  }
})

test("get refuses a symlinked secret file", async () => {
  const { tmp, root, store } = await stored()
  fs.writeFileSync(path.join(tmp, "outside"), "not-a-secret-value")
  fs.symlinkSync(path.join(tmp, "outside"), path.join(root, "link"))
  const error = await store.get("link").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/'link'/)
})

const LOOSE_FILE_MODES = [0o644, 0o640, 0o400, 0o700].map((m) => [m.toString(8), m] as const)

test.each(LOOSE_FILE_MODES)("get refuses a secret file without mode 0600 [%s]", async (_shown, loose) => {
  const { root, store } = await stored()
  fs.chmodSync(path.join(root, "token"), loose)
  const error = await store.get("token").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/'token' must be mode 0600/)
  expectUnlocked(root)
})

test("an unreadable secret file says so", async () => {
  const { root, store } = await stored()
  fs.chmodSync(path.join(root, "token"), 0)
  const error = await store.get("token").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/'token' is not readable/)
  expectUnlocked(root)
})

test("get refuses a secret file of another user", async () => {
  const { store } = await stored()
  const real = fs.fstatSync
  const spy = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const st = real(fd)
    return st.isFile() ? withUid(st, st.uid + 1) : st
  }) as typeof fs.fstatSync)
  onTestFinished(() => spy.mockRestore())
  const error = await store.get("token").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/'token' belongs to another user/)
})

test("get refuses a value too short to scrub", async () => {
  const { root, store } = await stored()
  fs.writeFileSync(path.join(root, "short"), "abc\n", { mode: 0o600 })
  fs.chmodSync(path.join(root, "short"), 0o600)
  const error = await store.get("short").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/'short' is shorter than 8 characters/)
  expect((error as Error).message).not.toContain("abc")
})

test("concurrent sets on a fresh store all succeed", async () => {
  const root = path.join(tempDir(), "s")
  const store = new SecretStore(root)
  const names = Array.from({ length: 8 }, (_, i) => `token${i}`)
  const results = await Promise.allSettled(names.map((name, i) => store.set(name, `value-number-${i}`)))
  expect(results.filter((r) => r.status === "rejected")).toEqual([])
  expect(fs.readdirSync(root).sort()).toEqual([".lock", ...names].sort())
})

const ODD_FILES = [
  ["mkdir", (p: string) => fs.mkdirSync(p)],
  ["fifo", fifo],
] as const

test.each(ODD_FILES)("get refuses anything but a regular file [%s]", async (_kind, make) => {
  const { root, store } = await stored()
  make(path.join(root, "odd"))
  const start = performance.now()
  const error = await store.get("odd").catch((e: unknown) => e)
  // A blocked open in the fifo case would take about 3 s, until the bounded writer frees it.
  expect(performance.now() - start).toBeLessThan(2_000)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/'odd'/)
})

test("a symlinked root is refused and its target left alone", async () => {
  const tmp = tempDir()
  const target = path.join(tmp, "shared")
  fs.mkdirSync(target, { mode: 0o700 })
  fs.symlinkSync(target, path.join(tmp, "s"))
  const store = new SecretStore(path.join(tmp, "s"))
  fs.chmodSync(target, 0o755)
  for (const call of [() => store.set("token", "first-value"), () => store.get("token"), () => store.delete("token")]) {
    const error = await call().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateFileError)
    expect((error as Error).message).toMatch(/symlink/)
  }
  // A trailing `/` or `/.` would make lstat follow the symlink.
  for (const tail of ["/", "/."]) {
    const error = await new SecretStore(path.join(tmp, "s") + tail).set("token", "first-value").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateFileError)
    expect((error as Error).message).toMatch(/symlink/)
  }
  expect(mode(target)).toBe(0o755)
  expect(fs.readdirSync(target)).toEqual([])
})

const LOOSE_ROOT_MODES = [0o755, 0o750, 0o701].map((m) => [m.toString(8), m] as const)

test.each(LOOSE_ROOT_MODES)("a loose root is refused [%s]", async (_shown, loose) => {
  const { root, store } = await stored()
  fs.chmodSync(root, loose)
  for (const call of [() => store.set("token", "second-value"), () => store.get("token"), () => store.delete("token")]) {
    const error = await call().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateFileError)
    expect((error as Error).message).toMatch(/0700/)
  }
  expect(mode(root)).toBe(loose)
  fs.chmodSync(root, 0o700)
  expect(await store.get("token")).toBe("first-value")
})

test("a root that is a file is refused", async () => {
  const root = path.join(tempDir(), "s")
  fs.writeFileSync(root, "x")
  const error = await new SecretStore(root).set("token", "first-value").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PrivateFileError)
  expect((error as Error).message).toMatch(/directory/)
  // A root under a file fails its lstat with ENOTDIR.
  const nested = await new SecretStore(path.join(root, "inner")).get("token").catch((e: unknown) => e)
  expect(nested).toBeInstanceOf(PrivateFileError)
  expect((nested as Error).message).toMatch(/directory/)
})

test("get from a missing root is a key error", async () => {
  const tmp = tempDir()
  const error = await new SecretStore(path.join(tmp, "missing")).get("token").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(SecretNotSetError)
  expect((error as Error).message).toContain("token")
  expect(fs.readdirSync(tmp)).toEqual([])
})

test("a lock file open to others is refused", async () => {
  const { root, store } = await stored()
  fs.chmodSync(path.join(root, ".lock"), 0o644)
  const error = await store.get("token").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(FileLockError)
  expect((error as Error).message).not.toContain("first-value")
})

test("a folder of another user is refused", async () => {
  const tmp = tempDir()
  const root = path.join(tmp, "s")
  const folder = path.join(tmp, "p")
  fs.mkdirSync(root, { mode: 0o700 })
  fs.mkdirSync(folder, { mode: 0o700 })
  const store = new SecretStore(root)
  const real = fs.lstatSync
  const spy = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, options?: fs.StatSyncOptions) => {
    const st = real(p, options)
    return (p === root || p === folder) && st ? withUid(st, Number(st.uid) + 1) : st
  }) as typeof fs.lstatSync)
  onTestFinished(() => spy.mockRestore())
  const file = path.join(folder, "f")
  for (const call of [() => store.get("token"), () => writePrivate(file, "x"), () => readPrivate(file)]) {
    const error = await call().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrivateFileError)
    expect((error as Error).message).toMatch(/belongs to another user/)
  }
  expect(fs.readdirSync(root)).toEqual([])
  expect(fs.readdirSync(folder)).toEqual([])
})

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

test("set and write private fsync the temp file before renaming it", async () => {
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
  await new SecretStore(path.join(tmp, "s")).set("token", "first-value")
  await writePrivate(path.join(tmp, "f"), "x")
  expect(calls).toEqual(["fsync", "rename", "fsync", "rename"])
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
  ["set", (store: SecretStore) => store.set("token", "second-value")],
  ["get", (store: SecretStore) => store.get("token")],
  ["delete", (store: SecretStore) => store.delete("token")],
  ["writePrivate", (store: SecretStore) => writePrivate(path.join(store.root, "f"), "y")],
  ["readPrivate", (store: SecretStore) => readPrivate(path.join(store.root, "f"))],
] as const

test.each(LOCKED_CALLS)("every call waits for the folders lock [%s]", async (_shown, call) => {
  const { root, store } = await stored()
  await writePrivate(path.join(root, "f"), "x")
  const lock = lockFile(path.join(root, ".lock"), { private: true })
  let settled = false
  const pending = call(store).finally(() => {
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

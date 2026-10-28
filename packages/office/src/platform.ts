/**
 * Every Bun-specific call of the office, in one file: moving to Node rewrites this file, plus the few
 * Bun-only behaviours elsewhere that no lint can see (unix-socket fetch, file imports). The office
 * spawns its own code only through `selfCommand()`, with `selfSpawnEnv()` and an office-controlled cwd,
 * and through `helperCommand()`, which runs the `__fs-helper` in the sandbox.
 */
import { dlopen, FFIType, read, type Pointer } from "bun:ffi"
import fs from "node:fs"
import os from "node:os"
import { Readable } from "node:stream"
import type { ReadableStream } from "node:stream/web"
import { fileURLToPath } from "node:url"
import type { Helper } from "./sandbox/policy.ts"

/** The Bun flags that stop a checkout's Bun from reading the cwd's `.env` and `bunfig.toml`
 *  (and its preloads) or installing a missing package; `packages/cli/bin/opencorp` passes the
 *  same ones. */
const CHECKOUT_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

/** The argv prefix that runs the office's own code: the binary itself when compiled (built with
 *  `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`), else this Bun with
 *  `CHECKOUT_FLAGS` on the CLI's entry. */
export function selfCommand(): [string, ...string[]] {
  if (Bun.isStandaloneExecutable) return [process.execPath]
  return [process.execPath, ...CHECKOUT_FLAGS, fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url))]
}

/** How to run the `__fs-helper`, and the files its profile exposes: the compiled binary in its helper
 *  mode, or (checkout) this Bun with the no-autoload flags running `sandbox/fs_helper.ts` as its entry. */
export function helperCommand(): { argv: [string, ...string[]]; helper: Helper } {
  // Resolved paths, as the sandbox profile names them.
  const bin = fs.realpathSync(process.execPath)
  if (Bun.isStandaloneExecutable) return { argv: [bin, "__fs-helper"], helper: { binary: bin } }
  const entry = fs.realpathSync(fileURLToPath(new URL("./sandbox/fs_helper.ts", import.meta.url)))
  return { argv: [bin, ...CHECKOUT_FLAGS, entry], helper: { bun: bin, entry } }
}

const UNSAFE_ENV = /^(BUN_|LD_|DYLD_)|^NODE_(OPTIONS|PATH|PRESERVE_SYMLINKS(_MAIN)?)$/

/** Whether `name` changes how Bun, Node or the loader start, or is one a spawn can't pass as given (empty, or
 *  holding `=` or NUL); a self-spawn's env never carries one. */
export function unsafeEnvName(name: string): boolean {
  return name === "" || name.includes("=") || name.includes("\0") || UNSAFE_ENV.test(name)
}

/** `env` without the names `unsafeEnvName` flags, and without unset values: the last filter on
 *  every self-spawn's env. */
export function selfSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !unsafeEnvName(name)) kept[name] = value
  }
  return kept
}

/** The cwd of a self-spawn with no folder of its own: the real path of the user's home dir,
 *  never the caller's cwd (a project folder). */
export function selfSpawnCwd(): string {
  return fs.realpathSync(os.homedir())
}

/** Replaces this process (same pid) with `argv`, run in `cwd` with exactly `env`. Doesn't return; if the exec
 *  fails it throws, already in `cwd`. */
export function reexec(argv: [string, ...string[]], env: Record<string, string>, cwd: string): never {
  if (!process.execve) throw Object.assign(new Error("this runtime has no process.execve"), { code: "ENOSYS" })
  process.chdir(cwd)
  return process.execve(argv[0], argv, env)
}

/** The file a `node:worker_threads` worker named `name` starts from, in both layouts. */
export function threadEntry(name: "runs_indexer"): URL {
  // A compiled binary's bundle has `import.meta.url` `file:///$bunfs/root/<outfile>`, with no `.js`,
  // so "not `.ts`" is the compiled check.
  return import.meta.url.endsWith(".ts")
    ? new URL(`../../cli/src/${name}.ts`, import.meta.url) // checkout: the shim on disk
    : new URL(`./${name}.js`, import.meta.url) // compiled: beside the main bundle
}

/** The bytes of a file embedded with `import file from "…" with { type: "file" }`: `file` is the
 *  path that import gave (on disk in a checkout, under `/$bunfs/` in the binary). */
export function embedded(file: string): Buffer {
  return fs.readFileSync(file)
}

// O_CLOEXEC on Linux: the same value on x64 and arm64 (asm-generic).
const O_CLOEXEC = 0o2000000
let linuxLibc: { pipe2: (fds: Int32Array, flags: number) => number } | undefined

/** A new pipe as `[readFd, writeFd]`, both close-on-exec (libc's `pipe2`; musl's loader maps `libc.so.6` to
 *  itself). Linux only: there the runtime's `"pipe"` stdio is a socketpair, and opening `/dev/stdout` or
 *  `/dev/fd/N` on a socket fails with ENXIO. */
export function pipe(): [number, number] {
  // pipe2 isn't variadic: one call form on every arch.
  linuxLibc ??= dlopen("libc.so.6", { pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 } }).symbols
  const fds = new Int32Array(2)
  if (linuxLibc.pipe2(fds, O_CLOEXEC) !== 0) throw new Error("pipe2 failed (out of file descriptors?)")
  return [fds[0]!, fds[1]!]
}

/** A stream of what arrives on pipe `fd`, read through the runtime's event loop, not the fs thread pool (where
 *  each pending read on a blocking pipe holds one of its threads, one per core). Owns `fd`: closes it once the
 *  stream closes (end, destroy or error). */
export function pipeReadable(fd: number): Readable {
  // Through unknown: the packages that also typecheck this file (the app, the CLI) give the runtime's stream the
  // DOM's type, which doesn't overlap Node's web-stream type.
  const stream = Readable.fromWeb(Bun.file(fd).stream() as unknown as ReadableStream<Uint8Array>)
  // The runtime's stream never closes the fd itself.
  stream.once("close", () => fs.closeSync(fd))
  return stream
}

/** Writes `data` to pipe `fd` through the runtime's event loop, not the fs thread pool, ends it and closes `fd`.
 *  May reject with the write's error (EPIPE when the reader is gone). */
export async function endPipe(fd: number, data: string | Buffer): Promise<void> {
  try {
    const sink = Bun.file(fd).writer()
    sink.write(data)
    await sink.end()
  } finally {
    // The runtime's sink never closes the fd itself.
    fs.closeSync(fd)
  }
}

const SANDBOX_FILTER_NONE = 0
const SANDBOX_FILTER_PATH = 1

/** `sandbox_check` in this arch's call form, and the path filter type to pass it. */
type Sandbox = {
  check: (pid: number, operation: Buffer | null, filter: number, path: Buffer | null) => number
  pathFilter: number
}
let sandbox: Sandbox | undefined

/** Opens libsystem_sandbox once and declares `sandbox_check` in this arch's call form. */
function loadSandbox(): Sandbox {
  if (sandbox) return sandbox
  const lib = "/usr/lib/system/libsystem_sandbox.dylib"
  const { ptr: P, i32: I, i64: L } = FFIType
  // int sandbox_check(pid_t, const char *operation, int filter_type, ...): the path is variadic.
  // darwin-arm64 puts variadic arguments on the stack, so five dummies fill the registers x3..x7
  // first; x64 passes the path as a plain 4th argument. The wrong form gives wrong answers.
  let check: Sandbox["check"]
  if (process.arch === "arm64") {
    const { symbols } = dlopen(lib, { sandbox_check: { args: [I, P, I, L, L, L, L, L, P], returns: I } })
    check = (pid, operation, filter, path) =>
      symbols.sandbox_check(pid, operation, filter, 0n, 0n, 0n, 0n, 0n, path)
  } else if (process.arch === "x64") {
    const { symbols } = dlopen(lib, { sandbox_check: { args: [I, P, I, P], returns: I } })
    check = (pid, operation, filter, path) => symbols.sandbox_check(pid, operation, filter, path)
  } else {
    throw new Error(`sandbox_check has no call form for ${process.arch}`)
  }
  const libc = dlopen("/usr/lib/libSystem.B.dylib", { dlsym: { args: [P, P], returns: P } })
  // RTLD_DEFAULT: search every loaded image.
  const found = libc.symbols.dlsym(-2 as unknown as Pointer, cString("SANDBOX_CHECK_NO_REPORT"))
  // Keeps the denied checks out of the system log.
  const noReport = found ? read.i32(found, 0) : 0
  sandbox = { check, pathFilter: SANDBOX_FILTER_PATH | noReport }
  return sandbox
}

/** `text` as a NUL-terminated C string. */
function cString(text: string): Buffer {
  return Buffer.from(`${text}\0`)
}

/** libsystem_sandbox's `sandbox_check`: 0 allowed, 1 denied, -1 error. With `operation` and `path`:
 *  whether `pid` may do `operation` on `path` (path filter, SANDBOX_CHECK_NO_REPORT OR-ed in so the
 *  query isn't logged). With `operation` null: whether `pid` is sandboxed (filter none, as Python). */
export function sandboxCheck(pid: number, operation: null): number
export function sandboxCheck(pid: number, operation: string, path: string): number
export function sandboxCheck(pid: number, operation: string | null, path?: string): number {
  const { check, pathFilter } = loadSandbox()
  if (operation === null) return check(pid, null, SANDBOX_FILTER_NONE, null)
  return check(pid, cString(operation), pathFilter, cString(path!))
}

/** libproc's `proc_listallpids`, `proc_listpgrppids` and `proc_pidinfo`, as declared through bun:ffi. */
type LibProc = {
  proc_listallpids: (buffer: Int32Array | null, bytes: number) => number
  proc_listpgrppids: (pgid: number, buffer: Int32Array | null, bytes: number) => number
  proc_pidinfo: (pid: number, flavor: number, arg: bigint, buffer: Uint8Array, bytes: number) => number
}
let libProc: LibProc | undefined

/** Opens libproc on first use, so importing this file works where there is no libproc. */
function loadLibProc(): LibProc {
  const { ptr: P, i32: I, u64: U } = FFIType
  libProc ??= dlopen("/usr/lib/libproc.dylib", {
    proc_listallpids: { args: [P, I], returns: I },
    proc_listpgrppids: { args: [I, P, I], returns: I },
    proc_pidinfo: { args: [I, I, U, P, I], returns: I },
  }).symbols
  return libProc
}

/** Every pid on the machine (libproc `proc_listallpids`). */
export function listAllPids(): number[] {
  const lib = loadLibProc()
  // The size argument is in bytes, the result a count; the slack covers pids born in between.
  const count = lib.proc_listallpids(null, 0)
  if (count < 0) throw new Error("proc_listallpids failed")
  const pids = new Int32Array(count + 64)
  const got = lib.proc_listallpids(pids, pids.byteLength)
  if (got < 0) throw new Error("proc_listallpids failed")
  return Array.from(pids.subarray(0, got))
}

const PROC_PIDTBSDINFO = 3
// struct proc_bsdinfo: pbi_pid (u32) at 12, pbi_start_tvsec (u64) at 120, pbi_start_tvusec (u64) at 128,
// 136 bytes in all; the same layout and call form on arm64 and x86_64.
const BSDINFO_SIZE = 136

/** The start time of `pid` in seconds since the epoch (µs resolution), from libproc's
 *  `proc_pidinfo(PROC_PIDTBSDINFO)`, zombies included; null when it can't be read: no such process, another
 *  user's process, or an id outside 2..2^31 − 1. macOS only. */
export function procStartTime(pid: number): number | null {
  // The office-wide pid guard: never 0 or 1 (process.kill would hit our own group or every process),
  // never a value i32 would wrap.
  if (!Number.isInteger(pid) || pid < 2 || pid > 0x7fffffff) return null
  const info = new Uint8Array(BSDINFO_SIZE)
  // A non-zero `arg` makes xnu look among zombies too, so an exited but unreaped child still reads.
  const size = loadLibProc().proc_pidinfo(pid, PROC_PIDTBSDINFO, 1n, info, BSDINFO_SIZE)
  if (size !== BSDINFO_SIZE) return null
  const view = new DataView(info.buffer)
  if (view.getUint32(12, true) !== pid) return null
  return Number(view.getBigUint64(120, true)) + Number(view.getBigUint64(128, true)) / 1e6
}

const PROC_PIDT_SHORTBSDINFO = 13
// struct proc_bsdshortinfo: pbsi_pid at 0, pbsi_pgid at 8, pbsi_status at 12, pbsi_ruid at 44, pbsi_svuid at 52
// (all u32), 64 bytes in all; the same layout on arm64 and x86_64.
const SHORTINFO_SIZE = 64
// pbsi_status of a zombie.
const SZOMB = 5

/** The members of process group `pgid` (libproc `proc_listpgrppids`) that aren't zombies yet and that the office
 *  may signal; empty when the listing fails or `pgid` is outside 2..2^31 − 1. Each member's
 *  `proc_pidinfo(PROC_PIDT_SHORTBSDINFO)` leaves out zombies and another user's processes (by the kernel's rule:
 *  neither its real nor its saved uid is the office's real or effective uid, unless the office is root). A member
 *  still exiting counts, since one that was forking when it was killed finishes that fork first. A member that
 *  can't be read counts too: that read needs no privilege, so it fails only for a process in flux (being created
 *  or exec'ing) or one gone since the listing. macOS only. */
export function liveGroupMembers(pgid: number): number[] {
  if (!Number.isInteger(pgid) || pgid < 2 || pgid > 0x7fffffff) return []
  const lib = loadLibProc()
  // As in listAllPids: bytes in, a count out; with no buffer the count is an upper bound.
  const count = lib.proc_listpgrppids(pgid, null, 0)
  if (count <= 0) return []
  const pids = new Int32Array(count + 64)
  const got = lib.proc_listpgrppids(pgid, pids, pids.byteLength)
  if (got <= 0) return []
  const uids = [process.getuid!(), process.geteuid!()]
  const root = uids[1] === 0
  const info = new Uint8Array(SHORTINFO_SIZE)
  const view = new DataView(info.buffer)
  return Array.from(pids.subarray(0, got)).filter((pid) => {
    // A non-zero `arg` makes xnu look among zombies too, so an unreaped one reads as a zombie.
    const size = lib.proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 1n, info, SHORTINFO_SIZE)
    if (size !== SHORTINFO_SIZE || view.getUint32(0, true) !== pid) return true
    return (
      view.getUint32(8, true) === pgid &&
      view.getUint32(12, true) !== SZOMB &&
      (root || uids.includes(view.getUint32(44, true)) || uids.includes(view.getUint32(52, true)))
    )
  })
}

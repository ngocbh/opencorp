/**
 * Every Bun-specific call of the office, in one file: moving to Node rewrites this file, plus the few
 * Bun-only behaviours elsewhere that no lint can see (unix-socket fetch, file imports). The office
 * spawns its own code only through `selfCommand()`, with `selfSpawnEnv()` and an office-controlled cwd,
 * and through `helperCommand()`, which runs the `__fs-helper` in the sandbox.
 */
import { dlopen, FFIType, read, type Pointer } from "bun:ffi"
import fs from "node:fs"
import os from "node:os"
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

/** Whether `name` changes how Bun, Node or the loader start; a self-spawn's env never carries one. */
export function unsafeEnvName(name: string): boolean {
  return UNSAFE_ENV.test(name)
}

/** `env` without the names that change how the runtime or loader starts, and without unset
 *  values: the last filter on every self-spawn's env. */
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
  if (!process.execve) throw new Error("this runtime has no process.execve")
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

/** libproc's `proc_listallpids`, opened once. */
let procListAllPids: ((buffer: Int32Array | null, bytes: number) => number) | undefined

/** Every pid on the machine (libproc `proc_listallpids`). */
export function listAllPids(): number[] {
  procListAllPids ??= dlopen("/usr/lib/libproc.dylib", {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  }).symbols.proc_listallpids
  // The size argument is in bytes, the result a count; the slack covers pids born in between.
  const count = procListAllPids(null, 0)
  if (count < 0) throw new Error("proc_listallpids failed")
  const pids = new Int32Array(count + 64)
  const got = procListAllPids(pids, pids.byteLength)
  if (got < 0) throw new Error("proc_listallpids failed")
  return Array.from(pids.subarray(0, got))
}

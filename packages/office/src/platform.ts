/**
 * Every Bun-specific call of the office, in one file: moving to Node rewrites this file, plus the few
 * Bun-only behaviours elsewhere that no lint can see (unix-socket fetch, file imports). The office
 * spawns its own code only through `selfCommand()`, with `selfSpawnEnv()` and an office-controlled cwd.
 */
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath } from "node:url"

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

/** Names a self-spawn's env never carries: they change how Bun, Node or the loader start. */
const UNSAFE_ENV = /^(BUN_|LD_|DYLD_)|^NODE_(OPTIONS|PATH)$/

/** `env` without the names that change how the runtime or loader starts, and without unset
 *  values: the last filter on every self-spawn's env. */
export function selfSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !UNSAFE_ENV.test(name)) kept[name] = value
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

// Running the Python side of `opencorp`, and checking that the office is up. Onboarding, the doctor,
// and starting the office live in `python -m opencorp.install`, run with this checkout's venv;
// it reads the home from $OPENCORP_HOME, which it inherits, or from a `--home` flag passed
// through. `opencorp` never starts the office on its own: the service `opencorp init` or `opencorp onboard` installed does.
import { createOfficeClient } from "@opencorp/client"
import { readIdentity, type Identity, defaultSocket, identityPath } from "@opencorp/client/node"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The checkout `opencorp` runs from; the office runs from the same one. */
export const REPO = path.resolve(import.meta.dir, "../../..")

/** What running the Python side touches; tests pass fakes. */
export interface Deps {
  exists(file: string): boolean
  which(command: string): string | null
  /** Runs `argv` with this terminal's stdin, stdout and stderr; resolves to its exit code. */
  spawn(argv: string[], cwd?: string): Promise<number>
  error(message: string): void
}

export const realDeps: Deps = {
  exists: (file) => fs.existsSync(file),
  which: (command) => Bun.which(command),
  spawn: async (argv, cwd) => {
    // Bun.spawn's default is the environment bun started with; changes made since (the doctor's OPENCORP_BUN) count.
    const proc = Bun.spawn(argv, { cwd, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    return await proc.exited
  },
  error: (message) => console.error(message),
}

/** The python in the checkout's venv, which `uv sync` makes. */
export function venvPython(repo = REPO) {
  return path.join(repo, ".venv", "bin", "python")
}

/**
 * Runs `python -m opencorp.install <command> ...args` from the venv and resolves to its exit
 * code; without a venv, says to run `opencorp onboard` and resolves to 1. It runs in the caller's
 * folder, so a relative `--home` or $OPENCORP_HOME means the same as it does to the TUI.
 */
export async function runInstall(command: string, args: string[], deps: Deps = realDeps): Promise<number> {
  const python = venvPython()
  if (!deps.exists(python)) {
    deps.error(`opencorp: no Python environment at ${path.dirname(path.dirname(python))}; run \`opencorp onboard\``)
    return 1
  }
  return deps.spawn([python, "-m", "opencorp.install", command, ...args])
}

/**
 * Syncs the checkout's venv with uv (on PATH or in ~/.local/bin) and resolves to uv's exit code; without uv, says
 * so for `opencorp <command>` and resolves to 1.
 */
export async function syncVenv(command: string, deps: Deps = realDeps): Promise<number> {
  const uv = deps.which("uv") ?? [path.join(os.homedir(), ".local", "bin", "uv")].find((p) => deps.exists(p))
  if (!uv) {
    deps.error(`opencorp ${command}: uv not found; install it (https://docs.astral.sh/uv/) and run \`opencorp ${command}\` again`)
    return 1
  }
  // Quiet keeps uv's progress lines out of the install's prompts; its errors still show.
  return deps.spawn([uv, "sync", "--frozen", "--quiet"], REPO)
}

/**
 * Syncs the checkout's venv, then runs `runInstall(command, args)`; the venv is what runs it, so it must exist and
 * match the checkout first.
 */
export async function syncThenInstall(command: string, args: string[], deps: Deps = realDeps): Promise<number> {
  const synced = await syncVenv(command, deps)
  if (synced !== 0) return synced
  return runInstall(command, args, deps)
}

/** Exit code when no office answers, as `python -m opencorp.install start` exits with no office yet. */
export const NO_OFFICE = 3

/** Says the office isn't running; returns `NO_OFFICE`. */
export function officeNotRunning(): number {
  console.error("The office isn't running. Run `opencorp doctor`.")
  return NO_OFFICE
}

/**
 * This device's identity, or undefined without one. A file it can't use is reported on stderr
 * and treated as none: the office then says whether it needs a token.
 */
export function localIdentity(): Identity | undefined {
  const warn = (message: string) => console.error(`opencorp: ${message}`)
  try {
    return readIdentity(identityPath(), warn)
  } catch (e) {
    warn(e instanceof Error ? e.message : String(e))
    return undefined
  }
}

/** A client for the office on the default socket that sends the token of `me` (this device's identity). */
export function officeClient(me = localIdentity()) {
  return createOfficeClient({ socket: defaultSocket(), token: me?.token })
}

/** Whether an office answers `GET /health`, which needs no token, on the unix socket `socket` within 2 s. */
export async function officeAnswers(socket: string): Promise<boolean> {
  try {
    const res = await fetch("http://office/health", { unix: socket, signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

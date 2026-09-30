// Running the Python side of `ac`, and checking that the office is up. Onboarding, the doctor,
// and starting the office live in `python -m agent_corp.install`, run with this checkout's venv;
// it reads the home from $AGENT_CORP_HOME, which it inherits, or from a `--home` flag passed
// through. `ac` never starts the office on its own: the service `ac onboard` installed does.
import fs from "node:fs"
import path from "node:path"

/** The checkout `ac` runs from; the office runs from the same one. */
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
    const proc = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    return await proc.exited
  },
  error: (message) => console.error(message),
}

/** The python in the checkout's venv, which `uv sync` makes. */
export function venvPython(repo = REPO) {
  return path.join(repo, ".venv", "bin", "python")
}

/**
 * Runs `python -m agent_corp.install <command> ...args` from the venv and resolves to its exit
 * code; without a venv, says to run `ac onboard` and resolves to 1. It runs in the caller's
 * folder, so a relative `--home` or $AGENT_CORP_HOME means the same as it does to the TUI.
 */
export async function runInstall(command: string, args: string[], deps: Deps = realDeps): Promise<number> {
  const python = venvPython()
  if (!deps.exists(python)) {
    deps.error(`ac: no Python environment at ${path.dirname(path.dirname(python))}; run \`ac onboard\``)
    return 1
  }
  return deps.spawn([python, "-m", "agent_corp.install", command, ...args])
}

/** Exit code when no office answers, as `python -m agent_corp.install start` exits with no office yet. */
export const NO_OFFICE = 3

/** Says the office isn't running; returns `NO_OFFICE`. */
export function officeNotRunning(): number {
  console.error("The office isn't running. Run `ac doctor`.")
  return NO_OFFICE
}

/** Whether an office answers `GET /people` on the unix socket `socket` within 2 s. */
export async function officeAnswers(socket: string): Promise<boolean> {
  try {
    const res = await fetch("http://office/people", { unix: socket, signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

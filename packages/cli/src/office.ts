// Running the setup commands, and checking that the office is up. Onboarding, the doctor, and starting the office
// live in the office's `opencorp install` entry, in this same binary; it runs in the home dir with the setup env
// (this env without the names that change how Bun starts). `opencorp` never starts the office on its own: the
// service `opencorp init` or `opencorp onboard` installed does.
import { createOfficeClient } from "@opencorp/client"
import { readIdentity, type Identity, defaultSocket, identityPath } from "@opencorp/client/node"
import { selfCommand, selfSpawnCwd, selfSpawnEnv } from "@opencorp/office/platform"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** What running the install touches; tests pass fakes. */
export interface Deps {
  /** Runs `argv` in `cwd` with exactly `env` and this terminal's stdin, stdout and stderr; resolves to its exit
   *  code (128 + the signal's number for one a signal ended). Meanwhile it passes SIGTERM and SIGHUP on to it,
   *  and the first SIGINT after INTERRUPT_GRACE_MS (later ones aren't passed on, so a targeted repeat SIGINT never
   *  reaches the install's rule that a repeat Ctrl-C exits at once; a terminal's repeat Ctrl-C still does). */
  spawn(argv: string[], options: { cwd: string; env: Record<string, string> }): Promise<number>
  /** The folder the install runs in (`selfSpawnCwd`); throws when the home folder doesn't exist. */
  spawnCwd(): string
}

/** How long a SIGINT waits before it is passed on to a running install. */
export const INTERRUPT_GRACE_MS = 2000

export const realDeps: Deps = {
  spawn: async (argv, { cwd, env }) => {
    const proc = Bun.spawn(argv, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    const forward = (signal: NodeJS.Signals) => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal)
    }
    let grace: ReturnType<typeof setTimeout> | undefined
    const onTerm = () => forward("SIGTERM")
    const onHup = () => forward("SIGHUP")
    // A terminal's Ctrl-C already reaches the install through the foreground group, and a second one at once would
    // hit its rule that a repeat Ctrl-C exits without draining. Waiting still passes on a SIGINT sent to this
    // process alone, without doubling the terminal's.
    const onInt = () => {
      grace ??= setTimeout(() => forward("SIGINT"), INTERRUPT_GRACE_MS)
    }
    process.on("SIGTERM", onTerm)
    process.on("SIGHUP", onHup)
    process.on("SIGINT", onInt)
    try {
      return await proc.exited
    } finally {
      process.off("SIGTERM", onTerm)
      process.off("SIGHUP", onHup)
      process.off("SIGINT", onInt)
      clearTimeout(grace)
    }
  },
  spawnCwd: selfSpawnCwd,
}

/** How to run one install command: its argv, env and folder. */
export interface InstallSpec {
  argv: string[]
  env: Record<string, string>
  cwd: string
}

/** `value` resolved against the caller's folder when it is a relative path; else unchanged: empty, absolute,
 *  `~` or `~/…` (which the install expands), or when the folder can't be read. */
function absolute(value: string, cwd: () => string): string {
  if (value === "" || value === "~" || value.startsWith("~/") || path.isAbsolute(value)) return value
  try {
    return path.resolve(cwd(), value)
  } catch {
    // Bun's process.cwd() throws from a deleted folder.
    return value
  }
}

/** `value` resolved against the caller's folder when it names an existing local folder by a relative path; a URL,
 *  an scp-style `host:path` or a `~` path is unchanged. */
function localFrom(value: string, cwd: () => string): string {
  if (value.includes("://") || /^[^/]*:/.test(value) || value.startsWith("~")) return value
  const resolved = absolute(value, cwd)
  return resolved !== value && fs.existsSync(resolved) ? resolved : value
}

/**
 * `args` with each `--home` (and, for onboard, `--from`) value that is a relative path made absolute against the
 * caller's folder, which `cwd` reads only when one is: the install runs in the home dir, so a relative path typed
 * here must keep naming the folder it was typed in.
 */
function absoluteArgs(command: string, args: string[], cwd: () => string): string[] {
  const fixes: Record<string, (value: string, cwd: () => string) => string> = { "--home": absolute }
  if (command === "onboard") fixes["--from"] = localFrom
  const out = [...args]
  for (let i = 0; i < out.length; i++) {
    const arg = out[i]!
    const eq = arg.indexOf("=")
    const flag = eq < 0 ? arg : arg.slice(0, eq)
    const fix = fixes[flag]
    if (!fix) continue
    if (eq >= 0) out[i] = `${flag}=${fix(arg.slice(eq + 1), cwd)}`
    // A separate value that looks like a flag (`--home -x`) the install's parser rejects as a usage error; `-` is a
    // value.
    else if (i + 1 < out.length && !/^-./.test(out[i + 1]!)) out[i + 1] = fix(out[++i]!, cwd)
  }
  return out
}

/**
 * How to run `opencorp install <command> ...args` in this binary: relative `--home`, `--from` (onboard) and
 * `$OPENCORP_HOME` made absolute against `cwd`, the env `environ` without the names that change how Bun starts,
 * and `home` (by default the home dir, which throws when it doesn't exist) as its folder.
 */
export function installSpawn(
  command: string,
  args: string[],
  environ: Record<string, string | undefined> = process.env,
  cwd: () => string = () => process.cwd(),
  home: string = selfSpawnCwd(),
): InstallSpec {
  const env = { ...environ }
  if (env.OPENCORP_HOME !== undefined) env.OPENCORP_HOME = absolute(env.OPENCORP_HOME, cwd)
  return {
    argv: [...selfCommand(), "install", command, ...absoluteArgs(command, args, cwd)],
    env: selfSpawnEnv(env),
    cwd: home,
  }
}

/** `installSpawn(command, args)` in `deps.spawnCwd()`, or undefined after saying on stderr that the home folder
 *  doesn't exist. */
export function installSpec(command: string, args: string[], deps: Deps): InstallSpec | undefined {
  let home: string
  try {
    home = deps.spawnCwd()
  } catch {
    console.error(`opencorp ${command}: your home folder ${os.homedir()} doesn't exist`)
    return undefined
  }
  return installSpawn(command, args, process.env, () => process.cwd(), home)
}

/** Runs `opencorp install <command> ...args` and resolves to its exit code; 1 when the home folder doesn't exist. */
export async function install(command: string, args: string[], deps: Deps = realDeps): Promise<number> {
  const spec = installSpec(command, args, deps)
  return spec ? deps.spawn(spec.argv, { cwd: spec.cwd, env: spec.env }) : 1
}

/** `typed` without one leading `@`: a handle as people write it. */
export const bareHandle = (typed: string) => typed.replace(/^@/, "")

/** Exit code when no office answers, as the install's `start` exits with no office yet. */
export const NO_OFFICE = 3

/** Says the office isn't running; returns `NO_OFFICE`. */
export function officeNotRunning(): number {
  console.error("The office isn't running. Run `opencorp start` (or `opencorp doctor` if it won't start).")
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

/** A client for the office on the default socket; `me` is this device's identity, or undefined to send no token. */
export function officeClient(me: Identity | undefined) {
  return createOfficeClient({ socket: defaultSocket(), token: me?.token })
}

/**
 * Warns on stderr when the office on the default socket now takes a request without a token, as after removing the
 * last device any human listed. Says nothing when it refuses one or can't be asked.
 */
export async function warnIfTokenless(): Promise<void> {
  try {
    const { person, device } = await createOfficeClient({ socket: defaultSocket() }).whoami()
    if (device !== null || !person) return
    console.error(
      `opencorp: warning: no human lists a device now, so the office takes requests without a token as @${person}; ` +
        "run `opencorp login` to need tokens again",
    )
  } catch {
    // A refusal means the office still needs a token, which is what removing a device should leave.
  }
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

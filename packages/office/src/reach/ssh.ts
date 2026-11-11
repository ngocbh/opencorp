/** The SSH plumbing of reaching a remote HQ: the generated configs and the ssh wrapper, the child runner, the node
 *  master and its lifeline, mux sessions and `-O` commands, and the watcher that ends every master once this process
 *  is gone. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Writable } from "node:stream"
import { sameProcess, startTime } from "../install/proc.ts"
import { replaceFile, writePrivate } from "../secrets.ts"
import type { ReachPaths } from "./paths.ts"
import { type Spec, safePath, word } from "./spec.ts"

/** The owner's config, then the system's, which `-F` skips. `home` is the passwd entry's (`os.userInfo().homedir`),
 *  where ssh's own `~` points; only `realVisitDeps` calls this. */
export const defaultIncludes = (home: string) => [path.join(home, ".ssh", "config"), "/etc/ssh/ssh_config"]

/** `hq/ssh/config` (`config.batch` with `batch`): our options first, since ssh keeps the first value it reads, so the
 *  owner's ControlPath can't win and our `-O exit` never ends their masters. Each include is double-quoted (a home
 *  may hold a space); there's no default, so a test can't include the real `~/.ssh/config` by leaving it out. */
export function configText(cm: string, { batch = false, includes }: { batch?: boolean; includes: readonly string[] }): string {
  if (includes.some((file) => /["\n]/.test(file))) throw new Error("an included ssh config's path can't hold \" or a newline")
  return [
    "# Written by opencorp hq on each visit; edits are lost.",
    ...(batch ? ["BatchMode yes"] : []),
    "ControlMaster auto",
    `ControlPath ${cm}/%C`,
    "ControlPersist 60",
    "ServerAliveInterval 15",
    "ServerAliveCountMax 3",
    ...includes.map((file) => `Include "${file}"`),
    "",
  ].join("\n")
}

/** `hq/ssh/bin/ssh`, first on PATH for reach.sh and the shell tool: the real ssh by absolute path (so ProxyJump's hop,
 *  built from argv0 and `-F`, shares the config) with our config; each exit status is appended to $OPENCORP_SSH_STATUS,
 *  so a 255 counts where a pipeline or `|| true` hides it. */
export function wrapperText(realSsh: string): string {
  // The hop's command holds argv0 unquoted.
  if (!safePath(realSsh)) throw new Error(`ssh's path can't be used unquoted: ${realSsh}`)
  return [
    "#!/bin/sh",
    "# Written by opencorp hq on each visit.",
    `${word(realSsh)} -F "$OPENCORP_SSH_CONFIG" "$@"`,
    "status=$?",
    // Single-quoted TS strings: `${…-}` is sh, not a template.
    'if [ -n "${OPENCORP_SSH_STATUS-}" ]; then printf \'%s\\n\' "$status" >>"$OPENCORP_SSH_STATUS"; fi',
    'exit "$status"',
    "",
  ].join("\n")
}

/** Writes both configs (0600) and the wrapper (0700) for this visit. */
export async function writeSshFiles(paths: ReachPaths, realSsh: string, includes: readonly string[]): Promise<void> {
  await writePrivate(paths.config, configText(paths.cm, { includes }))
  await writePrivate(paths.batchConfig, configText(paths.cm, { batch: true, includes }))
  await writePrivate(paths.wrapper, wrapperText(realSsh))
  fs.chmodSync(paths.wrapper, 0o700)
}

/** The first executable `ssh` in an absolute entry of `pathVar` other than the folder `skip` (our wrapper's), or
 *  null. */
export function findSsh(pathVar: string | undefined, skip: string): string | null {
  const ours = realOrSelf(skip)
  for (const entry of (pathVar ?? "").split(":")) {
    if (!path.isAbsolute(entry) || realOrSelf(entry) === ours) continue
    const file = path.join(entry, "ssh")
    try {
      if (!fs.statSync(file).isFile()) continue
      fs.accessSync(file, fs.constants.X_OK)
    } catch {
      continue
    }
    return file
  }
  return null
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** A step that can prompt (Duo, a password, a host key) gets 5 minutes; one over an open master 60 s. */
export const LIMITS = Object.freeze({ promptMs: 5 * 60_000, stepMs: 60_000 })

/** What every reach step needs; `signal` is the visit's Ctrl-C. */
export interface ReachContext {
  readonly paths: ReachPaths
  /** The real ssh, by absolute path. */
  readonly ssh: string
  /** The environment the visit was started with; children get only `sshEnv`'s part of it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether to use `config.batch`, so a login that would prompt fails at once. */
  readonly batch: boolean
  /** Children's output for the owner. */
  readonly echo: (text: string) => void
  readonly signal?: AbortSignal
  readonly limits: { readonly promptMs: number; readonly stepMs: number }
}

/** The env of reach.sh, the shell tool and every ssh: our wrapper first on PATH, HOME, the agent socket, and the
 *  config and status file the wrapper reads. Nothing else of the visit's env. */
export function sshEnv(ctx: ReachContext): Record<string, string> {
  const { paths, env } = ctx
  return {
    PATH: `${paths.bin}:${env.PATH || "/usr/bin:/bin"}`,
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.SSH_AUTH_SOCK !== undefined ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}),
    OPENCORP_SSH_CONFIG: ctx.batch ? paths.batchConfig : paths.config,
    OPENCORP_SSH_STATUS: paths.status(process.pid),
  }
}

/** Empties this process's status file (0600), before a run whose ssh exits are read after. */
export function resetStatus(ctx: ReachContext): void {
  replaceFile(ctx.paths.ssh, path.basename(ctx.paths.status(process.pid)), "")
}

/** The exit statuses the wrapper recorded since `resetStatus`, in order. */
export function readStatuses(ctx: ReachContext): number[] {
  let text: string
  try {
    text = fs.readFileSync(ctx.paths.status(process.pid), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return text
    .split("\n")
    .filter((line) => /^[0-9]+$/.test(line.trim()))
    .map((line) => Number(line.trim()))
}

/** `text` without control characters other than tab and newline: output from another machine must not drive the
 *  owner's terminal. */
export const cleanOutput = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

/** A finished child: its exit code (128 + n for signal n, 127 when it couldn't start), output, and whether it was ended
 *  for its time or for the visit's stop. */
export interface Ran {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}
/** How long a child's pipes are read after it exits. */
export const DRAIN_MS = 200
/** How much of each stream a child keeps. */
export const KEEP_CHARS = 64 * 1024
/** How long a child ended with SIGTERM has before SIGKILL. */
export const KILL_GRACE_MS = 2000

/** Runs `argv` with stdin from /dev/null. It's done when it exits, plus `DRAIN_MS`: a detached ssh master's jump host
 *  can hold the pipes open for minutes (OpenSSH 8.0). It keeps the last `KEEP_CHARS` of each stream, since the
 *  spec and the error worth showing come last. */
export function runChild(
  argv: readonly [string, ...string[]],
  o: {
    env: Record<string, string>
    cwd: string
    timeoutMs: number
    signal?: AbortSignal
    echo?: (text: string) => void
    echoStdout?: boolean
  },
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let done = false
    const keep = (kept: string, more: string) => (kept + more).slice(-KEEP_CHARS)
    child.stdout!.setEncoding("utf8").on("data", (c: string) => {
      stdout = keep(stdout, c)
      if (o.echoStdout) o.echo?.(c)
    })
    child.stderr!.setEncoding("utf8").on("data", (c: string) => {
      stderr = keep(stderr, c)
      o.echo?.(c)
    })
    const stop = () => {
      timedOut = true
      if (child.pid !== undefined) killTree(child.pid)
    }
    const timer = setTimeout(stop, o.timeoutMs)
    // A signal that already fired never fires "abort" again.
    if (o.signal?.aborted) stop()
    else o.signal?.addEventListener("abort", stop, { once: true })
    const finish = (ran: Ran) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener("abort", stop)
      child.stdout!.destroy()
      child.stderr!.destroy()
      resolve(ran)
    }
    child.on("error", (e) => {
      if (child.pid === undefined) finish({ code: 127, stdout: "", stderr: e.message, timedOut: false })
    })
    child.on("exit", (code, sig) => {
      const exit = code ?? 128 + (sig ? (os.constants.signals[sig] ?? 0) : 0)
      setTimeout(() => finish({ code: exit, stdout, stderr, timedOut }), DRAIN_MS)
    })
  })
}

/** The last non-blank stderr line, cleaned, at most 300 characters. */
export function lastStderr(ran: Ran): string {
  const lines = cleanOutput(ran.stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  return (lines.at(-1) ?? "").slice(0, 300)
}

/** The processes below `pid` as `ps` lists them now, deepest first. */
export function descendants(pid: number): number[] {
  const ps = ["/bin/ps", "/usr/bin/ps"].find((file) => fs.existsSync(file))
  if (ps === undefined) return []
  let out: string
  try {
    out = execFileSync(ps, ["-A", "-o", "pid=,ppid="], {
      env: { LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 5000,
    })
  } catch {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of out.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue
    children.set(parent!, [...(children.get(parent!) ?? []), child!])
  }
  const found: number[] = []
  for (let level = children.get(pid) ?? []; level.length > 0; level = level.flatMap((p) => children.get(p) ?? []))
    found.push(...level.filter((p) => p !== pid && !found.includes(p)))
  return found.reverse()
}

/** Ends `pid` and its descendants, read from `ps` now: SIGTERM, then SIGKILL after `KILL_GRACE_MS` to each still
 *  running. `pid` first, so a shell can't run its next command once its child ends. Children can't lead a group of
 *  their own (ssh's prompts need the foreground tty), so this walks the tree instead of signalling a group. */
export function killTree(pid: number): void {
  const tree = [pid, ...descendants(pid)].map((p) => ({ pid: p, started: startTime(p) }))
  for (const { pid: p } of tree) send(p, "SIGTERM")
  setTimeout(() => {
    for (const { pid: p, started } of tree) if (started !== null && sameProcess(p, started)) send(p, "SIGKILL")
  }, KILL_GRACE_MS).unref()
}

/** Sends `sig` to `pid`; a process that already went, or isn't ours, is skipped. */
function send(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {}
}

/** The node master's argv: a master on `socket` whose session is a remote `cat` reading our pipe. */
export function masterArgv(ssh: string, spec: Spec, { config, socket }: { config: string; socket: string }): string[] {
  return [
    ssh, "-F", config,
    "-M", "-S", socket,
    // Ends with its session, which ends when our pipe closes: no ControlPersist detach.
    "-o", "ControlPersist=no",
    // The owner's LocalForward, ExitOnForwardFailure or RequestTTY can't break it; -O forward still works.
    "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no",
    ...(spec.jump ? ["-J", spec.jump.join(",")] : []),
    ...(spec.port !== undefined ? ["-p", String(spec.port)] : []),
    "--", spec.host,
    "cat >/dev/null",
  ]
}

/** The node master: its process, the pipe that is its lifeline, its exit code, and its control socket. */
export interface Master {
  readonly child: ChildProcess
  readonly lifeline: Writable
  readonly exited: Promise<number>
  readonly socket: string
}

/** Starts the node master as a foreground child, its stdin a pipe this process holds and never writes. When this
 *  process ends, `kill -9` included, the remote cat exits and ssh ends the master once no channel is open; an HQ tab's
 *  `/api/events` is one, so the visit's watcher also `-O exit`s it. Its stderr is the owner's unless `quiet`. */
export function startMaster(ctx: ReachContext, spec: Spec, { quiet = false } = {}): Master {
  const { paths } = ctx
  const argv = masterArgv(ctx.ssh, spec, { config: ctx.batch ? paths.batchConfig : paths.config, socket: paths.node })
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: paths.dir,
    env: sshEnv(ctx),
    stdio: ["pipe", "ignore", quiet ? "ignore" : "inherit"],
  })
  // The master may be gone when the pipe closes (EPIPE).
  child.stdin!.on("error", () => {})
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => {
      if (child.pid === undefined) resolve(127)
    })
    child.on("exit", (code, sig) => resolve(code ?? 128 + (sig ? (os.constants.signals[sig] ?? 0) : 0)))
  })
  return { child, lifeline: child.stdin!, exited, socket: paths.node }
}

/** Until the control socket exists (ssh binds it only after login), the master exits, or `timeoutMs` pass or `signal`
 *  aborts (then it kills the master); polls every 100 ms. */
export function waitForSocket(
  master: Master,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"up" | "exited" | "timed_out"> {
  return new Promise((resolve) => {
    let done = false
    const finish = (result: "up" | "exited" | "timed_out") => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      resolve(result)
    }
    const stop = () => {
      if (master.child.pid !== undefined) killTree(master.child.pid)
      finish("timed_out")
    }
    const poll = setInterval(() => {
      if (isSocket(master.socket)) finish("up")
    }, 100)
    const timer = setTimeout(stop, timeoutMs)
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop, { once: true })
    void master.exited.then(() => finish("exited"))
  })
}

/** Whether `p` is a unix socket (not following a symlink). */
export const isSocket = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isSocket() ?? false

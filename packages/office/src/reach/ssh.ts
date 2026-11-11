/** The SSH plumbing of reaching a remote HQ: the generated configs and the ssh wrapper, the child runner, the node
 *  master and its lifeline, mux sessions and `-O` commands, and the watcher that ends every master once this process
 *  is gone. */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Writable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { sameProcess, startTime } from "../install/proc.ts"
import { replaceFile, writePrivate } from "../secrets.ts"
import type { ReachPaths } from "./paths.ts"
import { remoteCommand, type Spec, safePath, word } from "./spec.ts"

/** The owner's config, then the system's, which `-F` skips. `home` is the passwd entry's (`os.userInfo().homedir`),
 *  where ssh's own `~` points; only `realVisitDeps` calls this. */
export const defaultIncludes = (home: string) => [path.join(home, ".ssh", "config"), "/etc/ssh/ssh_config"]

/** `hq/ssh/config` (`config.batch` with `batch`): our options first, since ssh keeps the first value it reads, so the
 *  owner's ControlPath can't win and our `-O exit` never ends their masters. With `sessionOptions` (an ssh that knows
 *  them, OpenSSH 8.7 on) it also pins the session options whose `none`, `yes` and `yes` would defeat the master's cat
 *  lifeline. Each include is double-quoted (a home may hold a space); there's no default, so a test can't include the
 *  real `~/.ssh/config` by leaving it out. */
export function configText(
  cm: string,
  { batch = false, includes, sessionOptions = false }: { batch?: boolean; includes: readonly string[]; sessionOptions?: boolean },
): string {
  if (includes.some((file) => /["\n]/.test(file))) throw new Error("an included ssh config's path can't hold \" or a newline")
  return [
    "# Written by opencorp hq on each visit; edits are lost.",
    ...(batch ? ["BatchMode yes"] : []),
    "ControlMaster auto",
    `ControlPath ${cm}/%C`,
    "ControlPersist 60",
    "ServerAliveInterval 15",
    "ServerAliveCountMax 3",
    // Not behind IgnoreUnknown for older ssh: the first IgnoreUnknown read wins, so ours would void the owner's.
    ...(sessionOptions ? ["SessionType default", "StdinNull no", "ForkAfterAuthentication no"] : []),
    ...includes.map((file) => `Include "${file}"`),
    "",
  ].join("\n")
}

const knows = new Map<string, boolean>()

/** Whether the ssh at `ssh` accepts SessionType, StdinNull and ForkAfterAuthentication (OpenSSH 8.7 on): `ssh -G`
 *  checks the options without connecting or reading a config. Remembered per path. */
export function knowsSessionOptions(ssh: string): boolean {
  let known = knows.get(ssh)
  if (known === undefined) {
    const options = ["SessionType=default", "StdinNull=no", "ForkAfterAuthentication=no"].flatMap((o) => ["-o", o])
    const ran = spawnSync(ssh, ["-G", "-F", "/dev/null", ...options, "--", CONTROL_HOST], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
      timeout: CONTROL_MS,
    })
    known = ran.status === 0
    knows.set(ssh, known)
  }
  return known
}

/** `hq/ssh/bin/ssh`, first on PATH for reach.sh and the shell tool: the real ssh by absolute path (so ProxyJump's hop,
 *  built from the program name ssh was run as and `-F`, shares the config) with our config; each exit status is
 *  appended to $OPENCORP_SSH_STATUS, so a 255 counts where a pipeline or `|| true` hides it. */
export function wrapperText(realSsh: string): string {
  // The hop's command holds the program name unquoted.
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
  const sessionOptions = knowsSessionOptions(realSsh)
  await writePrivate(paths.config, configText(paths.cm, { includes, sessionOptions }))
  await writePrivate(paths.batchConfig, configText(paths.cm, { batch: true, includes, sessionOptions }))
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
  /** Children's output for the owner, already cleaned, as it comes. */
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
 *  can hold the pipes open for minutes (OpenSSH 8.0). It keeps the last `KEEP_CHARS` of each stream as it came, since
 *  the spec and the error worth showing come last; `echo` gets stderr (and stdout with `echoStdout`) cleaned. */
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
      if (o.echoStdout) o.echo?.(cleanOutput(c))
    })
    child.stderr!.setEncoding("utf8").on("data", (c: string) => {
      stderr = keep(stderr, c)
      o.echo?.(cleanOutput(c))
    })
    const stop = () => {
      if (!running(child)) return
      timedOut = true
      killTree(child.pid!)
    }
    const timer = setTimeout(stop, o.timeoutMs)
    // A signal that already fired never fires "abort" again.
    if (o.signal?.aborted) stop()
    else o.signal?.addEventListener("abort", stop, { once: true })
    const disarm = () => {
      clearTimeout(timer)
      o.signal?.removeEventListener("abort", stop)
    }
    const finish = (ran: Ran) => {
      if (done) return
      done = true
      disarm()
      child.stdout!.destroy()
      child.stderr!.destroy()
      resolve(ran)
    }
    child.on("error", (e) => {
      if (child.pid === undefined) finish({ code: 127, stdout: "", stderr: e.message, timedOut: false })
    })
    child.on("exit", (code, sig) => {
      // Exited in time: neither the timer nor a stop during the drain makes it a timeout.
      disarm()
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

/** Whether `child` started and hasn't exited: once it has, its pid may be reaped and reused. */
function running(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null
}

/** Sends `sig` to `pid`; a process that already went, or isn't ours, is skipped. */
function send(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {}
}

/** The node master's argv: a master on `socket` whose session is a remote `cat` reading our pipe. */
export function masterArgv(ssh: string, spec: Spec, { config, socket }: { config: string; socket: string }): [string, ...string[]] {
  return [
    ssh, "-F", config,
    "-M", "-S", socket,
    // Ends with its session, which ends when our pipe closes: no ControlPersist detach.
    "-o", "ControlPersist=no",
    // The owner's LocalForward, ExitOnForwardFailure or RequestTTY can't break it; -O forward still works.
    "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no",
    // ClearAllForwardings leaves these: a long-lived master needn't hand the node the owner's agent or display.
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
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

/** Starts the node master as a foreground child, after removing any leftover `cm/node`, its stdin a pipe this process
 *  holds and never writes. When this process ends, `kill -9` included, the remote cat exits and ssh ends the master
 *  once no channel is open; an HQ tab's `/api/events` is one, so the visit's watcher also `-O exit`s it. Its stderr
 *  (banners, a node's login-shell output, Duo's menu; ssh's prompts go to /dev/tty) reaches `ctx.echo` cleaned, unless
 *  `quiet`. */
export function startMaster(ctx: ReachContext, spec: Spec, { quiet = false } = {}): Master {
  const { paths } = ctx
  // The lock holder owns cm/node. A leftover there would read as up before login, and ssh would refuse to bind over
  // it ("already exists, disabling multiplexing").
  fs.rmSync(paths.node, { force: true })
  const argv = masterArgv(ctx.ssh, spec, { config: ctx.batch ? paths.batchConfig : paths.config, socket: paths.node })
  const child = spawn(argv[0], argv.slice(1), {
    cwd: paths.dir,
    env: sshEnv(ctx),
    stdio: ["pipe", "ignore", quiet ? "ignore" : "pipe"],
  })
  // The master may be gone when the pipe closes (EPIPE).
  child.stdin!.on("error", () => {})
  // Text from another machine must not drive the owner's terminal.
  child.stderr?.setEncoding("utf8").on("data", (c: string) => ctx.echo(cleanOutput(c)))
  // Read until the master exits, plus DRAIN_MS: its jump host may hold the pipe open longer (ssh ignores SIGPIPE).
  child.once("exit", () => setTimeout(() => child.stderr?.destroy(), DRAIN_MS))
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
      if (running(master.child)) killTree(master.child.pid!)
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

/** A session over the master at `socket`. ControlMaster=no: never a new master. ProxyCommand=false: with no master
 *  it fails at once instead of logging in again. No -J (ssh refuses it beside ProxyCommand). -F /dev/null: no
 *  `Match exec` of the owner's runs. IdentityFile=none: it never authenticates, and without it ssh reads the
 *  default keys in `~/.ssh` before failing. */
export function muxArgv(ssh: string, socket: string, host: string, command: string): [string, ...string[]] {
  return [
    ssh, "-F", "/dev/null", "-S", socket,
    "-o", "ControlMaster=no", "-o", "ProxyCommand=false", "-o", "IdentityFile=none",
    "-T", "--", host, command,
  ]
}

/** Adds a forward of 127.0.0.1:`port` to the unix socket `target`; exits 255 when it can't (a mux client ignores
 *  ExitOnForwardFailure, so the exit is the only answer). */
export function forwardArgv(ssh: string, socket: string, host: string, port: number, target: string): [string, ...string[]] {
  return [ssh, "-F", "/dev/null", "-S", socket, "-O", "forward", "-L", `127.0.0.1:${port}:${target}`, "--", host]
}

/** `-O` needs a destination even with `-S`; it isn't used. */
export const CONTROL_HOST = "opencorp-hq"

/** `-O check` or `-O exit` on the master at `socket`. */
export function controlArgv(ssh: string, socket: string, op: "check" | "exit"): [string, ...string[]] {
  return [ssh, "-F", "/dev/null", "-S", socket, "-O", op, "--", CONTROL_HOST]
}

/** How long a `-O` command may take. */
export const CONTROL_MS = 5000

/** Runs `opencorp <args>` on HQ's machine over the node master; its output isn't echoed. */
export function mux(ctx: ReachContext, spec: Spec, args: readonly string[]): Promise<Ran> {
  const argv = muxArgv(ctx.ssh, ctx.paths.node, spec.host, remoteCommand(spec, args))
  return runChild(argv, {
    env: sshEnv(ctx),
    cwd: ctx.paths.dir,
    timeoutMs: ctx.limits.stepMs,
    signal: ctx.signal,
  })
}

/** Forwards 127.0.0.1:`port` here to the unix socket `target` on HQ's machine, over the node master. */
export function forward(ctx: ReachContext, spec: Spec, port: number, target: string): Promise<Ran> {
  const argv = forwardArgv(ctx.ssh, ctx.paths.node, spec.host, port, target)
  return runChild(argv, { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: CONTROL_MS, signal: ctx.signal })
}

/** `-O check` or `-O exit` on the master at `socket`. */
export function control(ctx: ReachContext, socket: string, op: "check" | "exit"): Promise<Ran> {
  const argv = controlArgv(ctx.ssh, socket, op)
  return runChild(argv, { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: CONTROL_MS, signal: ctx.signal })
}

/** Ends every master whose control socket is in `cm` with `-O exit`, the node's first (so its hop goes before the login
 *  master), then removes each file there, except a socket whose `-O exit` failed while something still listens on it:
 *  the watcher, or the next visit, tries that one again. Never signals a pid. Runs on stop, so it ignores the stop
 *  signal. */
export async function exitAll(ctx: ReachContext): Promise<void> {
  const names = readdirOrEmpty(ctx.paths.cm).sort((a, b) => (a === "node" ? -1 : b === "node" ? 1 : a.localeCompare(b)))
  for (const name of names) {
    const file = path.join(ctx.paths.cm, name)
    if (isSocket(file) && (await control({ ...ctx, signal: undefined }, file, "exit")).code !== 0 && (await listening(file)))
      continue
    fs.rmSync(file, { force: true, recursive: true })
  }
}

/** Whether something accepts connections on the unix socket `file` (within `CONTROL_MS`). */
function listening(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(file)
    const done = (answer: boolean) => {
      clearTimeout(timer)
      c.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => done(false), CONTROL_MS)
    c.once("connect", () => done(true))
    c.once("error", () => done(false))
  })
}

/** Ends the node master alone, leaving the login node's for a retry: `-O exit`, then up to `CONTROL_MS` for it to
 *  go, else (or when `-O exit` fails) ends our own child; removes `cm/node`. */
export async function endNode(ctx: ReachContext, master: Master): Promise<void> {
  const asked = await control({ ...ctx, signal: undefined }, master.socket, "exit")
  const gone =
    asked.code === 0 &&
    (await Promise.race([master.exited.then(() => true), sleep(CONTROL_MS).then(() => false)]))
  if (!gone && running(master.child)) killTree(master.child.pid!)
  await master.exited
  fs.rmSync(master.socket, { force: true })
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

/** `$1` is the real ssh, `$2` the `cm` folder. INT and HUP are ignored (its `cat`, ssh and sleeps inherit that); once
 *  stdin ends, `-O exit` on `cm/node` first (its hop goes before the login master), then on every other socket that
 *  isn't a symlink (one could name the owner's own master). Each `-O exit` gets `CONTROL_MS`, kept in POSIX sh since
 *  macOS has no `timeout`: a guard kills it then, and is itself ended, with its sleep, once the exit returns. */
export const WATCHER = `trap '' INT HUP
ssh=$1
cm=$2
quit() {
  [ -S "$1" ] && [ ! -h "$1" ] || return 0
  "$ssh" -F /dev/null -S "$1" -O exit ${CONTROL_HOST} &
  p=$!
  ( trap 'kill "$t" 2>/dev/null; exit 0' TERM; sleep ${CONTROL_MS / 1000} & t=$!; wait "$t"; kill "$p" 2>/dev/null ) &
  g=$!
  wait "$p"
  kill "$g" 2>/dev/null
  wait "$g"
}
cat >/dev/null
quit "$cm/node"
for s in "$cm"/*; do
  [ "$s" = "$cm/node" ] || quit "$s"
done
exit 0
`

/** `$0` names it in `ps`, so `pgrep -f opencorp-hq-watch` finds a leftover. */
export const watcherArgv = (ssh: string, cm: string) => ["/bin/sh", "-c", WATCHER, "opencorp-hq-watch", ssh, cm]

/** The visit's watcher: its process, and `release()`, which lets it run its exits and resolves once it's gone. */
export interface Watcher {
  readonly child: ChildProcess
  release(): Promise<void>
}

/** Starts the visit's watcher on a second pipe this process holds and never writes, so it ends every master once this
 *  process ends, even by `kill -9`. `release()` ends its stdin and resolves on its exit (SIGKILL after
 *  `2 * CONTROL_MS`): after `exitAll`, before the lock goes. */
export function startWatcher(ctx: ReachContext): Watcher {
  const child = spawn("/bin/sh", watcherArgv(ctx.ssh, ctx.paths.cm).slice(1), {
    cwd: ctx.paths.dir,
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "ignore", "ignore"],
  })
  child.stdin!.on("error", () => {})
  const exited = new Promise<void>((resolve) => {
    child.on("error", () => {
      if (child.pid === undefined) resolve()
    })
    child.on("exit", () => resolve())
  })
  return {
    child,
    async release() {
      child.stdin!.end()
      const timer = setTimeout(() => child.kill("SIGKILL"), 2 * CONTROL_MS)
      await exited
      clearTimeout(timer)
    },
  }
}

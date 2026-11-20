/** The SSH plumbing of reaching a remote HQ: the generated configs and the ssh wrapper, the child runner, the node
 *  master and its lifeline, mux sessions and `-O` commands, and the watcher that ends every master once this process
 *  is gone. */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { sameProcess, startTime } from "../../util/proc.ts"
import { replaceFile, writePrivate } from "../../util/private_files.ts"
import type { ReachPaths } from "./paths.ts"
import { remoteCommand, type Spec, safePath, word } from "./spec.ts"

/** The owner's config, then the system's, which `-F` skips. `home` is the passwd entry's (`os.userInfo().homedir`),
 *  where ssh's own `~` points; only `realVisitDeps` calls this. */
export const defaultIncludes = (home: string) => [
  path.join(home, ".ssh", "config"),
  // Apple's and the distributions' system config; a Homebrew or Nix ssh reads its own under its prefix instead.
  "/etc/ssh/ssh_config",
]

/** How long a login master of ours stays after its last session (ControlPersist), in seconds. */
export const PERSIST_S = 60

/** `hq/ssh/config` (`config.batch` with `batch`): the owner's config and the system's first, then ours. ssh keeps the
 *  first value it reads, so the owner's settings win wherever they set one, and ours are defaults: sharing in `cm`
 *  (so a socket there is one an ssh of ours bound, the owner having set no ControlPath), keep-alives, and, with
 *  `sessionOptions` (an ssh that knows them, OpenSSH 8.7 on), the session options a visit needs. After an Include ssh
 *  reads on as before it, so a `Host` block the owner's file ends in doesn't take ours. Each include is double-quoted
 *  (a home may hold a space); there's no default, so a test can't include the real `~/.ssh/config` by leaving it
 *  out. */
export function configText(
  cm: string,
  {
    batch = false,
    includes,
    sessionOptions = false,
  }: { batch?: boolean; includes: readonly string[]; sessionOptions?: boolean },
): string {
  return [
    HEADER,
    ...includeLines(includes),
    ...(batch ? ["BatchMode yes"] : []),
    "ControlMaster auto",
    `ControlPath ${cm}/%C`,
    `ControlPersist ${PERSIST_S}`,
    "ServerAliveInterval 15",
    "ServerAliveCountMax 3",
    // Only where ssh knows them, not behind an IgnoreUnknown: the owner's may already have set one, and the first wins.
    ...(sessionOptions ? ["SessionType default", "StdinNull no", "ForkAfterAuthentication no"] : []),
    "",
  ].join("\n")
}

/** `hq/ssh/agent.config`, which the agent's ssh reads while learning: `ControlMaster no`, then the visit config's
 *  includes, and nothing else. It rides a connection the user has open, at their ControlPath, or logs in directly, and
 *  never keeps one: in the SSH-only sandbox `~/.ssh` is read-only, and under `ControlMaster auto` with no master to
 *  ride ssh would log in, fail to bind its socket there and exit 255. */
export function agentConfigText(includes: readonly string[]): string {
  return [HEADER, "ControlMaster no", ...includeLines(includes), ""].join("\n")
}

const HEADER = "# Written by opencorp hq on each visit; edits are lost."

/** An `Include` line for each of `includes`, double-quoted (a home may hold a space); throws for a path holding `"` or
 *  a newline, which would end the line. */
function includeLines(includes: readonly string[]): string[] {
  if (includes.some((file) => /["\n]/.test(file))) throw new Error("an included ssh config's path can't hold \" or a newline")
  return includes.map((file) => `Include "${file}"`)
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

/** Where the settings a visit can't work with are explained. */
const TROUBLESHOOTING = "https://opencorp.readthedocs.io/hq/#troubleshooting"

/** Of the options `ssh -G` printed for a host, the ones a visit can't work with, as the owner would write them: a
 *  RemoteCommand (ssh refuses a command of its own beside it), RequestTTY force, SessionType none or subsystem,
 *  StdinNull or ForkAfterAuthentication yes (OpenSSH 8.7 on; an older ssh prints none of the three), and a ControlPath
 *  a master would bind in a folder that is missing or not writable (ssh logs in, then exits 255). */
export function breakingOptions(printed: string): string[] {
  const options = new Map<string, string>()
  for (const line of printed.split("\n")) {
    const m = /^(\S+) (.*)$/.exec(line.trim())
    if (m !== null && !options.has(m[1]!.toLowerCase())) options.set(m[1]!.toLowerCase(), m[2]!)
  }
  const yes = (key: string) => ["yes", "true"].includes(options.get(key) ?? "")
  const found: string[] = []
  if ((options.get("remotecommand") ?? "none") !== "none") found.push("RemoteCommand")
  if (options.get("requesttty") === "force") found.push("RequestTTY force")
  const session = options.get("sessiontype")
  if (session === "none" || session === "subsystem") found.push(`SessionType ${session}`)
  if (yes("stdinnull")) found.push("StdinNull yes")
  if (yes("forkafterauthentication")) found.push("ForkAfterAuthentication yes")
  const controlPath = options.get("controlpath") ?? "none"
  if (!["false", "no"].includes(options.get("controlmaster") ?? "false") && controlPath !== "none") {
    // ssh prints the path with its tokens expanded; one it left can't be checked here.
    const folder = path.dirname(controlPath.replace(/^~(?=\/)/, () => os.userInfo().homedir))
    const problem = path.isAbsolute(folder) && !folder.includes("%") ? folderProblem(folder) : null
    if (problem !== null) found.push(`a ControlPath whose folder ${cleanOutput(folder)} ${problem}`)
  }
  return found
}

/** Why ssh can't bind a socket in `folder`, as the end of a sentence, or null when it can. */
function folderProblem(folder: string): string | null {
  try {
    if (!fs.statSync(folder).isDirectory()) return "doesn't exist"
    fs.accessSync(folder, fs.constants.W_OK)
    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? "doesn't exist" : "you can't write to"
  }
}

/** A host a visit's ssh reaches: `[user@]host`, and its port when the spec names one. */
export interface SshHost {
  readonly host: string
  readonly port?: number
}

/** `[user@]host[:port]`, as a jump host is written, or null for anything else (`none`, say). */
export function jumpHost(jump: string): SshHost | null {
  const m = /^([A-Za-z0-9_.@-]+?)(?::([0-9]{1,5}))?$/.exec(jump)
  if (m === null || m[1] === "none") return null
  return m[2] === undefined ? { host: m[1]! } : { host: m[1]!, port: Number(m[2]) }
}

/** After a failed visit: `ssh -G` with the visit's config for each of `hosts`, and each jump host the config gives
 *  one, once each (a read; it connects nowhere), and a line for each host naming what the owner's config sets for it
 *  that a visit can't work with. A host ssh prints no options for names nothing. Stops at the visit's stop. */
export async function configProblems(ctx: ReachContext, hosts: readonly SshHost[]): Promise<string[]> {
  const lines: string[] = []
  const seen = new Set<string>()
  const queue = [...hosts]
  for (let next = queue.shift(); next !== undefined && !ctx.signal?.aborted; next = queue.shift()) {
    const { host, port } = next
    const key = `${host} ${port ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    const ported = port === undefined ? [] : ["-p", String(port)]
    const argv: [string, ...string[]] = [ctx.ssh, "-F", ctx.paths.config, "-G", ...ported, "--", host]
    const ran = await runChild(argv, { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: CONTROL_MS, signal: ctx.signal })
    if (ran.code !== 0 || ran.timedOut) continue
    const jumps = /^proxyjump (\S+)$/m.exec(ran.stdout)?.[1] ?? ""
    for (const jump of jumps.split(",")) {
      const hop = jumpHost(jump)
      if (hop !== null) queue.push(hop)
    }
    const found = breakingOptions(ran.stdout)
    if (found.length === 0) continue
    lines.push(`opencorp hq: your ssh config sets ${listed(found)} for ${host}, which a visit can't work with; see ${TROUBLESHOOTING}`)
  }
  return lines
}

/** `items` as a sentence's list: "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/** `hq/ssh/bin/ssh`, first on PATH for reach.sh, the shell tool and the agent's shells: the real ssh by absolute path
 *  (so ProxyJump's hop, built from the program name ssh was run as and `-F`, shares the config) with the config
 *  `$OPENCORP_SSH_CONFIG` names; each exit status but a
 *  control command's (`-O`) is appended to $OPENCORP_SSH_STATUS, so a 255 counts where a pipeline or `|| true` hides
 *  it. When the host it named is a plain `[user@]host`, the host follows, then its jump hosts from `-J` or
 *  `-o ProxyJump`: a failed visit checks the owner's config for them. */
export function wrapperText(realSsh: string): string {
  // The hop's command holds the program name unquoted.
  if (!safePath(realSsh)) throw new Error(`ssh's path can't be used unquoted: ${realSsh}`)
  return [
    "#!/bin/sh",
    "# Written by opencorp hq on each visit.",
    `${word(realSsh)} -F "$OPENCORP_SSH_CONFIG" "$@"`,
    "status=$?",
    // A control command (-O) opens no connection: its 255 (no master yet) isn't "couldn't connect". The options end
    // at `--` or the destination; these take a value, which may look like an option.
    "control=",
    "skip=",
    "last=",
    "host=",
    "jumps=",
    // An -o value that sets ProxyJump (`ProxyJump=a,b` or `proxyjump a,b`): its hosts, less the = and blanks.
    "proxyjump() {",
    "  case $1 in",
    "    [Pp][Rr][Oo][Xx][Yy][Jj][Uu][Mm][Pp][=\\ ]*) v=${1#?????????}; jumps=${v#\"${v%%[!= ]*}\"} ;;",
    "  esac",
    "}",
    'for a in "$@"; do',
    "  case $skip in",
    "    J) jumps=$a; skip=; continue ;;",
    '    o) proxyjump "$a"; skip=; continue ;;',
    "    ?) skip=; continue ;;",
    "  esac",
    '  if [ -n "$last" ]; then host=$a; break; fi',
    "  case $a in",
    "    --) last=1 ;;",
    "    -O*) control=1; break ;;",
    "    -J) skip=J ;;",
    "    -J*) jumps=${a#-J} ;;",
    "    -o) skip=o ;;",
    '    -o*) proxyjump "${a#-o}" ;;',
    "    -[BbcDEeFIiLlmpQRSWw]) skip=1 ;;",
    "    -*) ;;",
    "    *) host=$a; break ;;",
    "  esac",
    "done",
    // Only names no option or shell word could be go on the line.
    "case $host in -*|*[!A-Za-z0-9_.@-]*) host= ;; esac",
    "case $jumps in -*|*[!A-Za-z0-9_.@:,-]*) jumps= ;; esac",
    // Single-quoted TS strings: `${…-}` is sh, not a template.
    'line=$status',
    'if [ -n "$host" ]; then line="$line $host${jumps:+ $jumps}"; fi',
    'if [ -z "$control" ] && [ -n "${OPENCORP_SSH_STATUS-}" ]; then printf \'%s\\n\' "$line" >>"$OPENCORP_SSH_STATUS"; fi',
    'exit "$status"',
    "",
  ].join("\n")
}

/** Writes the visit's two configs and the agent's (0600), and the wrapper (0700), for this visit. */
export async function writeSshFiles(paths: ReachPaths, realSsh: string, includes: readonly string[]): Promise<void> {
  const sessionOptions = knowsSessionOptions(realSsh)
  await writePrivate(paths.config, configText(paths.cm, { includes, sessionOptions }))
  await writePrivate(paths.batchConfig, configText(paths.cm, { batch: true, includes, sessionOptions }))
  await writePrivate(paths.agentConfig, agentConfigText(includes))
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

/** A step that can prompt (Duo, a password, a host key) gets 5 minutes; one over an open master 60 s; each step of
 *  the quiet try after a drop, which never prompts, 20 s, so one riding a stale connection soon asks for Enter. */
export const LIMITS = Object.freeze({ promptMs: 5 * 60_000, stepMs: 60_000, quietMs: 20_000 })

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
  readonly limits: { readonly promptMs: number; readonly stepMs: number; readonly quietMs: number }
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

/** The lines the wrapper recorded since `resetStatus`, in order: each exit status, and the hosts its ssh named, its
 *  jump hosts before its destination. */
function statusLines(ctx: ReachContext): { status: number; hosts: SshHost[] }[] {
  let text: string
  try {
    text = fs.readFileSync(ctx.paths.status(process.pid), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return text.split("\n").flatMap((line) => {
    const m = /^([0-9]+)(?: ([A-Za-z0-9_.@-]+)(?: ([A-Za-z0-9_.@:,-]+))?)?$/.exec(line.trim())
    if (m === null) return []
    const jumps = (m[3] ?? "").split(",").flatMap((jump) => jumpHost(jump) ?? [])
    return [{ status: Number(m[1]), hosts: m[2] === undefined ? [] : [...jumps, { host: m[2] }] }]
  })
}

/** The exit statuses the wrapper recorded since `resetStatus`, in order. */
export const readStatuses = (ctx: ReachContext): number[] => statusLines(ctx).map((line) => line.status)

/** The hosts the wrapper's ssh calls named since `resetStatus`, jump hosts included, each once, in order. */
export function readHosts(ctx: ReachContext): SshHost[] {
  const hosts = new Map<string, SshHost>()
  for (const { host, port } of statusLines(ctx).flatMap((line) => line.hosts)) {
    const key = `${host} ${port ?? ""}`
    if (!hosts.has(key)) hosts.set(key, port === undefined ? { host } : { host, port })
  }
  return [...hosts.values()]
}

/** Leaves raw mode on a terminal and pauses `stdin`, so this process holds no read that would take the keys meant for
 *  ssh's prompt on /dev/tty; after each answer, before each child that may prompt. */
export function quietStdin(stdin: Readable): void {
  const tty = stdin as Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
  if (tty.isTTY === true) tty.setRawMode?.(false)
  stdin.pause()
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/** The first `n` UTF-16 units of `text`, less the half of a surrogate pair the cut would leave at its end. */
export function headChars(text: string, n: number): string {
  const cut = text.slice(0, n)
  return cut.length > 0 && isHigh(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut
}

/** The last `n` UTF-16 units of `text`, less the half of a surrogate pair the cut would leave at its start. */
export function tailChars(text: string, n: number): string {
  const cut = n <= 0 ? "" : text.slice(-n)
  return cut.length > 0 && isLow(cut.charCodeAt(0)) ? cut.slice(1) : cut
}

/** `text` with each lone surrogate as U+FFFD: text that goes to a model must be valid Unicode. */
export const wellFormed = (text: string) =>
  text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")

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
    const keep = (kept: string, more: string) => tailChars(kept + more, KEEP_CHARS)
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
  return headChars(lines.at(-1) ?? "", 300)
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

/** The node master's argv: a master on `socket` whose session is a remote `cat` reading our pipe. Its options here
 *  beat the owner's config, which a visit's reads first; with `sessionOptions` (an ssh that knows them) it pins those
 *  too. */
export function masterArgv(
  ssh: string,
  spec: Spec,
  { config, socket, sessionOptions }: { config: string; socket: string; sessionOptions: boolean },
): [string, ...string[]] {
  return [
    ssh, "-F", config,
    "-M", "-S", socket,
    // Ends with its session, which ends when our pipe closes: no ControlPersist detach.
    "-o", "ControlPersist=no",
    // The owner's RemoteCommand would refuse our cat, and their SessionType, StdinNull or ForkAfterAuthentication
    // would run no session or detach: the cat is the lifeline.
    "-o", "RemoteCommand=none",
    ...(sessionOptions ? ["-o", "SessionType=default", "-o", "StdinNull=no", "-o", "ForkAfterAuthentication=no"] : []),
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

/** The node master: its exit code, its control socket, and how to end it at once. */
export interface Master {
  readonly exited: Promise<number>
  readonly socket: string
  /** Ends it now, and what it started. */
  kill(): void
}

/** A node master this process spawned: its process, and the pipe that is its lifeline. */
export interface SpawnedMaster extends Master {
  readonly child: ChildProcess
  readonly lifeline: Writable
}

/** Starts the node master as a foreground child, after removing any leftover `cm/node`, its stdin a pipe this process
 *  holds and never writes. When this process ends, `kill -9` included, the remote cat exits and ssh ends the master
 *  once no channel is open; an HQ tab's `/api/events` is one, so the visit's watcher also `-O exit`s it. Its stderr
 *  (banners, a node's login-shell output, Duo's menu; ssh's prompts go to /dev/tty) reaches `ctx.echo` cleaned, unless
 *  `quiet`. */
export function startMaster(ctx: ReachContext, spec: Spec, { quiet = false } = {}): SpawnedMaster {
  const { paths } = ctx
  // The lock holder owns cm/node. A leftover there would read as up before login, and ssh would refuse to bind over
  // it ("already exists, disabling multiplexing").
  fs.rmSync(paths.node, { force: true })
  const argv = masterArgv(ctx.ssh, spec, {
    config: ctx.batch ? paths.batchConfig : paths.config,
    socket: paths.node,
    sessionOptions: knowsSessionOptions(ctx.ssh),
  })
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
  const kill = () => {
    if (running(child)) killTree(child.pid!)
  }
  return { child, lifeline: child.stdin!, exited, socket: paths.node, kill }
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
      master.kill()
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

/** A session over the master at `socket`. ControlMaster=no: never a new master. ProxyCommand=/usr/bin/false (by path,
 *  so no PATH lookup): with no master it fails at once instead of logging in again. No -J (ssh refuses it beside ProxyCommand). -F /dev/null: no
 *  `Match exec` of the owner's runs. IdentityFile=none: it never authenticates, and without it ssh reads the
 *  default keys in `~/.ssh` before failing. */
export function muxArgv(ssh: string, socket: string, host: string, command: string): [string, ...string[]] {
  return [
    ssh, "-F", "/dev/null", "-S", socket,
    "-o", "ControlMaster=no", "-o", "ProxyCommand=/usr/bin/false", "-o", "IdentityFile=none",
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

/** Whether `socket` is one of our own control sockets: a file straight in `cm` that isn't a link. Only an ssh of ours
 *  binds there (`-S`, or the visit config's ControlPath where the owner set none); a link could name a master of the
 *  owner's. */
function ownSocket(paths: ReachPaths, socket: string): boolean {
  if (path.dirname(path.resolve(socket)) !== path.resolve(paths.cm)) return false
  return !(fs.lstatSync(socket, { throwIfNoEntry: false })?.isSymbolicLink() ?? false)
}

/** What a step on a socket that isn't ours answers, without running ssh: the owner's masters are theirs to keep. */
function notOurs(paths: ReachPaths, socket: string): Promise<Ran> {
  const why = `${socket} isn't OpenCorp's own control socket in ${paths.cm}; left alone\n`
  return Promise.resolve({ code: 255, stdout: "", stderr: why, timedOut: false })
}

/** Runs `opencorp <args>` on HQ's machine over the node master; its output isn't echoed. */
export function mux(ctx: ReachContext, spec: Spec, args: readonly string[]): Promise<Ran> {
  if (!ownSocket(ctx.paths, ctx.paths.node)) return notOurs(ctx.paths, ctx.paths.node)
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
  if (!ownSocket(ctx.paths, ctx.paths.node)) return notOurs(ctx.paths, ctx.paths.node)
  const argv = forwardArgv(ctx.ssh, ctx.paths.node, spec.host, port, target)
  return runChild(argv, { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: CONTROL_MS, signal: ctx.signal })
}

/** `-O check` or `-O exit` on the master at `socket`, only when it's one of ours (`ownSocket`). */
export function control(ctx: ReachContext, socket: string, op: "check" | "exit"): Promise<Ran> {
  if (!ownSocket(ctx.paths, socket)) return notOurs(ctx.paths, socket)
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
  if (!gone) master.kill()
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

/** The SSH-only sandbox: what OpenCorp's `hq` shell and reach.sh may touch as the owner. They get the network and
 *  their SSH, but never the model's key or sign-in in hq/, OpenCorp's other files, nor the rest of the home.
 *
 *  The shell's ssh keeps its control sockets in a folder of its own, `controlDir`, inside its temp folder. `hq/cm`,
 *  where the office's own ssh calls keep their masters outside the sandbox, is never mounted, so a call can't plant
 *  a socket there that the office would take for its master. The shell's ssh must name `controlDir` in its
 *  ControlPath, through a config of its own: under the visit's config, which names hq/cm, ssh only warns and goes on
 *  without a master. */
import fs from "node:fs"
import path from "node:path"
import { existingDir, realPath, within } from "./policy.ts"
import { run } from "./run.ts"

/** The host `sshFiles` asks about: one no config names, so only its `Host *` and defaults apply. */
const UNKNOWN_HOST = "opencorp-hq"
/** How long `ssh -G` may take, in seconds: it connects nowhere, though a config's `Match exec` runs a command. */
const SSH_G_S = 10
/** The system's ssh config, which the visit's config includes. */
const SYSTEM_SSH_CONFIG = "/etc/ssh/ssh_config"
/** How deep ssh follows Include lines (its READCONF_MAX_DEPTH), and how many files the walk reads at most. */
const MAX_INCLUDE_DEPTH = 16
const MAX_CONFIGS = 256
/** How many entries a scan for hard links reads in one folder tree before it refuses. */
const MAX_SCANNED = 10_000

/** What ssh reads a file `ssh -G` names as. */
export type SshFileKind = "identity" | "certificate" | "known_hosts"

/** A file `ssh -G` names, as an absolute path. */
export interface SshFile {
  kind: SshFileKind
  path: string
}

export interface SshPolicyInit {
  /** The owner's home as ssh sees it (the passwd entry's): `~/.ssh` is read there. */
  home: string
  /** `<OPENCORP_HOME>/hq`. */
  hq: string
  /** A private, writable temp folder: the call's TMPDIR and working folder. */
  tmpdir: string
  /** The wrapper's exit-status file under `hq/ssh/`. */
  statusFile: string
  /** SSH_AUTH_SOCK: a socket, or a link to one. */
  agentSocket?: string | null
  /** A Kerberos ticket cache as KRB5CCNAME names it: a file (`FILE:<path>` or its path), or a KCM socket's path. */
  kerberos?: string | null
  /** `sshFiles`'s answer for the visit's config. */
  sshFiles?: readonly SshFile[]
  /** More read-only paths: tests bind the fake ssh and its Bun here. */
  readOnly?: readonly string[]
}

/** Refused: a bind would expose hq's credentials, hq itself, the home, or a file through a link. */
export class UnsafeProfile extends Error {
  override name = "UnsafeProfile"
}

/** The access one SSH-only call gets: the network, the system as the workspace profile has it plus ssh's and
 *  Kerberos's configuration, and only the paths below. Every path is resolved. */
export class SshPolicy {
  readonly kind = "ssh"
  /** The owner's home: the call's HOME. Only the paths below are mounted in it. */
  readonly home: string
  /** The call's TMPDIR and working folder, read-write. */
  readonly tmpdir: string
  /** `<tmpdir>/cm` (0700): the folder the shell's ssh binds its control sockets in. */
  readonly controlDir: string
  /** Bound read-only, in this order: `~/.ssh`, the files `ssh -G` names that the profile takes (the constructor
   *  says which), `hq/ssh`, then the extra paths. */
  readonly readOnly: readonly string[]
  /** Files bound read-write for their data only, never to be removed, renamed or linked, in this order:
   *  `~/.ssh/known_hosts`, the status file, and a ticket file. */
  readonly writable: readonly string[]
  /** The sockets the call may connect to, and do nothing else with: the agent's and a KCM's. */
  readonly sockets: readonly string[]
  /** The agent's socket, where the call finds it (its SSH_AUTH_SOCK), or null. */
  readonly agentSocket: string | null
  /** KRB5CCNAME for a ticket cache that is a file (`FILE:<path>`), or null: a KCM socket is found from krb5.conf. */
  readonly ccache: string | null
  /** On Linux, a copy of each config file ssh reads that someone else owns, in `hq/ssh/system`, and the file it
   *  stands for, which bubblewrap mounts it over. In bubblewrap's user namespace root's files show as owned by
   *  nobody, and ssh refuses an included config that isn't root's or the user's ("Bad owner or permissions"); a
   *  copy is the user's, 0600. They live in hq/ssh, which the call can't write, not in its temp folder: the office
   *  writes them, outside the sandbox, so a link the call planted could redirect them. Empty on macOS, where
   *  Seatbelt shows owners as they are. */
  readonly systemConfig: readonly (readonly [copy: string, target: string])[]
  /** The credentials the call can read: each private key `ssh -G` names that exists, in `~/.ssh` or bound beside
   *  it, and a ticket file. The command reader must take them as credential paths, besides the ones it knows, so a
   *  command that reads one asks even where the key's path looks like any other file. */
  readonly credentials: readonly string[]
  /** What the profile left out of the call, each naming the path and why. */
  readonly notes: readonly string[]

  /**
   * Resolves every path (`realPath`) and checks each bind; creates `~/.ssh` (0700), `~/.ssh/known_hosts` and the
   * status file (0600), and `controlDir` (0700) when missing; on Linux writes `systemConfig`'s copies.
   *
   * Throws `UnsafeProfile`, before it creates anything:
   * - for a bind that is or holds `hq` or the home, that is, holds or lies inside `hq/provider.json`, `hq/auth.json`
   *   or the connections' folder, or that is a hard link to one of their files; a hard link to one anywhere in
   *   `~/.ssh` or `hq/ssh`, which are mounted whole, counts too;
   * - for a temp folder inside `hq` or `~/.ssh`, and a status file outside `hq/ssh`;
   * - for a known_hosts, status file or ticket file (bound read-write) that is a link, not a regular file, not the
   *   user's, or has other hard links, and for a `controlDir` that is a link, not a folder, or not the user's.
   *
   * Of `sshFiles`, a file in `~/.ssh` or the system's ssh folder is mounted with it, and a missing one binds
   * nothing. Any other is bound only when it is a regular file the user owns, with no other hard link, outside
   * OpenCorp's home and its company, and not a shell history; the rest get a note. A bound private key brings its
   * `.pub` and `-cert.pub` when they are there, as ssh reads them beside it. An agent's socket that is no socket,
   * a ticket cache that names no file or socket by its absolute path (a kernel keyring), and either one in
   * OpenCorp's home (the office's own socket is there) get a note too.
   *
   * Throws `Error` when `tmpdir` or `hq/ssh` is not an existing folder.
   */
  constructor(init: SshPolicyInit) {
    const home = realPath(init.home)
    const hq = realPath(init.hq)
    const office = realPath(path.dirname(init.hq))
    const ssh = realPath(path.join(home, ".ssh"))
    const hqSsh = existingDir("hq/ssh", path.join(hq, "ssh"))
    const tmpdir = existingDir("tmpdir", init.tmpdir)
    const knownHosts = path.join(ssh, "known_hosts")
    const statusDir = realPath(path.dirname(init.statusFile))
    const status = path.join(statusDir, path.basename(init.statusFile))
    const controlDir = path.join(tmpdir, "cm")
    const denied = new Denied(home, hq, office)
    const notes: string[] = []
    const credentials: string[] = []

    // The call writes these, so none may reach hq's files or ~/.ssh.
    denied.check(tmpdir, "the temp folder")
    if (within(tmpdir, hq) || within(tmpdir, ssh)) {
      throw new UnsafeProfile(`the SSH-only sandbox's temp folder ${tmpdir} lies in ${within(tmpdir, hq) ? hq : ssh}`)
    }
    if (statusDir !== hqSsh) {
      throw new UnsafeProfile(`the SSH-only sandbox's status file ${status} is not in ${hqSsh}`)
    }
    writableFile(knownHosts, "known_hosts")
    writableFile(status, "the status file")
    const folder = lstat(controlDir)
    if (folder !== undefined) {
      const why = folder.isSymbolicLink()
        ? "is a link"
        : !folder.isDirectory()
          ? "is not a folder"
          : folder.uid !== uid()
            ? "is not the user's"
            : null
      if (why !== null) throw new UnsafeProfile(`the SSH-only sandbox's socket folder ${controlDir} ${why}`)
    }

    const bound: string[] = []
    const company = realPath(path.join(office, "company"))
    const systemSsh = realPath(path.dirname(SYSTEM_SSH_CONFIG))
    /** Whether `real` is OpenCorp's: its home, or its company wherever that lives. */
    const ours = (real: string) => within(real, office) || within(real, company)
    /** Binds `p` (given, resolved as `real`) when it fits, else notes why; true when bound. */
    const take = (p: string, real: string, entry: fs.Stats): boolean => {
      const why = entry.isSymbolicLink()
        ? "it is a link"
        : !entry.isFile()
          ? "it is not a regular file"
          : entry.uid !== uid()
            ? "it is not the user's"
            : entry.nlink !== 1
              ? "it has other hard links"
              : ours(real)
                ? "it is in OpenCorp's home"
                : HISTORY.test(path.basename(real))
                  ? "it is a shell history"
                  : null
      if (why !== null) notes.push(`${p} is not bound: ${why}`)
      else if (!bound.includes(real)) bound.push(real)
      return why === null
    }
    for (const file of init.sshFiles ?? []) {
      if (!path.isAbsolute(file.path)) {
        notes.push(`${file.path} is not bound: it is not an absolute path`)
        continue
      }
      const real = realPath(file.path)
      denied.check(real, `the ${file.kind} file`)
      const entry = lstat(file.path)
      if (within(real, ssh)) {
        if (file.kind === "identity" && entry?.isFile()) credentials.push(real)
        continue
      }
      if (entry === undefined || within(real, systemSsh)) continue
      if (!take(file.path, real, entry) || file.kind !== "identity") continue
      credentials.push(real)
      for (const partner of [`${real}.pub`, `${real}-cert.pub`]) {
        const found = lstat(partner)
        if (found === undefined) continue
        denied.check(partner, "the certificate file")
        take(partner, partner, found)
      }
    }

    let agent: string | null = null
    if (init.agentSocket) {
      const given = init.agentSocket
      if (!path.isAbsolute(given)) {
        notes.push(`the agent's socket ${given} is not bound: it is not an absolute path`)
      } else {
        const real = realPath(given)
        denied.check(real, "the agent's socket")
        // The office's own sockets are there.
        if (ours(real)) notes.push(`the agent's socket ${given} is not bound: it is in OpenCorp's home`)
        else if (lstat(real)?.isSocket()) agent = real
        else notes.push(`the agent's socket ${given} is not bound: it is not a socket`)
      }
    }
    let ticket: string | null = null
    let kcm: string | null = null
    if (init.kerberos) {
      const name = init.kerberos
      const file = name.startsWith("FILE:") ? name.slice("FILE:".length) : name
      if (!path.isAbsolute(file)) {
        notes.push(`the Kerberos cache ${name} is not bound: it names no file or socket by its absolute path`)
      } else {
        const real = realPath(file)
        denied.check(real, "the Kerberos cache")
        const entry = lstat(real)
        if (ours(real)) notes.push(`the Kerberos cache ${name} is not bound: it is in OpenCorp's home`)
        else if (entry === undefined) notes.push(`the Kerberos cache ${name} is not bound: nothing is there`)
        else if (entry.isSocket()) kcm = real
        else {
          writableFile(file, "the Kerberos ticket")
          ticket = real
          credentials.push(real)
        }
      }
    }
    const extras = (init.readOnly ?? []).map((p) => realPath(p))
    for (const p of extras) denied.check(p, "the extra path")
    // Mounted whole, so a hard link to a credential anywhere in them would be readable.
    denied.scan(ssh)
    denied.scan(hqSsh)

    // ssh makes ~/.ssh 0700 the first time it writes there.
    if (!fs.existsSync(ssh)) fs.mkdirSync(ssh, { mode: 0o700 })
    createPrivate(knownHosts)
    createPrivate(status)
    // As made, or as found if another process made them first.
    writableFile(knownHosts, "known_hosts")
    writableFile(status, "the status file")
    if (folder === undefined) fs.mkdirSync(controlDir, { mode: 0o700 })
    const starts = [
      { file: SYSTEM_SSH_CONFIG, base: systemSsh },
      { file: path.join(ssh, "config"), base: ssh },
    ]

    this.home = home
    this.tmpdir = tmpdir
    this.controlDir = controlDir
    this.readOnly = [ssh, ...bound, hqSsh, ...extras]
    this.writable = [knownHosts, status, ...(ticket === null ? [] : [ticket])]
    this.sockets = [agent, kcm].filter((p) => p !== null)
    this.agentSocket = agent
    this.ccache = ticket === null ? null : `FILE:${ticket}`
    this.systemConfig =
      process.platform === "linux" ? copyConfigs(path.join(hqSsh, "system"), includedConfigs(starts, home, uid())) : []
    this.credentials = credentials
    this.notes = notes
  }
}

/** A shell's history file: bash's, zsh's, fish's, sh's, less's and the like. */
const HISTORY = /(hist(ory)?|hst)$/i

/** The paths an SSH-only call must never reach: hq and the home as wholes, and the model's key, its sign-in and
 *  the connections' tokens, the last three also by inode, so a hard link to one of their files is caught. */
class Denied {
  readonly #wholes: [string, string][]
  readonly #secrets: [string, string][]
  readonly #inodes = new Map<string, string>()

  constructor(home: string, hq: string, office: string) {
    this.#wholes = [
      ["hq", hq],
      ["the home", home],
    ]
    this.#secrets = [
      ["hq/provider.json", realPath(path.join(hq, "provider.json"))],
      ["hq/auth.json", realPath(path.join(hq, "auth.json"))],
      ["the connections", realPath(path.join(office, "office", "connections"))],
    ]
    for (const [name, p] of this.#secrets) for (const file of regularFiles(p)) this.#inodes.set(inode(file)!, name)
  }

  /** Throws `UnsafeProfile` when `bind` (resolved), named `what`, is or holds hq or the home, is, holds or lies in
   *  a secret, or is a hard link to one of their files. */
  check(bind: string, what: string): void {
    const exposed =
      this.#wholes.find(([, p]) => within(p, bind))?.[0] ??
      this.#secrets.find(([, p]) => within(p, bind) || within(bind, p))?.[0] ??
      this.#inodes.get(inode(bind) ?? "")
    if (exposed !== undefined) {
      throw new UnsafeProfile(`the SSH-only sandbox would expose ${exposed} through ${what} ${bind}`)
    }
  }

  /** Throws `UnsafeProfile` when a file anywhere in `dir`, which is mounted whole, is a hard link to a secret's. */
  scan(dir: string): void {
    for (const file of regularFiles(dir)) {
      const name = this.#inodes.get(inode(file)!)
      if (name !== undefined) {
        throw new UnsafeProfile(`${file} is a hard link to ${name}; the SSH-only sandbox would expose it`)
      }
    }
  }
}

/** The regular files at or under `p`, links not followed; throws `UnsafeProfile` past `MAX_SCANNED` entries. */
function regularFiles(p: string): string[] {
  const files: string[] = []
  const queue = [p]
  let seen = 0
  while (queue.length > 0) {
    const next = queue.pop()!
    if (++seen > MAX_SCANNED) throw new UnsafeProfile(`the SSH-only sandbox can't check ${p}: it holds too many files`)
    const entry = lstat(next)
    if (entry?.isFile()) files.push(next)
    else if (entry?.isDirectory()) {
      let names: string[] = []
      try {
        names = fs.readdirSync(next)
      } catch {}
      for (const name of names) queue.push(path.join(next, name))
    }
  }
  return files
}

/** `p`'s device and inode when it is a regular file, links not followed, or undefined. */
function inode(p: string): string | undefined {
  const entry = lstat(p)
  return entry?.isFile() ? `${entry.dev}:${entry.ino}` : undefined
}

/** `p`'s own stat (a link is not followed), or undefined when any lstat fails. */
function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p)
  } catch {
    return undefined
  }
}

/** Throws `UnsafeProfile` unless `p`, which a call writes, is missing or a plain file: no link, a regular file, the
 *  user's, with no other hard link. A link or a hard link would bind its target read-write. */
function writableFile(p: string, what: string): void {
  const entry = lstat(p)
  if (entry === undefined) return
  const why = entry.isSymbolicLink()
    ? "is a link"
    : !entry.isFile()
      ? "is not a regular file"
      : entry.uid !== uid()
        ? "is not the user's"
        : entry.nlink !== 1
          ? "has other hard links"
          : null
  if (why !== null) throw new UnsafeProfile(`the SSH-only sandbox binds ${what} ${p} read-write, but it ${why}`)
}

/** The absolute files `ssh -G -F <config> opencorp-hq` names under identityfile, certificatefile,
 *  userknownhostsfile and globalknownhostsfile, with their kinds, each once. It runs in the SSH-only sandbox
 *  `policy`, one built without `sshFiles`, so a config's `Match exec` runs there, as under the shell's own ssh;
 *  `ssh` and `config` are the office's, and none of its arguments comes from the agent. ssh prints `~` and `%d`
 *  (the home) as written, so both become the policy's home; a relative path names no file the profile can know. An
 *  ssh that fails names nothing: it would fail the same way in the call. */
export async function sshFiles(policy: SshPolicy, ssh: string, config: string): Promise<SshFile[]> {
  const ran = await run(policy, [ssh, "-G", "-F", config, "--", UNKNOWN_HOST], { timeout: SSH_G_S })
  if (ran.exit !== 0) return []
  const files: SshFile[] = []
  for (const line of ran.stdout.toString("utf8").split("\n")) {
    const match = /^(\S+) (.+)$/.exec(line)
    if (match === null) continue
    const kind = KINDS[match[1]!.toLowerCase()]
    if (kind === undefined) continue
    // One identity or certificate per line; the known-hosts lists are space-separated on one.
    const values = kind === "known_hosts" ? match[2]!.split(" ") : [match[2]!]
    for (const value of values) {
      const file = value.replace(/^(~|%d)(?=\/|$)/, policy.home)
      if (path.isAbsolute(file) && !files.some((f) => f.path === file)) files.push({ kind, path: file })
    }
  }
  return files
}

/** The `ssh -G` keys that name files, and what ssh reads each as. */
const KINDS: Record<string, SshFileKind> = {
  identityfile: "identity",
  certificatefile: "certificate",
  userknownhostsfile: "known_hosts",
  globalknownhostsfile: "known_hosts",
}

/** The config files `starts` name and reach through their `Include` lines, as ssh reads them, each resolved, that
 *  `uid` doesn't own. A start's relative includes are relative to its `base` (`/etc/ssh` for the system's config,
 *  `~/.ssh` for the user's), `~` is `home`, and a glob may only be in a path's last part. A file that can't be read
 *  is left out, as ssh skips it. */
export function includedConfigs(
  starts: readonly { file: string; base: string }[],
  home: string,
  uid: number,
): string[] {
  const queue = starts.map((start) => ({ ...start, depth: 0 }))
  const seen = new Set<string>()
  const found: string[] = []
  while (queue.length > 0 && seen.size < MAX_CONFIGS) {
    const { file, base, depth } = queue.shift()!
    const real = realPath(file)
    if (seen.has(real)) continue
    seen.add(real)
    let text: string
    let owner: number
    try {
      text = fs.readFileSync(real, "utf8")
      owner = fs.statSync(real).uid
    } catch {
      continue
    }
    if (owner !== uid) found.push(real)
    if (depth >= MAX_INCLUDE_DEPTH) continue
    for (const line of text.split("\n")) {
      const include = /^\s*include(?:\s*=\s*|\s+)(.*)$/i.exec(line)
      if (include === null) continue
      for (const word of include[1]!.matchAll(/"([^"]*)"|(\S+)/g)) {
        const arg = word[1] ?? word[2]!
        if (arg.startsWith("#")) break
        const expanded = arg.replace(/^~(?=\/|$)/, home)
        const pattern = path.isAbsolute(expanded) ? expanded : path.join(base, expanded)
        for (const match of glob(pattern)) queue.push({ file: match, base, depth: depth + 1 })
      }
    }
  }
  return found
}

/** The files `pattern` names: itself without a wildcard, else the entries of its folder its last part matches
 *  (`*` and `?`; a leading dot only by a dot), sorted as glob(3) sorts them. */
function glob(pattern: string): string[] {
  const dir = path.dirname(pattern)
  const last = path.basename(pattern)
  if (!/[*?]/.test(last)) return [pattern]
  if (/[*?]/.test(dir)) return []
  const regex = new RegExp(
    "^" + last.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]") + "$",
  )
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => regex.test(name) && (!name.startsWith(".") || last.startsWith(".")))
    .sort()
    .map((name) => path.join(dir, name))
}

/** Writes a copy of each of `files` (0600) into `dir`, made 0700 when missing, each replacing the last one in
 *  one rename, and returns `[copy, file]` for each copied. A file that can't be read is left out. Throws
 *  `UnsafeProfile` when `dir` is a link, not a folder, or not the user's. */
function copyConfigs(dir: string, files: readonly string[]): [string, string][] {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 })
  const st = fs.lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid()) {
    throw new UnsafeProfile(`the SSH-only sandbox's copies of the system's ssh config can't go in ${dir}`)
  }
  const copies: [string, string][] = []
  for (const file of files) {
    let data: Buffer
    try {
      data = fs.readFileSync(file)
    } catch {
      continue
    }
    const copy = path.join(dir, encodeURIComponent(file))
    const temp = `${copy}.${process.pid}.tmp`
    fs.rmSync(temp, { force: true })
    fs.writeFileSync(temp, data, { mode: 0o600, flag: "wx" })
    fs.renameSync(temp, copy)
    copies.push([copy, file])
  }
  return copies
}

/** This process's user id. */
function uid(): number {
  return process.getuid!()
}

/** Creates an empty file at `p` (0600) unless something is there, so a bind has a source. */
function createPrivate(p: string): void {
  try {
    fs.writeFileSync(p, "", { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

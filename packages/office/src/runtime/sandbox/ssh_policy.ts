/** The SSH-only sandbox: what OpenCorp's `hq` shell and reach.sh may touch as the owner. They get the network and
 *  their SSH, but never the model's key or sign-in in hq/, nor the rest of the home. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { realPath } from "./policy.ts"

/** The host `sshFiles` asks about: one no config names, so only its `Host *` and defaults apply. */
const UNKNOWN_HOST = "opencorp-hq"
/** How long `ssh -G` may take; it reads configs and connects nowhere. */
const SSH_G_MS = 10_000

export interface SshPolicyInit {
  /** The owner's home as ssh sees it (the passwd entry's): `~/.ssh` is read there. */
  home: string
  /** `<OPENCORP_HOME>/hq`. */
  hq: string
  /** A private, writable temp folder: the call's TMPDIR and working folder. */
  tmpdir: string
  /** The wrapper's exit-status file under `hq/ssh/`. */
  statusFile: string
  agentSocket?: string | null
  /** A Kerberos ticket cache: a file, or a KCM socket. */
  kerberos?: string | null
  /** `sshFiles`'s answer for the visit's config. */
  sshFiles?: readonly string[]
  /** More read-only paths: tests bind the fake ssh and its Bun here. */
  readOnly?: readonly string[]
}

/** Refused: a bind would expose hq's credentials, hq itself, or the home. */
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
  /** `hq/cm`, where ssh's masters bind their control sockets. */
  readonly cm: string
  /** Bound read-only, in this order: `~/.ssh`, the files `ssh -G` names, `hq/ssh`, then the extra paths. */
  readonly readOnly: readonly string[]
  /** Bound read-write over them, in this order: `~/.ssh/known_hosts`, the status file, `hq/cm`. */
  readonly writable: readonly string[]
  /** The agent's socket and the ticket cache, bound read-write; Seatbelt also lets the call connect to each. */
  readonly sockets: readonly string[]
  /** The agent's socket, where the call finds it (its SSH_AUTH_SOCK), or null. */
  readonly agentSocket: string | null
  /** KRB5CCNAME for a ticket cache that is a file (`FILE:<path>`), or null: a KCM socket is found from krb5.conf. */
  readonly ccache: string | null

  /** Resolves every path (`realPath`); creates `~/.ssh/known_hosts` (0600) and the status file when missing; throws
   *  `UnsafeProfile` for a bind that is or holds `hq`, `hq/provider.json`, `hq/auth.json` or the home, and for a
   *  status file outside `hq/ssh`. Throws `Error` when `tmpdir`, `hq/ssh` or `hq/cm` is not an existing folder.
   *  Nothing is created for a policy that is refused. */
  constructor(init: SshPolicyInit) {
    const home = realPath(init.home)
    const hq = realPath(init.hq)
    const ssh = realPath(path.join(home, ".ssh"))
    const knownHosts = realPath(path.join(ssh, "known_hosts"))
    const hqSsh = existingDir("hq/ssh", path.join(hq, "ssh"))
    const status = realPath(init.statusFile)
    const agent = init.agentSocket ? realPath(init.agentSocket) : null
    const kerberos = init.kerberos ? realPath(init.kerberos) : null
    this.home = home
    this.tmpdir = existingDir("tmpdir", init.tmpdir)
    this.cm = existingDir("hq/cm", path.join(hq, "cm"))
    const resolved = (paths: readonly string[] | undefined) => (paths ?? []).map((p) => realPath(p))
    this.readOnly = [ssh, ...resolved(init.sshFiles), hqSsh, ...resolved(init.readOnly)]
    this.writable = [knownHosts, status, this.cm]
    this.sockets = [agent, kerberos].filter((p) => p !== null)
    this.agentSocket = agent
    this.ccache = kerberos !== null && stat(kerberos)?.isFile() ? `FILE:${kerberos}` : null
    const denied = {
      hq,
      home,
      "hq/provider.json": realPath(path.join(hq, "provider.json")),
      "hq/auth.json": realPath(path.join(hq, "auth.json")),
    }
    for (const bind of [...this.readOnly, ...this.writable, ...this.sockets, this.tmpdir]) {
      for (const [name, kept] of Object.entries(denied)) {
        // hq/ssh and hq/cm lie inside hq and are the profile's own; nothing may lie inside either credential file.
        const inside = name.endsWith(".json") && within(bind, kept)
        if (within(kept, bind) || inside) {
          throw new UnsafeProfile(`the SSH-only sandbox would expose ${name} (${kept}) through ${bind}`)
        }
      }
    }
    // It is bound read-write, so it must be the wrapper's own file and nothing else of the home.
    if (path.dirname(status) !== hqSsh) {
      throw new UnsafeProfile(`the SSH-only sandbox's status file ${status} is not in ${hqSsh}`)
    }
    // ssh makes ~/.ssh 0700 the first time it writes there.
    if (!fs.existsSync(ssh)) fs.mkdirSync(ssh, { mode: 0o700 })
    createPrivate(knownHosts)
    createPrivate(status)
  }
}

/** The absolute files `ssh -G -F <config> opencorp-hq` names under identityfile, certificatefile,
 *  userknownhostsfile and globalknownhostsfile, with `~` as `home`, outside `home/.ssh`. ssh prints `~` and `%d`
 *  (the home) as written, so both become `home`; a relative path names no file the profile can know. An ssh that
 *  fails names nothing: it would fail the same way in the sandbox. */
export function sshFiles(ssh: string, config: string, home: string): string[] {
  const ran = spawnSync(ssh, ["-G", "-F", config, "--", UNKNOWN_HOST], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: SSH_G_MS,
  })
  if (ran.status !== 0) return []
  const own = path.join(home, ".ssh")
  const files: string[] = []
  for (const line of ran.stdout.split("\n")) {
    const match = /^(\S+) (.+)$/.exec(line)
    if (match === null) continue
    const key = match[1]!.toLowerCase()
    // One identity or certificate per line; the known-hosts lists are space-separated on one.
    const values =
      key === "identityfile" || key === "certificatefile"
        ? [match[2]!]
        : key === "userknownhostsfile" || key === "globalknownhostsfile"
          ? match[2]!.split(" ")
          : []
    for (const value of values) {
      const file = value.replace(/^(~|%d)(?=\/|$)/, home)
      if (path.isAbsolute(file) && !within(file, own) && !files.includes(file)) files.push(file)
    }
  }
  return files
}

/** Whether `child` is `parent` or lies inside it (both resolved). */
function within(child: string, parent: string): boolean {
  return parent === "/" || child === parent || child.startsWith(parent + "/")
}

/** `p`'s stat, links followed, or undefined when any stat fails (missing, a file in the path, a link loop). */
function stat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p)
  } catch {
    return undefined
  }
}

/** `p` resolved; throws if it is not an existing folder. */
function existingDir(name: string, p: string): string {
  const resolved = realPath(p)
  if (!stat(resolved)?.isDirectory()) throw new Error(`${name} ${resolved} is not an existing directory`)
  return resolved
}

/** Creates an empty file at `p` (0600) unless something is there, so a bind has a source. */
function createPrivate(p: string): void {
  try {
    fs.writeFileSync(p, "", { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

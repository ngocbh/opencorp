/** bubblewrap (Linux) command lines for sandboxed calls. */
import fs from "node:fs"
import { helperFiles, type SandboxPolicy } from "./policy.ts"
import type { SshPolicy } from "./ssh_policy.ts"

// Top-level system directories; on merged-/usr systems some are links into /usr.
export const SYSTEM_DIRS: readonly string[] = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]
export const SYSTEM_FILES: readonly string[] = [
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/resolv.conf",
]
// systemd-resolved's stub, which /etc/resolv.conf points to on Ubuntu.
export const NETWORK_PATHS: readonly string[] = ["/run/systemd/resolve"]
// What ssh and Kerberos read of the system, for the SSH-only profile. RHEL's ssh config includes the crypto policy,
// and its krb5.conf.d includes sssd's folder, without which Kerberos won't start; where users come from sssd, ssh
// needs its socket to find its own passwd entry, and exits without it.
export const SSH_SYSTEM_FILES: readonly string[] = [
  "/etc/ssh",
  "/etc/crypto-policies",
  "/etc/krb5.conf",
  "/etc/krb5.conf.d",
  "/var/lib/sss/pubconf/krb5.include.d",
  "/var/lib/sss/pipes/nss",
]

/**
 * Returns the `bwrap` argv that runs `argv` under `policy`.
 *
 * The call gets new pid, ipc, uts, and (unless `policy.network`) network namespaces, a
 * fresh `/proc` that shows only its own processes, and (unless `tty`) a new session. It dies with its
 * parent. Only system paths, the workspace, the tmpdir, the policy's read-only paths,
 * and the helper's own files (when `policy.helper` is set) are mounted; the home
 * directory, `/run/user` (the D-Bus user bus), and every other path are absent.
 *
 * With `tty` the call keeps the terminal it was started on: no new session, so a program can read `/dev/tty`
 * (ssh's prompts). That terminal is the instrument's own PTY, never the owner's: `--new-session` stops a call
 * writing into its parent's terminal (TIOCSTI, CVE-2017-5226), and here the parent's terminal is the call's own.
 * Known limit: a program in the call can still push input into that same PTY with TIOCSTI, unless the kernel
 * turns it off (Linux 6.2's `dev.tty.legacy_tiocsti`) or a seccomp filter refuses it, as one could before 6.2. The
 * office passes no seccomp filter today, and that is acceptable because the PTY is the call's own: the input it
 * pushes is the call's own input, which reaches no further than the approved command already does. The command
 * could type at a prompt itself that way, a secret one included, but the guard at a secret prompt is there to stop
 * the agent's keys, and the command was approved.
 */
export function command(policy: SandboxPolicy, argv: readonly string[], { tty = false } = {}): string[] {
  const args = system({ tty, network: policy.network, files: SYSTEM_FILES })
  for (const p of policy.readOnly) args.push("--ro-bind-try", p, p)
  args.push("--bind", policy.tmpdir, policy.tmpdir)
  const ws = policy.workspace
  if (policy.writable) args.push("--bind", ws, ws, ...protectedBinds(policy))
  else args.push("--ro-bind", ws, ws)
  if (policy.helper) {
    for (const f of helperFiles(policy.helper)) args.push("--ro-bind", f, f)
  }
  // The tmpfs root holds only mount points; read-only, so writes outside the
  // binds fail instead of landing in a throwaway directory.
  return [...args, "--remount-ro", "/", "--chdir", ws, "--", ...argv]
}

/**
 * Returns the `bwrap` argv that runs `argv` under the SSH-only `policy`.
 *
 * The call shares the host's network and otherwise gets what `command` gives a call: its own namespaces, `/proc`
 * and `/dev`, and a new session unless `tty`. It sees the system paths and `SSH_SYSTEM_FILES` read-only, the
 * policy's copies of the system's ssh config over the originals, then the policy's read-only paths, its writable
 * files over them (so `~/.ssh/known_hosts` takes writes inside the read-only `~/.ssh`), a test's own folder
 * read-write, its sockets read-only, and its temp folder, where it starts; then, with a wrapper, the real ssh at
 * `REAL_SSH` and the wrapper over every other ssh (`SshPolicy.sshOver`). Nothing else of the home or of hq is mounted:
 * not the model's sign-in, another destination's folder or a control-socket folder (`hq/cm-*`).
 *
 * Each writable file is a mount point in a read-only folder, so the call can write its data but can't remove,
 * rename or link it. A socket takes connections on a read-only mount, and nothing else.
 */
export function sshCommand(policy: SshPolicy, argv: readonly string[], { tty = false } = {}): string[] {
  const args = system({ tty, network: true, files: [...SYSTEM_FILES, ...SSH_SYSTEM_FILES] })
  // Over the system's own: ssh refuses root's configs, which the user namespace shows as nobody's.
  for (const [copy, target] of policy.systemConfig) args.push("--ro-bind", copy, target)
  for (const p of policy.readOnly) args.push("--ro-bind-try", p, p)
  // Made or checked by the policy, so a missing one is an error worth seeing.
  for (const p of policy.writable) args.push("--bind", p, p)
  for (const p of policy.readWrite) args.push("--bind", p, p)
  // An agent that has gone leaves its path behind; ssh then goes on without it, as it would outside.
  for (const p of policy.sockets) args.push("--ro-bind-try", p, p)
  args.push("--bind", policy.tmpdir, policy.tmpdir)
  // Last, so no folder mounted later covers them: the real ssh where the wrapper runs it, and the wrapper over the rest.
  for (const [source, target] of policy.sshOver) args.push("--ro-bind", source, target)
  return [...args, "--remount-ro", "/", "--chdir", policy.tmpdir, "--", ...argv]
}

/** The start of every call's argv: the namespaces, a new session unless `tty`, the network only if `network`, the
 *  system directories, `files` (and `NETWORK_PATHS` with the network) read-only, `/proc` and `/dev`. */
function system({ tty, network, files }: { tty: boolean; network: boolean; files: readonly string[] }): string[] {
  const args = ["bwrap", "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"]
  if (!tty) args.push("--new-session")
  if (!network) args.push("--unshare-net")
  for (const p of SYSTEM_DIRS) {
    if (lstat(p)?.isSymbolicLink()) args.push("--symlink", fs.readlinkSync(p), p)
    else args.push("--ro-bind-try", p, p)
  }
  for (const p of [...files, ...(network ? NETWORK_PATHS : [])]) args.push("--ro-bind-try", p, p)
  args.push("--proc", "/proc", "--dev", "/dev")
  return args
}

/**
 * Returns the mounts that keep a writable workspace's protected paths read-only: `.git`'s hooks and config, then
 * the harnesses' project config.
 *
 * They come after the workspace bind so they cover it. `.git` is bound onto itself:
 * Linux refuses to rename a mount point, but not a directory that merely contains one,
 * so binding only `.git/hooks` and `.git/config` would leave `mv .git .git2` open.
 * A missing `.git/hooks` is created first, since a bind needs an existing source. A missing
 * `.git` is created empty (a call's `holdGit` makes it, and removes it after), and it and a
 * `.git` with no config (not a repository yet) are bound read-only whole: otherwise `git init`
 * there would write a config with, say, `core.fsmonitor`, which git run later as the owner (or a
 * harness's own git) runs.
 *
 * Each project config folder (`.codex`, `.agents`, `.claude`) is bound read-only onto itself, so it can't be written,
 * renamed or removed; a missing one is created first, as `.git/hooks` is. A project config file (`.mcp.json`) is
 * bound only when it exists: a missing file can't be held without creating it, so the call can still create one.
 *
 * Symlinks are never bound: bwrap follows them on both sides, so model code could point
 * `.git/config` at `~/.ssh/id_ed25519` and have the next call mount the key.
 */
function protectedBinds(policy: SandboxPolicy): string[] {
  const { folders, files } = policy.protectedPaths
  const binds = gitBinds(policy)
  for (const p of folders) {
    const stat = lstat(p)
    if (stat === undefined) fs.mkdirSync(p)
    else if (stat.isSymbolicLink()) continue
    binds.push("--ro-bind", p, p)
  }
  for (const p of files) {
    const stat = lstat(p)
    if (stat !== undefined && !stat.isSymbolicLink()) binds.push("--ro-bind", p, p)
  }
  return binds
}

/** The mounts of `protectedBinds` that keep `.git` protected. */
function gitBinds(policy: SandboxPolicy): string[] {
  const { git, hooks, config } = policy.protectedPaths
  let stat = lstat(git)
  if (stat === undefined) {
    fs.mkdirSync(git)
    stat = lstat(git)
  }
  if (stat === undefined || stat.isSymbolicLink()) return []
  // A worktree's .git file names the real git dir.
  if (stat.isFile()) return ["--ro-bind", git, git]
  if (!stat.isDirectory()) return []
  if (lstat(config) === undefined) return ["--ro-bind", git, git]
  if (lstat(hooks) === undefined) fs.mkdirSync(hooks)
  const binds = ["--bind", git, git]
  for (const p of [hooks, config]) {
    if (!lstat(p)?.isSymbolicLink()) binds.push("--ro-bind-try", p, p)
  }
  return binds
}

/** How many calls hold each empty `.git` made for them, by path (see `holdGit`). */
const heldGits = new Map<string, number>()

/**
 * Holds a writable workspace's empty `.git` for one call, making it where it is missing, so `command` binds it
 * read-only; returns the release to call once the call has ended, or `undefined` when there is nothing to hold (a
 * read-only workspace, or a `.git` that isn't an empty folder).
 *
 * The last release removes it, if it is still empty: an empty `.git` left in the owner's tree would make ripgrep,
 * which both harnesses search with, take the folder for a repository of its own and drop a parent's `.gitignore`.
 * git itself skips an empty `.git`. An empty one a crashed office left is held, and so removed, by the next call.
 * Holds are counted in this process, so a call never removes a mount point another call still runs under.
 */
export function holdGit(policy: SandboxPolicy): (() => void) | undefined {
  if (!policy.writable) return undefined
  const { git } = policy.protectedPaths
  const stat = lstat(git)
  if (stat === undefined) fs.mkdirSync(git)
  else if (!stat.isDirectory() || fs.readdirSync(git).length > 0) return undefined
  heldGits.set(git, (heldGits.get(git) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (heldGits.get(git) ?? 1) - 1
    if (left > 0) {
      heldGits.set(git, left)
      return
    }
    heldGits.delete(git)
    try {
      // Only an empty folder goes: rmdir refuses one that was filled, a file and a link.
      fs.rmdirSync(git)
    } catch {}
  }
}

/** `p`'s own stat (a link is not followed), or `undefined` if nothing is there. */
function lstat(p: string): fs.Stats | undefined {
  return fs.lstatSync(p, { throwIfNoEntry: false })
}

/** bubblewrap (Linux) command lines for sandboxed calls. */
import fs from "node:fs"
import { helperFiles, type SandboxPolicy } from "./policy.ts"

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

/**
 * Returns the `bwrap` argv that runs `argv` under `policy`.
 *
 * The call gets new pid, ipc, uts, and (unless `policy.network`) network namespaces, a
 * fresh `/proc` that shows only its own processes, and a new session. It dies with its
 * parent. Only system paths, the workspace, the tmpdir, the policy's read-only paths,
 * and the helper's own files (when `policy.helper` is set) are mounted; the home
 * directory, `/run/user` (the D-Bus user bus), and every other path are absent.
 */
export function command(policy: SandboxPolicy, argv: readonly string[]): string[] {
  const args = [
    "bwrap",
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--new-session",
  ]
  if (!policy.network) args.push("--unshare-net")
  for (const p of SYSTEM_DIRS) {
    if (lstat(p)?.isSymbolicLink()) args.push("--symlink", fs.readlinkSync(p), p)
    else args.push("--ro-bind-try", p, p)
  }
  for (const p of [...SYSTEM_FILES, ...(policy.network ? NETWORK_PATHS : [])]) args.push("--ro-bind-try", p, p)
  args.push("--proc", "/proc", "--dev", "/dev")
  for (const p of policy.readOnly) args.push("--ro-bind-try", p, p)
  args.push("--bind", policy.tmpdir, policy.tmpdir)
  const ws = policy.workspace
  if (policy.writable) args.push("--bind", ws, ws, ...gitBinds(policy))
  else args.push("--ro-bind", ws, ws)
  if (policy.helper) {
    for (const f of helperFiles(policy.helper)) args.push("--ro-bind", f, f)
  }
  // The tmpfs root holds only mount points; read-only, so writes outside the
  // binds fail instead of landing in a throwaway directory.
  return [...args, "--remount-ro", "/", "--chdir", ws, "--", ...argv]
}

/**
 * Returns the mounts that keep a writable workspace's `.git` protected.
 *
 * They come after the workspace bind so they cover it. `.git` is bound onto itself:
 * Linux refuses to rename a mount point, but not a directory that merely contains one,
 * so binding only `.git/hooks` and `.git/config` would leave `mv .git .git2` open.
 * A missing `.git/hooks` is created first, since a bind needs an existing source; a
 * missing `.git/config` stays missing, and is then writable.
 *
 * Symlinks are never bound: bwrap follows them on both sides, so model code could point
 * `.git/config` at `~/.ssh/id_ed25519` and have the next call mount the key.
 */
function gitBinds(policy: SandboxPolicy): string[] {
  const [git, hooks, config] = policy.protectedPaths
  const stat = lstat(git)
  if (stat === undefined || stat.isSymbolicLink()) return []
  if (stat.isFile()) {
    // A worktree's .git file names the real git dir.
    return ["--ro-bind", git, git]
  }
  if (!stat.isDirectory()) return []
  if (lstat(hooks) === undefined) fs.mkdirSync(hooks)
  const binds = ["--bind", git, git]
  for (const p of [hooks, config]) {
    if (!lstat(p)?.isSymbolicLink()) binds.push("--ro-bind-try", p, p)
  }
  return binds
}

/** `p`'s own stat (a link is not followed), or `undefined` if nothing is there. */
function lstat(p: string): fs.Stats | undefined {
  return fs.lstatSync(p, { throwIfNoEntry: false })
}

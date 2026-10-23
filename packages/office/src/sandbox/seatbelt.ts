/** Seatbelt (macOS `sandbox-exec`) profiles for sandboxed calls. */
import fs from "node:fs"
import path from "node:path"
import { helperFiles, type SandboxPolicy } from "./policy.ts"

export const SYSTEM_SUBPATHS: readonly string[] = [
  "/usr",
  "/bin",
  "/System",
  "/Library",
  "/opt/homebrew",
  "/private/etc/ssl",
  "/private/var/db/timezone",
]
export const SYSTEM_LITERALS: readonly string[] = [
  "/private/etc/hosts",
  "/private/etc/resolv.conf",
  "/private/etc/services",
  "/private/etc/protocols",
  "/private/etc/localtime",
  "/private/etc/passwd",
  "/private/etc/group",
  "/private/etc/shells",
  // /bin/sh execs the shell this link names.
  "/private/var/select/sh",
  // xcrun shims such as /usr/bin/git find the developer directory through these.
  "/private/var/select/developer_dir",
  "/private/var/db/xcode_select_link",
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
]
// Top-level links that path lookups go through.
export const ROOT_LINKS: readonly string[] = ["/etc", "/tmp", "/var"]
export const MACH_SERVICES: readonly string[] = [
  "com.apple.system.opendirectoryd.libinfo", // getpwuid and friends
  "com.apple.system.notification_center", // notify(3), used by libc time zone code
]
export const NETWORK_MACH_SERVICES: readonly string[] = [
  "com.apple.dnssd.service",
  "com.apple.SystemConfiguration.configd",
  "com.apple.trustd.agent",
]
export const SYSCTL_PREFIXES: readonly string[] = ["hw.", "machdep.cpu."]
export const SYSCTL_NAMES: readonly string[] = [
  "kern.argmax",
  "kern.boottime",
  "kern.hostname",
  "kern.maxfilesperproc",
  "kern.maxproc",
  "kern.ngroups",
  "kern.osproductversion",
  "kern.osrelease",
  "kern.ostype",
  "kern.osvariant_status",
  "kern.osversion",
  "kern.secure_kernel",
  "kern.usrstack64",
  "kern.version",
  "sysctl.proc_cputype",
  "vm.loadavg",
]
export const DNS_SOCKET = "/private/var/run/mDNSResponder"

/**
 * Returns a default-deny SBPL profile that allows exactly what `policy` grants.
 *
 * Allowed: system and toolchain paths read-only, the workspace (read, or read-write
 * with `.git`, `.git/hooks`, and `.git/config` read-only), the private tmpdir, the
 * policy's extra read-only paths, the helper's own files when `policy.helper` is set,
 * a few mach services, and IP networking only if `policy.network`. The office install
 * is write-denied. Everything else, including unix sockets, Apple Events, and
 * LaunchServices, is denied.
 *
 * `canary`, a directory, gets a `file-write-data` rule (a no-op on a directory) that
 * marks processes running under this profile; see `sandbox.escapees`. `developerDir`
 * is the toolchain folder to allow: left out, `developerDir()` finds it; `null` means none.
 */
export function profile(
  policy: SandboxPolicy,
  options: { canary?: string; developerDir?: string | null } = {},
): string {
  const developer = options.developerDir === undefined ? developerDir() : options.developerDir
  const readable = [policy.workspace, policy.tmpdir, ...policy.readOnly]
  if (developer) readable.push(developer)
  const ws = policy.workspace
  const lines = [
    "(version 1)",
    "(deny default)",
    ";; Processes: children inherit this profile; no reach into other processes.",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    allow("sysctl-read", [
      ...SYSCTL_PREFIXES.map((p) => `(sysctl-name-prefix ${quote(p)})`),
      ...SYSCTL_NAMES.map((n) => `(sysctl-name ${quote(n)})`),
    ]),
    allow("mach-lookup", MACH_SERVICES.map((n) => `(global-name ${quote(n)})`)),
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    ";; System and toolchain, read-only.",
    allow("file-read*", [
      '(literal "/")',
      ...[...SYSTEM_SUBPATHS, ...(developer ? [developer] : [])].map((p) => `(subpath ${quote(p)})`),
      ...SYSTEM_LITERALS.map((p) => `(literal ${quote(p)})`),
    ]),
    '(allow file-write-data (literal "/dev/null"))',
    ";; The call's own descriptors by path, so `echo x > /dev/stderr` works.",
    '(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))',
    ";; Ancestors of allowed paths: metadata only, so lookups and realpath work.",
    allow("file-read-metadata", [...ROOT_LINKS, ...ancestors(readable)].map((p) => `(literal ${quote(p)})`)),
    ";; The workspace.",
  ]
  if (policy.writable) {
    const [git, hooks, config] = policy.protectedPaths
    lines.push(
      `(allow file-read* file-write* (subpath ${quote(ws)}))`,
      ";; Model code must not plant git hooks or config the owner later runs",
      ";; unsandboxed, nor rename .git to swap in a planted one.",
      `(deny file-write* (literal ${quote(git)}) (subpath ${quote(hooks)}) (literal ${quote(config)}))`,
    )
  } else {
    lines.push(`(allow file-read* (subpath ${quote(ws)}))`)
  }
  lines.push(";; The private temp directory.", `(allow file-read* file-write* (subpath ${quote(policy.tmpdir)}))`)
  if (policy.readOnly.length > 0) {
    lines.push(allow("file-read*", policy.readOnly.map((p) => `(subpath ${quote(p)})`)))
  }
  const helper = policy.helper
  if (helper) {
    const files = helperFiles(helper)
    lines.push(
      ";; The file helper only: read (and so run) its own files; metadata on their folders.",
      allow("file-read*", files.map((f) => `(literal ${quote(f)})`)),
      allow("file-read-metadata", ancestors(files).map((p) => `(literal ${quote(p)})`)),
    )
    if (!("binary" in helper)) {
      lines.push(
        ";; Bun lists the folder of the file it runs.",
        `(allow file-read-data (literal ${quote(path.dirname(helper.entry))}))`,
      )
    }
  }
  if (options.canary !== undefined) {
    lines.push(
      ";; Marks this call's processes; see sandbox.escapees.",
      `(allow file-write-data (literal ${quote(options.canary)}))`,
    )
  }
  // After every file allow, since Seatbelt applies the last matching rule.
  if (policy.office.install.length > 0) {
    lines.push(
      ";; The office install: model code must not replace a file the office runs unsandboxed.",
      "(deny file-write* " + policy.office.install.map((p) => `(subpath ${quote(p)})`).join(" ") + ")",
    )
  }
  if (policy.network) {
    lines.push(
      ";; IP networking only: unix sockets (office, tmux) stay denied.",
      "(allow network-outbound (remote ip))",
      "(allow network-inbound (local ip))",
      "(allow network-bind (local ip))",
      `(allow network-outbound (remote unix-socket (path-literal ${quote(DNS_SOCKET)})))`,
      allow("mach-lookup", NETWORK_MACH_SERVICES.map((n) => `(global-name ${quote(n)})`)),
    )
  }
  return lines.join("\n") + "\n"
}

function allow(op: string, filters: readonly string[]): string {
  return `(allow ${op} ` + filters.join(" ") + ")"
}

/** Quotes a string for SBPL. */
function quote(value: string): string {
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"'
}

/** Every parent of each of `paths`, nearest first, each listed once. */
function ancestors(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const p of paths) {
    for (let dir = path.dirname(p); ; dir = path.dirname(dir)) {
      seen.add(dir)
      if (dir === path.dirname(dir)) break
    }
  }
  return [...seen]
}

/** Returns the selected Xcode or Command Line Tools directory, if any. */
export function developerDir(): string | null {
  const link = "/private/var/select/developer_dir"
  try {
    return fs.lstatSync(link).isSymbolicLink() ? fs.realpathSync(link) : null
  } catch {
    return null
  }
}

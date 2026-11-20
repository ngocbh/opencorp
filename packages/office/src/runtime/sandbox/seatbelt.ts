/** Seatbelt (macOS `sandbox-exec`) profiles for sandboxed calls. */
import fs from "node:fs"
import path from "node:path"
import { helperFiles, type SandboxPolicy } from "./policy.ts"
import type { SshPolicy } from "./ssh_policy.ts"

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
// A terminal call's own terminal, and no other; see `profile`'s `tty`.
const TTY_RULE = '(allow file-read* file-write* file-ioctl (literal "/dev/tty") (literal (param "TTY")))'
// IP networking and DNS: unix sockets other than the DNS responder's stay denied unless a profile names them.
const NETWORK_RULES: readonly string[] = [
  "(allow network-outbound (remote ip))",
  "(allow network-inbound (local ip))",
  "(allow network-bind (local ip))",
  `(allow network-outbound (remote unix-socket (path-literal ${quote(DNS_SOCKET)})))`,
  allow("mach-lookup", NETWORK_MACH_SERVICES.map((n) => `(global-name ${quote(n)})`)),
]
// ssh's and Kerberos's system configuration, for the SSH-only profile.
export const SSH_SYSTEM_SUBPATHS: readonly string[] = ["/private/etc/ssh", "/private/etc/krb5.conf.d"]
export const SSH_SYSTEM_LITERALS: readonly string[] = ["/private/etc/krb5.conf"]
// The setuid programs macOS ships, which the SSH-only profile refuses to run: Seatbelt can't see a setuid bit.
export const SETUID_PROGRAMS: readonly string[] = [
  "/usr/bin/sudo",
  "/usr/bin/su",
  "/usr/bin/login",
  "/usr/bin/newgrp",
  "/usr/bin/passwd",
  "/usr/libexec/ssh-keysign",
]

/**
 * Returns a default-deny SBPL profile that allows exactly what `policy` grants.
 *
 * Allowed: system and toolchain paths read-only, the workspace (read, or read-write
 * with its `protectedPaths` read-only), the private tmpdir, the
 * policy's extra read-only paths, the helper's own files when `policy.helper` is set,
 * a few mach services, and IP networking only if `policy.network`. The install folders
 * of the office and its programs are write-denied. Everything else, including unix
 * sockets, Apple Events, and LaunchServices, is denied.
 *
 * `canary`, a directory, gets a `file-write-data` rule (a no-op on a directory) that
 * marks processes running under this profile; see `escapees.ts`. `developerDir`
 * is the toolchain folder to allow: left out, `developerDir()` finds it; `null` means none.
 *
 * With `tty` the call may use the terminal it runs on, and only that one: its controlling terminal, `/dev/tty`
 * (ssh's prompts), and the PTY slave its descriptors name, for reads, writes and terminal ioctls (`stty -echo`).
 * The slave's path isn't known when the profile is written, so the profile takes it as the `TTY` parameter, which
 * sandbox-exec's `-D` sets (see `terminalCommand` in `run.ts`). Any other terminal, the owner's included, stays
 * denied. Unverified on macOS, and a wrong rule there does not fail safe: the call's descriptors are open on the
 * terminal before the profile applies, so the call still reads and writes it, but the rule can refuse the ioctl
 * behind `stty -echo`, and a password typed at the prompt would then show on the screen, and so land in the model's
 * view of the terminal and in its record.
 */
export function profile(
  policy: SandboxPolicy,
  options: { canary?: string; developerDir?: string | null; tty?: boolean } = {},
): string {
  const developer = options.developerDir === undefined ? developerDir() : options.developerDir
  const ws = policy.workspace
  const lines = head(developer, options.tty ?? false)
  lines.push(...metadata([policy.workspace, policy.tmpdir, ...policy.readOnly], developer), ";; The workspace.")
  if (policy.writable) {
    const { git, hooks, config, folders, files } = policy.protectedPaths
    // Seatbelt matches a path that doesn't exist yet too, so a missing project config is held as well.
    const denied = [
      `(literal ${quote(git)})`,
      `(subpath ${quote(hooks)})`,
      `(literal ${quote(config)})`,
      ...folders.map((p) => `(subpath ${quote(p)})`),
      ...files.map((p) => `(literal ${quote(p)})`),
    ]
    lines.push(
      `(allow file-read* file-write* (subpath ${quote(ws)}))`,
      ";; Model code must not plant git hooks or config the owner later runs",
      ";; unsandboxed, nor rename .git to swap in a planted one, nor plant",
      ";; a harness's project config, which a harness run as the owner loads.",
      "(deny file-write* " + denied.join(" ") + ")",
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
    if ("entry" in helper) {
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
  if (policy.network) lines.push(";; IP networking only: unix sockets (office, tmux) stay denied.", ...NETWORK_RULES)
  return lines.join("\n") + "\n"
}

/**
 * Returns the default-deny SBPL profile for the SSH-only `policy`.
 *
 * Allowed: what every profile allows of the system, plus ssh's and Kerberos's configuration, read-only; the
 * policy's read-only paths (`~/.ssh` among them); the data of its writable files (`known_hosts`, the status file, a
 * ticket), which can't be removed, renamed or replaced; its temp folder; binding and reaching the shell's own
 * control sockets in `controlDir`; connecting to the owner's control sockets in `socketFolders` (`~/.ssh` and their
 * ControlPath folder), to the agent's socket and to a KCM's, and nothing more on them; and IP networking with the
 * DNS responder. The setuid programs macOS ships can't run. `canary`, `developerDir` and `tty`
 * are `profile`'s. Unverified on macOS.
 */
export function sshProfile(
  policy: SshPolicy,
  options: { canary?: string; developerDir?: string | null; tty?: boolean } = {},
): string {
  const developer = options.developerDir === undefined ? developerDir() : options.developerDir
  const lines = head(developer, options.tty ?? false, {
    processes: [
      ";; Setuid programs: Seatbelt can't see a setuid bit, so the ones macOS ships are refused by name.",
      "(deny process-exec* " + SETUID_PROGRAMS.map((p) => `(literal ${quote(p)})`).join(" ") + ")",
    ],
    system: [
      ";; ssh's and Kerberos's system configuration, read-only.",
      allow("file-read*", [
        ...SSH_SYSTEM_SUBPATHS.map((p) => `(subpath ${quote(p)})`),
        ...SSH_SYSTEM_LITERALS.map((p) => `(literal ${quote(p)})`),
      ]),
    ],
  })
  lines.push(
    ...metadata(
      [...policy.readOnly, ...policy.writable, ...policy.readWrite, ...policy.sockets, policy.tmpdir],
      developer,
    ),
    ";; ~/.ssh, the files ssh -G names, hq/ssh and any extra paths, read-only.",
    allow("file-read*", policy.readOnly.map((p) => `(subpath ${quote(p)})`)),
    ";; known_hosts, this call's status file and a ticket file: their data only, " +
      "so none is removed, renamed or replaced.",
    allow("file-read* file-write-data", policy.writable.map((p) => `(literal ${quote(p)})`)),
    ";; The private temp directory, which holds the shell's own control sockets.",
    `(allow file-read* file-write* (subpath ${quote(policy.tmpdir)}))`,
    ...(policy.readWrite.length > 0
      ? [
          ";; A test's own folder, read-write.",
          allow("file-read* file-write*", policy.readWrite.map((p) => `(subpath ${quote(p)})`)),
        ]
      : []),
    ";; ssh's control sockets: the shell's masters bind theirs in its own folder, and its calls connect there.",
    `(allow network-bind network-inbound network-outbound (subpath ${quote(policy.controlDir)}))`,
    ";; The user's own control sockets, in ~/.ssh and their ControlPath folder: connected to, never bound.",
    allow("network-outbound", policy.socketFolders.map((p) => `(subpath ${quote(p)})`)),
  )
  if (policy.sockets.length > 0) {
    lines.push(
      ";; The agent's socket and a KCM's: connected to, nothing more.",
      allow("file-read-metadata", policy.sockets.map((p) => `(literal ${quote(p)})`)),
      allow("network-outbound", policy.sockets.map((p) => `(remote unix-socket (path-literal ${quote(p)}))`)),
    )
  }
  if (options.canary !== undefined) {
    lines.push(
      ";; Marks this call's processes; see sandbox.escapees.",
      `(allow file-write-data (literal ${quote(options.canary)}))`,
    )
  }
  lines.push(";; The network: IP, and the DNS responder.", ...NETWORK_RULES)
  return lines.join("\n") + "\n"
}

/** Every profile's first lines: the processes (then `more.processes`), sysctls, the system's mach services, the
 *  system and toolchain read-only (then `more.system`), the call's own descriptors, and its terminal with `tty`. */
function head(
  developer: string | null,
  tty: boolean,
  more: { processes?: readonly string[]; system?: readonly string[] } = {},
): string[] {
  const lines = [
    "(version 1)",
    "(deny default)",
    ";; Processes: children inherit this profile; no reach into other processes.",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    ...(more.processes ?? []),
    allow("sysctl-read", [
      ...SYSCTL_PREFIXES.map((p) => `(sysctl-name-prefix ${quote(p)})`),
      ...SYSCTL_NAMES.map((n) => `(sysctl-name ${quote(n)})`),
    ]),
    allow("mach-lookup", MACH_SERVICES.map((n) => `(global-name ${quote(n)})`)),
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    ";; System and toolchain, read-only.",
    allow("file-read*", [
      '(literal "/")',
      ...SYSTEM_SUBPATHS.map((p) => `(subpath ${quote(p)})`),
      ...(developer ? [`(subpath ${quote(developer)})`] : []),
      ...SYSTEM_LITERALS.map((p) => `(literal ${quote(p)})`),
    ]),
    ...(more.system ?? []),
    '(allow file-write-data (literal "/dev/null"))',
    ";; The call's own descriptors by path, so `echo x > /dev/stderr` works.",
    '(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))',
  ]
  if (tty) lines.push(TTY_RULE)
  return lines
}

/** The metadata rule for the ancestors of `readable` and the developer dir, after its comment. */
function metadata(readable: readonly string[], developer: string | null): string[] {
  const paths = [...ROOT_LINKS, ...ancestors(developer ? [...readable, developer] : readable)]
  return [
    ";; Ancestors of allowed paths: metadata only, so lookups and realpath work.",
    allow("file-read-metadata", paths.map((p) => `(literal ${quote(p)})`)),
  ]
}

function allow(op: string, filters: readonly string[]): string {
  return `(allow ${op} ` + filters.join(" ") + ")"
}

/** Quotes a string for SBPL. */
function quote(value: string): string {
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"'
}

/** The ancestors of each of `paths` (not the path itself), nearest first, each listed once; `/` has none. */
function ancestors(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const p of paths) {
    for (let dir = p; path.dirname(dir) !== dir; ) {
      dir = path.dirname(dir)
      seen.add(dir)
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
    // Missing or dangling link: no toolchain to allow.
    return null
  }
}

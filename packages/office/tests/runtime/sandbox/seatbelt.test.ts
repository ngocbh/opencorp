/** Seatbelt (macOS `sandbox-exec`) profiles for sandboxed calls. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { SandboxPolicy } from "../../../src/runtime/sandbox/policy.ts"
import { MACH_SERVICES, NETWORK_MACH_SERVICES, profile, sshProfile } from "../../../src/runtime/sandbox/seatbelt.ts"
import { goldenPolicy, goldenSshPolicy, makePolicy } from "./helpers.ts"

/** `makePolicy()` with the read-only path `<root>/py` (Python's `make` fixture). */
function setup() {
  const { root, make } = makePolicy()
  const extra = path.join(root, "py")
  fs.mkdirSync(extra)
  return { root, make: (opts: { writable?: boolean; network?: boolean } = {}) => make({ ...opts, readOnly: [extra] }) }
}

/** The lines of `text` that allow or deny `op`. */
function rules(text: string, op: string): string[] {
  return text.split("\n").filter((line) => line.startsWith(`(allow ${op}`) || line.startsWith(`(deny ${op}`))
}

test("denies by default", () => {
  const text = profile(setup().make())
  expect(text.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"])
})

test("the workspace shell keeps .codex, .agents, .claude and .mcp.json read-only, as it keeps .git", () => {
  const policy = setup().make()
  const text = profile(policy)
  const ws = policy.workspace
  const allow = `(allow file-read* file-write* (subpath "${ws}"))`
  // Seatbelt matches a path that doesn't exist yet too, so a missing .mcp.json is held as well.
  const deny =
    `(deny file-write* (literal "${ws}/.git") (subpath "${ws}/.git/hooks") (literal "${ws}/.git/config")` +
    ` (subpath "${ws}/.codex") (subpath "${ws}/.agents") (subpath "${ws}/.claude") (literal "${ws}/.mcp.json"))`
  expect(text).toContain(allow)
  expect(text).toContain(deny)
  // Seatbelt applies the last matching rule, so the deny must come after the allow.
  expect(text.indexOf(deny)).toBeGreaterThan(text.indexOf(allow))
})

test("read only workspace has no write rule", () => {
  const policy = setup().make({ writable: false })
  const text = profile(policy)
  expect(text).toContain(`(allow file-read* (subpath "${policy.workspace}"))`)
  expect(rules(text, "file-write").some((line) => line.includes(policy.workspace))).toBe(false)
})

test("tmpdir and read only paths", () => {
  const policy = setup().make()
  const text = profile(policy)
  expect(text).toContain(`(allow file-read* file-write* (subpath "${policy.tmpdir}"))`)
  expect(text).toContain(`(allow file-read* (subpath "${policy.readOnly[0]}"))`)
})

test("ancestors get metadata only", () => {
  const policy = setup().make()
  const text = profile(policy)
  const parent = path.dirname(policy.workspace)
  expect(rules(text, "file-read-metadata").join("\n")).toContain(`(literal "${parent}")`)
  expect(text).not.toContain(`(subpath "${parent}")`)
})

test("no network rules when off", () => {
  const text = profile(setup().make({ network: false }))
  expect(rules(text, "network")).toEqual([])
  expect(text).not.toContain("com.apple.dnssd.service")
})

test("network is ip only when on", () => {
  const text = profile(setup().make({ network: true }))
  expect(text).toContain("(allow network-outbound (remote ip))")
  // Unix sockets (the office socket, tmux) stay closed; only the DNS responder opens.
  const unix = text.split("\n").filter((line) => line.includes("unix-socket"))
  expect(unix).toEqual(['(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'])
  expect(text).not.toContain("(allow network*)")
  expect(text).not.toContain("(allow network-outbound)")
})

test("mach lookups are the minimal set", () => {
  const { make } = setup()
  for (const network of [false, true]) {
    const text = profile(make({ network }))
    const names = new Set([...text.matchAll(/\(global-name "([^"]+)"\)/g)].map((m) => m[1]!))
    const expected = new Set([...MACH_SERVICES, ...(network ? NETWORK_MACH_SERVICES : [])])
    expect(names).toEqual(expected)
    // No Apple Events, LaunchServices, or pasteboard.
    expect(
      [...names].some((n) => n.includes("appleevents") || n.includes("launchservices") || n.includes("pasteboard")),
    ).toBe(false)
  }
})

test("sysctl read is a list", () => {
  const text = profile(setup().make())
  expect(text).not.toContain("(allow sysctl-read)")
  expect(text.includes('(sysctl-name "hw.ncpu")') || text.includes('(sysctl-name-prefix "hw.")')).toBe(true)
})

test("process rules stay in the sandbox", () => {
  const text = profile(setup().make())
  expect(text).toContain("(allow signal (target same-sandbox))")
  expect(text).toContain("(allow process-info* (target same-sandbox))")
})

test("std stream paths", () => {
  const text = profile(setup().make())
  expect(text).toContain(
    '(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))',
  )
})

test("canary gets a write data rule", () => {
  const { root, make } = setup()
  const policy = make()
  expect(profile(policy).replaceAll('(literal "/dev/null")', "")).not.toContain("file-write-data (literal")
  const canary = path.join(root, "canary")
  const text = profile(policy, { canary })
  expect(text).toContain(`(allow file-write-data (literal "${canary}"))`)
})

test("quotes in paths are escaped", () => {
  const { root, tmp } = makePolicy()
  const ws = path.join(root, 'we"ird\\ws')
  fs.mkdirSync(ws)
  const policy = new SandboxPolicy({ workspace: ws, writable: true, network: false, tmpdir: tmp })
  const text = profile(policy)
  expect(policy.workspace.endsWith('/we"ird\\ws')).toBe(true)
  expect(text).toContain('(subpath "' + policy.workspace.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '")')
})

/** Block G2 of the Python office's goldens: read-only, networked, a read-only path, no developer dir, no canary. */
const G2 = `(version 1)
(deny default)
;; Processes: children inherit this profile; no reach into other processes.
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.") (sysctl-name "kern.argmax") (sysctl-name "kern.boottime") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.ngroups") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center"))
(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))
;; System and toolchain, read-only.
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/private/etc/ssl") (subpath "/private/var/db/timezone") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/etc/services") (literal "/private/etc/protocols") (literal "/private/etc/localtime") (literal "/private/etc/passwd") (literal "/private/etc/group") (literal "/private/etc/shells") (literal "/private/var/select/sh") (literal "/private/var/select/developer_dir") (literal "/private/var/db/xcode_select_link") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write-data (literal "/dev/null"))
;; The call's own descriptors by path, so \`echo x > /dev/stderr\` works.
(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))
;; Ancestors of allowed paths: metadata only, so lookups and realpath work.
(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var") (literal "/Users/me") (literal "/Users") (literal "/") (literal "/Users/me/.opencorp/office/sessions/s1") (literal "/Users/me/.opencorp/office/sessions") (literal "/Users/me/.opencorp/office") (literal "/Users/me/.opencorp") (literal "/opt/tools") (literal "/opt"))
;; The workspace.
(allow file-read* (subpath "/Users/me/project"))
;; The private temp directory.
(allow file-read* file-write* (subpath "/Users/me/.opencorp/office/sessions/s1/tmp"))
(allow file-read* (subpath "/opt/tools/python"))
;; IP networking only: unix sockets (office, tmux) stay denied.
(allow network-outbound (remote ip))
(allow network-inbound (local ip))
(allow network-bind (local ip))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.trustd.agent"))
`

/** Block G1 of the Python office's goldens up to the tmpdir rule, with the harnesses' project config write-denied:
 *  writable, offline, a developer dir. */
const G1_HEAD = `(version 1)
(deny default)
;; Processes: children inherit this profile; no reach into other processes.
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.") (sysctl-name "kern.argmax") (sysctl-name "kern.boottime") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.ngroups") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center"))
(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))
;; System and toolchain, read-only.
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/private/etc/ssl") (subpath "/private/var/db/timezone") (subpath "/Library/Developer/CommandLineTools") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/etc/services") (literal "/private/etc/protocols") (literal "/private/etc/localtime") (literal "/private/etc/passwd") (literal "/private/etc/group") (literal "/private/etc/shells") (literal "/private/var/select/sh") (literal "/private/var/select/developer_dir") (literal "/private/var/db/xcode_select_link") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write-data (literal "/dev/null"))
;; The call's own descriptors by path, so \`echo x > /dev/stderr\` works.
(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))
;; Ancestors of allowed paths: metadata only, so lookups and realpath work.
(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var") (literal "/Users/me") (literal "/Users") (literal "/") (literal "/Users/me/.opencorp/office/sessions/s1") (literal "/Users/me/.opencorp/office/sessions") (literal "/Users/me/.opencorp/office") (literal "/Users/me/.opencorp") (literal "/Library/Developer") (literal "/Library"))
;; The workspace.
(allow file-read* file-write* (subpath "/Users/me/project"))
;; Model code must not plant git hooks or config the owner later runs
;; unsandboxed, nor rename .git to swap in a planted one, nor plant
;; a harness's project config, which a harness run as the owner loads.
(deny file-write* (literal "/Users/me/project/.git") (subpath "/Users/me/project/.git/hooks") (literal "/Users/me/project/.git/config") (subpath "/Users/me/project/.codex") (subpath "/Users/me/project/.agents") (subpath "/Users/me/project/.claude") (literal "/Users/me/project/.mcp.json"))
;; The private temp directory.
(allow file-read* file-write* (subpath "/Users/me/.opencorp/office/sessions/s1/tmp"))
`

/** The canary block of G1. */
const CANARY = `;; Marks this call's processes; see sandbox.escapees.
(allow file-write-data (literal "/private/tmp/oc-canary-1/allowed"))
`

/** G1_HEAD with the read-only path `/opt/tools/python`, as the Python office writes it. */
const G5_HEAD = `(version 1)
(deny default)
;; Processes: children inherit this profile; no reach into other processes.
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.") (sysctl-name "kern.argmax") (sysctl-name "kern.boottime") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.ngroups") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center"))
(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))
;; System and toolchain, read-only.
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/private/etc/ssl") (subpath "/private/var/db/timezone") (subpath "/Library/Developer/CommandLineTools") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/etc/services") (literal "/private/etc/protocols") (literal "/private/etc/localtime") (literal "/private/etc/passwd") (literal "/private/etc/group") (literal "/private/etc/shells") (literal "/private/var/select/sh") (literal "/private/var/select/developer_dir") (literal "/private/var/db/xcode_select_link") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write-data (literal "/dev/null"))
;; The call's own descriptors by path, so \`echo x > /dev/stderr\` works.
(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))
;; Ancestors of allowed paths: metadata only, so lookups and realpath work.
(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var") (literal "/Users/me") (literal "/Users") (literal "/") (literal "/Users/me/.opencorp/office/sessions/s1") (literal "/Users/me/.opencorp/office/sessions") (literal "/Users/me/.opencorp/office") (literal "/Users/me/.opencorp") (literal "/opt/tools") (literal "/opt") (literal "/Library/Developer") (literal "/Library"))
;; The workspace.
(allow file-read* file-write* (subpath "/Users/me/project"))
;; Model code must not plant git hooks or config the owner later runs
;; unsandboxed, nor rename .git to swap in a planted one, nor plant
;; a harness's project config, which a harness run as the owner loads.
(deny file-write* (literal "/Users/me/project/.git") (subpath "/Users/me/project/.git/hooks") (literal "/Users/me/project/.git/config") (subpath "/Users/me/project/.codex") (subpath "/Users/me/project/.agents") (subpath "/Users/me/project/.claude") (literal "/Users/me/project/.mcp.json"))
;; The private temp directory.
(allow file-read* file-write* (subpath "/Users/me/.opencorp/office/sessions/s1/tmp"))
(allow file-read* (subpath "/opt/tools/python"))
`

/** The install block for G3 to G5's two install folders. */
const INSTALL = `;; The office install: model code must not replace a file the office runs unsandboxed.
(deny file-write* (subpath "/Users/me/.npm-global/lib/node_modules/opencorp-darwin-arm64") (subpath "/Users/me/.npm-global/lib/node_modules/opencorp"))
`

/** The compiled helper's block for G4. */
const BINARY_HELPER = `;; The file helper only: read (and so run) its own files; metadata on their folders.
(allow file-read* (literal "/Users/me/.npm-global/lib/node_modules/opencorp-darwin-arm64/bin/opencorp"))
(allow file-read-metadata (literal "/Users/me/.npm-global/lib/node_modules/opencorp-darwin-arm64/bin") (literal "/Users/me/.npm-global/lib/node_modules/opencorp-darwin-arm64") (literal "/Users/me/.npm-global/lib/node_modules") (literal "/Users/me/.npm-global/lib") (literal "/Users/me/.npm-global") (literal "/Users/me") (literal "/Users") (literal "/"))
`

/** The checkout helper's block for G5. */
const CHECKOUT_HELPER = `;; The file helper only: read (and so run) its own files; metadata on their folders.
(allow file-read* (literal "/Users/me/.bun/bin/bun") (literal "/Users/me/src/opencorp/packages/office/src/sandbox/fs_helper.ts"))
(allow file-read-metadata (literal "/Users/me/.bun/bin") (literal "/Users/me/.bun") (literal "/Users/me") (literal "/Users") (literal "/") (literal "/Users/me/src/opencorp/packages/office/src/sandbox") (literal "/Users/me/src/opencorp/packages/office/src") (literal "/Users/me/src/opencorp/packages/office") (literal "/Users/me/src/opencorp/packages") (literal "/Users/me/src/opencorp") (literal "/Users/me/src"))
;; Bun lists the folder of the file it runs.
(allow file-read-data (literal "/Users/me/src/opencorp/packages/office/src/sandbox"))
`

/** G5's install block. */
const CHECKOUT_INSTALL = `;; The office install: model code must not replace a file the office runs unsandboxed.
(deny file-write* (subpath "/Users/me/src/opencorp"))
`

const G1 = G1_HEAD + CANARY
const G3 = G1 + INSTALL
const G4 = G1_HEAD + BINARY_HELPER + CANARY + INSTALL
const G5 = G5_HEAD + CHECKOUT_HELPER + CANARY + CHECKOUT_INSTALL

const SHELL = {
  workspace: "/Users/me/project",
  writable: true,
  network: false,
  tmpdir: "/Users/me/.opencorp/office/sessions/s1/tmp",
}
const SHELL_OPTIONS = { canary: "/private/tmp/oc-canary-1/allowed", developerDir: "/Library/Developer/CommandLineTools" }
const INSTALL_PATHS = [
  "/Users/me/.npm-global/lib/node_modules/opencorp-darwin-arm64",
  "/Users/me/.npm-global/lib/node_modules/opencorp",
]
const BINARY = { binary: "/Users/me/.npm-global/lib/node_modules/opencorp-darwin-arm64/bin/opencorp" }
const CHECKOUT = {
  bun: "/Users/me/.bun/bin/bun",
  entry: "/Users/me/src/opencorp/packages/office/src/sandbox/fs_helper.ts",
}

test("a shell profile equals the Python profile byte for byte", () => {
  expect(profile(goldenPolicy(SHELL), SHELL_OPTIONS)).toBe(G1)
  const g2 = goldenPolicy({ ...SHELL, writable: false, network: true, readOnly: ["/opt/tools/python"] })
  expect(profile(g2, { developerDir: null })).toBe(G2)
})

test("the install is write denied after every file allow", () => {
  const policy = goldenPolicy({ ...SHELL, install: INSTALL_PATHS })
  const text = profile(policy, SHELL_OPTIONS)
  expect(text).toBe(G3)
  const lines = text.split("\n")
  const deny = lines.findIndex((line) => line.startsWith("(deny file-write* (subpath"))
  expect(deny).toBeGreaterThan(lines.indexOf('(allow file-read* file-write* (subpath "/Users/me/project"))'))
  expect(deny).toBeGreaterThan(
    lines.indexOf('(allow file-read* file-write* (subpath "/Users/me/.opencorp/office/sessions/s1/tmp"))'),
  )
  expect(deny).toBeGreaterThan(lines.indexOf('(allow file-write-data (literal "/private/tmp/oc-canary-1/allowed"))'))
  // Seatbelt applies the last matching rule, so no file allow may follow the deny.
  expect(lines.slice(deny).some((line) => line.startsWith("(allow file-"))).toBe(false)
})

test("the compiled helper profile adds only the helper rules", () => {
  const policy = goldenPolicy({ ...SHELL, install: INSTALL_PATHS, helper: BINARY })
  expect(profile(policy, SHELL_OPTIONS)).toBe(G4)
})

test("the checkout helper profile adds only the helper rules and lists the entry folder", () => {
  const policy = goldenPolicy({
    ...SHELL,
    readOnly: ["/opt/tools/python"],
    install: ["/Users/me/src/opencorp"],
    helper: CHECKOUT,
  })
  expect(profile(policy, SHELL_OPTIONS)).toBe(G5)
})

test("a shell profile has no helper rule", () => {
  const texts = [
    profile(goldenPolicy(SHELL), SHELL_OPTIONS),
    profile(goldenPolicy({ ...SHELL, install: INSTALL_PATHS }), SHELL_OPTIONS),
  ]
  for (const text of texts) {
    expect(text).not.toContain("file-read-data")
    for (const file of [BINARY.binary, CHECKOUT.bun, CHECKOUT.entry, path.dirname(CHECKOUT.entry)])
      expect(text).not.toContain(file)
  }
})

/** The rule a terminal profile adds: the call's controlling terminal, and the one PTY slave sandbox-exec names as
 *  the `TTY` parameter. */
const TTY = '(allow file-read* file-write* file-ioctl (literal "/dev/tty") (literal (param "TTY")))\n'
/** The line it follows. */
const DEV_FD = '(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))\n'

test("a terminal profile lets the call use its own terminal and nothing else's", () => {
  // Unverified on macOS: only the profile's text is checked here.
  const policy = goldenPolicy(SHELL)
  expect(G1.split(DEV_FD)).toHaveLength(2)
  const text = profile(policy, { ...SHELL_OPTIONS, tty: true })
  expect(text).toBe(G1.replace(DEV_FD, DEV_FD + TTY))
  // One device by its exact path, never a pattern that could name another terminal.
  expect(text.match(/\(param "TTY"\)/g)).toHaveLength(1)
  expect(text).not.toContain("regex")
  expect(text).not.toContain("/dev/ttys")
  expect(profile(policy, { ...SHELL_OPTIONS, tty: false })).toBe(G1)
  expect(profile(policy, SHELL_OPTIONS)).toBe(G1)
})

/** The SSH-only profile for `SSH_LAYOUT` on a terminal, with a developer dir and a canary. */
const SSH_G1 = `(version 1)
(deny default)
;; Processes: children inherit this profile; no reach into other processes.
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
;; Setuid programs: Seatbelt can't see a setuid bit, so the ones macOS ships are refused by name.
(deny process-exec* (literal "/usr/bin/sudo") (literal "/usr/bin/su") (literal "/usr/bin/login") (literal "/usr/bin/newgrp") (literal "/usr/bin/passwd") (literal "/usr/libexec/ssh-keysign"))
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.") (sysctl-name "kern.argmax") (sysctl-name "kern.boottime") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.ngroups") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center"))
(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))
;; System and toolchain, read-only.
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/private/etc/ssl") (subpath "/private/var/db/timezone") (subpath "/Library/Developer/CommandLineTools") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/etc/services") (literal "/private/etc/protocols") (literal "/private/etc/localtime") (literal "/private/etc/passwd") (literal "/private/etc/group") (literal "/private/etc/shells") (literal "/private/var/select/sh") (literal "/private/var/select/developer_dir") (literal "/private/var/db/xcode_select_link") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
;; ssh's and Kerberos's system configuration, read-only.
(allow file-read* (subpath "/private/etc/ssh") (subpath "/private/etc/krb5.conf.d") (literal "/private/etc/krb5.conf"))
(allow file-write-data (literal "/dev/null"))
;; The call's own descriptors by path, so \`echo x > /dev/stderr\` works.
(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))
(allow file-read* file-write* file-ioctl (literal "/dev/tty") (literal (param "TTY")))
;; Ancestors of allowed paths: metadata only, so lookups and realpath work.
(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var") (literal "/Users/me") (literal "/Users") (literal "/") (literal "/Users/me/keys") (literal "/Users/me/.opencorp/hq") (literal "/Users/me/.opencorp") (literal "/Users/me/.ssh") (literal "/Users/me/.opencorp/hq/ssh") (literal "/private/tmp") (literal "/private") (literal "/private/tmp/com.apple.launchd.abc") (literal "/Library/Developer") (literal "/Library"))
;; ~/.ssh, the files ssh -G names, the destination's hq/<name>/ssh and any extra paths, read-only.
(allow file-read* (subpath "/Users/me/.ssh") (subpath "/Users/me/keys/id") (subpath "/Users/me/.opencorp/hq/ssh"))
;; known_hosts, this call's status file and a ticket file: their data only, so none is removed, renamed or replaced.
(allow file-read* file-write-data (literal "/Users/me/.ssh/known_hosts") (literal "/Users/me/.opencorp/hq/ssh/status.4242") (literal "/private/tmp/krb5cc_501"))
;; The private temp directory, which holds the shell's own control sockets.
(allow file-read* file-write* (subpath "/private/tmp/oc-ssh-1"))
;; ssh's control sockets: the shell's masters bind theirs in its own folder, and its calls connect there.
(allow network-bind network-inbound network-outbound (subpath "/private/tmp/oc-ssh-1/cm"))
;; The user's own control sockets, in ~/.ssh and their ControlPath folder: connected to, never bound.
(allow network-outbound (subpath "/Users/me/.ssh"))
;; The agent's socket and a KCM's: connected to, nothing more.
(allow file-read-metadata (literal "/private/tmp/com.apple.launchd.abc/Listeners"))
(allow network-outbound (remote unix-socket (path-literal "/private/tmp/com.apple.launchd.abc/Listeners")))
;; Marks this call's processes; see sandbox.escapees.
(allow file-write-data (literal "/private/tmp/oc-canary-1/allowed"))
;; The network: IP, and the DNS responder.
(allow network-outbound (remote ip))
(allow network-inbound (local ip))
(allow network-bind (local ip))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.trustd.agent"))
`

const SSH_LAYOUT = {
  home: "/Users/me",
  hq: "/Users/me/.opencorp/hq",
  tmpdir: "/private/tmp/oc-ssh-1",
  statusFile: "/Users/me/.opencorp/hq/ssh/status.4242",
  bound: ["/Users/me/keys/id"],
  agentSocket: "/private/tmp/com.apple.launchd.abc/Listeners",
  ticket: "/private/tmp/krb5cc_501",
}

test("the SSH-only profile allows exactly those paths and the network", () => {
  // Unverified on macOS: only the profile's text is checked here.
  const policy = goldenSshPolicy(SSH_LAYOUT)
  expect(sshProfile(policy, { ...SHELL_OPTIONS, tty: true })).toBe(SSH_G1)
  // Off a terminal, the terminal rule goes and nothing else changes.
  expect(sshProfile(policy, SHELL_OPTIONS)).toBe(SSH_G1.replace(TTY, ""))
  // No hq file but ssh/, nothing writable there or in ~/.ssh but known_hosts and the status file's data, and no
  // unix socket but the shell's own, the agent's and the DNS responder's.
  const text = sshProfile(policy, SHELL_OPTIONS)
  expect(text).not.toContain("provider.json")
  expect(text).not.toContain("auth.json")
  expect(text).not.toContain('(subpath "/Users/me")')
  expect(text).not.toContain('(subpath "/Users/me/.opencorp/hq")')
  expect(text).not.toContain("/Users/me/.opencorp/hq/cm")
  const lines = text.split("\n")
  const writes = lines.filter((l) => l.includes("file-write") && l.includes("/Users/me"))
  expect(writes).toEqual([
    '(allow file-read* file-write-data (literal "/Users/me/.ssh/known_hosts") (literal "/Users/me/.opencorp/hq/ssh/status.4242") (literal "/private/tmp/krb5cc_501"))',
  ])
  // Seatbelt applies the last matching rule, so the setuid deny follows the exec allow.
  expect(lines.findIndex((l) => l.startsWith("(deny process-exec*"))).toBeGreaterThan(
    lines.indexOf("(allow process-exec process-fork)"),
  )
})

test("the profile lets a call connect to sockets in ~/.ssh and the ControlPath folder, and write nothing there", () => {
  // Unverified on macOS: only the profile's text is checked here.
  const policy = goldenSshPolicy({ ...SSH_LAYOUT, bound: ["/Users/me/keys/id", "/Users/me/cm"], controlFolders: ["/Users/me/cm"] })
  const lines = sshProfile(policy, SHELL_OPTIONS).split("\n")
  const at = lines.indexOf(";; The user's own control sockets, in ~/.ssh and their ControlPath folder: connected to, never bound.")
  expect(lines.slice(at, at + 2)).toEqual([
    ";; The user's own control sockets, in ~/.ssh and their ControlPath folder: connected to, never bound.",
    '(allow network-outbound (subpath "/Users/me/.ssh") (subpath "/Users/me/cm"))',
  ])
  expect(lines).toContain('(allow file-read* (subpath "/Users/me/.ssh") (subpath "/Users/me/keys/id") (subpath "/Users/me/cm") (subpath "/Users/me/.opencorp/hq/ssh"))')
  // Read and connected to only: no write, bind or listen there.
  const there = lines.filter((l) => l.includes('"/Users/me/cm"') || l.includes('(subpath "/Users/me/.ssh")'))
  expect(there.filter((l) => /file-write|network-bind|network-inbound/.test(l))).toEqual([])
  expect(lines.filter((l) => l.includes("file-write") && l.includes("/Users/me/"))).toEqual([
    '(allow file-read* file-write-data (literal "/Users/me/.ssh/known_hosts") (literal "/Users/me/.opencorp/hq/ssh/status.4242") (literal "/private/tmp/krb5cc_501"))',
  ])
})

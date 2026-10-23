/** Seatbelt (macOS `sandbox-exec`) profiles for sandboxed calls. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { SandboxPolicy } from "../../src/sandbox/policy.ts"
import { MACH_SERVICES, NETWORK_MACH_SERVICES, profile } from "../../src/sandbox/seatbelt.ts"
import { goldenPolicy, makePolicy } from "./helpers.ts"

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

test("workspace read write with git protected", () => {
  const policy = setup().make()
  const text = profile(policy)
  const ws = policy.workspace
  const allow = `(allow file-read* file-write* (subpath "${ws}"))`
  const deny = `(deny file-write* (literal "${ws}/.git") (subpath "${ws}/.git/hooks") (literal "${ws}/.git/config"))`
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
  const text = profile(new SandboxPolicy({ workspace: ws, writable: true, network: false, tmpdir: tmp }))
  // `root` is already real; Bun's realpathSync fails on a path with a backslash.
  expect(text).toContain('(subpath "' + ws.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '")')
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

/** Block G1 of the Python office's goldens up to the tmpdir rule: writable, offline, a developer dir. */
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
;; unsandboxed, nor rename .git to swap in a planted one.
(deny file-write* (literal "/Users/me/project/.git") (subpath "/Users/me/project/.git/hooks") (literal "/Users/me/project/.git/config"))
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
;; unsandboxed, nor rename .git to swap in a planted one.
(deny file-write* (literal "/Users/me/project/.git") (subpath "/Users/me/project/.git/hooks") (literal "/Users/me/project/.git/config"))
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

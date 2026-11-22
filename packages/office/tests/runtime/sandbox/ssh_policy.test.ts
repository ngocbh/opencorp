/** The SSH-only sandbox: what OpenCorp's `hq` shell may touch, checked on its policy and through the real sandbox. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { run, startOnTerminal } from "../../../src/runtime/sandbox/run.ts"
import { SETUID_PROGRAMS } from "../../../src/runtime/sandbox/seatbelt.ts"
import { includedConfigs, REAL_SSH, SshPolicy, type SshPolicyInit, sshFiles } from "../../../src/runtime/sandbox/ssh_policy.ts"
import { installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { tempDir, waitFor } from "../../helpers.ts"
import { sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A temp home as the profile meets it: `.ssh` with a config, a key and known_hosts; a secret and a `.bashrc`
 *  beside it; and `.opencorp` with hq's key, sign-in, the visit's ssh files and `cm/`, a learned file, a
 *  connection and the company. `make` builds a policy over it, with `<root>/tmp` as the call's temp folder and
 *  `hq/ssh/status.4242` as its status file. */
function layout() {
  const root = tempDir()
  const home = path.join(root, "home")
  const ssh = path.join(home, ".ssh")
  const office = path.join(home, ".opencorp")
  const hq = path.join(office, "hq")
  const tmp = path.join(root, "tmp")
  const file = (p: string, text: string, mode = 0o600) => {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
    fs.writeFileSync(p, text, { mode })
    return p
  }
  file(path.join(ssh, "config"), "Host *\n")
  file(path.join(ssh, "id_test"), "decoy-ssh-key\n")
  file(path.join(ssh, "known_hosts"), "h ssh-ed25519 AAAA\n")
  file(path.join(home, "secret.txt"), "decoy-secret\n")
  file(path.join(home, ".bashrc"), "# rc\n")
  file(path.join(hq, "provider.json"), '{"key":"decoy-provider"}\n')
  file(path.join(hq, "auth.json"), '{"token":"decoy-auth"}\n')
  file(path.join(hq, "learned.json"), "{}\n")
  file(path.join(hq, "ssh", "config"), "# Written by opencorp hq on each visit; edits are lost.\n")
  file(path.join(hq, "ssh", "bin", "ssh"), "#!/bin/sh\n", 0o700)
  file(path.join(office, "office", "connections", "work.json"), '{"token":"decoy-connection"}\n')
  file(path.join(office, "company", "rules.yaml"), "[]\n")
  fs.mkdirSync(path.join(hq, "cm"), { mode: 0o700 })
  fs.mkdirSync(tmp)
  const statusFile = path.join(hq, "ssh", "status.4242")
  return {
    root,
    home,
    ssh,
    hq,
    tmp,
    file,
    statusFile,
    knownHosts: path.join(ssh, "known_hosts"),
    bashrc: path.join(home, ".bashrc"),
    provider: path.join(hq, "provider.json"),
    auth: path.join(hq, "auth.json"),
    connection: path.join(office, "office", "connections", "work.json"),
    make: (more: Partial<SshPolicyInit> = {}) => new SshPolicy({ home, hq, tmpdir: tmp, statusFile, ...more }),
  }
}

const mode = (p: string) => fs.statSync(p).mode & 0o777
const identity = (p: string) => ({ kind: "identity" as const, path: p })

/** A unix socket listening at `p` until the test ends. */
async function listening(p: string): Promise<string> {
  const server = net.createServer((c) => c.destroy())
  await new Promise<void>((resolve) => server.listen(p, resolve))
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return p
}

test("an SSH-only policy binds ~/.ssh read-only, known_hosts and the status file for data, and nothing of hq/cm", () => {
  const h = layout()
  const policy = h.make()
  expect(policy.kind).toBe("ssh")
  expect(policy.home).toBe(h.home)
  expect(policy.tmpdir).toBe(h.tmp)
  expect(policy.readOnly).toEqual([h.ssh, path.join(h.hq, "ssh")])
  expect(policy.writable).toEqual([h.knownHosts, h.statusFile])
  expect(policy.sockets).toEqual([])
  expect(policy.agentSocket).toBeNull()
  expect(policy.ccache).toBeNull()
  expect(policy.credentials).toEqual([])
  expect(policy.notes).toEqual([])
  // The shell's own control sockets go in its temp folder; the office's, in hq/cm, are never mounted.
  expect(policy.controlDir).toBe(path.join(h.tmp, "cm"))
  expect(fs.statSync(policy.controlDir).isDirectory()).toBe(true)
  expect(mode(policy.controlDir)).toBe(0o700)
  const lists = [...policy.readOnly, ...policy.writable, ...policy.sockets]
  expect(lists.filter((p) => p.startsWith(path.join(h.hq, "cm")))).toEqual([])
  // Created first, private, so the bind has a source for the wrapper's appends.
  expect(fs.readFileSync(h.statusFile, "utf8")).toBe("")
  expect(mode(h.statusFile)).toBe(0o600)
})

test("the agent's socket and a ticket are bound where they resolve, and a ticket counts as a credential", async () => {
  const h = layout()
  const agent = await listening(path.join(h.root, "agent.sock"))
  fs.symlinkSync(agent, path.join(h.root, "agent-link"))
  const ticket = h.file(path.join(h.root, "krb5cc_test"), "ticket")
  const extra = path.join(h.root, "extra")
  fs.mkdirSync(extra)
  const policy = h.make({ agentSocket: path.join(h.root, "agent-link"), kerberos: `FILE:${ticket}`, readOnly: [extra] })
  expect(policy.readOnly).toEqual([h.ssh, path.join(h.hq, "ssh"), extra])
  expect(policy.writable).toEqual([h.knownHosts, h.statusFile, ticket])
  expect(policy.sockets).toEqual([agent])
  expect(policy.agentSocket).toBe(agent)
  expect(policy.ccache).toBe(`FILE:${ticket}`)
  expect(policy.credentials).toEqual([ticket])
  // A bare path is a file cache too; a KCM socket is one to connect to.
  expect(h.make({ kerberos: ticket }).ccache).toBe(`FILE:${ticket}`)
  const kcm = await listening(path.join(h.root, "kcm.sock"))
  const viaKcm = h.make({ kerberos: kcm })
  expect(viaKcm.sockets).toEqual([kcm])
  expect(viaKcm.ccache).toBeNull()
  expect(viaKcm.credentials).toEqual([])
  // What names no file or socket by its path is left out, with a note: a kernel keyring, a relative path, a file
  // posing as the agent.
  const keyring = h.make({ kerberos: "KEYRING:persistent:1000", agentSocket: ticket })
  expect([keyring.writable, keyring.sockets]).toEqual([[h.knownHosts, h.statusFile], []])
  expect(keyring.notes).toEqual([
    `the agent's socket ${ticket} is not bound: it is not a socket`,
    "the Kerberos cache KEYRING:persistent:1000 is not bound: it names no file or socket by its absolute path",
  ])
  expect(h.make({ kerberos: "FILE:krb5cc" }).notes).toEqual([
    "the Kerberos cache FILE:krb5cc is not bound: it names no file or socket by its absolute path",
  ])
  // Nor is anything of OpenCorp's: the office's own socket, or its files posing as a ticket.
  const officeSocket = await listening(path.join(h.home, ".opencorp", "office", "office.sock"))
  const learned = path.join(h.hq, "learned.json")
  const own = h.make({ agentSocket: officeSocket, kerberos: `FILE:${learned}` })
  expect([own.writable, own.sockets, own.credentials]).toEqual([[h.knownHosts, h.statusFile], [], []])
  expect(own.notes).toEqual([
    `the agent's socket ${officeSocket} is not bound: it is in OpenCorp's home`,
    `the Kerberos cache FILE:${learned} is not bound: it is in OpenCorp's home`,
  ])
})

test("known_hosts is created 0600 when it's missing", () => {
  const h = layout()
  fs.rmSync(h.knownHosts)
  h.make()
  expect(fs.readFileSync(h.knownHosts, "utf8")).toBe("")
  expect(mode(h.knownHosts)).toBe(0o600)
  // One that's there is kept as it is.
  fs.writeFileSync(h.knownHosts, "h ssh-ed25519 AAAA\n")
  fs.chmodSync(h.knownHosts, 0o644)
  h.make()
  expect(fs.readFileSync(h.knownHosts, "utf8")).toBe("h ssh-ed25519 AAAA\n")
  expect(mode(h.knownHosts)).toBe(0o644)
  // With no ~/.ssh at all, it is made 0700 first, as ssh makes it.
  fs.rmSync(h.ssh, { recursive: true })
  h.make()
  expect(mode(h.ssh)).toBe(0o700)
  expect(mode(h.knownHosts)).toBe(0o600)
})

test("a policy that would bind hq, the home, provider.json, auth.json or a connection is refused", () => {
  const h = layout()
  fs.rmSync(h.knownHosts)
  fs.symlinkSync(h.provider, path.join(h.root, "provider-link"))
  fs.linkSync(h.provider, path.join(h.root, "provider-hardlink"))
  fs.linkSync(h.connection, path.join(h.root, "connection-hardlink"))
  const exposed = [
    h.hq,
    h.home,
    h.provider,
    h.auth,
    h.connection,
    path.dirname(h.connection),
    // A bind that holds hq or the home holds them too, a link is judged by where it leads, a hard link by its inode.
    path.join(h.home, ".opencorp"),
    path.dirname(h.home),
    path.join(h.root, "provider-link"),
    path.join(h.root, "provider-hardlink"),
    path.join(h.root, "connection-hardlink"),
  ]
  for (const p of exposed) {
    for (const more of [{ sshFiles: [identity(p)] }, { agentSocket: p }, { kerberos: p }, { readOnly: [p] }]) {
      expect(() => h.make(more), `${JSON.stringify(more)}`).toThrow(UnsafeProfile)
    }
  }
  // The temp folder is written: it may not hold hq or the home, nor lie in hq or ~/.ssh.
  for (const tmpdir of [h.hq, h.home, path.join(h.hq, "ssh"), h.ssh]) {
    expect(() => h.make({ tmpdir }), tmpdir).toThrow(UnsafeProfile)
  }
  expect(() => h.make({ statusFile: h.provider })).toThrow(UnsafeProfile)
  // The status file is bound read-write, so it may only be the wrapper's own, in hq/ssh.
  expect(() => h.make({ statusFile: path.join(h.home, "secret.txt") })).toThrow(UnsafeProfile)
  expect(() => h.make({ statusFile: path.join(h.hq, "cm", "status.4242") })).toThrow(UnsafeProfile)
  // Nothing is created for a policy that is refused.
  expect(fs.existsSync(h.knownHosts)).toBe(false)
  expect(fs.existsSync(h.statusFile)).toBe(false)
  expect(fs.existsSync(path.join(h.tmp, "cm"))).toBe(false)
  expect(() => h.make()).not.toThrow()
})

test("a known_hosts, status file, ticket or socket folder that is a link, or has another hard link, is refused", () => {
  const h = layout()
  const rc = fs.readFileSync(h.bashrc, "utf8")
  const refused = (what: RegExp, more: Partial<SshPolicyInit> = {}) => {
    expect(() => h.make(more)).toThrow(UnsafeProfile)
    expect(() => h.make(more)).toThrow(what)
  }
  const reset = (p: string) => {
    fs.rmSync(p, { recursive: true, force: true })
  }
  // A link would bind its target read-write: known_hosts to ~/.bashrc was the way to write it.
  reset(h.knownHosts)
  fs.symlinkSync(h.bashrc, h.knownHosts)
  refused(/known_hosts .* is a link/)
  reset(h.knownHosts)
  fs.linkSync(h.bashrc, h.knownHosts)
  refused(/known_hosts .* has other hard links/)
  reset(h.knownHosts)
  fs.mkdirSync(h.knownHosts)
  refused(/known_hosts .* is not a regular file/)
  reset(h.knownHosts)
  fs.symlinkSync(h.bashrc, h.statusFile)
  refused(/status file .* is a link/)
  reset(h.statusFile)
  fs.linkSync(h.bashrc, h.statusFile)
  refused(/status file .* has other hard links/)
  reset(h.statusFile)
  const ticket = path.join(h.root, "krb5cc_test")
  fs.symlinkSync(h.bashrc, ticket)
  refused(/Kerberos ticket .* is a link/, { kerberos: `FILE:${ticket}` })
  reset(ticket)
  fs.linkSync(h.bashrc, ticket)
  refused(/Kerberos ticket .* has other hard links/, { kerberos: ticket })
  reset(ticket)
  const cm = path.join(h.tmp, "cm")
  fs.symlinkSync(h.home, cm)
  refused(/socket folder .* is a link/)
  reset(cm)
  fs.writeFileSync(cm, "")
  refused(/socket folder .* is not a folder/)
  reset(cm)
  expect(fs.readFileSync(h.bashrc, "utf8")).toBe(rc)
  expect(() => h.make()).not.toThrow()
})

test("a hard link to a credential inside ~/.ssh or hq/ssh is refused", () => {
  const h = layout()
  for (const [link, target] of [
    [path.join(h.ssh, "innocent"), h.provider],
    [path.join(h.ssh, "sub", "deeper"), h.auth],
    [path.join(h.hq, "ssh", "notes"), h.connection],
  ] as const) {
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.linkSync(target, link)
    expect(() => h.make(), link).toThrow(UnsafeProfile)
    expect(() => h.make(), link).toThrow(link)
    fs.rmSync(link)
  }
  expect(() => h.make()).not.toThrow()
})

test("only identity, certificate and known-hosts files the user owns outright are bound; the rest get a note", () => {
  const h = layout()
  const key = h.file(path.join(h.home, "keys", "id"), "decoy-key")
  const pub = h.file(path.join(h.home, "keys", "id.pub"), "ssh-ed25519 AAAA")
  const autoCert = h.file(path.join(h.home, "keys", "id-cert.pub"), "cert")
  const cert = h.file(path.join(h.home, "certs", "c.pub"), "cert")
  const hosts = h.file(path.join(h.home, "kh"), "h ssh-ed25519 AAAA\n")
  const history = h.file(path.join(h.home, ".bash_history"), "ssh h\n")
  const learned = path.join(h.hq, "learned.json")
  const company = path.join(h.home, ".opencorp", "company", "rules.yaml")
  const linked = path.join(h.home, "link-key")
  fs.symlinkSync(key, linked)
  const shared = h.file(path.join(h.home, "shared", "id"), "decoy-key")
  fs.linkSync(shared, path.join(h.home, "shared", "id2"))
  const policy = h.make({
    sshFiles: [
      identity(key),
      identity(path.join(h.ssh, "id_test")),
      identity(path.join(h.ssh, "id_missing")),
      identity(path.join(h.home, "missing")),
      { kind: "certificate", path: cert },
      { kind: "known_hosts", path: hosts },
      { kind: "known_hosts", path: "/etc/ssh/ssh_known_hosts" },
      identity(learned),
      identity(company),
      identity(history),
      identity(linked),
      identity(shared),
      identity(path.join(h.home, "keys")),
    ],
  })
  // The key's .pub and -cert.pub come with it, as ssh reads them beside it; ~/.ssh and /etc/ssh are mounted anyway.
  expect(policy.readOnly).toEqual([h.ssh, key, pub, autoCert, cert, hosts, path.join(h.hq, "ssh")])
  // Every private key ssh may read in the sandbox, for the command reader.
  expect(policy.credentials).toEqual([key, path.join(h.ssh, "id_test")])
  expect(policy.notes).toEqual([
    `${learned} is not bound: it is in OpenCorp's home`,
    `${company} is not bound: it is in OpenCorp's home`,
    `${history} is not bound: it is a shell history`,
    `${linked} is not bound: it is a link`,
    `${shared} is not bound: it has other hard links`,
    `${path.join(h.home, "keys")} is not bound: it is not a regular file`,
  ])
})

test("an ssh outside the system folders is bound read-only, and refused where it would expose hq or the home", () => {
  const h = layout()
  // The system's own is mounted with the system.
  expect(h.make({ ssh: "/usr/bin/ssh" }).readOnly).toEqual([h.ssh, path.join(h.hq, "ssh")])
  // One elsewhere is bound by itself, after the files ssh -G names: where it resolves, and, since the wrapper runs it
  // by the name it was found by, a link to it too.
  const own = h.file(path.join(h.root, "openssh", "bin", "ssh"), "#!/bin/sh\n", 0o755)
  const link = path.join(h.root, "ssh-link")
  fs.symlinkSync(own, link)
  const key = h.file(path.join(h.home, "keys", "id"), "decoy-key")
  const policy = h.make({ ssh: link, sshFiles: [identity(key)] })
  expect(policy.readOnly).toEqual([h.ssh, key, own, link, path.join(h.hq, "ssh")])
  expect(policy.notes).toEqual([])
  expect(h.make({ ssh: own }).readOnly).toEqual([h.ssh, own, path.join(h.hq, "ssh")])
  // A link outside the system's folders to the system's own ssh: the link alone.
  const toSystem = path.join(h.root, "bin", "ssh")
  fs.mkdirSync(path.dirname(toSystem))
  fs.symlinkSync("/usr/bin/ssh", toSystem)
  expect(h.make({ ssh: toSystem }).readOnly).toEqual([h.ssh, toSystem, path.join(h.hq, "ssh")])
  // A link in OpenCorp's home is refused, wherever it leads.
  const inHq = path.join(h.hq, "ssh-link")
  fs.symlinkSync(own, inHq)
  expect(() => h.make({ ssh: inHq })).toThrow(UnsafeProfile)
  // Nothing is bound where it would expose hq, the home, OpenCorp's files or a credential.
  fs.linkSync(h.provider, path.join(h.root, "ssh-provider"))
  for (const ssh of [h.home, h.hq, h.provider, path.join(h.root, "ssh-provider"), path.join(h.hq, "learned.json")]) {
    expect(() => h.make({ ssh }), ssh).toThrow(UnsafeProfile)
  }
  // One that is no regular file is left out, with a note.
  const folder = path.join(h.root, "openssh")
  expect(h.make({ ssh: folder }).readOnly).toEqual([h.ssh, path.join(h.hq, "ssh")])
  expect(h.make({ ssh: folder }).notes).toEqual([`ssh ${folder} is not bound: it is not a regular file`])
})

test.skipIf(process.platform !== "linux")(
  "on Linux a wrapper in hq/ssh is mounted over ssh, the system's ssh and the visit's wrapper, and ssh at REAL_SSH",
  () => {
    const h = layout()
    const wrapper = h.file(path.join(h.hq, "ssh", "agent-ssh"), "#!/bin/sh\n", 0o700)
    const own = h.file(path.join(h.root, "openssh", "bin", "ssh"), "#!/bin/sh\n", 0o755)
    const visit = path.join(h.hq, "ssh", "bin", "ssh")
    const policy = h.make({ ssh: own, wrapper, wrapperOver: [visit] })
    const system = ["/usr/local/bin/ssh", "/usr/bin/ssh", "/bin/ssh", "/usr/sbin/ssh", "/sbin/ssh"]
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.realpathSync(p))
    expect(policy.sshOver).toEqual([
      [own, REAL_SSH],
      ...[own, ...new Set(system), visit].map((target) => [wrapper, target] as const),
    ])
    // None without a wrapper; and a wrapper the call could change, or a link, is refused.
    expect(h.make({ ssh: own }).sshOver).toEqual([])
    const outside = h.file(path.join(h.tmp, "agent-ssh"), "#!/bin/sh\n", 0o700)
    expect(() => h.make({ ssh: own, wrapper: outside })).toThrow(UnsafeProfile)
    const link = path.join(h.hq, "ssh", "agent-link")
    fs.symlinkSync(outside, link)
    expect(() => h.make({ ssh: own, wrapper: link })).toThrow(UnsafeProfile)
  },
)

test("a ControlPath folder outside ~/.ssh is bound read-only only when it is the user's own, 0700, and holds only sockets", async () => {
  const h = layout()
  const control = (folder: string) => ({ kind: "control" as const, path: path.join(folder, "%C") })
  const cm = path.join(h.root, "cm")
  fs.mkdirSync(cm, { mode: 0o700 })
  fs.chmodSync(cm, 0o700)
  await listening(path.join(cm, "master"))
  const policy = h.make({ sshFiles: [control(cm)] })
  // Read-only, to connect to: ssh rides a master of the user's there, and can't bind one.
  expect(policy.readOnly).toEqual([h.ssh, cm, path.join(h.hq, "ssh")])
  expect(policy.socketFolders).toEqual([h.ssh, cm])
  expect(policy.writable).toEqual([h.knownHosts, h.statusFile])
  expect(policy.notes).toEqual([])
  // In ~/.ssh it is mounted with it, and connected to there.
  const inSsh = path.join(h.ssh, "tmp")
  fs.mkdirSync(inSsh, { mode: 0o700 })
  expect(h.make({ sshFiles: [control(inSsh)] }).readOnly).toEqual([h.ssh, path.join(h.hq, "ssh")])
  expect(h.make({ sshFiles: [control(inSsh)] }).socketFolders).toEqual([h.ssh])
  // Anything else is left out, with a note.
  const open = path.join(h.root, "open")
  fs.mkdirSync(open, { mode: 0o700 })
  fs.chmodSync(open, 0o750)
  const mixed = path.join(h.root, "mixed")
  fs.mkdirSync(mixed, { mode: 0o700 })
  fs.chmodSync(mixed, 0o700)
  h.file(path.join(mixed, "notes.txt"), "decoy-secret\n")
  const file = h.file(path.join(h.root, "file"), "")
  const cases: [string, string][] = [
    [open, "it is not 0700"],
    [mixed, "it holds something other than sockets"],
    [path.join(h.hq, "cm"), "it is in OpenCorp's home"],
    [path.join(h.root, "missing"), "nothing is there"],
    [file, "it is not a folder"],
    ["/", "it is not the user's"],
  ]
  for (const [folder, why] of cases) {
    const left = h.make({ sshFiles: [control(folder)] })
    expect([folder, left.readOnly, left.socketFolders]).toEqual([folder, [h.ssh, path.join(h.hq, "ssh")], [h.ssh]])
    expect(left.notes).toEqual([`the ControlPath folder ${folder} is not bound: ${why}`])
  }
})

test("the config files ssh reads are found through its Include lines: globs, quotes, relative paths and nesting", () => {
  const root = tempDir()
  const etc = path.join(root, "etc")
  const home = path.join(root, "home")
  const file = (p: string, text = "") => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
    return p
  }
  const main = file(path.join(etc, "ssh_config"), `Host *\n  Include conf.d/*.conf\nInclude "${root}/a dir/q.conf" ${root}/plain.conf\n`)
  const a = file(path.join(etc, "conf.d/a.conf"), `include=${root}/crypto.config\n`)
  const b = file(path.join(etc, "conf.d/b.conf"))
  file(path.join(etc, "conf.d/.hidden.conf"))
  file(path.join(etc, "conf.d/c.txt"))
  const q = file(path.join(root, "a dir/q.conf"))
  // A loop back to the start is read once.
  const plain = file(path.join(root, "plain.conf"), `Include ${main}\n`)
  const crypto = file(path.join(root, "policies/openssh.txt"))
  fs.symlinkSync(crypto, path.join(root, "crypto.config"))
  const user = file(path.join(home, ".ssh/config"), "Include ~/.ssh/more.conf\nInclude extra.conf\n# Include /never\n")
  const more = file(path.join(home, ".ssh/more.conf"), `Include ${b}\n`)
  const extra = file(path.join(home, ".ssh/extra.conf"))
  const starts = [
    { file: main, base: etc },
    { file: user, base: path.join(home, ".ssh") },
  ]
  // A uid no file has: every file counts as someone else's. Links are named by where they lead.
  expect(new Set(includedConfigs(starts, home, -1))).toEqual(new Set([main, a, b, q, plain, crypto, user, more, extra]))
  // The user's own files pass ssh's owner check, so none is copied.
  expect(includedConfigs(starts, home, process.getuid!())).toEqual([])
})

test.skipIf(process.platform !== "linux" || !fs.existsSync("/etc/ssh/ssh_config"))(
  "on Linux the system's ssh config is copied for the sandbox, the user's own and private, over the original",
  () => {
    const h = layout()
    const policy = h.make()
    const targets = policy.systemConfig.map(([, target]) => target)
    if (fs.statSync("/etc/ssh/ssh_config").uid !== process.getuid!()) expect(targets).toContain("/etc/ssh/ssh_config")
    for (const [copy, target] of policy.systemConfig) {
      expect(path.dirname(copy)).toBe(path.join(h.hq, "ssh", "system"))
      expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(target))
      expect(fs.statSync(copy).uid).toBe(process.getuid!())
      expect(mode(copy)).toBe(0o600)
    }
    // Built again, each copy is written afresh in the same place.
    fs.writeFileSync(policy.systemConfig[0]![0], "stale\n")
    expect(h.make().systemConfig).toEqual(policy.systemConfig)
    expect(fs.readFileSync(policy.systemConfig[0]![0])).toEqual(fs.readFileSync(policy.systemConfig[0]![1]))
    expect(fs.readdirSync(path.join(h.hq, "ssh", "system"))).toHaveLength(policy.systemConfig.length)
  },
)

test.skipIf(!sandboxAvailable())(
  "ssh -G runs in the profile, and its files keep their kinds while the rest of its lines are ignored",
  async () => {
    const h = layout()
    const config = path.join(h.hq, "ssh", "config")
    const secret = path.join(h.home, "secret.txt")
    const printed = [
      "user x",
      "hostname opencorp-hq",
      "identityfile ~/keys/id",
      "identityfile ~/.ssh/id_test",
      "identityfile %d/keys/id2",
      "identityfile keys/relative",
      "certificatefile ~/certs/id-cert.pub",
      "userknownhostsfile ~/.ssh/known_hosts ~/kh",
      "globalknownhostsfile /etc/ssh/ssh_known_hosts",
      "controlpath ~/.opencorp/hq/cm/%C",
      "proxycommand cat ~/secret.txt",
    ]
    // The stub stands in for ssh in the sandbox: what it reads and writes there is the sandbox's, as a Match exec's.
    const stub = path.join(h.tmp, "ssh-stub")
    const script = [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "$TMPDIR/args"`,
      `if cat '${secret}' >/dev/null 2>&1; then echo 'identityfile ~/escaped'; fi`,
      "cat <<'EOF'",
      ...printed,
      "EOF",
      "",
    ]
    fs.writeFileSync(stub, script.join("\n"), { mode: 0o700 })
    const base = h.make()
    expect(await sshFiles(base, stub, config)).toEqual([
      { kind: "identity", path: path.join(h.home, "keys/id") },
      { kind: "identity", path: path.join(h.ssh, "id_test") },
      { kind: "identity", path: path.join(h.home, "keys/id2") },
      { kind: "certificate", path: path.join(h.home, "certs/id-cert.pub") },
      { kind: "known_hosts", path: h.knownHosts },
      { kind: "known_hosts", path: path.join(h.home, "kh") },
      { kind: "known_hosts", path: "/etc/ssh/ssh_known_hosts" },
      // The socket a master of the owner's would listen on, whose folder the policy may bind to connect to.
      { kind: "control", path: path.join(h.home, ".opencorp/hq/cm/%C") },
    ])
    // Resolved for a host the owner's config doesn't know, from the visit's config.
    expect(fs.readFileSync(path.join(h.tmp, "args"), "utf8")).toBe(["-G", "-F", config, "--", "opencorp-hq", ""].join("\n"))
    // An ssh that fails names nothing.
    fs.writeFileSync(stub, "#!/bin/sh\necho 'identityfile ~/keys/id'\nexit 255\n", { mode: 0o700 })
    expect(await sshFiles(base, stub, config)).toEqual([])
  },
)

/** Runs `script` under `policy` with `/bin/sh -c`, `args` as $0 and on, and returns its exit and output. */
async function sh(policy: SshPolicy, script: string, ...args: string[]) {
  const r = await run(policy, ["/bin/sh", "-c", script, ...args], { timeout: 20 })
  return { exit: r.exit, out: r.stdout.toString("utf8"), err: r.stderr.toString("utf8") }
}

test.skipIf(!sandboxAvailable())(
  "in the SSH-only sandbox, provider.json, auth.json and the rest of the home can't be read",
  async () => {
    const h = layout()
    const script = [
      'for f in "$@"; do cat "$f" 2>/dev/null; echo "[$?]"; done',
      "echo ---",
      'ls -1A "$0"',
      "echo ---",
      'ls -1A "$0/.opencorp/hq"',
    ].join("\n")
    const r = await sh(h.make(), script, h.home, h.provider, h.auth, h.connection, path.join(h.home, "secret.txt"))
    const [cats, home, hq] = r.out.split("---\n")
    const exits = [...cats!.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
    expect(exits, r.out + r.err).toHaveLength(4)
    for (const exit of exits) expect(exit, r.out + r.err).not.toBe(0)
    expect(r.out).not.toContain("decoy")
    if (process.platform === "linux") {
      // bubblewrap makes the mount points' folders, and nothing else of the home: no hq/cm.
      expect(home!.split("\n").filter(Boolean)).toEqual([".opencorp", ".ssh"])
      expect(hq!.split("\n").filter(Boolean)).toEqual(["ssh"])
    } else {
      // Seatbelt gives the home and hq metadata only, so listing them fails.
      expect(r.exit, r.out + r.err).not.toBe(0)
    }
  },
)

test.skipIf(!sandboxAvailable())(
  "in it ~/.ssh reads, known_hosts and the status file take data, and only its own folders take files",
  async () => {
    const h = layout()
    const policy = h.make()
    const before = fs.readFileSync(path.join(h.ssh, "config"), "utf8")
    const script = [
      'cat "$HOME/.ssh/config" "$HOME/.ssh/id_test" || exit 3',
      'echo "new ssh-ed25519 BBBB" >> "$HOME/.ssh/known_hosts" || exit 4',
      'echo 255 >> "$0" || exit 5',
      'echo x > "$1/x" || exit 6',
      'echo t > "$TMPDIR/t" || exit 7',
      "echo WROTE",
      'for p in "$HOME/.ssh/new" "$HOME/.ssh/config" "$2/new" "$2/config" "$3/node" "$HOME/new" "$4"; do',
      '  (echo y > "$p") 2>/dev/null && echo "WROTE $p"',
      "done",
      // known_hosts and the status file take data only: they can't be removed, renamed or linked.
      'rm -f "$HOME/.ssh/known_hosts" 2>/dev/null && echo "REMOVED known_hosts"',
      'mv "$0" "$0.moved" 2>/dev/null && echo "MOVED status"',
      'ln "$HOME/.ssh/known_hosts" "$TMPDIR/kh" 2>/dev/null && echo "LINKED known_hosts"',
      "exit 0",
    ].join("\n")
    const hqCm = path.join(h.hq, "cm")
    const r = await sh(policy, script, h.statusFile, policy.controlDir, path.join(h.hq, "ssh"), hqCm, h.provider)
    expect(r.exit, r.out + r.err).toBe(0)
    expect(r.out).toBe("Host *\ndecoy-ssh-key\nWROTE\n")
    expect(fs.readFileSync(h.knownHosts, "utf8")).toBe("h ssh-ed25519 AAAA\nnew ssh-ed25519 BBBB\n")
    expect(fs.readFileSync(h.statusFile, "utf8")).toBe("255\n")
    expect(fs.readFileSync(path.join(policy.controlDir, "x"), "utf8")).toBe("x\n")
    expect(fs.readFileSync(path.join(h.tmp, "t"), "utf8")).toBe("t\n")
    expect(fs.readFileSync(path.join(h.ssh, "config"), "utf8")).toBe(before)
    expect(fs.readdirSync(hqCm)).toEqual([])
    expect(fs.existsSync(path.join(h.ssh, "new"))).toBe(false)
    expect(fs.existsSync(path.join(h.hq, "ssh", "new"))).toBe(false)
    expect(fs.existsSync(path.join(h.home, "new"))).toBe(false)
    expect(fs.readFileSync(h.provider, "utf8")).toBe('{"key":"decoy-provider"}\n')
  },
)

const SSH = "/usr/bin/ssh"

// -G resolves the config and connects nowhere. Without ssh here, a strict sandbox run fails rather than skips.
test.skipIf(!sandboxAvailable() || (!fs.existsSync(SSH) && !process.env.OPENCORP_TEST_SANDBOX))(
  "the real ssh reads the system's config in the profile",
  async () => {
    const h = layout()
    const config = path.join(h.hq, "ssh", "config")
    fs.writeFileSync(config, `Include "${path.join(h.ssh, "config")}"\nInclude "/etc/ssh/ssh_config"\n`)
    const r = await run(h.make(), [SSH, "-G", "-F", config, "localhost"], { timeout: 20 })
    const err = r.stderr.toString()
    expect(r.exit, err).toBe(0)
    expect(err).not.toContain("Bad owner")
    expect(r.stdout.toString()).toContain("\nhostname localhost\n")
  },
)

// A symlink to the system's ssh, outside the system's folders: ssh -V runs by the link's name, as the wrapper runs it.
test.skipIf(!sandboxAvailable() || (!fs.existsSync(SSH) && !process.env.OPENCORP_TEST_SANDBOX))(
  "a symlinked ssh outside the system's folders runs in the profile by the link's own path",
  async () => {
    const h = layout()
    const link = path.join(h.root, "bin", "ssh")
    fs.mkdirSync(path.dirname(link))
    fs.symlinkSync(SSH, link)
    const r = await run(h.make({ ssh: link }), [link, "-V"], { timeout: 20 })
    expect(r.exit, r.stderr.toString()).toBe(0)
    expect(r.stderr.toString()).toStartWith("OpenSSH")
  },
)

const SSH_AGENT = "/usr/bin/ssh-agent"
const SSH_ADD = "/usr/bin/ssh-add"

test.skipIf(!sandboxAvailable() || !fs.existsSync(SSH_AGENT) || !fs.existsSync(SSH_ADD))(
  "it reaches the ssh agent's socket",
  async () => {
    const h = layout()
    const sock = path.join(h.root, "agent.sock")
    const agent: ChildProcess = spawn(SSH_AGENT, ["-a", sock, "-D"], {
      env: { PATH: "/usr/bin:/bin", HOME: h.home },
      stdio: "ignore",
    })
    const ended = new Promise((resolve) => agent.once("exit", resolve))
    onTestFinished(async () => {
      agent.kill("SIGKILL")
      await ended
    })
    await waitFor(() => fs.existsSync(sock), { timeout: 10_000, what: "the agent's socket" })
    // 1 is "the agent has no identities"; 2 is "can't connect to the agent".
    const reached = await run(h.make({ agentSocket: sock }), [SSH_ADD, "-l"], { timeout: 20 })
    expect(reached.exit, reached.stdout.toString() + reached.stderr.toString()).toBe(1)
    // Without the bind, the same path names nothing in the sandbox.
    const unbound = await sh(h.make(), 'SSH_AUTH_SOCK="$0" exec "$1" -l', sock, SSH_ADD)
    expect(unbound.exit, unbound.out + unbound.err).toBe(2)
    // The socket can be reached, not removed.
    const removed = await sh(h.make({ agentSocket: sock }), 'rm -f "$SSH_AUTH_SOCK" 2>/dev/null && echo REMOVED')
    expect(removed.out).toBe("")
    expect(fs.existsSync(sock)).toBe(true)
  },
)

test.skipIf(!sandboxAvailable())("setuid programs gain nothing in it", async () => {
  const h = layout()
  if (process.platform === "linux") {
    // bubblewrap sets PR_SET_NO_NEW_PRIVS, so an exec never gains a setuid bit's privileges.
    const r = await sh(h.make(), "cat /proc/self/status")
    expect(r.out, r.err).toContain("NoNewPrivs:\t1")
    return
  }
  // Seatbelt can't see a setuid bit, so the profile refuses to run each one. Unverified on macOS.
  for (const program of SETUID_PROGRAMS.filter((p) => fs.existsSync(p))) {
    const r = await sh(h.make(), '"$0" -h </dev/null >/dev/null 2>&1; echo "[$?]"', program)
    expect(r.out, program).toBe("[126]\n")
  }
})

test.skipIf(!sandboxAvailable())("a sandboxed ssh on a terminal prompts on /dev/tty", async () => {
  const h = layout()
  // The fake keeps its log and tty.txt in its own folder, so it lives in the call's temp folder, which takes writes.
  const fake = installFakeSsh(path.join(h.tmp, "fake"), { login: "tty" })
  // It runs on this Bun, from the office's source.
  const src = fileURLToPath(new URL("../../../src/", import.meta.url))
  const policy = h.make({ readOnly: [src, fs.realpathSync(process.execPath)] })
  let output = ""
  const decoder = new TextDecoder()
  const pty = startOnTerminal(policy, [fake.ssh, "h"], {
    cols: 80,
    rows: 24,
    onData: (chunk) => {
      output += decoder.decode(chunk, { stream: true })
    },
  })
  onTestFinished(async () => {
    pty.kill("SIGKILL")
    pty.close()
    await pty.exited
  })
  await waitFor(() => output.includes("fake password for h: "), { timeout: 15_000, what: "the password prompt" })
  await waitFor(() => !pty.modes().echo, { timeout: 5_000, what: "echo off" })
  pty.write("s3cret\n")
  expect(await pty.exited).toBe(0)
  expect(fake.tty()).toEqual(["s3cret"])
  expect(fake.logins()).toEqual(["h"])
  expect(output).not.toContain("s3cret")
})

/** The `FILE:` cache `klist` reports, when it holds a valid ticket here; null otherwise. Only `klist -s` reads it in
 *  the sandbox, which prints nothing. */
function fileTicket(): string | null {
  if (!fs.existsSync("/usr/bin/klist")) return null
  if (spawnSync("/usr/bin/klist", ["-s"], { stdio: "ignore", timeout: 10_000 }).status !== 0) return null
  const listed = spawnSync("/usr/bin/klist", [], { encoding: "utf8", timeout: 10_000 })
  return /^Ticket cache: FILE:(\/.*)$/m.exec(listed.stdout ?? "")?.[1] ?? null
}

const TICKET = fileTicket()

test.skipIf(!sandboxAvailable() || TICKET === null)("a Kerberos ticket in a FILE: cache is readable in it", async () => {
  const h = layout()
  const r = await run(h.make({ kerberos: `FILE:${TICKET!}` }), ["/usr/bin/klist", "-s"], { timeout: 20 })
  expect(r.exit, r.stderr.toString()).toBe(0)
})

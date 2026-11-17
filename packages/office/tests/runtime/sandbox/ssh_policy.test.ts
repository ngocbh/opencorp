/** The SSH-only sandbox: what OpenCorp's `hq` shell may touch, checked on its policy and through the real sandbox. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { realPath } from "../../../src/runtime/sandbox/policy.ts"
import { run, startOnTerminal } from "../../../src/runtime/sandbox/run.ts"
import { SETUID_PROGRAMS } from "../../../src/runtime/sandbox/seatbelt.ts"
import {
  includedConfigs,
  SshPolicy,
  type SshPolicyInit,
  sshFiles,
  UnsafeProfile,
} from "../../../src/runtime/sandbox/ssh_policy.ts"
import { installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { tempDir, waitFor } from "../../helpers.ts"
import { sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A temp home as the profile meets it: `.ssh` with a config, a key and known_hosts; a secret beside it; and
 *  `.opencorp/hq` with the model's key and sign-in, the visit's ssh files and `cm/`. `make` builds a policy over it,
 *  with `<root>/tmp` as the call's temp folder and `hq/ssh/status.4242` as its status file. */
function layout() {
  const root = tempDir()
  const home = path.join(root, "home")
  const ssh = path.join(home, ".ssh")
  const hq = path.join(home, ".opencorp", "hq")
  const tmp = path.join(root, "tmp")
  const file = (p: string, text: string, mode = 0o600) => {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
    fs.writeFileSync(p, text, { mode })
  }
  file(path.join(ssh, "config"), "Host *\n")
  file(path.join(ssh, "id_test"), "decoy-ssh-key\n")
  file(path.join(ssh, "known_hosts"), "h ssh-ed25519 AAAA\n")
  file(path.join(home, "secret.txt"), "decoy-secret\n")
  file(path.join(hq, "provider.json"), '{"key":"decoy-provider"}\n')
  file(path.join(hq, "auth.json"), '{"token":"decoy-auth"}\n')
  file(path.join(hq, "ssh", "config"), "# Written by opencorp hq on each visit; edits are lost.\n")
  file(path.join(hq, "ssh", "bin", "ssh"), "#!/bin/sh\n", 0o700)
  fs.mkdirSync(path.join(hq, "cm"), { mode: 0o700 })
  fs.mkdirSync(tmp)
  const statusFile = path.join(hq, "ssh", "status.4242")
  return {
    root,
    home,
    ssh,
    hq,
    tmp,
    statusFile,
    knownHosts: path.join(ssh, "known_hosts"),
    provider: path.join(hq, "provider.json"),
    auth: path.join(hq, "auth.json"),
    make: (more: Partial<SshPolicyInit> = {}) => new SshPolicy({ home, hq, tmpdir: tmp, statusFile, ...more }),
  }
}

const mode = (p: string) => fs.statSync(p).mode & 0o777

test("an SSH-only policy binds ~/.ssh read-only and known_hosts, hq/cm and the status file read-write", () => {
  const h = layout()
  const policy = h.make()
  expect(policy.kind).toBe("ssh")
  expect(policy.home).toBe(h.home)
  expect(policy.tmpdir).toBe(h.tmp)
  expect(policy.readOnly).toEqual([h.ssh, path.join(h.hq, "ssh")])
  expect(policy.writable).toEqual([h.knownHosts, h.statusFile, path.join(h.hq, "cm")])
  expect(policy.sockets).toEqual([])
  expect(policy.agentSocket).toBeNull()
  expect(policy.ccache).toBeNull()
  // Created first, private, so the bind has a source for the wrapper's appends.
  expect(fs.readFileSync(h.statusFile, "utf8")).toBe("")
  expect(mode(h.statusFile)).toBe(0o600)

  // The agent's socket and a ticket cache are bound read-write, each where it resolves; extra read-only paths last.
  const agent = path.join(h.root, "agent.sock")
  const ticket = path.join(h.root, "krb5cc_test")
  const extra = path.join(h.root, "extra")
  fs.writeFileSync(agent, "")
  fs.writeFileSync(ticket, "")
  fs.mkdirSync(extra)
  fs.symlinkSync(agent, path.join(h.root, "agent-link"))
  const full = h.make({ agentSocket: path.join(h.root, "agent-link"), kerberos: ticket, readOnly: [extra] })
  expect(full.readOnly).toEqual([h.ssh, path.join(h.hq, "ssh"), extra])
  expect(full.writable).toEqual(policy.writable)
  expect(full.sockets).toEqual([agent, ticket])
  expect(full.agentSocket).toBe(agent)
  expect(full.ccache).toBe(`FILE:${ticket}`)
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

test("a policy that would bind hq, the home, provider.json or auth.json is refused", () => {
  const h = layout()
  fs.rmSync(h.knownHosts)
  fs.symlinkSync(h.provider, path.join(h.root, "provider-link"))
  const exposed = [
    h.hq,
    h.home,
    h.provider,
    h.auth,
    // A bind that holds hq or the home holds them too, and a link is judged by where it leads.
    path.join(h.home, ".opencorp"),
    path.dirname(h.home),
    path.join(h.root, "provider-link"),
  ]
  for (const p of exposed) {
    for (const more of [{ sshFiles: [p] }, { agentSocket: p }, { kerberos: p }, { readOnly: [p] }]) {
      expect(() => h.make(more), `${JSON.stringify(more)}`).toThrow(UnsafeProfile)
    }
  }
  expect(() => h.make({ tmpdir: h.hq })).toThrow(UnsafeProfile)
  expect(() => h.make({ tmpdir: h.home })).toThrow(UnsafeProfile)
  expect(() => h.make({ statusFile: h.provider })).toThrow(UnsafeProfile)
  // The status file is bound read-write, so it may only be the wrapper's own, in hq/ssh.
  expect(() => h.make({ statusFile: path.join(h.home, "secret.txt") })).toThrow(UnsafeProfile)
  expect(() => h.make({ statusFile: path.join(h.hq, "cm", "status.4242") })).toThrow(UnsafeProfile)
  // Nothing is created for a policy that is refused.
  expect(fs.existsSync(h.knownHosts)).toBe(false)
  expect(fs.existsSync(h.statusFile)).toBe(false)
  // hq's own ssh/ and cm/, and the rest of ~/.ssh, are what the profile is for.
  expect(() => h.make({ sshFiles: [path.join(h.hq, "cm"), path.join(h.home, "keys", "id")] })).not.toThrow()
})

test("ssh -G's files outside ~/.ssh are bound read-only, and the rest of its lines are ignored", () => {
  const h = layout()
  const config = path.join(h.hq, "ssh", "config")
  const args = path.join(h.root, "args")
  const stub = path.join(h.root, "ssh-stub")
  const printed = [
    "user x",
    "hostname opencorp-hq",
    "identityfile ~/keys/id",
    "identityfile ~/.ssh/id_test",
    "identityfile %d/keys/id2",
    "identityfile keys/relative",
    "certificatefile ~/certs/id-cert.pub",
    "userknownhostsfile ~/.ssh/known_hosts ~/kh",
    "globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2",
    "controlpath ~/.opencorp/hq/cm/%C",
    "proxycommand cat ~/secret.txt",
  ]
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\ncat <<'EOF'\n${printed.join("\n")}\nEOF\n`, {
    mode: 0o700,
  })
  const files = sshFiles(stub, config, h.home)
  expect(files).toEqual([
    path.join(h.home, "keys/id"),
    path.join(h.home, "keys/id2"),
    path.join(h.home, "certs/id-cert.pub"),
    path.join(h.home, "kh"),
    "/etc/ssh/ssh_known_hosts",
    "/etc/ssh/ssh_known_hosts2",
  ])
  // Resolved for a host the owner's config doesn't know, from the visit's config.
  expect(fs.readFileSync(args, "utf8")).toBe(["-G", "-F", config, "--", "opencorp-hq", ""].join("\n"))
  const policy = h.make({ sshFiles: files })
  expect(policy.readOnly).toEqual([h.ssh, ...files.map((f) => realPath(f)), path.join(h.hq, "ssh")])
  // An ssh that fails names nothing.
  fs.writeFileSync(stub, "#!/bin/sh\necho 'identityfile ~/keys/id'\nexit 255\n", { mode: 0o700 })
  expect(sshFiles(stub, config, h.home)).toEqual([])
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
    const r = await sh(h.make(), script, h.home, h.provider, h.auth, path.join(h.home, "secret.txt"))
    const [cats, home, hq] = r.out.split("---\n")
    const exits = [...cats!.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
    expect(exits, r.out + r.err).toHaveLength(3)
    for (const exit of exits) expect(exit, r.out + r.err).not.toBe(0)
    expect(r.out).not.toContain("decoy")
    if (process.platform === "linux") {
      // bubblewrap makes the mount points' folders, and nothing else of the home.
      expect(home!.split("\n").filter(Boolean)).toEqual([".opencorp", ".ssh"])
      expect(hq!.split("\n").filter(Boolean)).toEqual(["cm", "ssh"])
    } else {
      // Seatbelt gives the home and hq metadata only, so listing them fails.
      expect(r.exit, r.out + r.err).not.toBe(0)
    }
  },
)

test.skipIf(!sandboxAvailable())(
  "in it ~/.ssh reads, and known_hosts, hq/cm and the status file take writes",
  async () => {
    const h = layout()
    const cm = path.join(h.hq, "cm")
    const before = fs.readFileSync(path.join(h.ssh, "config"), "utf8")
    const script = [
      'cat "$HOME/.ssh/config" "$HOME/.ssh/id_test" || exit 3',
      'echo "new ssh-ed25519 BBBB" >> "$HOME/.ssh/known_hosts" || exit 4',
      'echo 255 >> "$0" || exit 5',
      'echo x > "$1/x" || exit 6',
      'echo t > "$TMPDIR/t" || exit 7',
      "echo WROTE",
      'for p in "$HOME/.ssh/new" "$HOME/.ssh/config" "$2/new" "$2/config" "$HOME/new" "$3"; do',
      '  (echo y > "$p") 2>/dev/null && echo "WROTE $p"',
      "done",
      "exit 0",
    ].join("\n")
    const r = await sh(h.make(), script, h.statusFile, cm, path.join(h.hq, "ssh"), h.provider)
    expect(r.exit, r.out + r.err).toBe(0)
    expect(r.out).toBe("Host *\ndecoy-ssh-key\nWROTE\n")
    expect(fs.readFileSync(h.knownHosts, "utf8")).toBe("h ssh-ed25519 AAAA\nnew ssh-ed25519 BBBB\n")
    expect(fs.readFileSync(h.statusFile, "utf8")).toBe("255\n")
    expect(fs.readFileSync(path.join(cm, "x"), "utf8")).toBe("x\n")
    expect(fs.readFileSync(path.join(h.tmp, "t"), "utf8")).toBe("t\n")
    expect(fs.readFileSync(path.join(h.ssh, "config"), "utf8")).toBe(before)
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
  const r = await run(h.make({ kerberos: TICKET! }), ["/usr/bin/klist", "-s"], { timeout: 20 })
  expect(r.exit, r.stderr.toString()).toBe(0)
})

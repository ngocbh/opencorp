/** The agent's SSH-only policy for learning's shells: hq/ssh read-only for the wrapper and the agent's config, the
 *  user's ssh config read-only, and nothing else of hq. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { makeDirs, ReachPaths } from "../../../src/features/reach/paths.ts"
import { agentPolicy, sshHome, TEST_SSH_DIR, testFolder } from "../../../src/features/reach/sandbox.ts"
import { writeSshFiles } from "../../../src/features/reach/ssh.ts"
import { refusal, type run, SandboxUnavailable } from "../../../src/runtime/sandbox/run.ts"
import type { SshPolicy } from "../../../src/runtime/sandbox/ssh_policy.ts"
import { UnsafeProfile, within } from "../../../src/runtime/sandbox/policy.ts"

const SSH = "/usr/bin/ssh"

/** A short temp home with `~/.ssh/config`, and OpenCorp's home in it: hq made, with the model's key, sign-in and the
 *  visit's ssh files. `tmpdir` is a fresh 0700 folder beside the home. Removed when the test finishes. */
async function home() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, "home")
  const ssh = path.join(dir, ".ssh")
  fs.mkdirSync(path.join(ssh, "tmp"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(ssh, "config"), `Host *\n  ControlPath ${ssh}/tmp/%C\n`, { mode: 0o600 })
  const paths = new ReachPaths(path.join(dir, ".opencorp"))
  makeDirs(paths)
  fs.writeFileSync(paths.provider, '{"key":"decoy-provider"}\n', { mode: 0o600 })
  fs.writeFileSync(paths.auth, '{"token":"decoy-auth"}\n', { mode: 0o600 })
  await writeSshFiles(paths, SSH, [path.join(ssh, "config")])
  const tmpdir = path.join(root, "tmp")
  fs.mkdirSync(tmpdir, { mode: 0o700 })
  return { root, dir, ssh, paths, tmpdir }
}

test("hq's agent policy binds hq/ssh read-only and nothing else of hq, hq/cm included", async () => {
  const h = await home()
  const policy = await agentPolicy(h.paths, { home: h.dir, tmpdir: h.tmpdir, ssh: SSH, env: {} })
  expect(policy.home).toBe(h.dir)
  expect(policy.tmpdir).toBe(h.tmpdir)
  expect(policy.readOnly).toEqual([h.ssh, h.paths.ssh])
  // A status file of the agent's own is the one file of hq a call may write, and only its data: never the visit's,
  // which its replays read.
  expect(policy.writable).toEqual([path.join(h.ssh, "known_hosts"), h.paths.agentStatus(process.pid)])
  expect(policy.writable).not.toContain(h.paths.status(process.pid))
  expect(policy.socketFolders).toEqual([h.ssh])
  const reached = [...policy.readOnly, ...policy.writable, ...policy.sockets, ...policy.socketFolders, policy.tmpdir]
  expect(reached.filter((p) => within(p, h.paths.dir) && !within(p, h.paths.ssh))).toEqual([])
  expect(reached.filter((p) => within(p, h.paths.cm))).toEqual([])
})

test("the agent's socket and Kerberos ticket come from the visit's env", async () => {
  const h = await home()
  const ticket = path.join(h.root, "krb5cc_test")
  fs.writeFileSync(ticket, "ticket", { mode: 0o600 })
  const env = { KRB5CCNAME: `FILE:${ticket}`, SSH_AUTH_SOCK: path.join(h.root, "gone.sock"), HOME: "/elsewhere" }
  const policy = await agentPolicy(h.paths, { home: h.dir, tmpdir: h.tmpdir, ssh: SSH, env })
  expect(policy.ccache).toBe(`FILE:${ticket}`)
  expect(policy.writable).toContain(ticket)
  // An agent socket that is gone is noted, not bound.
  expect(policy.agentSocket).toBeNull()
  expect(policy.notes).toEqual([`the agent's socket ${env.SSH_AUTH_SOCK} is not bound: it is not a socket`])
})

test("a temp folder or status file that would expose hq is refused", async () => {
  const h = await home()
  const make = (tmpdir: string) => agentPolicy(h.paths, { home: h.dir, tmpdir, ssh: SSH, env: {} })
  const inHq = path.join(h.paths.dir, "tmp")
  fs.mkdirSync(inHq, { mode: 0o700 })
  for (const tmpdir of [inHq, h.paths.dir, h.paths.home, h.dir]) await expect(make(tmpdir)).rejects.toThrow(UnsafeProfile)
  // hq/ssh, where the status file is, swapped for a link to hq: binding it would bind hq whole.
  fs.renameSync(h.paths.ssh, `${h.paths.ssh}.real`)
  fs.symlinkSync(h.paths.dir, h.paths.ssh)
  await expect(make(h.tmpdir)).rejects.toThrow(UnsafeProfile)
  await expect(make(h.tmpdir)).rejects.toThrow("would expose hq")
})

/** `run`, whose sandbox is a stand-in command: `/bin/sh -c script`, run here, with what it exits and prints as the
 *  call's. Each call's policy and argv are kept in `calls`. */
function standIn(script: string) {
  const calls: { policy: SshPolicy; argv: readonly string[] }[] = []
  const runIn: typeof run = async (policy, argv) => {
    calls.push({ policy: policy as SshPolicy, argv })
    const ran = spawnSync("/bin/sh", ["-c", script], { timeout: 10_000 })
    const empty = Buffer.alloc(0)
    return {
      exit: ran.status, stdout: ran.stdout, stderr: ran.stderr, stdoutTail: empty, stderrTail: empty,
      stdoutBytes: ran.stdout.length, stderrBytes: ran.stderr.length, timedOut: false, interrupted: false,
      truncated: false, duration: 0, refused: refusal("linux", ran.status, ran.stderr),
    }
  }
  return { calls, runIn }
}

test("a sandbox that can't run a call counts as none: bubblewrap's refusal, or a runner that can't start", async () => {
  const h = await home()
  const make = (runIn: typeof run) => agentPolicy(h.paths, { home: h.dir, tmpdir: h.tmpdir, ssh: SSH, env: {}, run: runIn })
  // bubblewrap where unprivileged user namespaces are off.
  const refused = standIn('printf "bwrap: setting up uid map: Permission denied\\n" >&2; exit 1')
  await expect(make(refused.runIn)).rejects.toThrow(SandboxUnavailable)
  await expect(make(refused.runIn)).rejects.toThrow(/^bwrap: setting up uid map: Permission denied$/)
  // One trivial call, in the policy itself.
  expect(refused.calls[0]!.argv).toEqual(["/bin/sh", "-c", "exit 0"])
  expect(refused.calls[0]!.policy.tmpdir).toBe(h.tmpdir)
  // A runner that can't start (no bwrap on PATH), and one that fails for any other reason.
  const missing: typeof run = async () => {
    throw Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT" })
  }
  await expect(make(missing)).rejects.toThrow(new SandboxUnavailable("the sandbox can't start: spawn bwrap ENOENT"))
  await expect(make(standIn("exit 3").runIn)).rejects.toThrow(new SandboxUnavailable("a sandboxed call exited 3"))
  // A call that runs is a sandbox.
  const works = standIn("exit 0")
  expect((await make(works.runIn)).home).toBe(h.dir)
})

test("the test fake's folder is bound only when OPENCORP_TEST_SSH_DIR names it, and is refused when it is or holds hq or the home, lies in the home, $HOME or OpenCorp's home, is a link or another user's", async () => {
  const h = await home()
  const envHome = path.join(h.root, "env-home")
  fs.mkdirSync(envHome, { mode: 0o700 })
  const make = (dir?: string) =>
    agentPolicy(h.paths, {
      home: h.dir,
      tmpdir: h.tmpdir,
      ssh: SSH,
      env: { HOME: envHome, ...(dir === undefined ? {} : { [TEST_SSH_DIR]: dir }) },
    })
  expect((await make()).readWrite).toEqual([])
  const fake = path.join(h.root, "fake")
  fs.mkdirSync(fake, { mode: 0o700 })
  const bound = await make(fake)
  expect(bound.readWrite).toEqual([fake])
  // Nothing else changes: the same home, read-only paths and writable files.
  expect([bound.home, bound.readOnly, bound.writable]).toEqual([h.dir, [h.ssh, h.paths.ssh], (await make()).writable])
  const folder = (at: string, mode = 0o700) => {
    fs.mkdirSync(at, { recursive: true, mode })
    fs.chmodSync(at, mode)
    return at
  }
  const link = path.join(h.root, "link")
  fs.symlinkSync(fake, link)
  // OpenCorp's home outside the user's.
  const office = new ReachPaths(path.join(h.root, "oc"))
  makeDirs(office)
  await writeSshFiles(office, SSH, [path.join(h.ssh, "config")])
  const refused: [string, string, ReachPaths][] = [
    [h.paths.dir, `it lies in ${h.dir}`, h.paths],
    [h.dir, `it holds ${h.dir}`, h.paths],
    [h.root, `it holds ${h.dir}`, h.paths],
    [folder(path.join(h.dir, "fake")), `it lies in ${h.dir}`, h.paths],
    [folder(path.join(envHome, "fake")), `it lies in ${envHome}`, h.paths],
    [office.dir, `it lies in ${office.home}`, office],
    [folder(path.join(office.home, "fake")), `it lies in ${office.home}`, office],
    [link, "it is a link", h.paths],
    [folder(path.join(h.root, "open"), 0o755), "it is not 0700", h.paths],
    ["/usr", "it is not the user's", h.paths],
    [path.join(h.root, "missing"), "nothing is there", h.paths],
  ]
  // The passwd entry's home, which ssh's home stands in for in a test.
  const passwd = path.join(h.root, "passwd")
  fs.mkdirSync(passwd, { mode: 0o700 })
  refused.push([folder(path.join(passwd, "fake")), `it lies in ${passwd}`, h.paths])
  for (const [dir, why, paths] of refused) {
    const env = { HOME: envHome, [TEST_SSH_DIR]: dir }
    const error = await agentPolicy(paths, { home: h.dir, tmpdir: h.tmpdir, ssh: SSH, env, passwd }).catch((e: unknown) => e)
    expect([dir, error instanceof UnsafeProfile, (error as Error).message]).toEqual([
      dir,
      true,
      `the test folder ${dir} can't be bound: ${why}`,
    ])
  }
  expect(testFolder(fake, [h.dir, envHome, h.paths.home, passwd])).toBe(fake)
})

test("with it, ssh's home is $HOME, and nothing in the passwd home is read or made", async () => {
  const h = await home()
  const fake = path.join(h.root, "fake")
  fs.mkdirSync(fake, { mode: 0o700 })
  // The passwd entry's home, which nothing may read: a folder no one can enter.
  const passwd = path.join(h.root, "passwd")
  fs.mkdirSync(passwd, { mode: 0o700 })
  fs.chmodSync(passwd, 0o000)
  expect(sshHome(passwd, { HOME: h.dir })).toBe(passwd)
  const env = { HOME: h.dir, [TEST_SSH_DIR]: fake }
  expect(sshHome(passwd, env)).toBe(h.dir)
  const policy = await agentPolicy(h.paths, { home: sshHome(passwd, env), tmpdir: h.tmpdir, ssh: SSH, env, passwd })
  expect(policy.home).toBe(h.dir)
  expect(policy.readOnly[0]).toBe(h.ssh)
  fs.chmodSync(passwd, 0o700)
  expect(fs.readdirSync(passwd)).toEqual([])
})

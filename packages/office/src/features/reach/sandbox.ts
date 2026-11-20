/** The agent's SSH-only sandbox while learning: the owner's ssh config and `~/.ssh` read-only, `hq/ssh` read-only for
 *  the wrapper and the agent's config, and nothing else of hq, `hq/cm` included. */
import fs from "node:fs"
import { realPath, within } from "../../runtime/sandbox/policy.ts"
import { run, SandboxUnavailable } from "../../runtime/sandbox/run.ts"
import { SshPolicy, sshFiles, UnsafeProfile } from "../../runtime/sandbox/ssh_policy.ts"
import type { ReachPaths } from "./paths.ts"
import { cleanOutput, headChars } from "./ssh.ts"

/** How long the probe call may take, in seconds. */
const PROBE_S = 30

/**
 * For tests only: the variable naming the folder of a test's fake ssh (its program and the state it writes), which
 * the agent's sandbox then binds read-write, once it passes `testFolder`'s checks; ssh's home is then `$HOME` rather
 * than the passwd entry's, so no test reads or makes anything in the real `~/.ssh`. Unset, nothing changes. The
 * CLI's tmux tests set it: the agent's shell is the one ssh the real CLI sandboxes.
 */
export const TEST_SSH_DIR = "OPENCORP_TEST_SSH_DIR"

/** ssh's home for the agent's shells: `passwd`, the passwd entry's (`os.userInfo().homedir`), where ssh reads
 *  `~/.ssh`; `$HOME` when `TEST_SSH_DIR` names a test's folder. */
export function sshHome(passwd: string, env: Readonly<Record<string, string | undefined>>): string {
  return env[TEST_SSH_DIR] && env.HOME ? env.HOME : passwd
}

/** What the agent's policy is built from, besides hq's paths. */
export interface AgentPolicyInit {
  /** ssh's home, where it reads `~/.ssh`: `sshHome`'s. */
  readonly home: string
  /** The shells' temp folder: a private folder outside hq and `~/.ssh`. */
  readonly tmpdir: string
  /** The real ssh the wrapper runs (`findSsh`'s): bound read-only outside the system's folders, and asked what files
   *  the agent's config names. */
  readonly ssh: string
  /** The visit's environment: the agent's socket (`SSH_AUTH_SOCK`), a Kerberos cache (`KRB5CCNAME`) and, in tests,
   *  `TEST_SSH_DIR` come from it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** More read-only paths: tests bind the fake ssh's Bun and source here. */
  readonly readOnly?: readonly string[]
  /** Runs the probe call in the sandbox: `run` from runtime/sandbox; tests stand in one whose sandbox fails. */
  readonly run?: typeof run
}

/** The SSH-only policy for learning's shells. Its temp folder and the agent's own status file in `hq/ssh` are
 *  checked as `SshPolicy` checks them; a probe call must run in it; then `ssh -G` with `hq/ssh/agent.config` names the
 *  files and ControlPath folder it binds. With `TEST_SSH_DIR` in the env, that folder is bound read-write once
 *  `testFolder` passes it. Throws `UnsafeProfile` for a bind that would expose hq, the home or a credential, and
 *  `SandboxUnavailable` where this platform has no sandbox or the probe can't run in it. */
export async function agentPolicy(paths: ReachPaths, o: AgentPolicyInit): Promise<SshPolicy> {
  const test = o.env[TEST_SSH_DIR]
  const init = {
    home: o.home,
    hq: paths.dir,
    tmpdir: o.tmpdir,
    statusFile: paths.agentStatus(process.pid),
    agentSocket: o.env.SSH_AUTH_SOCK ?? null,
    kerberos: o.env.KRB5CCNAME ?? null,
    ssh: o.ssh,
    readOnly: o.readOnly ?? [],
    readWrite: test ? [testFolder(test, [o.home, o.env.HOME ?? o.home, paths.home])] : [],
  }
  const base = new SshPolicy(init)
  await probe(base, o.run ?? run)
  return new SshPolicy({ ...init, sshFiles: await sshFiles(base, o.ssh, paths.agentConfig) })
}

/** `dir`, a test's fake ssh folder, resolved, once it is the user's own 0700 folder, no link, holding none of `homes`
 *  (ssh's home, `$HOME` and OpenCorp's home) and lying in none of them; `SshPolicy` then checks it as any bind, and
 *  for hard links to a credential. Throws `UnsafeProfile` otherwise. */
export function testFolder(dir: string, homes: readonly string[]): string {
  const refuse = (why: string) => new UnsafeProfile(`the test folder ${dir} can't be bound: ${why}`)
  let entry: fs.Stats
  try {
    entry = fs.lstatSync(dir)
  } catch {
    throw refuse("nothing is there")
  }
  if (entry.isSymbolicLink()) throw refuse("it is a link")
  if (!entry.isDirectory()) throw refuse("it is not a folder")
  if (entry.uid !== process.getuid!()) throw refuse("it is not the user's")
  if ((entry.mode & 0o777) !== 0o700) throw refuse("it is not 0700")
  const real = realPath(dir)
  for (const home of homes.map((h) => realPath(h))) {
    if (within(home, real)) throw refuse(`it holds ${home}`)
    if (within(real, home)) throw refuse(`it lies in ${home}`)
  }
  return real
}

/** Throws `SandboxUnavailable`, saying why, unless `/bin/sh -c 'exit 0'` runs in `policy` within `PROBE_S`: on
 *  Linux, bubblewrap missing, or refused where unprivileged user namespaces are off; on macOS, Seatbelt refusing the
 *  profile. Any failure counts, since the shells would fail the same way, and no sandbox only asks the owner. */
async function probe(policy: SshPolicy, runIn: typeof run): Promise<void> {
  let ran: Awaited<ReturnType<typeof run>>
  try {
    ran = await runIn(policy, ["/bin/sh", "-c", "exit 0"], { timeout: PROBE_S })
  } catch (error) {
    if (error instanceof SandboxUnavailable) throw error
    throw new SandboxUnavailable(`the sandbox can't start: ${(error as Error).message}`)
  }
  if (ran.exit === 0) return
  if (ran.exit === null) throw new SandboxUnavailable(`a sandboxed call didn't finish in ${PROBE_S} s`)
  const said = cleanOutput(ran.stderr.toString("utf8")).split("\n").map((line) => line.trim()).filter(Boolean).at(-1)
  throw new SandboxUnavailable(said === undefined ? `a sandboxed call exited ${ran.exit}` : headChars(said, 300))
}

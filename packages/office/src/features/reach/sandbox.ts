/** The agent's SSH-only sandbox while learning: the owner's ssh config and `~/.ssh` read-only, `hq/ssh` read-only for
 *  the wrapper and the agent's config, and nothing else of hq, `hq/cm` included. */
import { run, SandboxUnavailable } from "../../runtime/sandbox/run.ts"
import { SshPolicy, sshFiles } from "../../runtime/sandbox/ssh_policy.ts"
import type { ReachPaths } from "./paths.ts"
import { cleanOutput, headChars } from "./ssh.ts"

/** How long the probe call may take, in seconds. */
const PROBE_S = 30

/** What the agent's policy is built from, besides hq's paths. */
export interface AgentPolicyInit {
  /** ssh's home, where it reads `~/.ssh`: the passwd entry's (`os.userInfo().homedir`). */
  readonly home: string
  /** The shells' temp folder: a private folder outside hq and `~/.ssh`. */
  readonly tmpdir: string
  /** The real ssh the wrapper runs (`findSsh`'s): bound read-only outside the system's folders, and asked what files
   *  the agent's config names. */
  readonly ssh: string
  /** The visit's environment: the agent's socket (`SSH_AUTH_SOCK`) and a Kerberos cache (`KRB5CCNAME`) come from it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** More read-only paths: tests bind the fake ssh's Bun and source here. */
  readonly readOnly?: readonly string[]
  /** Runs the probe call in the sandbox: `run` from runtime/sandbox; tests stand in one whose sandbox fails. */
  readonly run?: typeof run
}

/** The SSH-only policy for learning's shells. Its temp folder and the agent's own status file in `hq/ssh` are
 *  checked as `SshPolicy` checks them; a probe call must run in it; then `ssh -G` with `hq/ssh/agent.config` names the
 *  files and ControlPath folder it binds. Throws `UnsafeProfile` for a bind that would expose hq, the home or a
 *  credential, and `SandboxUnavailable` where this platform has no sandbox or the probe can't run in it. */
export async function agentPolicy(paths: ReachPaths, o: AgentPolicyInit): Promise<SshPolicy> {
  const init = {
    home: o.home,
    hq: paths.dir,
    tmpdir: o.tmpdir,
    statusFile: paths.agentStatus(process.pid),
    agentSocket: o.env.SSH_AUTH_SOCK ?? null,
    kerberos: o.env.KRB5CCNAME ?? null,
    ssh: o.ssh,
    readOnly: o.readOnly ?? [],
  }
  const base = new SshPolicy(init)
  await probe(base, o.run ?? run)
  return new SshPolicy({ ...init, sshFiles: await sshFiles(base, o.ssh, paths.agentConfig) })
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

/** The agent's SSH-only sandbox while learning: the owner's ssh config and `~/.ssh` read-only, `hq/ssh` read-only for
 *  the wrapper and the agent's config, and nothing else of hq, `hq/cm` included. */
import { SshPolicy, sshFiles } from "../../runtime/sandbox/ssh_policy.ts"
import type { ReachPaths } from "./paths.ts"

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
}

/** The SSH-only policy for learning's shells. Its temp folder and `hq/ssh`'s status file are checked as
 *  `SshPolicy` checks them; `ssh -G` with `hq/ssh/agent.config` (run in the policy without its files) names the files
 *  and ControlPath folder it binds. Throws `UnsafeProfile` for a bind that would expose hq, the home or a credential,
 *  and `SandboxUnavailable` where this platform has no sandbox. */
export async function agentPolicy(paths: ReachPaths, o: AgentPolicyInit): Promise<SshPolicy> {
  const init = {
    home: o.home,
    hq: paths.dir,
    tmpdir: o.tmpdir,
    statusFile: paths.status(process.pid),
    agentSocket: o.env.SSH_AUTH_SOCK ?? null,
    kerberos: o.env.KRB5CCNAME ?? null,
    ssh: o.ssh,
    readOnly: o.readOnly ?? [],
  }
  return new SshPolicy({ ...init, sshFiles: await sshFiles(new SshPolicy(init), o.ssh, paths.agentConfig) })
}

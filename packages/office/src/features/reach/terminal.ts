/** Learning's terminal: the shells OpenCorp's agent works while it learns the path to HQ. They run in an SSH-only
 *  sandbox of their own (`agentPolicy`) with the owner's ssh config and `ControlMaster no`, so the agent's ssh rides a
 *  connection the owner has open, or logs in directly, and never keeps one. The model's key and sign-in stay out of
 *  reach, and the terminal shows the screen as it is: nothing is scrubbed from its view or records, which go to
 *  `hq/sessions/<id>/terminal/`. Where there is no sandbox, the owner is asked first, with Stop as the default. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { now } from "@opencorp/protocol"
import { spawnPty } from "../../platform.ts"
import type { CheckInput, Permissions } from "../../runtime/permissions/policy.ts"
import { SAFE_PATH, SandboxUnavailable, scrubbedEnv, startOnTerminal } from "../../runtime/sandbox/run.ts"
import type { SshPolicy } from "../../runtime/sandbox/ssh_policy.ts"
import { InstrumentRecord } from "../../tools/terminal/record.ts"
import type { ShellHost, ShellState } from "../../tools/terminal/shell.ts"
import { Terminal, type TerminalHost, type TerminalShells, type TerminalTool } from "../../tools/terminal/terminal.ts"
import { refusalText, type ToolName } from "../../tools/terminal/tools.ts"
import { newId } from "../../util/ids.ts"
import { checkFolder, makePrivateFolder } from "../../util/private_files.ts"
import type { ReachPaths } from "./paths.ts"
import { NO_SANDBOX_QUESTION, noSandbox, RUN_UNSANDBOXED, STOP } from "./risks.ts"
import { agentPolicy, type AgentPolicyInit } from "./sandbox.ts"

/** Who runs the agent's commands, as the records name them. */
const DRIVER = "opencorp"

/** The question before shells run with no sandbox: the risks, the question, its answers, and the one a bare Enter
 *  takes. */
export interface ConsentAsk {
  readonly lines: readonly string[]
  readonly question: string
  readonly choices: readonly string[]
  readonly default: string
}

/** Asks the owner `ask` and resolves to the answer they chose. */
export type Consent = (ask: ConsentAsk) => Promise<string>

/** What learning's terminal is made from; the agent sets none of it. */
export interface LearningTerminalOptions {
  /** hq's paths. The visit has written its ssh files (`writeSshFiles`): the wrapper and `agent.config`. */
  readonly paths: ReachPaths
  /** The learning session's id: its shells' records go to `paths.session(session)/terminal/<shell id>/`. */
  readonly session: string
  /** ssh's home, where it reads `~/.ssh`: the passwd entry's (`os.userInfo().homedir`). */
  readonly home: string
  /** The real ssh the wrapper runs (`findSsh`'s). */
  readonly ssh: string
  /** The visit's environment, for the agent's socket and a Kerberos cache; nothing else of it reaches a shell. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The session's mode, rules, cards and Auto's check, and the credentials its `where` marks. Where a shell starts
   *  is the terminal's own to say. */
  readonly permissions: Permissions
  /** Asks the owner whether shells may run with no sandbox; only `RUN_UNSANDBOXED` starts them. */
  readonly consent: Consent
  /** Where shell `id`'s state changes and live output go, from the moment it is made. */
  readonly onShell?: (id: string, name: string) => {
    changed(state: ShellState): void
    output(chunk: Uint8Array): void
  }
  /** More read-only paths for the sandbox: tests bind the fake ssh's Bun and source here. */
  readonly readOnly?: readonly string[]
  /** The shells' temp folder. By default a fresh one (0700) under the system's temp folder, removed once the
   *  terminal has closed; tests pass one that holds the fake ssh. */
  readonly tmpdir?: string
  /** Builds the shells' sandbox (`agentPolicy`); tests stand in one that can't. */
  readonly policy?: (paths: ReachPaths, init: AgentPolicyInit) => Promise<SshPolicy>
}

/** Learning's terminal, as a `Terminal` whose host this function binds: its shells on PTYs in the agent's SSH-only
 *  sandbox, driven by OpenCorp, under `o.permissions`, each with a record in the session's folder.
 *
 *  Where the platform has no sandbox (`SandboxUnavailable`), `o.consent` shows the risks and asks before any shell
 *  starts, Stop by default. On Yes the shells start with none, which the gate reads as the SSH-only profile; on Stop
 *  none starts, and every call says why, before any gate.
 *
 *  Throws for a session id that isn't one plain name, before anything else, and what building the sandbox throws
 *  otherwise (`UnsafeProfile`, say). */
export async function learningTerminal(o: LearningTerminalOptions): Promise<Terminal> {
  o.paths.session(o.session)
  const made = o.tmpdir === undefined
  const tmpdir = fs.realpathSync(o.tmpdir ?? fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-learn-")))
  const cleanUp = () => {
    if (made) fs.rmSync(tmpdir, { recursive: true, force: true })
    fs.rmSync(o.paths.agentStatus(process.pid), { force: true })
  }
  try {
    const shells = await learningShells(o, tmpdir)
    if (typeof shells !== "string") return new LearningTerminal(host(o, shells, tmpdir), cleanUp)
    cleanUp()
    return new StoppedTerminal(host(o, stoppedShells(shells), tmpdir), shells)
  } catch (error) {
    cleanUp()
    throw error
  }
}

/** Shells in the agent's sandbox; where there is none, shells with none once the owner says so, or why there are
 *  none. */
async function learningShells(o: LearningTerminalOptions, tmpdir: string): Promise<TerminalShells | string> {
  let sandbox: SshPolicy
  try {
    const init = { home: o.home, tmpdir, ssh: o.ssh, env: o.env, readOnly: o.readOnly ?? [] }
    sandbox = await (o.policy ?? agentPolicy)(o.paths, init)
  } catch (error) {
    if (!(error instanceof SandboxUnavailable)) throw error
    const lines = noSandbox(o.paths, error.message)
    const ask = { lines, question: NO_SANDBOX_QUESTION, choices: [RUN_UNSANDBOXED, STOP], default: STOP }
    if ((await o.consent(ask)) === RUN_UNSANDBOXED) return unsandboxed(o, tmpdir)
    return `the owner stopped learning's shells: OpenCorp can't sandbox them here (${error.message})`
  }
  return sandboxed(o.paths, sandbox, tmpdir)
}

/** A `Terminal` that removes its shells' temp folder and status file once they have ended. */
class LearningTerminal extends Terminal {
  constructor(
    host: TerminalHost,
    private readonly cleanUp: () => void,
  ) {
    super(host)
  }

  override async close(): Promise<void> {
    try {
      await super.close()
    } finally {
      this.cleanUp()
    }
  }
}

/** Learning's terminal once the owner chose Stop: every call is refused with `why`, before any gate or shell. */
class StoppedTerminal extends Terminal {
  constructor(
    host: TerminalHost,
    private readonly why: string,
  ) {
    super(host)
  }

  override tools(): Record<ToolName, TerminalTool> {
    const refuse = async () => refusalText(this.why)
    const tools = Object.entries(super.tools()).map(([name, tool]) => [name, { ...tool, call: refuse }])
    return Object.fromEntries(tools) as Record<ToolName, TerminalTool>
  }

  override async runApproved(): Promise<string> {
    return refusalText(this.why)
  }
}

/** Shells that never start, saying `why`. */
function stoppedShells(why: string): TerminalShells {
  const refuse: ShellHost["start"] = () => {
    throw new Error(why)
  }
  return { kind: "pty", sandbox: null, start: refuse, env: {} }
}

/** PTY shells in `sandbox`: its env and `TERM`, with the visit's ssh wrapper first on `PATH` and the agent's config. */
function sandboxed(paths: ReachPaths, sandbox: SshPolicy, tmpdir: string): TerminalShells {
  return {
    kind: "pty",
    sandbox,
    start: (argv, io) => {
      startsIn(tmpdir)
      return startOnTerminal(sandbox, argv, { cols: io.cols, rows: io.rows, onData: io.onData, env: io.env })
    },
    env: { ...scrubbedEnv(sandbox), TERM: "xterm-256color", ...sshVars(paths) },
  }
}

/** PTY shells with no sandbox, which only the owner allows: the env a sandboxed shell gets, made here. */
function unsandboxed(o: LearningTerminalOptions, tmpdir: string): TerminalShells {
  const { SSH_AUTH_SOCK: agent, KRB5CCNAME: kerberos } = o.env
  return {
    kind: "pty",
    sandbox: null,
    start: (argv, io) => {
      startsIn(tmpdir)
      return spawnPty(argv, { cwd: tmpdir, env: io.env, cols: io.cols, rows: io.rows, onData: io.onData })
    },
    env: {
      HOME: o.home,
      TMPDIR: tmpdir,
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      ...(agent ? { SSH_AUTH_SOCK: agent } : {}),
      ...(kerberos ? { KRB5CCNAME: kerberos } : {}),
      ...sshVars(o.paths),
    },
  }
}

/** The visit's ssh wrapper first on `PATH`, reading the agent's config. */
function sshVars(paths: ReachPaths): Record<string, string> {
  return { PATH: `${paths.bin}:${SAFE_PATH}`, OPENCORP_SSH_CONFIG: paths.agentConfig }
}

/** Throws unless `folder` is a folder: a PTY's library may start a shell whose folder is gone in the home instead. */
function startsIn(folder: string): void {
  let directory = false
  try {
    directory = fs.statSync(folder).isDirectory()
  } catch {}
  if (!directory) throw new Error(`the shells' folder is not a directory: ${folder}`)
}

/** The host of learning's shells: OpenCorp drives them under the caller's permissions, each new shell gets a record in
 *  the session's folder, and they start in `tmpdir`. */
function host(o: LearningTerminalOptions, shells: TerminalShells, tmpdir: string): TerminalHost {
  const records = path.join(o.paths.session(o.session), "terminal")
  return {
    shells,
    driver: DRIVER,
    permissions: startingIn(o.permissions, o.paths, tmpdir),
    shellHost: (name, profile) => {
      for (const dir of [o.paths.sessions, o.paths.session(o.session), records]) {
        makePrivateFolder(dir)
        checkFolder(dir, "folder")
      }
      const id = newId()
      const meta = { id, name, kind: "terminal" as const, profile, driver: DRIVER, started: now() }
      const record = new InstrumentRecord(path.join(records, id), meta)
      const listener = o.onShell?.(id, name)
      return {
        id,
        record,
        changed: (state) => listener?.changed(state),
        output: (chunk) => listener?.output(chunk),
      }
    },
  }
}

/** `base`, but a new shell starts in `tmpdir`, as the terminal's own `where` says, and hq's model key and sign-in,
 *  and everything in the office's connections and secrets folders, are credentials beside those `base` marks: the
 *  reader's own patterns know them only under `~/.opencorp`. */
function startingIn(base: Permissions, paths: ReachPaths, tmpdir: string): Permissions {
  const { check, blocked } = base
  const office = ["connections", "secrets"].map((name) => `${path.join(paths.home, "office", name)}/**`)
  return {
    mode: () => base.mode(),
    rules: () => base.rules(),
    where: () => {
      const where = base.where()
      const credentials = [...(where.credentials ?? []), paths.provider, paths.auth, ...office]
      return { ...where, profile: "ssh", cwd: tmpdir, writable: [], credentials }
    },
    hold: (card, callId) => base.hold(card, callId),
    ...(check ? { check: (input: CheckInput, signal: AbortSignal) => check.call(base, input, signal) } : {}),
    ...(blocked ? { blocked: () => blocked.call(base) } : {}),
  }
}


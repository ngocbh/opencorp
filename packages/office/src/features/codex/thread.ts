/** What a Codex thread runs under beside its employee's permission: the private folder under `/tmp` holding each
 *  thread's temp folder and the fence, the app-server's PATH and TMPDIR, and the load that turns the owner's MCP
 *  servers off but those the employee may use. Also doctor's probe of a thread that starts but can't be used. */
import fs from "node:fs"
import path from "node:path"
import {
  type EmployeePermission,
  type HarnessInstall,
  checkCodexInstall,
  codexThread,
  harnessHomes,
  harnessPath,
} from "../../runtime/sandbox/harness_profile.ts"
import { fenceIn, freshFolder, harnessRoot, removeFolder } from "../../runtime/sandbox/harness_temp.ts"
import { UnsafeProfile, UnsafeWorkspace } from "../../runtime/sandbox/policy.ts"
import { APP_SERVER_ARGS, CodexProcess, CodexStartError, threadLoad } from "../../tools/codex/codex.ts"
import { type JsonRpc, RpcClosed, RpcError, nameOf } from "../../tools/codex/rpc.ts"

/** Milliseconds `config/read` has to answer. */
const CONFIG_READ_MS = 30_000
/** Milliseconds the probe's app-server has to exit once its stdin closes. */
const PROBE_GRACE_MS = 2_000

/** `<base>/opencorp-<uid>/codex`, which holds each Codex thread's temp folder and the fence (`harnessRoot`). */
export function harnessTemp(base = "/tmp"): string {
  return harnessRoot("codex", base)
}

/** The app-server's environment for a thread under `p`: `base` with the harness PATH and `p`'s temp folder as TMPDIR.
 *  Throws as `harnessPath` does. */
export function threadEnv(base: Record<string, string>, p: EmployeePermission): Record<string, string> {
  return { ...base, PATH: harnessPath(p), TMPDIR: p.tmpdir }
}

/** A project's own Codex config (`.codex/config.toml` in the folder or one above it) that Codex would load for a
 *  thread there, because the owner's Codex config trusts the project. Its MCP servers and hooks would run as the owner,
 *  outside the employee's permission, and the thread's override can't stop them, so the load is refused. */
export class ProjectConfigLoads extends Error {
  override name = "ProjectConfigLoads"

  constructor(readonly folders: readonly string[]) {
    super(
      `Codex would load this project's own config (${folders.map((f) => path.join(f, "config.toml")).join(", ")}), ` +
        "since your Codex config trusts the project, and its MCP servers and hooks would run as you, outside your " +
        "employee's permission. Untrust the project in your Codex config.toml (its [projects] entry), or remove that " +
        "file, then send your message again.",
    )
  }
}

/** MCP servers the owner's Codex config defines that a running thread's override, made at its load, doesn't turn off:
 *  added since, they would start as the owner at the next turn, which reloads the config. */
export class McpServersAdded extends Error {
  override name = "McpServersAdded"

  constructor(readonly servers: readonly string[]) {
    super(
      `Your Codex config has MCP servers this session didn't turn off when it started (${servers.join(", ")}), and ` +
        "they would run as you, outside your employee's permission. Remove them from your Codex config.toml, or " +
        "end this session and start another, which turns them off, then send your message again.",
    )
  }
}

/** The owner's Codex config as the app-server reads it for a thread in `cwd` (`config/read` with its layers; nothing
 *  is written): the MCP servers it defines, and those of them Codex starts as a program (`stdio`: a `command`, as
 *  against a `url`). Throws `ProjectConfigLoads` when a project layer would load, and rejects as the request does. */
export async function ownerConfig(rpc: JsonRpc, cwd: string): Promise<{ mcpServers: string[]; stdio: string[] }> {
  const read = (await rpc.request("config/read", { cwd, includeLayers: true }, { timeout: CONFIG_READ_MS })) as {
    config?: { mcp_servers?: unknown }
    layers?: { name?: { type?: unknown; dotCodexFolder?: unknown }; disabledReason?: unknown }[] | null
  } | null
  // Codex lists a project layer it won't load (the project isn't trusted) with the reason it doesn't.
  const loaded = (read?.layers ?? []).filter((layer) => layer.name?.type === "project" && !layer.disabledReason)
  if (loaded.length > 0) throw new ProjectConfigLoads(loaded.map((layer) => String(layer.name?.dotCodexFolder)))
  const servers = read?.config?.mcp_servers
  const defined = isRecord(servers) ? Object.entries(servers) : []
  const stdio = defined.filter(([, server]) => isRecord(server) && server.command !== undefined).map(([name]) => name)
  return { mcpServers: defined.map(([name]) => name), stdio }
}

/** The `thread/start` (or `thread/resume`) params of a thread in `p.workspace` under `p`, with profile `id`: every MCP
 *  server the owner's config defines (`ownerConfig`) turned off but those `p` allows, each of those Codex starts as a
 *  program started in the office's empty folder, and `install` read (`codexThread`). Rejects when the config can't be
 *  read, since a server left on would run as the owner; throws `ProjectConfigLoads`, and as `codexThread` does. */
export async function employeeLoad(rpc: JsonRpc, p: EmployeePermission, id: string, install: string) {
  const { mcpServers, stdio } = await ownerConfig(rpc, p.workspace)
  return threadLoad(p.workspace, codexThread(p, id, { install, mcpServers, stdio }))
}

/** Throws `UnsafeProfile` unless Codex's answer to a load (`thread/start`, `thread/resume`) says the thread runs as
 *  the office asked: no approval asked, and profile `id` active. */
export function checkLoaded(answer: unknown, id: string): void {
  const loaded = (isRecord(answer) ? answer : {}) as { approvalPolicy?: unknown; activePermissionProfile?: unknown }
  const profile = isRecord(loaded.activePermissionProfile) ? loaded.activePermissionProfile.id : null
  if (loaded.approvalPolicy === "never" && profile === id) return
  throw new UnsafeProfile(
    `Codex loaded the thread with approval policy ${JSON.stringify(loaded.approvalPolicy ?? null)} and profile ` +
      `${JSON.stringify(profile ?? null)}, not "never" and ${JSON.stringify(id)}`,
  )
}

/** What `threadProbe` runs. */
export type ProbeOptions = {
  /** What runs Codex, its install folder (`nativeCodex`), and the path found on PATH that led to it. */
  codex: HarnessInstall
  /** The app-server's environment, as the office gives one (the worker environment). */
  env: Record<string, string>
  /** The office's environment: its `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. */
  environ: Record<string, string | undefined>
  /** The owner's home and `<OPENCORP_HOME>`, denied by name. */
  home: string
  officeHome: string
  /** Where `harnessTemp` is (default `/tmp`). */
  base?: string
  /** Milliseconds each request has to answer. */
  timeoutMs: number
  /** Folders others may write: every person's writable listed folders, and live sessions' folders. */
  othersWritable?: readonly string[]
}

/** What `threadProbe` found: what failed and the log holding Codex's output, or null; the projects the owner's Codex
 *  config trusts whose own config would load, where employees' Codex sessions are refused; and the MCP servers the
 *  owner's Codex config defines, by name (none when it failed before reading them). */
export type Probed = { failed: { why: string; log: string } | null; projectConfigs: string[]; mcpServers: string[] }

/** The most trusted projects the probe looks at. */
const PROJECTS_MAX = 50

/** Whether a Codex thread under an employee's permission can be used. It checks Codex as the office would run it
 *  (`checkCodexInstall`), starts it as a session does, loads an ephemeral thread in a fresh read-only folder with no
 *  network, then lists the thread's MCP servers, which reloads its config as each turn does: a thread can start under
 *  a config no turn could load. Then, for each project the owner's Codex config trusts (up to 50), whether its own
 *  config would load. No model turn runs; the probe's folders are removed, and Codex's output stays in
 *  `doctor-codex.log` beside the fence. The MCP servers its load turned off are the owner's, named for doctor. */
export async function threadProbe(options: ProbeOptions): Promise<Probed> {
  const root = harnessTemp(options.base)
  const name = `doctor-${process.pid}`
  const dir = freshFolder(root, name)
  const ws = path.join(dir, "ws")
  const tmpdir = path.join(dir, "tmp")
  fs.mkdirSync(ws, { mode: 0o700 })
  fs.mkdirSync(tmpdir, { mode: 0o700 })
  const log = path.join(root, "doctor-codex.log")
  fs.rmSync(log, { force: true })
  let proc: CodexProcess | null = null
  let step = ""
  let mcpServers: string[] = []
  try {
    const p: EmployeePermission = {
      workspace: ws,
      gitRoot: null,
      writable: false,
      network: false,
      tmpdir,
      fence: fenceIn(root),
      folders: [],
      home: options.home,
      officeHome: options.officeHome,
      harnessHomes: harnessHomes(options.environ),
      othersWritable: options.othersWritable ?? [],
    }
    checkCodexInstall(p, options.codex)
    const started: CodexProcess = (proc = new CodexProcess({
      command: [options.codex.run, ...APP_SERVER_ARGS],
      cwd: ws,
      env: threadEnv(options.env, p),
      log,
      onNotification() {},
      // Doctor serves nothing; Codex takes the error as a refusal.
      onRequest: (id) => void started.rpc?.replyError(id, -32601, "opencorp doctor answers no request").catch(() => {}),
      onExit() {},
      environ: options.environ,
      logLine() {},
    }))
    step = "the start"
    await started.start()
    const rpc = started.rpc!
    const timeout = options.timeoutMs
    step = "config/read"
    // As `employeeLoad` loads a session's thread, keeping the names the owner's config defines.
    mcpServers = (await ownerConfig(rpc, ws)).mcpServers
    const params = threadLoad(ws, codexThread(p, "opencorp-doctor", { install: options.codex.install, mcpServers }))
    step = "thread/start"
    const loaded = await rpc.request("thread/start", { ...params, ephemeral: true }, { timeout })
    checkLoaded(loaded, "opencorp-doctor")
    step = "mcpServerStatus/list"
    const threadId = (loaded as { thread: { id: string } }).thread.id
    await rpc.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" }, { timeout })
    step = "config/read"
    return { failed: null, projectConfigs: await projectConfigs(rpc), mcpServers }
  } catch (error) {
    return { failed: { why: probeFailure(error, step), log }, projectConfigs: [], mcpServers: [] }
  } finally {
    await proc?.close(PROBE_GRACE_MS)
    removeFolder(root, name)
  }
}

/** The `.codex` folders whose config Codex would load in the projects the owner's Codex config trusts (the first 50
 *  that are folders), as `ownerConfig` finds them; a project Codex can't read is skipped. */
async function projectConfigs(rpc: JsonRpc): Promise<string[]> {
  const read = (await rpc.request("config/read", {}, { timeout: CONFIG_READ_MS })) as { config?: { projects?: unknown } }
  const projects = read?.config?.projects
  const trusted = Object.entries(isRecord(projects) ? projects : {})
    .filter(([dir, project]) => isRecord(project) && project.trust_level === "trusted" && path.isAbsolute(dir))
    .map(([dir]) => dir)
    .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    .slice(0, PROJECTS_MAX)
  const found: string[] = []
  for (const dir of trusted) {
    try {
      await ownerConfig(rpc, dir)
    } catch (error) {
      if (error instanceof ProjectConfigLoads) found.push(...error.folders)
    }
  }
  return [...new Set(found)]
}

/** Why the probe failed at `step` (empty before Codex runs). */
function probeFailure(error: unknown, step: string): string {
  if (error instanceof UnsafeProfile || error instanceof UnsafeWorkspace) {
    return `an employee's permission can't be built here: ${error.message}`
  }
  if (step === "the start") {
    return `Codex didn't start: ${failure(error instanceof CodexStartError ? error.cause : error)}`
  }
  if (error instanceof ProjectConfigLoads) return error.message
  return `${step} failed: ${failure(error)}`
}

/** What went wrong, in words: Codex's own message, or the error's. */
function failure(error: unknown): string {
  if (error instanceof RpcError) return error.rpcMessage
  if (error instanceof RpcClosed || error instanceof Error) return error.message
  return nameOf(error)
}

/** A plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

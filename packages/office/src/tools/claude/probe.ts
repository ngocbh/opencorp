/** Doctor's probe of Claude Code: whether it starts as an employee's session would, under their permission, signed
 *  in, and at least the floor, with no model call. */
import fs from "node:fs"
import path from "node:path"
import { type EmployeePermission, checkClaudeInstall, claudeStart } from "../../runtime/sandbox/harness_profile.ts"
import { fenceIn, freshFolder, harnessRoot, removeFolder, sweepTemp } from "../../runtime/sandbox/harness_temp.ts"
import { ClaudeProcess, claudeArgs } from "./claude.ts"

/** Milliseconds the probe's Claude Code has to exit once its stdin closes. */
const PROBE_GRACE_MS = 2_000

/** What `probeStart` runs. */
export type ProbeOptions = {
  /** What runs Claude Code, and its install folder (`nativeClaude`). */
  claude: { run: string; install: string }
  /** Claude Code's environment before its fixed variables, as the office gives one (the worker environment). */
  env: Record<string, string>
  /** The office's environment: its `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. */
  environ: Record<string, string | undefined>
  /** The owner's home and `<OPENCORP_HOME>`, denied by name. */
  home: string
  officeHome: string
  /** Where the harness folder is (`harnessRoot`; default `/tmp`). */
  base?: string
}

/** Starts Claude Code as an employee's session starts it, in a fresh read-only folder with no network and no listed
 *  folder, under the permission's settings: `checkClaudeInstall` first, since it runs as the owner, then the start,
 *  which reads `initialize`'s version and account and sends no message, so no model call runs. Resolves with why it
 *  failed (`ClaudeStartError`'s kinds, or `UnsafeProfile` and `UnsafeWorkspace` for the permission or the install),
 *  or null, and the log holding Claude Code's output, `doctor-claude.log` in the harness folder. The probe's folders
 *  are removed, and a dead probe's left by a crash are swept first. */
export async function probeStart(options: ProbeOptions): Promise<{ error: Error | null; log: string }> {
  const root = harnessRoot("claude", options.base)
  sweepTemp(root, () => false, () => {})
  const name = `doctor-${process.pid}`
  const dir = freshFolder(root, name)
  const ws = path.join(dir, "ws")
  const tmpdir = path.join(dir, "tmp")
  fs.mkdirSync(ws, { mode: 0o700 })
  fs.mkdirSync(tmpdir, { mode: 0o700 })
  const log = path.join(root, "doctor-claude.log")
  fs.rmSync(log, { force: true })
  let proc: ClaudeProcess | null = null
  try {
    const p: EmployeePermission = {
      workspace: ws,
      gitRoot: null,
      writable: false,
      network: false,
      tmpdir,
      // The permission's check wants one; Claude Code's settings don't use it.
      fence: fenceIn(root),
      folders: [],
      home: options.home,
      officeHome: options.officeHome,
      harnessHomes: [options.environ.CODEX_HOME, options.environ.CLAUDE_CONFIG_DIR].filter((d): d is string => !!d),
    }
    checkClaudeInstall(p, options.claude)
    const start = claudeStart(p)
    proc = new ClaudeProcess({
      command: [options.claude.run, ...claudeArgs(start)],
      cwd: ws,
      env: { ...options.env, ...start.env },
      log,
      environ: options.environ,
      onMessage() {},
      onExit() {},
      logLine() {},
    })
    await proc.start()
    return { error: null, log }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)), log }
  } finally {
    await proc?.close(PROBE_GRACE_MS)
    removeFolder(root, name)
  }
}

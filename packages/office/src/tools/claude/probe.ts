/** Doctor's probe of Claude Code: whether it starts as an employee's session would, under their permission, signed
 *  in, and at least the floor, with no model call. */
import fs from "node:fs"
import path from "node:path"
import {
  type EmployeePermission,
  type HarnessInstall,
  checkClaudeInstall,
  checkSocatInstall,
  claudeStart,
} from "../../runtime/sandbox/harness_profile.ts"
import {
  fenceIn,
  freshFolder,
  harnessRoot,
  programsFolder,
  removeFolder,
  sweepTemp,
} from "../../runtime/sandbox/harness_temp.ts"
import { UnsafeProfile } from "../../runtime/sandbox/policy.ts"
import { ClaudeProcess, claudeArgs } from "./claude.ts"

/** Milliseconds the probe's Claude Code has to exit once its stdin closes. */
const PROBE_GRACE_MS = 2_000

/** What `probeStart` runs. */
export type ProbeOptions = {
  /** What runs Claude Code, its install folder (`nativeClaude`), and the path found on PATH that led to it. */
  claude: HarnessInstall
  /** Claude Code's environment before its fixed variables, as the office gives one (the worker environment). */
  env: Record<string, string>
  /** The office's environment: its `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. */
  environ: Record<string, string | undefined>
  /** The owner's home and `<OPENCORP_HOME>`, denied by name. */
  home: string
  officeHome: string
  /** Where the harness folder is (`harnessRoot`; default `/tmp`). */
  base?: string
  /** Folders others may write: every person's writable listed folders, and live sessions' folders. */
  othersWritable?: readonly string[]
  /** The socat Claude Code's sandbox runs, where it needs one: checked as Claude Code is and copied into the probe's
   *  own `bin`, first on its PATH, as a session's start does. */
  socat?: string
}

/** Starts Claude Code as an employee's session starts it, under the permission's settings, in a read-only folder with
 *  no network and no listed folder: `checkClaudeInstall` first, since it runs as the owner, then the start, which
 *  reads `initialize`'s version and account and sends no message, so no model call runs and no command runs in the
 *  sandbox (a sandbox that fails only on a command shows only in a session). It keeps no session, and runs in the
 *  same folder each time (`doctor-ws`, empty, kept), so Claude Code's own record of the folders it ran in doesn't
 *  grow; it is given no instructions, which matter only to a message. Resolves with why it failed
 *  (`ClaudeStartError`'s kinds, or `UnsafeProfile` and `UnsafeWorkspace` for the permission or the install), or null,
 *  and the log holding Claude Code's output, `doctor-claude.log` in the harness folder. The probe's temp folder is
 *  removed, and a dead probe's left by a crash is swept first. */
export async function probeStart(options: ProbeOptions): Promise<{ error: Error | null; log: string }> {
  const root = harnessRoot("claude", options.base)
  sweepTemp(root, () => false, () => {})
  const name = `doctor-${process.pid}`
  const dir = freshFolder(root, name)
  const ws = keptFolder(path.join(root, "doctor-ws"))
  const tmpdir = path.join(dir, "tmp")
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
      othersWritable: options.othersWritable ?? [],
    }
    checkClaudeInstall(p, options.claude)
    if (options.socat !== undefined) {
      p.programs = programsFolder(dir, "bin", { socat: checkSocatInstall(p, options.socat) })
    }
    const start = claudeStart(p)
    proc = new ClaudeProcess({
      command: [options.claude.run, ...claudeArgs(start, { persist: false })],
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

/** `dir`, an empty private folder of the user's: made 0700 when missing; `UnsafeProfile` when it is a link, not the
 *  user's or not empty. */
function keptFolder(dir: string): string {
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new UnsafeProfile(`doctor's folder ${dir} isn't the user's own folder (a link is refused)`)
  }
  if (fs.readdirSync(dir).length > 0) throw new UnsafeProfile(`doctor's folder ${dir} isn't empty`)
  return dir
}

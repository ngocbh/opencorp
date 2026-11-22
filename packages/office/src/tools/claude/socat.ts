/** The socat Claude Code's Linux sandbox runs for its network bridge, inside the sandbox: where it runs from, what the
 *  sandbox must read for it to load, and that it runs at all. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
  type EmployeePermission,
  checkPermission,
  checkSocatInstall,
  harnessPath,
  systemPath,
} from "../../runtime/sandbox/harness_profile.ts"
import { programsFolder } from "../../runtime/sandbox/harness_temp.ts"
import { realPath } from "../../runtime/sandbox/policy.ts"
import { ClaudeSandboxUnavailable } from "./claude.ts"

/** Milliseconds `ldd` and `socat -V` each have. */
const RUN_TIMEOUT_MS = 10_000

/** The socat the office found can't be used: it doesn't run, or a library it loads can't be found. */
export class SocatUnusable extends ClaudeSandboxUnavailable {
  override name = "SocatUnusable"
}

/** What a session's start gives Claude Code for socat: the private folder holding its link (`EmployeePermission.programs`),
 *  or null when it needs none, and the folders the sandbox must read for it (`EmployeePermission.programReads`). */
export type PreparedSocat = { programs: string | null; reads: string[] }

/** What `prepareSocat` runs; tests pass stand-ins. */
export type SocatOptions = {
  /** The harness folder, and the name of this start's programs folder in it (`<session>.bin`). */
  root: string
  name: string
  /** The libraries `file` loads, as `ldd` resolves them (default `lddLibraries`). */
  libraries?: (file: string) => string[]
  /** The system folders on the harness PATH (default its own). */
  system?: readonly string[]
  /** The environment `socat -V` runs with, but its PATH, which is the harness's (default none). */
  env?: Record<string, string>
}

/**
 * Readies socat `found` (on the office's PATH, or `OPENCORP_SOCAT_BIN`) for a start under `p`: its real file checked as
 * Claude Code is (`checkSocatInstall`), then run once, outside the sandbox, with `-V`. One in a system folder on the
 * harness PATH needs nothing more. Any other is linked, alone, into the private folder `<root>/<name>` first on the
 * harness PATH, and the sandbox reads its real file's folder and the folders of the libraries it loads (`ldd`), each
 * checked as its folder is when the start builds the permission. Throws `UnsafeProfile` from the checks, and
 * `SocatUnusable` for one that doesn't run or misses a library.
 */
export function prepareSocat(p: EmployeePermission, found: string, options: SocatOptions): PreparedSocat {
  const { libraries = lddLibraries, system = systemPath(), env = {} } = options
  const real = checkSocatInstall(p, found)
  const ran = spawnSync(real, ["-V"], {
    env: { ...env, PATH: harnessPath(p) },
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (ran.error !== undefined || ran.status !== 0) {
    const why = (ran.stderr ?? "").trim().split("\n")[0]?.slice(0, 200) || ran.error?.message || `exit ${ran.status}`
    throw new SocatUnusable(
      `the socat the office found, ${real}, doesn't run (${why}); install a socat that runs as you, or point ` +
        "OPENCORP_SOCAT_BIN at one, then restart the office and run `opencorp doctor`",
    )
  }
  const folder = path.dirname(real)
  if (system.some((dir) => fs.existsSync(dir) && realPath(dir) === folder)) return { programs: null, reads: [] }
  const loaded = libraries(real).flatMap((lib) => [realPath(path.dirname(lib)), path.dirname(realPath(lib))])
  const reads = [...new Set([folder, ...loaded])]
  // Each folder checked before anything is made; the start's permission checks them again.
  checkPermission({ ...p, programReads: reads })
  const programs = programsFolder(options.root, options.name, { socat: real })
  return { programs, reads }
}

/** The libraries `file` loads, as the system's `ldd` resolves them (none for a static program or a script); throws
 *  `SocatUnusable` for one it can't find. */
export function lddLibraries(file: string): string[] {
  const ran = spawnSync("/usr/bin/ldd", [file], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  })
  const out = `${ran.stdout ?? ""}${ran.stderr ?? ""}`
  if (/not a dynamic executable/.test(out)) return []
  if (ran.error !== undefined || ran.status !== 0) throw new SocatUnusable(`ldd couldn't read ${file}: ${out.trim().slice(0, 200)}`)
  const missing = out.split("\n").find((line) => /=> not found/.test(line))
  if (missing !== undefined) throw new SocatUnusable(`${file} can't load ${missing.trim()}`)
  const libs: string[] = []
  for (const line of out.split("\n")) {
    const m = /=>\s+(\/\S+)\s+\(0x/.exec(line) ?? /^\s*(\/\S+)\s+\(0x/.exec(line)
    if (m !== null) libs.push(m[1]!)
  }
  return libs
}

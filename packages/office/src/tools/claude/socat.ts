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
 * Readies socat `found` (on the office's PATH, or `OPENCORP_SOCAT_BIN`) for a start under `p`, checking before it runs
 * anything of it: its real file checked as Claude Code is (`checkSocatInstall`), the libraries it loads read with
 * `ldd`, and its folder and theirs checked as an install folder is (`EmployeePermission.programReads`); only then is it
 * run once, outside the sandbox, with `-V`, so nothing the employee could plant loads first. One in a system folder on
 * the harness PATH needs nothing more. Any other is linked, alone, into the private folder `<root>/<name>` first on the
 * harness PATH, and the sandbox reads those folders. Throws `UnsafeProfile` from the checks, and `SocatUnusable` for
 * one that misses a library or doesn't run.
 */
export function prepareSocat(p: EmployeePermission, found: string, options: SocatOptions): PreparedSocat {
  const { libraries = lddLibraries, system = systemPath(), env = {} } = options
  const real = checkSocatInstall(p, found)
  const folder = path.dirname(real)
  const loaded = libraries(real).flatMap((lib) => [realPath(path.dirname(lib)), path.dirname(realPath(lib))])
  const reads = [...new Set([folder, ...loaded])]
  checkPermission({ ...p, programReads: reads })
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
  if (system.some((dir) => fs.existsSync(dir) && realPath(dir) === folder)) return { programs: null, reads: [] }
  const programs = programsFolder(options.root, options.name, { socat: real })
  return { programs, reads }
}

/** The libraries `file` loads, as the system's `ldd` resolves them, with a fixed environment (`parseLdd`). */
export function lddLibraries(file: string): string[] {
  const ran = spawnSync("/usr/bin/ldd", [file], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  })
  const out = `${ran.stdout ?? ""}${ran.stderr ?? ""}`
  if (ran.error !== undefined || (ran.status !== 0 && !/not a dynamic executable/.test(out))) {
    throw new SocatUnusable(`ldd couldn't read ${file}: ${out.trim().slice(0, 200)}`)
  }
  return parseLdd(out, file)
}

/** The library files in `ldd`'s output for `file`: none for a static program or a script. Throws `SocatUnusable` for a
 *  library it couldn't find (an RPATH folder it didn't resolve is never checked), and for one at a path with a space,
 *  which this reading leaves out rather than guess. */
export function parseLdd(out: string, file: string): string[] {
  if (/not a dynamic executable/.test(out)) return []
  const libs: string[] = []
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (/=>\s*not found/.test(line)) throw new SocatUnusable(`${file} can't load ${line.split(/\s+/)[0]}: ldd finds no such library`)
    const resolved = /^\S+ => (\/\S+) \(0x[0-9a-f]+\)$/.exec(line) ?? /^(\/\S+) \(0x[0-9a-f]+\)$/.exec(line)
    if (resolved !== null) libs.push(resolved[1]!)
    else if (/^\S+ (=> )?\(0x[0-9a-f]+\)$/.test(line)) continue // the kernel's vdso, which is no file
    else throw new SocatUnusable(`${file} loads a library at a path with a space, which OpenCorp doesn't read: ${line}`)
  }
  return libs
}

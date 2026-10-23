/** What one sandboxed call may touch. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Home paths holding credentials or office state; a workspace may not be one of them or
 *  lie inside one, since the workspace is readable (and maybe writable) by model code. */
export const SENSITIVE_HOME_PATHS: readonly string[] = [
  ".opencorp",
  // The home from before the rename to OpenCorp, until its owner moves it: it still holds keys and the store.
  ".agent-corp",
  ".ssh",
  ".aws",
  ".gnupg",
  ".config",
  "Library",
  ".claude",
  ".codex",
  ".docker",
  ".kube",
  ".netrc",
]

/** The workspace would expose the home directory, the whole disk, credentials, or the office's own programs. */
export class UnsafeWorkspace extends Error {
  override name = "UnsafeWorkspace"
}

/** The office's own paths a workspace must stay clear of, and the home dir. */
export interface OfficePaths {
  /** The user's home dir; defaults to `os.homedir()`. */
  home?: string
  /** The office's install folders: refused as, around or inside a workspace; write-denied by Seatbelt. */
  install?: readonly string[]
  /** Programs the office runs (git, codex, tmux, bwrap, ps, who, and its own runtime in a checkout). */
  tools?: readonly string[]
  /** The daemon's PATH entries. */
  path?: readonly string[]
}

/** The `__fs-helper` program: the compiled binary, or Bun running the helper's source file. */
export type Helper = { binary: string } | { bun: string; entry: string }

/** The files the helper runs from: `[binary]`, or `[bun, entry]`. */
export function helperFiles(helper: Helper): string[] {
  return "binary" in helper ? [helper.binary] : [helper.bun, helper.entry]
}

/** At most this many symlinks are followed while resolving one path, as in the kernel. */
const MAX_LINKS = 40

/** `p` with every symlink resolved, like Python's non-strict `os.path.realpath`: a missing tail is
 *  kept as given and a dangling link resolves to its target. */
function real(p: string, links = 0): string {
  // Seatbelt matches resolved paths (/private/var/..., not /var/...), so every
  // path the profile names must be resolved the same way.
  const abs = path.resolve(p)
  try {
    return fs.realpathSync(abs)
  } catch {
    if (abs === "/") return abs
  }
  const parent = path.dirname(abs)
  let isLink = false
  try {
    isLink = fs.lstatSync(abs).isSymbolicLink()
  } catch {}
  if (!isLink) return path.join(real(parent, links), path.basename(abs))
  if (links >= MAX_LINKS) return abs
  return real(path.resolve(real(parent, links), fs.readlinkSync(abs)), links + 1)
}

/** Whether `child` is `parent` or lies inside it (both resolved). */
function within(child: string, parent: string): boolean {
  return parent === "/" || child === parent || child.startsWith(parent + "/")
}

/** `entries` with each absolute one resolved; relative ones are kept as given (they refuse every workspace). */
function realEntries(entries: readonly string[] | undefined): string[] {
  return (entries ?? []).map((e) => (path.isAbsolute(e) ? real(e) : e))
}

/** Throws `UnsafeWorkspace` if `workspace` is `/`, contains the home directory, is or lies inside a
 *  sensitive home path (`SENSITIVE_HOME_PATHS`), contains or lies inside the office install, contains
 *  a program the office runs or a folder on its PATH, or if any office path is relative. */
export function checkWorkspace(workspace: string, office: OfficePaths = {}): void {
  const ws = real(workspace)
  const home = real(office.home ?? os.homedir())
  if (ws === "/" || within(home, ws)) {
    throw new UnsafeWorkspace(`workspace ${ws} contains the home directory ${home}; use a project folder`)
  }
  for (const rel of SENSITIVE_HOME_PATHS) {
    const sensitive = real(path.join(home, rel))
    if (within(ws, sensitive)) {
      throw new UnsafeWorkspace(`workspace ${ws} is inside the sensitive path ${sensitive}; use a project folder`)
    }
  }
  const absolute = (entry: string, kind: string): string => {
    if (path.isAbsolute(entry)) return real(entry)
    throw new UnsafeWorkspace(
      `workspace ${ws} is refused: the office's ${kind} has a relative entry ${JSON.stringify(entry)}; use absolute paths`,
    )
  }
  for (const entry of office.install ?? []) {
    const install = absolute(entry, "install")
    if (within(install, ws)) {
      throw new UnsafeWorkspace(`workspace ${ws} contains the office install at ${install}; use a project folder`)
    }
    if (within(ws, install)) {
      throw new UnsafeWorkspace(`workspace ${ws} is inside the office install at ${install}; use a project folder`)
    }
  }
  for (const entry of office.tools ?? []) {
    const tool = absolute(entry, "tool list")
    if (within(tool, ws)) {
      throw new UnsafeWorkspace(`workspace ${ws} contains ${tool}, a program the office runs; use a project folder`)
    }
  }
  for (const entry of office.path ?? []) {
    const dir = absolute(entry, "PATH")
    if (within(dir, ws)) {
      throw new UnsafeWorkspace(`workspace ${ws} contains ${dir}, a folder on the office's PATH; use a project folder`)
    }
  }
}

/** What a `SandboxPolicy` is built from; a policy's own fields are a superset, so
 *  `new SandboxPolicy({ ...policy, helper })` rebuilds one with every check re-run. */
export interface PolicyInit {
  workspace: string
  writable: boolean
  network: boolean
  tmpdir: string
  readOnly?: readonly string[]
  helper?: Helper | undefined
  office?: OfficePaths
}

/** The access one sandboxed call gets. Every path is resolved.
 *
 *  Throws `Error` if `workspace` or `tmpdir` is not an existing directory, and `UnsafeWorkspace`
 *  if `checkWorkspace` refuses the workspace. */
export class SandboxPolicy {
  /** The session's folder; readable, and writable if `writable`. */
  readonly workspace: string
  /** Whether the workspace is writable (`harness_policy.sandbox` is `workspace-write`). Its `.git`,
   *  `.git/hooks`, and `.git/config` stay read-only. */
  readonly writable: boolean
  /** Whether the call may use IP networking (`harness_policy.network`). */
  readonly network: boolean
  /** A private, writable temp directory; also the call's `HOME` and `TMPDIR`. */
  readonly tmpdir: string
  /** Extra read-only paths, such as the interpreter the file tools run on. */
  readonly readOnly: readonly string[]
  /** The `__fs-helper` program, when this call runs it; only its profile may read its files. */
  readonly helper: Helper | undefined
  /** The office's own paths and the home dir, every list set. */
  readonly office: Required<OfficePaths>

  constructor(init: PolicyInit) {
    this.workspace = existingDir("workspace", init.workspace)
    this.writable = init.writable
    this.network = init.network
    this.tmpdir = existingDir("tmpdir", init.tmpdir)
    this.readOnly = (init.readOnly ?? []).map((p) => real(p))
    const helper = init.helper
    this.helper =
      helper === undefined
        ? undefined
        : "binary" in helper
          ? { binary: real(helper.binary) }
          : { bun: real(helper.bun), entry: real(helper.entry) }
    const office = init.office ?? {}
    this.office = {
      home: real(office.home ?? os.homedir()),
      install: realEntries(office.install),
      tools: realEntries(office.tools),
      path: realEntries(office.path),
    }
    checkWorkspace(this.workspace, this.office)
  }

  /** The workspace paths that stay read-only in a writable workspace. */
  get protectedPaths(): readonly [string, string, string] {
    const git = path.join(this.workspace, ".git")
    return [git, path.join(git, "hooks"), path.join(git, "config")]
  }
}

/** `p` resolved; throws if it is not an existing directory. */
function existingDir(name: string, p: string): string {
  const resolved = real(p)
  if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${name} ${resolved} is not an existing directory`)
  }
  return resolved
}

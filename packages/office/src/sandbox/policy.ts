/** What one sandboxed call may touch. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Home paths holding credentials or office state; a workspace may not be one of them or
 *  lie inside one, since the workspace is readable (and maybe writable) by model code. */
export const SENSITIVE_HOME_PATHS: readonly string[] = [
  ".opencorp",
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

/**
 * `p` made absolute with its components resolved left to right, as the OS does: a symlink is
 * replaced by its target before later components (`..` included) apply, a missing component is
 * kept as given, and a dangling link resolves to its target. A link met again while its own target
 * is being resolved is a loop and is kept as given, as Python's `os.path.realpath` does. The longest
 * existing part with no `\` then gets its on-disk spelling (case, firmlinks). Throws if a link's
 * target is not valid UTF-8.
 */
function real(p: string): string {
  // Seatbelt matches resolved paths (/private/var/..., not /var/...), so every
  // path the profile names must be resolved the same way. The walk uses only lstat
  // and readlink on the raw string: path.resolve and realpathSync drop `..` before
  // links are resolved, and realpathSync reads `\` as a separator.
  const abs = path.isAbsolute(p) ? p : process.cwd() + "/" + p
  // A `{ done }` entry marks where a link's target ends, so its result can be kept.
  const pending: (string | { done: string })[] = abs.split("/").reverse()
  // Links met so far, as Python's realpath keeps them: a link maps to its resolved path, or to
  // null while its target is being walked. Each link is followed once, so the walk ends.
  const seen = new Map<string, string | null>()
  let resolved = "/"
  while (pending.length > 0) {
    const name = pending.pop()!
    if (typeof name !== "string") {
      seen.set(name.done, resolved)
      continue
    }
    if (name === "" || name === ".") continue
    if (name === "..") {
      // `resolved` holds no links (bar a looping one), so its dirname is the physical parent.
      resolved = path.dirname(resolved)
      continue
    }
    const next = resolved === "/" ? "/" + name : resolved + "/" + name
    const known = seen.get(next)
    if (known === null) {
      // A loop: no OS can traverse it (ELOOP), so the link stays as given.
      resolved = next
      continue
    }
    if (known !== undefined) {
      resolved = known
      continue
    }
    let isLink = false
    try {
      isLink = fs.lstatSync(next).isSymbolicLink()
    } catch {}
    if (!isLink) {
      resolved = next
      continue
    }
    seen.set(next, null)
    const raw = fs.readlinkSync(next, { encoding: "buffer" })
    const target = raw.toString("utf8")
    // A lossy decode would make the walk look up a different name than the OS follows.
    if (!Buffer.from(target, "utf8").equals(raw)) throw new Error(`symlink ${next} has a target that is not UTF-8`)
    if (target.startsWith("/")) resolved = "/"
    pending.push({ done: next }, ...target.split("/").reverse())
  }
  // On a case-insensitive volume home/.SSH is home/.ssh, and a firmlinked
  // /System/Volumes/Data/Users is /Users; realpathSync gives the on-disk spelling.
  let head = resolved
  let tail = ""
  while (head !== "/") {
    if (!head.includes("\\")) {
      try {
        return path.join(fs.realpathSync(head), tail)
      } catch {}
    }
    tail = "/" + path.basename(head) + tail
    head = path.dirname(head)
  }
  return resolved
}

/** Whether `child` is `parent` or lies inside it (both resolved). */
function within(child: string, parent: string): boolean {
  return parent === "/" || child === parent || child.startsWith(parent + "/")
}

/** Whether `path` is `dir` or lies inside it, both resolved as the OS resolves them (see `real`). */
export function isInside(path: string, dir: string): boolean {
  return within(real(path), real(dir))
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
  const resolvedEntry = (entry: string, kind: string): string => {
    if (path.isAbsolute(entry)) return real(entry)
    throw new UnsafeWorkspace(
      `workspace ${ws} is refused: the office's ${kind} has a relative entry ${JSON.stringify(entry)}; use absolute paths`,
    )
  }
  for (const entry of office.install ?? []) {
    const install = resolvedEntry(entry, "install")
    if (within(install, ws)) {
      throw new UnsafeWorkspace(`workspace ${ws} contains the office install at ${install}; use a project folder`)
    }
    if (within(ws, install)) {
      throw new UnsafeWorkspace(`workspace ${ws} is inside the office install at ${install}; use a project folder`)
    }
  }
  for (const entry of office.tools ?? []) {
    const tool = resolvedEntry(entry, "tool list")
    if (within(tool, ws)) {
      throw new UnsafeWorkspace(`workspace ${ws} contains ${tool}, a program the office runs; use a project folder`)
    }
  }
  for (const entry of office.path ?? []) {
    const dir = resolvedEntry(entry, "PATH")
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
  // Any failed stat (missing, a file in the path, a link loop) means no directory.
  let isDir = false
  try {
    isDir = fs.statSync(resolved).isDirectory()
  } catch {}
  if (!isDir) throw new Error(`${name} ${resolved} is not an existing directory`)
  return resolved
}

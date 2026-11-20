/** The permission a harness's own sandbox enforces, built from its employee's: Codex's per-thread permission profile
 *  and config override, and Claude Code's sandbox settings, with the PATH both run with.
 *
 *  OpenCorp puts no sandbox of its own around a harness. The harness runs as the owner, with its own login and
 *  config; its sandbox holds its commands (and Codex's file edits) to the employee's permission. What a harness would
 *  otherwise run as the owner outside that sandbox is turned off: hooks, `notify`, apps, plugins and MCP servers, and
 *  the folder's own project config, which stays untrusted. */
import fs from "node:fs"
import path from "node:path"
import {
  checkClearOf,
  checkWorkspace,
  existingDir,
  type OfficePaths,
  PROJECT_CONFIG_FILES,
  PROJECT_CONFIG_FOLDERS,
  realPath,
  SENSITIVE_HOME_PATHS,
  UnsafeProfile,
  UnsafeWorkspace,
  within,
} from "./policy.ts"

/** What an employee may touch, as OpenCorp sets it (the person's `harness_policy` and the session's folder). */
export interface EmployeePermission {
  /** The session's folder; it must pass `checkWorkspace` with the office's guards. */
  workspace: string
  /** Its git root (`git rev-parse --show-toplevel`), when it has one: Codex keys project trust by it. */
  gitRoot: string | null
  /** `harness_policy.sandbox === "workspace-write"`. */
  writable: boolean
  /** `harness_policy.network === true`. */
  network: boolean
  /** A fresh, empty, private folder for this thread (0700, the user's, not a link), outside `<OPENCORP_HOME>` and never
   *  the employee shell's `<sessionDir>/tmp`: the harness's TMPDIR (and Claude Code's `CLAUDE_CODE_TMPDIR`). */
  tmpdir: string
  /** The sentinel file every Codex profile denies (`/tmp/opencorp-<uid>/codex/fence`), which no listing covers. The
   *  office makes it first. */
  fence: string
  /** The person's extra folders (`harness_policy.folders`; empty until then), each mounted as given. */
  folders: readonly { path: string; access: "read" | "write" }[]
  /** The owner's home and `<OPENCORP_HOME>`, denied by name except where a listed folder covers them. */
  home: string
  officeHome: string
  office?: OfficePaths
  /** The harnesses' own config folders where they are set apart from the home (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`):
   *  denied by name, as the home's are, and never the session's folder. */
  harnessHomes?: readonly string[]
  /** Folders other people's permissions list as writable: none of them goes on this one's PATH. */
  othersWritable?: readonly string[]
}

/** The system folders that start every harness PATH. Both harnesses run `git`, `rg` and (Codex, on Linux) `bwrap`
 *  from PATH themselves, as the owner and outside their sandbox, so PATH holds no folder the employee can write. */
const SYSTEM_PATH: readonly string[] = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
]
/** Characters Codex (`*?[]`) or Claude Code's sandbox (also `{}`) read as a pattern in a path. */
const PATTERN = /[*?[\]{}]/

/** A listed folder, resolved. */
interface Listed {
  path: string
  access: "read" | "write"
}

/** An employee's permission, checked and with every path resolved. */
interface Checked {
  workspace: string
  gitRoot: string | null
  writable: boolean
  network: boolean
  tmpdir: string
  fence: string
  folders: Listed[]
  home: string
  /** `<OPENCORP_HOME>`, the home's credential folders and the harnesses' own config folders, less any a listed
   *  folder covers: denied by name. */
  denied: string[]
  /** The folders the harness's commands can write: the session's folder if writable, the temp folder, and each
   *  writable listed folder. */
  writableRoots: string[]
  /** The workspace's paths both harnesses keep read-only (`keptPaths`). */
  kept: Kept[]
  /** The harness PATH. */
  path: string
}

/** A workspace path kept read-only, and whether it is a folder (Claude Code's edit deny then covers what is in it). */
interface Kept {
  path: string
  folder: boolean
}

/** The per-thread Codex override (the session-flags layer) and the profile id it defines, for `thread/start` and
 *  `thread/resume`. Nested objects only, never dotted keys: Codex splits a top-level override key on its dots. The id
 *  is unique per session, since the layer is deep-merged with any other layer defining the same id; a subagent
 *  inherits its parent's profile.
 *
 *  `install` is the folder Codex is installed in (the one holding the `bin` of its resolved binary): its sandboxed
 *  commands run Codex's own binary, so the profile reads it, and it is refused if the employee can write it.
 *  `mcpServers` are the owner's MCP servers (`mcpServersOff`). Throws as `checkPermission` does. */
export function codexThread(
  p: EmployeePermission,
  id: string,
  { install, mcpServers = [] }: { install: string; mcpServers?: readonly string[] },
): { permissions: string; config: Record<string, unknown> } {
  // A `:` name is one of Codex's built-in profiles.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`a Codex profile id is letters, digits, - and _; got ${id}`)
  const c = checked(p)
  // No `:root` entry, so nothing is readable but what is listed. On equally specific entries deny beats write beats
  // read, and a more specific entry beats a broader one.
  const filesystem: Record<string, string> = {
    ":minimal": "read",
    [installFolder(install, c.writableRoots)]: "read",
    [c.workspace]: c.writable ? "write" : "read",
  }
  // Codex keeps a writable root's top-level .git and .codex read-only by itself, and .agents only when it exists;
  // listing all of them holds a missing one too (so no `git init` starts a repository), and the rest (.claude,
  // .mcp.json) Codex wouldn't hold at all.
  for (const kept of c.kept) filesystem[kept.path] = "read"
  filesystem[c.tmpdir] = "write"
  for (const folder of c.folders) filesystem[folder.path] = folder.access
  for (const denied of c.denied) filesystem[denied] = "deny"
  // Always: an exec-policy `allow` rule runs its command outside the sandbox unless the profile denies some read.
  filesystem[c.fence] = "deny"
  // The folder and its git root untrusted: so Codex never writes trust into the owner's config.toml, and never loads
  // the folder's own .codex/config.toml, whose MCP servers and hooks would run as the owner.
  const untrusted = { trust_level: "untrusted" }
  const projects: Record<string, unknown> = { [c.workspace]: untrusted }
  if (c.gitRoot !== null) projects[c.gitRoot] = untrusted
  const config: Record<string, unknown> = {
    permissions: { [id]: { filesystem, network: { enabled: c.network } } },
    projects,
    // Memories write the owner's Codex home; a skill's MCP dependency installs a server that runs as the owner.
    features: { hooks: false, apps: false, plugins: false, memories: false, skill_mcp_dependency_install: false },
    notify: [],
  }
  if (mcpServers.length > 0) config.mcp_servers = mcpServersOff(mcpServers)
  // Codex's own web search reaches the web from the harness, outside the sandbox.
  if (!c.network) config.web_search = "disabled"
  return { permissions: id, config }
}

/** The `mcp_servers` override that turns each of `defined` off: exactly the names the owner's Codex config defines,
 *  since Codex fails to load a config that turns off a name it doesn't define (it has no transport). */
export function mcpServersOff(defined: readonly string[]): Record<string, { enabled: false }> {
  return Object.fromEntries(defined.map((name) => [name, { enabled: false as const }]))
}

/** Claude Code's flag settings (`--settings`), its `--add-dir` folders, and its environment, for one session.
 *
 *  Its Bash sandbox reads everything but `denyRead` (where `allowRead` re-opens a folder), and can always write its
 *  working folder and each `--add-dir` folder, with `denyWrite` winning over every write allow; its own file tools
 *  are held by its permission rules, not the OS, so its `Read` denies mirror the folders denied by name. Throws as
 *  `checkPermission` does, and for the network on: its sandbox takes only a list of allowed hosts, and no setting
 *  that allows every host has been checked against a real Claude Code. */
export function claudeStart(p: EmployeePermission): {
  settings: Record<string, unknown>
  addDirs: string[]
  env: Record<string, string>
} {
  const c = checked(p)
  if (c.network) {
    throw new Error("Claude Code with the network on isn't supported yet: its sandbox can't allow every host")
  }
  const covered = (denied: string) => c.folders.some((folder) => within(denied, folder.path))
  // A Read deny beats any allow, so a denied folder holding a folder Claude Code may read isn't mirrored.
  const opened = [c.workspace, c.tmpdir, ...c.folders.map((folder) => folder.path)]
  const mirrored = c.denied.filter((denied) => !opened.some((p) => within(p, denied)))
  const readOnly = readOnlyOf(c.folders)
  const writable = writableOf(c.folders)
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: [...(covered(c.home) ? [] : [c.home]), ...c.denied],
        allowRead: [c.workspace, c.tmpdir, ...c.folders.map((folder) => folder.path)],
        allowWrite: [...(c.writable ? [c.workspace] : []), c.tmpdir, ...writable],
        denyWrite: [...(c.writable ? [] : [c.workspace]), ...readOnly, ...c.kept.map((kept) => kept.path)],
      },
      network: { allowedDomains: [], strictAllowlist: true },
    },
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      deny: [
        ...(c.writable ? [] : ["Edit", "Write", "NotebookEdit"]),
        ...readOnly.flatMap((folder) => rules("Edit", folder, true)),
        ...c.kept.flatMap((kept) => rules("Edit", kept.path, kept.folder)),
        ...mirrored.flatMap((denied) => rules("Read", denied, true)),
        // Both reach the web from Claude Code itself, outside its sandbox.
        "WebFetch",
        "WebSearch",
      ],
    },
    disableAllHooks: true,
  }
  const env = {
    PATH: c.path,
    TMPDIR: c.tmpdir,
    CLAUDE_CODE_TMPDIR: c.tmpdir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  }
  return { settings, addDirs: c.folders.map((folder) => folder.path), env }
}

/** Claude Code permission rules for `tool` on the absolute `p` (`//` starts an absolute path), and, for a folder, on
 *  what is in it. */
function rules(tool: string, p: string, folder: boolean): string[] {
  return folder ? [`${tool}(/${p})`, `${tool}(/${p}/**)`] : [`${tool}(/${p})`]
}

/** The fixed PATH both harnesses run with: the system folders, then the `bin` folder of each read-only listed folder.
 *  A writable listed folder is never on it, nor is any entry that is or walks through a folder the harness can
 *  write (the session's folder, the temp folder, a writable listed folder) or another person's writable folder,
 *  nor a listed `bin` that others than the user may write. Throws as `checkPermission` does. */
export function harnessPath(p: EmployeePermission): string {
  return checked(p).path
}

/** Throws `UnsafeWorkspace` (the session's folder) or `UnsafeProfile` (the temp folder or the fence; or a listed
 *  folder whose path walks through a folder the harness can write, which a link could repoint) before anything is
 *  built. Also `UnsafeProfile` for a path that isn't absolute or holds a pattern character, a listed folder that is
 *  the session's folder or listed twice, a folder the harness can write inside a read-only one (Claude Code's write
 *  deny would win there), or a PATH with nothing left on it. */
export function checkPermission(p: EmployeePermission): void {
  checked(p)
}

/** `p` checked as `checkPermission` says, with every path resolved. */
function checked(p: EmployeePermission): Checked {
  if (!path.isAbsolute(p.workspace)) {
    throw new UnsafeWorkspace(`workspace ${JSON.stringify(p.workspace)} isn't absolute`, "it isn't an absolute path")
  }
  const named: [string, string][] = [
    ["temp folder", p.tmpdir],
    ["fence", p.fence],
    ["home", p.home],
    ["office's home", p.officeHome],
    ...(p.gitRoot === null ? [] : ([["git root", p.gitRoot]] as [string, string][])),
    ...p.folders.map((folder): [string, string] => ["listed folder", folder.path]),
    ...(p.harnessHomes ?? []).map((dir): [string, string] => ["harness's config folder", dir]),
    ...(p.othersWritable ?? []).map((dir): [string, string] => ["other person's writable folder", dir]),
  ]
  for (const [what, given] of named) {
    if (!path.isAbsolute(given)) {
      throw new UnsafeProfile(`the harness's ${what} ${JSON.stringify(given)} isn't absolute`)
    }
  }
  const home = realPath(p.home)
  const officeHome = realPath(p.officeHome)
  const workspace = existingDir("workspace", p.workspace)
  checkWorkspace(workspace, { ...p.office, home })
  const harnessHomes = (p.harnessHomes ?? []).map((dir) => realPath(dir))
  checkClearOf(workspace, [officeHome, ...harnessHomes])
  const gitRoot = p.gitRoot === null ? null : realPath(p.gitRoot)
  const tmpdir = privateFolder(p.tmpdir, officeHome)
  const fence = fenceFile(p.fence, officeHome)
  const folders = listedFolders(p, workspace, tmpdir)
  const writable = [...(p.writable ? [workspace] : []), tmpdir, ...writableOf(folders)]
  const readOnly = [...(p.writable ? [] : [workspace]), ...readOnlyOf(folders)]
  for (const root of readOnly) {
    if (within(tmpdir, root)) {
      throw new UnsafeProfile(`the harness's temp folder ${tmpdir} lies in the read-only ${root}`)
    }
  }
  // Claude Code's write denies win over its write allows, so such a folder couldn't get the access set for it.
  for (const w of [...(p.writable ? [workspace] : []), ...writableOf(folders)]) {
    const outer = readOnly.find((root) => root !== w && within(w, root))
    if (outer !== undefined) throw new UnsafeProfile(`the harness can't write ${w} inside the read-only ${outer}`)
  }
  const sensitive = SENSITIVE_HOME_PATHS.map((rel) => realPath(path.join(home, rel)))
  const byName = [...new Set([officeHome, ...sensitive, ...harnessHomes])]
  const denied = byName.filter((d) => !folders.some((f) => within(d, f.path)))
  for (const resolved of [workspace, tmpdir, fence, home, ...folders.map((f) => f.path), ...denied]) {
    if (PATTERN.test(resolved)) throw new UnsafeProfile(`the harness would read ${resolved} as a pattern`)
  }
  return {
    workspace,
    gitRoot,
    writable: p.writable,
    network: p.network,
    tmpdir,
    fence,
    folders,
    home,
    denied,
    writableRoots: writable,
    kept: keptPaths(workspace),
    path: pathOf(folders, [...writable, ...(p.othersWritable ?? []).map((dir) => realPath(dir))]),
  }
}

/** The paths of the writable ones of `folders`. */
function writableOf(folders: readonly Listed[]): string[] {
  return folders.filter((folder) => folder.access === "write").map((folder) => folder.path)
}

/** The paths of the read-only ones of `folders`. */
function readOnlyOf(folders: readonly Listed[]): string[] {
  return folders.filter((folder) => folder.access === "read").map((folder) => folder.path)
}

/** `tmpdir` resolved, if it is an existing folder, not a link, the user's, private (no group or other access) and
 *  empty, and neither in nor holding the office's home (where the employee shell's own temp folders are). */
function privateFolder(tmpdir: string, officeHome: string): string {
  const what = `the harness's temp folder ${tmpdir}`
  const stat = fs.lstatSync(tmpdir, { throwIfNoEntry: false })
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeProfile(`${what} isn't a folder (a link is refused)`)
  }
  if (stat.uid !== process.getuid?.()) throw new UnsafeProfile(`${what} isn't the user's`)
  if ((stat.mode & 0o077) !== 0) throw new UnsafeProfile(`${what} isn't private (0700)`)
  if (fs.readdirSync(tmpdir).length > 0) throw new UnsafeProfile(`${what} isn't empty`)
  const real = realPath(tmpdir)
  if (within(real, officeHome) || within(officeHome, real)) throw new UnsafeProfile(`${what} lies in ${officeHome}`)
  return real
}

/** `fence` resolved, if it is an existing file, not a link, the user's, and not in the office's home. */
function fenceFile(fence: string, officeHome: string): string {
  const what = `the harness's fence ${fence}`
  const stat = fs.lstatSync(fence, { throwIfNoEntry: false })
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
    throw new UnsafeProfile(`${what} isn't a file the office made (a link is refused)`)
  }
  if (stat.uid !== process.getuid?.()) throw new UnsafeProfile(`${what} isn't the user's`)
  const real = realPath(fence)
  if (within(real, officeHome)) throw new UnsafeProfile(`${what} lies in ${officeHome}`)
  return real
}

/** `p.folders` resolved, each exactly as listed: refused if it is the session's folder or listed twice, or if its
 *  path walks through a folder the harness can write (the session's folder if writable, the temp folder, another
 *  writable listed folder), where the harness could swap a folder on the way for a link before the next build. */
function listedFolders(p: EmployeePermission, workspace: string, tmpdir: string): Listed[] {
  const walks = p.folders.map((folder) => {
    if (folder.access !== "read" && folder.access !== "write") {
      throw new UnsafeProfile(`the listed folder ${folder.path} has no access "read" or "write"`)
    }
    const visited: string[] = []
    return { path: realPath(folder.path, visited), access: folder.access, visited }
  })
  const writable = [...(p.writable ? [workspace] : []), tmpdir, ...writableOf(walks)]
  walks.forEach((walk, i) => {
    if (walk.path === workspace) throw new UnsafeProfile(`the listed folder ${walk.path} is the session's folder`)
    if (walks.findIndex((other) => other.path === walk.path) !== i) {
      throw new UnsafeProfile(`the folder ${walk.path} is listed twice`)
    }
    for (const root of writable) {
      if (root === walk.path) continue
      const through = within(walk.path, root) ? walk.path : walk.visited.find((v) => v !== root && within(v, root))
      if (through !== undefined) {
        throw new UnsafeProfile(
          `the listed folder ${walk.path} is reached through ${through}, in ${root}, which the harness can write`,
        )
      }
    }
  })
  return walks.map((walk) => ({ path: walk.path, access: walk.access }))
}

/** The workspace's paths both harnesses keep read-only: `.git` whole (a folder, a worktree's `.git` file, or missing,
 *  which both harnesses' sandboxes hold too, so no `git init` starts a repository whose config git later runs as the
 *  owner), then the project config folders and files. Only its parts would leave `mv .git` open, and Codex can't
 *  mount a missing part inside a read-only `.git`. A link is left out, unprotected: both harnesses' Linux sandboxes
 *  bind a read-only path onto itself, which follows a link and would mount its target. */
function keptPaths(workspace: string): Kept[] {
  const git = path.join(workspace, ".git")
  const kept: Kept[] = [
    { path: git, folder: !fs.lstatSync(git, { throwIfNoEntry: false })?.isFile() },
    ...PROJECT_CONFIG_FOLDERS.map((name) => ({ path: path.join(workspace, name), folder: true })),
    ...PROJECT_CONFIG_FILES.map((name) => ({ path: path.join(workspace, name), folder: false })),
  ]
  return kept.filter((k) => !fs.lstatSync(k.path, { throwIfNoEntry: false })?.isSymbolicLink())
}

/** `install` resolved, if the employee can't write it: neither it nor a folder its path walks through lies in a folder
 *  the harness can write, and it holds none. */
function installFolder(install: string, writable: readonly string[]): string {
  const what = `Codex's install folder ${JSON.stringify(install)}`
  if (!path.isAbsolute(install)) throw new UnsafeProfile(`${what} isn't absolute`)
  const visited: string[] = []
  const real = realPath(install, visited)
  for (const root of writable) {
    const through = [real, ...visited].find((p) => within(p, root)) ?? (within(root, real) ? root : undefined)
    if (through !== undefined) {
      throw new UnsafeProfile(`${what} is writable by the employee: ${through} is in or holds ${root}`)
    }
  }
  if (PATTERN.test(real)) throw new UnsafeProfile(`the harness would read ${real} as a pattern`)
  return real
}

/** The harness PATH over `folders`, leaving out each entry that is in, or walks through, one of `writable`, and each
 *  listed `bin` that others than the user may write (it or its folder is group- or other-writable). */
function pathOf(folders: readonly Listed[], writable: readonly string[]): string {
  const bins = readOnlyOf(folders)
    .filter((folder) => !openToOthers(folder) && !openToOthers(path.join(folder, "bin")))
    .map((folder) => path.join(folder, "bin"))
  const entries = [...SYSTEM_PATH, ...bins].filter((entry) => {
    const visited: string[] = []
    const real = realPath(entry, visited)
    return ![real, ...visited].some((p) => writable.some((root) => within(p, root)))
  })
  // A `:` would split an entry in two, and an empty PATH searches the working folder.
  const bad = entries.find((entry) => entry.includes(":"))
  if (bad !== undefined) throw new UnsafeProfile(`the harness PATH can't hold ${bad}, which has a ':'`)
  if (entries.length === 0) throw new UnsafeProfile("nothing is left on the harness PATH: every folder is writable")
  return [...new Set(entries)].join(":")
}

/** Whether `p` (followed) exists and its group or others may write it. */
function openToOthers(p: string): boolean {
  const stat = fs.statSync(p, { throwIfNoEntry: false })
  return stat !== undefined && (stat.mode & 0o022) !== 0
}

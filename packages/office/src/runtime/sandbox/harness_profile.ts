/** The permission a harness's own sandbox enforces, built from its employee's: Codex's per-thread permission profile
 *  and config override, and Claude Code's sandbox settings, with the PATH both run with.
 *
 *  OpenCorp puts no sandbox of its own around a harness. The harness runs as the owner, with its own login and
 *  config; its sandbox holds its commands (and Codex's file edits) to the employee's permission. What a harness would
 *  otherwise run as the owner outside that sandbox is turned off: hooks, `notify`, apps, plugins and MCP servers; the
 *  folder's own project config stays untrusted, unless the owner's config already trusts it (the load then refuses). */
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
  /** Folders others may write (other people's writable listings, and live sessions' folders): none of them goes on
   *  this one's PATH. */
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
/** Where the owner's own Unix sockets live: tmux's, ssh-agent's, D-Bus's (`/run/user/<uid>`), other Claude Code
 *  sessions' inboxes. Claude Code's Bash sandbox reads everything but `denyRead`, and on Linux the seccomp filter that
 *  blocks a Unix socket is optional (no setting requires it, and doctor can't see it without a model call: O5
 *  checks it), so a command that can read a socket there can connect to it and act as the owner. So they are all
 *  denied, but what a listed folder covers; the session's folder and temp folder (`allowRead`) are re-opened inside
 *  them. macOS's per-user temp folders are under `/var/folders`. */
const SOCKET_ROOTS: readonly string[] = [
  "/tmp",
  "/var/run",
  "/run",
  "/dev/shm",
  ...(process.platform === "darwin" ? ["/var/folders"] : []),
]
/** Characters Codex (`*?[]`) or Claude Code's sandbox (also `{}`) read as a pattern in a path. */
const PATTERN = /[*?[\]{}]/
/** The harnesses' own config under the home, and whether each is a folder: Codex's `~/.codex`, and Claude Code's
 *  `~/.claude` and `~/.claude.json`. */
const HARNESS_CONFIG: readonly [string, boolean][] = [
  [".codex", true],
  [".claude", true],
  [".claude.json", false],
]

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
  /** `othersWritable`, resolved. */
  others: string[]
  /** The project paths both harnesses keep read-only (`keptPaths`). */
  kept: Kept[]
  /** The office's home and the harnesses' own config where a writable listing covers them, and each writable listed
   *  folder inside one: read-only whatever is listed. */
  held: Kept[]
  /** The harness PATH. */
  path: string
}

/** A path kept read-only, and whether it is a folder (Claude Code's edit deny then covers what is in it). */
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
    [installFolder(install, [...c.writableRoots, ...c.others], CODEX.folder)]: "read",
    [c.workspace]: c.writable ? "write" : "read",
  }
  filesystem[c.tmpdir] = "write"
  for (const folder of c.folders) filesystem[folder.path] = folder.access
  // After the listed folders, so no listing lifts them. Codex keeps a writable root's top-level .git and .codex
  // read-only by itself, and .agents only when it exists; listing all of them holds a missing one too (so no
  // `git init` starts a repository), and the rest (.claude, .mcp.json, a .git above the folder, the harnesses' own
  // config) Codex wouldn't hold at all.
  for (const kept of [...c.kept, ...c.held]) filesystem[kept.path] = "read"
  for (const denied of c.denied) filesystem[denied] = "deny"
  // Always: an exec-policy `allow` rule runs its command outside the sandbox unless the profile denies some read.
  filesystem[c.fence] = "deny"
  // The folder and its git root untrusted, so Codex never writes trust into the owner's config.toml. This doesn't stop
  // Codex loading the folder's own .codex/config.toml where the owner's config already trusts the project: the load
  // refuses that case (its MCP servers and hooks would run as the owner).
  const untrusted = { trust_level: "untrusted" }
  const projects: Record<string, unknown> = { [c.workspace]: untrusted }
  if (c.gitRoot !== null) projects[c.gitRoot] = untrusted
  const config: Record<string, unknown> = {
    // The thread's own profile is also the config's default: Codex reloads the config for a turn (and for its MCP
    // list), and a config that defines a profile but sets no default fails to load, so every turn would fail.
    default_permissions: id,
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
  const sockets = [...new Set(SOCKET_ROOTS.filter((p) => fs.existsSync(p)).map((p) => realPath(p)))].filter(
    (root) => !covered(root),
  )
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: [...(covered(c.home) ? [] : [c.home]), ...sockets, ...c.denied],
        allowRead: [c.workspace, c.tmpdir, ...c.folders.map((folder) => folder.path)],
        allowWrite: [...(c.writable ? [c.workspace] : []), c.tmpdir, ...writable],
        denyWrite: [
          ...(c.writable ? [] : [c.workspace]),
          ...readOnly,
          ...c.kept.flatMap(denyWrites),
          ...c.held.map((held) => held.path),
        ],
      },
      network: { allowedDomains: [], strictAllowlist: true },
    },
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      // Its file tools run as the owner, outside its sandbox: they write only the working folders.
      blockWritesOutsideWorkingDirectories: true,
      deny: [
        ...(c.writable ? [] : ["Edit", "Write", "NotebookEdit"]),
        ...readOnly.flatMap((folder) => rules("Edit", folder, true)),
        ...[...c.kept, ...c.held].flatMap((kept) => rules("Edit", kept.path, kept.folder)),
        ...mirrored.flatMap((denied) => rules("Read", denied, true)),
        // Both reach the web from Claude Code itself, outside its sandbox.
        "WebFetch",
        "WebSearch",
        // They message and list the owner's other Claude Code sessions, which run outside this permission.
        "SendMessage",
        "ListAgents",
      ],
    },
    disableAllHooks: true,
    // The session still binds an inbox socket (only bare mode doesn't, and it skips the login); this drops what
    // arrives there, from the owner's other sessions or the employee's commands, undelivered.
    crossSessionInbound: "refuse",
  }
  const env = {
    PATH: c.path,
    TMPDIR: c.tmpdir,
    CLAUDE_CODE_TMPDIR: c.tmpdir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  }
  return { settings, addDirs: c.folders.map((folder) => folder.path), env }
}

/** Claude Code's `denyWrite` entries for a kept path. While a command runs, its Linux sandbox holds a missing path with
 *  an empty file on the host, and host git fails on a `.git` file (for good, if that file outlives the command); so a
 *  `.git` folder, present or missing, gets its `config` listed first, for which the sandbox makes the missing `.git`
 *  a folder instead. That order isn't yet checked against a real Claude Code. */
function denyWrites(kept: Kept): string[] {
  return path.basename(kept.path) === ".git" && kept.folder ? [path.join(kept.path, "config"), kept.path] : [kept.path]
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

/** Throws `UnsafeWorkspace` (the session's folder, or one reached through a link in a folder the harness can write)
 *  or `UnsafeProfile` (the temp folder or the fence; or a listed folder whose path walks through a folder the harness
 *  can write, which a link could repoint) before anything is built. Also `UnsafeProfile` for a path that isn't
 *  absolute or holds a null byte or a pattern character, a listed folder that is the session's folder or listed
 *  twice, a folder the harness can write inside a read-only one (Claude Code's write deny would win there), or a PATH
 *  with nothing left on it. */
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
    if (given.includes("\0")) {
      throw new UnsafeProfile(`the harness's ${what} ${JSON.stringify(given)} holds a null byte`)
    }
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
  checkReached(p.workspace, [tmpdir, ...writableOf(folders)])
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
  const held = heldPaths(folders, writable, [
    { path: officeHome, folder: true },
    ...HARNESS_CONFIG.map(([rel, folder]) => ({ path: realPath(path.join(home, rel)), folder })),
    ...harnessHomes.map((dir) => ({ path: dir, folder: true })),
  ])
  const others = (p.othersWritable ?? []).map((dir) => realPath(dir))
  const all = [workspace, tmpdir, fence, home, ...folders.map((f) => f.path), ...denied, ...held.map((h) => h.path)]
  for (const resolved of all) {
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
    others,
    kept: keptPaths(workspace, gitRoot, writable),
    held,
    path: pathOf(folders, [...writable, ...others]),
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

/** The project paths both harnesses keep read-only, whatever listed folder covers them, in the session's folder and
 *  at its git root, and `.git` alone in each other folder above the session's folder that `writable` (the folders the
 *  harness can write) holds: git finds a repository in any folder above, and runs its config as the owner. Above the
 *  writable folders nothing is kept, since the harness can't write there and a `read` entry would open it.
 *
 *  `.git` is kept whole (a folder, a worktree's `.git` file, or missing, which both harnesses' sandboxes hold too, so
 *  no `git init` starts a repository), then the project config folders and files. Only its parts would leave
 *  `mv .git` open, and Codex can't mount a missing part inside a read-only `.git`. A link is left out, unprotected:
 *  both harnesses' Linux sandboxes bind a read-only path onto itself, which follows a link and would mount its
 *  target. */
function keptPaths(workspace: string, gitRoot: string | null, writable: readonly string[]): Kept[] {
  const others = writable.filter((root) => root !== workspace)
  const dirs: [dir: string, whole: boolean][] = [[workspace, true]]
  // Folders above one outside every writable folder are outside them too.
  for (let dir = path.dirname(workspace); others.some((root) => within(dir, root)); dir = path.dirname(dir)) {
    dirs.push([dir, dir === gitRoot])
    if (dir === "/") break
  }
  const kept = dirs.flatMap(([dir, whole]): Kept[] => {
    const git = path.join(dir, ".git")
    return [
      { path: git, folder: !fs.lstatSync(git, { throwIfNoEntry: false })?.isFile() },
      ...(whole ? PROJECT_CONFIG_FOLDERS.map((name) => ({ path: path.join(dir, name), folder: true })) : []),
      ...(whole ? PROJECT_CONFIG_FILES.map((name) => ({ path: path.join(dir, name), folder: false })) : []),
    ]
  })
  return kept.filter((k) => !fs.lstatSync(k.path, { throwIfNoEntry: false })?.isSymbolicLink())
}

/** What of `config` (the office's home and the harnesses' own config, resolved) is held read-only whatever is listed:
 *  each one a folder in `writable` holds, and each writable listed folder inside one. A command that wrote Codex's
 *  `config.toml` would widen the next thread's own profile, which is deep-merged with it; one that wrote the office's
 *  files, its grants. One no writable folder covers stays as it is, denied by name or read-only, so no `read` entry
 *  opens it. While a command runs, Claude Code's Linux sandbox holds a missing one with an empty file on the host. */
function heldPaths(folders: readonly Listed[], writable: readonly string[], config: readonly Kept[]): Kept[] {
  const covered = config.filter((c) => writable.some((root) => within(c.path, root)))
  const inside = writableOf(folders)
    .filter((w) => config.some((c) => c.path !== w && within(w, c.path)))
    .map((w) => ({ path: w, folder: true }))
  const held = new Map([...covered, ...inside].map((k) => [k.path, k]))
  return [...held.values()]
}

/** Throws `UnsafeWorkspace` if the walk to `workspace` passes a link inside one of `writable` (the temp folder and the
 *  writable listed folders): the harness could repoint it before the next start. The session's folder may lie in a
 *  writable listed folder; only a link on the way is refused, as for a listed folder. */
function checkReached(workspace: string, writable: readonly string[]): void {
  const walked: string[] = []
  realPath(workspace, walked)
  for (const step of walked) {
    const root = writable.find((r) => step !== r && within(step, r))
    if (root === undefined || !fs.lstatSync(step, { throwIfNoEntry: false })?.isSymbolicLink()) continue
    throw new UnsafeWorkspace(
      `workspace ${workspace} is reached through ${step}, a link in ${root}, which the harness can write`,
      "it is reached through a link the employee can change",
    )
  }
}

/** How a harness's install is named in a refusal. */
interface Named {
  /** The file the office spawns: "the Codex the office runs". */
  run: string
  /** Its install folder: "Codex's install folder". */
  folder: string
}

const CODEX: Named = { run: "the Codex the office runs", folder: "Codex's install folder" }
const CLAUDE: Named = { run: "the Claude Code the office runs", folder: "Claude Code's install folder" }

/** Throws `UnsafeProfile` unless Codex as the office runs it can't be changed by anyone but the user: `run`, the file
 *  the office spawns, and `install`, the folder Codex's sandboxed commands run it from (`nativeCodex`). Neither, nor a
 *  folder either's path walks through, may lie in a folder the employee's harness can write, another person's
 *  writable folder or a live session's folder (`othersWritable`); the install folder may hold none of them; and
 *  neither file's folder, the file itself, the install folder nor its `bin` may be open to the group or others. Codex
 *  runs as the owner, outside any sandbox, so this comes before it runs. Throws as `checkPermission` does too. */
export function checkCodexInstall(p: EmployeePermission, install: HarnessInstall): void {
  checkInstall(p, install, CODEX)
}

/** Throws `UnsafeProfile` unless Claude Code as the office runs it can't be changed by anyone but the user, as
 *  `checkCodexInstall` checks Codex: `run`, the file the office spawns, `install`, the folder it is in
 *  (`nativeClaude`), and, when given, `found`, the path found on PATH that led to it (the walk to it, links
 *  included, lies in no folder others may write either). Claude Code runs as the owner, outside its own sandbox, so
 *  this comes before it runs. Throws as `checkPermission` does too. */
export function checkClaudeInstall(p: EmployeePermission, install: HarnessInstall): void {
  checkInstall(p, install, CLAUDE)
}

/** What runs a harness: the file the office spawns, the folder it is installed in, and, when given, the path found on
 *  PATH that led to the file (a launcher link, or npm's launcher). */
export interface HarnessInstall {
  run: string
  install: string
  found?: string
}

/** Throws `UnsafeProfile` unless `harness` as the office would run it can't be changed by anyone but the user, before
 *  any employee's permission is built, as doctor checks it before running it at all: the same checks as
 *  `checkCodexInstall` and `checkClaudeInstall`, against `othersWritable` alone (every person's writable listed
 *  folders, and live sessions' folders). */
export function checkHarnessBinary(
  harness: "codex" | "claude",
  install: HarnessInstall,
  othersWritable: readonly string[],
): void {
  const roots = othersWritable
    .filter((dir) => path.isAbsolute(dir) && !dir.includes("\0"))
    .map((dir) => realPath(dir))
  checkAgainst(roots, install, harness === "codex" ? CODEX : CLAUDE)
}

/** `checkCodexInstall` and `checkClaudeInstall`, with the harness's names for the refusals. */
function checkInstall(p: EmployeePermission, install: HarnessInstall, named: Named): void {
  const c = checked(p)
  checkAgainst([...c.writableRoots, ...c.others], install, named)
}

/** Throws `UnsafeProfile` if `install` lies in, holds or is reached through one of `roots`, or others than the user
 *  may write its files. */
function checkAgainst(roots: readonly string[], { run, install, found }: HarnessInstall, named: Named): void {
  installFolder(install, roots, named.folder)
  for (const file of found === undefined || found === run ? [run] : [found, run]) {
    const what = `${named.run}, ${JSON.stringify(file)},`
    if (!path.isAbsolute(file)) throw new UnsafeProfile(`${what} isn't absolute`)
    const visited: string[] = []
    const real = realPath(file, visited)
    const through = [real, ...visited].find((p) => roots.some((root) => within(p, root)))
    if (through !== undefined) throw new UnsafeProfile(`${what} is writable by the employee or others: ${through}`)
    const open = [real, path.dirname(real)].find(openToOthers)
    if (open !== undefined) throw new UnsafeProfile(`${what} can be changed: others than the user may write ${open}`)
  }
}

/** `install` resolved, if no one but the user can write it: neither it nor a folder its path walks through lies in
 *  one of `writable` (the folders the harness can write, and others' writable folders), it holds none, and neither it
 *  nor its `bin` is open to the group or others. `name` names it in a refusal. */
function installFolder(install: string, writable: readonly string[], name: string): string {
  const what = `${name} ${JSON.stringify(install)}`
  if (!path.isAbsolute(install)) throw new UnsafeProfile(`${what} isn't absolute`)
  const visited: string[] = []
  const real = realPath(install, visited)
  for (const root of writable) {
    const through = [real, ...visited].find((p) => within(p, root)) ?? (within(root, real) ? root : undefined)
    if (through !== undefined) {
      throw new UnsafeProfile(`${what} is writable by the employee or others: ${through} is in or holds ${root}`)
    }
  }
  const open = [real, path.join(real, "bin")].find(openToOthers)
  if (open !== undefined) throw new UnsafeProfile(`${what} can be changed: others than the user may write ${open}`)
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

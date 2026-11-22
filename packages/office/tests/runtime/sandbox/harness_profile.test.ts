/** A harness's permission, from its employee's: Codex's per-thread profile and override, Claude Code's settings, the
 *  harnesses' PATH, and the checks before any is built. */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { expect, setDefaultTimeout, test } from "bun:test"
import {
  checkClaudeInstall,
  checkCodexInstall,
  checkHarnessBinary,
  checkPermission,
  claudeStart,
  codexThread,
  type EmployeePermission,
  gitRootOf,
  harnessHomes,
  harnessPath,
  mcpServersOff,
} from "../../../src/runtime/sandbox/harness_profile.ts"
import { UnsafeProfile, UnsafeWorkspace } from "../../../src/runtime/sandbox/policy.ts"
import { nativeCodex } from "../../../src/tools/codex/codex.ts"
import { tempDir } from "../../helpers.ts"
import { sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(60_000)

/** The system folders every harness PATH starts with, on this platform. */
const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
if (process.platform === "darwin") SYSTEM.push("/opt/homebrew/bin")

/** A temp layout: a home holding credentials and an office (`.ssh/id_test`, `.codex/auth.json`, `.claude/`,
 *  `.opencorp/office/connections/main.json`), a workspace `<root>/ws` that is a git repo (a `.git` folder with its
 *  config), a private empty temp folder `<root>/tmp`, the fence `<root>/fence` and a Codex install
 *  `<root>/codex-install`, all resolved. `permission` builds an employee's permission over it, and `thread` its
 *  Codex thread. */
function layout() {
  const root = fs.realpathSync(tempDir())
  const home = path.join(root, "home")
  const officeHome = path.join(home, ".opencorp")
  const ws = path.join(root, "ws")
  const tmp = path.join(root, "tmp")
  const fence = path.join(root, "fence")
  for (const dir of [".ssh", ".claude", ".codex", ".opencorp/office/connections"]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(home, ".ssh/id_test"), "decoy-ssh-key")
  fs.writeFileSync(path.join(home, ".codex/auth.json"), '{"token": "decoy-codex"}')
  fs.writeFileSync(path.join(home, ".opencorp/office/connections/main.json"), '{"key": "decoy-connection"}')
  // Where Codex is installed: its sandboxed commands run its own binary from there.
  const install = path.join(root, "codex-install")
  fs.mkdirSync(path.join(install, "bin"), { recursive: true })
  fs.writeFileSync(path.join(install, "bin/codex"), "")
  // Only the user may change Codex's install, whatever the umask.
  for (const p of [install, path.join(install, "bin"), path.join(install, "bin/codex")]) fs.chmodSync(p, 0o755)
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true })
  fs.writeFileSync(path.join(ws, ".git/config"), "[core]\n")
  fs.mkdirSync(tmp, { mode: 0o700 })
  fs.chmodSync(tmp, 0o700)
  fs.writeFileSync(fence, "")
  const permission = (fields: Partial<EmployeePermission> = {}): EmployeePermission => ({
    workspace: ws,
    gitRoot: ws,
    writable: true,
    network: false,
    tmpdir: tmp,
    fence,
    folders: [],
    home,
    officeHome,
    ...fields,
  })
  /** A folder `<root>/<rel>` with a `bin` folder in it, both the user's alone to write, whatever the umask. */
  const folder = (rel: string): string => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.join(p, "bin"), { recursive: true })
    for (const dir of [p, path.join(p, "bin")]) fs.chmodSync(dir, 0o755)
    return p
  }
  /** Codex's thread for `p`, with the layout's install folder. */
  const thread = (p: EmployeePermission, options: { mcpServers?: readonly string[]; id?: string } = {}) =>
    codexThread(p, options.id ?? "opencorp-s1", { install, mcpServers: options.mcpServers })
  /** The filesystem entries of Codex's profile for `p`. */
  const filesystem = (p: EmployeePermission): Record<string, string> =>
    (thread(p).config.permissions as Record<string, { filesystem: Record<string, string> }>)["opencorp-s1"]!.filesystem
  return { root, home, officeHome, ws, tmp, fence, install, permission, folder, thread, filesystem }
}

/** The home's credential folders and the office's home under `home`, as Codex's deny entries. */
function codexDenies(home: string, except: readonly string[] = []): Record<string, string> {
  const named = [".opencorp", ".ssh", ".aws", ".gnupg", ".config", "Library", ".claude", ".codex", ".docker", ".kube"]
  const all = [...named, ".netrc"].map((rel) => path.join(home, rel)).filter((p) => !except.includes(p))
  return Object.fromEntries(all.map((p) => [p, "deny"]))
}

/** Where the owner's own Unix sockets live (tmux's, ssh-agent's, D-Bus's, other Claude Code sessions' inboxes), as
 *  Claude Code's sandbox gets them, resolved: none is readable, since its reads are a deny list and the seccomp
 *  filter that would block a socket is optional. */
const SOCKETS = [
  ...new Set(
    ["/tmp", "/var/tmp", "/var/run", "/run", "/dev/shm", ...(process.platform === "darwin" ? ["/var/folders"] : [])]
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.realpathSync(p)),
  ),
]

/** The same, as Claude Code's `denyRead`: the home first, then the socket folders. */
function claudeDenies(home: string, except: readonly string[] = []): string[] {
  return [home, ...SOCKETS, ...Object.keys(codexDenies(home, except))]
}

/** The tools Claude Code's start closes whatever the permission: the web, which Claude Code reaches itself, outside
 *  its sandbox, and messages to and the list of the owner's other Claude Code sessions. */
const CLOSED = ["WebFetch", "WebSearch", "SendMessage", "ListAgents"]

/** The workspace's paths both harnesses keep read-only, as Codex's `read` entries. */
function codexKept(ws: string): Record<string, string> {
  const kept = [".git", ".codex", ".agents", ".claude", ".mcp.json"]
  return Object.fromEntries(kept.map((rel) => [path.join(ws, rel), "read"]))
}

/** The same, as Claude Code's `denyWrite` entries and `Edit` denies (a folder's also covers what is in it). */
function claudeKept(ws: string, gitFolder = true): { denyWrite: string[]; deny: string[] } {
  const kept: [string, boolean][] = [
    [".git", gitFolder],
    [".codex", true],
    [".agents", true],
    [".claude", true],
    [".mcp.json", false],
  ]
  return {
    // A .git folder's config first, so that for a missing .git the sandbox makes a folder there, not a file.
    denyWrite: [...(gitFolder ? [path.join(ws, ".git/config")] : []), ...kept.map(([rel]) => path.join(ws, rel))],
    deny: kept.flatMap(([rel, folder]) => rules("Edit", path.join(ws, rel), folder)),
  }
}

/** Claude Code permission rules for `tool` on the absolute `p` (`//` starts an absolute path), and on what is in it
 *  when it is a folder. */
function rules(tool: string, p: string, folder = true): string[] {
  return folder ? [`${tool}(/${p})`, `${tool}(/${p}/**)`] : [`${tool}(/${p})`]
}

/** Claude Code's `Read` denies for the folders denied by name under `home`, mirroring its sandbox's `denyRead`. */
function claudeReads(home: string, except: readonly string[] = []): string[] {
  return Object.keys(codexDenies(home, except)).flatMap((p) => rules("Read", p))
}

/** The features every Codex override turns off. */
const FEATURES = { hooks: false, apps: false, plugins: false, memories: false, skill_mcp_dependency_install: false }

test("a writable employee's Codex override reads the minimal set and Codex's install, writes its folder and temp folder, denies the fence, and pins the folder and its git root untrusted", () => {
  const { home, ws, tmp, fence, install, permission, root, thread } = layout()
  expect(thread(permission())).toEqual({
    permissions: "opencorp-s1",
    config: {
      default_permissions: "opencorp-s1",
      permissions: {
        "opencorp-s1": {
          filesystem: {
            ":minimal": "read",
            [install]: "read",
            [ws]: "write",
            ...codexKept(ws),
            [tmp]: "write",
            ...codexDenies(home),
            [fence]: "deny",
          },
          network: { enabled: false },
        },
      },
      projects: { [ws]: { trust_level: "untrusted" } },
      features: FEATURES,
      notify: [],
      web_search: "disabled",
    },
  })
  // A folder inside a repo pins both: Codex keys trust by the folder first, then by its git root.
  const sub = path.join(root, "repo/ws")
  fs.mkdirSync(sub, { recursive: true })
  const nested = thread(permission({ workspace: sub, gitRoot: path.join(root, "repo") }), { id: "opencorp-s2" })
  expect(nested.config.projects).toEqual({
    [sub]: { trust_level: "untrusted" },
    [path.join(root, "repo")]: { trust_level: "untrusted" },
  })
  // No git root, only the folder.
  const bare = thread(permission({ gitRoot: null }), { id: "opencorp-s3" })
  expect(bare.config.projects).toEqual({ [ws]: { trust_level: "untrusted" } })
})

test("every Codex override makes its own profile the default, or every reload of the thread's config fails", () => {
  const { permission, thread } = layout()
  for (const id of ["opencorp-s1", "opencorp-01ABC"]) {
    const { permissions, config } = thread(permission({ writable: false }), { id })
    expect([permissions, config.default_permissions]).toEqual([id, id])
    expect(Object.keys(config.permissions as object)).toEqual([id])
  }
})

test("every Codex override turns hooks, apps, plugins, memories, notify and the given MCP servers off, and web search too with the network off", () => {
  const { permission, thread } = layout()
  for (const writable of [true, false]) {
    for (const network of [true, false]) {
      const { config } = thread(permission({ writable, network }), { mcpServers: ["docs", "a.b"] })
      expect(config.features).toEqual(FEATURES)
      expect(config.notify).toEqual([])
      expect(config.mcp_servers).toEqual({ docs: { enabled: false }, "a.b": { enabled: false } })
      if (network) expect("web_search" in config).toBe(false)
      else expect(config.web_search).toBe("disabled")
      const profile = (config.permissions as Record<string, { network: unknown }>)["opencorp-s1"]!
      expect(profile.network).toEqual({ enabled: network })
    }
  }
  // With no servers given there is nothing to turn off, and the key is left out: Codex refuses an entry for a name
  // its config doesn't define, so only the names it defines are passed.
  expect("mcp_servers" in thread(permission()).config).toBe(false)
  expect(mcpServersOff(["docs", "a.b"])).toEqual({ docs: { enabled: false }, "a.b": { enabled: false } })
  expect(mcpServersOff([])).toEqual({})
})

test("a read-only employee's folder is read-only in both harnesses, Claude Code's Bash write to it denied too", () => {
  const { home, ws, tmp, fence, install, permission, filesystem } = layout()
  const p = permission({ writable: false })
  expect(filesystem(p)).toEqual({
    ":minimal": "read",
    [install]: "read",
    [ws]: "read",
    ...codexKept(ws),
    [tmp]: "write",
    ...codexDenies(home),
    [fence]: "deny",
  })
  const { settings } = claudeStart(p)
  const kept = claudeKept(ws)
  const sandbox = settings.sandbox as { filesystem: Record<string, string[]> }
  // Claude Code's Bash sandbox can always write its working folder, so only the deny holds it.
  expect(sandbox.filesystem.allowWrite).toEqual([tmp])
  expect(sandbox.filesystem.denyWrite).toEqual([ws, ...kept.denyWrite])
  // Its own file tools can't write at all.
  expect((settings.permissions as { deny: string[] }).deny).toEqual([
    "Edit",
    "Write",
    "NotebookEdit",
    ...kept.deny,
    ...claudeReads(home),
    ...CLOSED,
  ])
})

test("both harnesses keep .git itself read-only, a missing one too, so a command can't move it aside or start one", () => {
  const { ws, permission, filesystem } = layout()
  const git = path.join(ws, ".git")
  const claude = () => {
    const { settings } = claudeStart(permission())
    return {
      denyWrite: (settings.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite,
      deny: (settings.permissions as { deny: string[] }).deny,
    }
  }
  // A repo: .git whole, never only its hooks and config (bwrap can't mount a missing one inside a read-only .git).
  for (const layoutOf of ["repo", "no hooks or config", "missing"] as const) {
    if (layoutOf === "no hooks or config") fs.rmSync(path.join(git, "config"))
    if (layoutOf === "missing") fs.rmSync(git, { recursive: true })
    const entries = filesystem(permission())
    expect(entries[git], layoutOf).toBe("read")
    expect(Object.keys(entries).filter((k) => k.startsWith(git + "/")), layoutOf).toEqual([])
    const { denyWrite, deny } = claude()
    // Claude Code's sandbox holds a missing path with an empty file on the host while a command runs, and host git
    // fails on a .git file; a missing .git/config listed first makes it a folder instead.
    expect(denyWrite.slice(0, 2), layoutOf).toEqual([path.join(git, "config"), git])
    // Claude Code's own tools can't write .git, or a .git file pointing at a planted repo.
    expect(deny, layoutOf).toEqual(expect.arrayContaining([`Edit(/${git})`, `Edit(/${git}/**)`]))
  }
})

test("Codex reads its own install folder, which the employee can't write", () => {
  const { root, ws, tmp, install, permission, folder, thread } = layout()
  const envs = folder("envs")
  const linked = path.join(envs, "link")
  fs.symlinkSync(install, linked)
  const inWs = path.join(ws, "tools/codex")
  fs.mkdirSync(inWs, { recursive: true })
  const writable: [string, EmployeePermission, string][] = [
    ["in the writable workspace", permission(), inWs],
    ["in a writable listed folder", permission({ folders: [{ path: envs, access: "write" }] }), path.join(envs, "bin")],
    ["reached through a writable folder", permission({ folders: [{ path: envs, access: "write" }] }), linked],
    ["holding the temp folder", permission(), root],
    ["the temp folder", permission(), tmp],
  ]
  for (const [what, p, at] of writable) {
    expect(() => codexThread(p, "opencorp-s1", { install: at }), what).toThrow(UnsafeProfile)
    expect(() => codexThread(p, "opencorp-s1", { install: at }), what).toThrow(/Codex's install folder/)
  }
  expect(() => codexThread(permission(), "opencorp-s1", { install: "codex" })).toThrow(/isn't absolute/)
  // In a read-only listed folder, or reached through a link outside what the employee writes, it is read resolved.
  const tools = folder("tools")
  fs.symlinkSync(install, path.join(tools, "codex"))
  const p = permission({ folders: [{ path: tools, access: "read" }] })
  const read = codexThread(p, "opencorp-s1", { install: path.join(tools, "codex") }).config.permissions as Record<
    string,
    { filesystem: Record<string, string> }
  >
  expect(read["opencorp-s1"]!.filesystem[install]).toBe("read")
  expect(thread(permission({ writable: false })).config.permissions).toBeDefined()
})

test("codex as the office runs it is refused before it runs where anyone but the user could change it", () => {
  const { root, ws, install, permission, folder } = layout()
  const binary = path.join(install, "bin/codex")
  expect(() => checkCodexInstall(permission(), { run: binary, install })).not.toThrow()
  // A wrapper the office spawns, in or reached through a folder the employee can write, though its install isn't.
  const wrapper = path.join(ws, "codex.sh")
  fs.writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 })
  expect(() => checkCodexInstall(permission(), { run: wrapper, install })).toThrow(/the Codex the office runs/)
  expect(() => checkCodexInstall(permission({ writable: false }), { run: wrapper, install })).not.toThrow()
  // Another person's writable folder, or a live session's folder.
  const shared = folder("shared")
  fs.mkdirSync(path.join(shared, "codex/bin"), { recursive: true })
  fs.writeFileSync(path.join(shared, "codex/bin/codex"), "", { mode: 0o755 })
  const elsewhere = { run: path.join(shared, "codex/bin/codex"), install: path.join(shared, "codex") }
  expect(() => checkCodexInstall(permission({ othersWritable: [shared] }), elsewhere)).toThrow(UnsafeProfile)
  expect(() => checkCodexInstall(permission(), elsewhere)).not.toThrow()
  // codexThread holds its install to the same.
  expect(() => codexThread(permission({ othersWritable: [shared] }), "opencorp-s1", { install: elsewhere.install }))
    .toThrow(/Codex's install folder/)
  // Open to the group or others: the binary, its folder, the install folder.
  for (const open of [elsewhere.run, path.dirname(elsewhere.run), elsewhere.install]) {
    fs.chmodSync(open, 0o775)
    expect(() => checkCodexInstall(permission(), elsewhere), open).toThrow(/others than the user may write/)
    fs.chmodSync(open, 0o755)
  }
  fs.chmodSync(path.join(root, "codex-install"), 0o757)
  expect(() => codexThread(permission(), "opencorp-s1", { install })).toThrow(/others than the user may write/)
})

test("claude as the office runs it is refused before it runs where anyone but the user could change it", () => {
  const { root, ws, permission, folder } = layout()
  // The native installer's layout: a launcher linking to a version in a folder of its own.
  const versions = folder("claude-install/versions")
  const binary = path.join(versions, "2.1.325")
  fs.writeFileSync(binary, "", { mode: 0o755 })
  const launcher = path.join(root, "claude-install/bin/claude")
  fs.mkdirSync(path.dirname(launcher), { recursive: true })
  fs.symlinkSync(binary, launcher)
  const native = { run: binary, install: versions }
  expect(() => checkClaudeInstall(permission(), native)).not.toThrow()
  // A launcher the employee can write, though the binary it links to isn't.
  const planted = path.join(ws, "claude")
  fs.symlinkSync(binary, planted)
  const reached = { run: planted, install: versions }
  expect(() => checkClaudeInstall(permission(), reached)).toThrow(/the Claude Code the office runs/)
  expect(() => checkClaudeInstall(permission({ writable: false }), reached)).not.toThrow()
  // Another person's writable folder, or a live session's folder, holding the install.
  const shared = folder("shared")
  fs.writeFileSync(path.join(shared, "claude"), "", { mode: 0o755 })
  const elsewhere = { run: path.join(shared, "claude"), install: shared }
  expect(() => checkClaudeInstall(permission({ othersWritable: [shared] }), elsewhere)).toThrow(UnsafeProfile)
  expect(() => checkClaudeInstall(permission({ othersWritable: [shared] }), elsewhere)).toThrow(
    /Claude Code's install folder/,
  )
  expect(() => checkClaudeInstall(permission(), elsewhere)).not.toThrow()
  // Open to the group or others: the binary, its folder, the install folder.
  for (const open of [binary, versions]) {
    fs.chmodSync(open, 0o775)
    expect(() => checkClaudeInstall(permission(), native), open).toThrow(/others than the user may write/)
    fs.chmodSync(open, 0o755)
  }
  // The check is the permission's too.
  expect(() => checkClaudeInstall(permission({ tmpdir: ws }), native)).toThrow(UnsafeProfile)
  // The path found on PATH that led to the binary: a launcher link the employee could repoint is refused.
  expect(() => checkClaudeInstall(permission(), { ...native, found: launcher })).not.toThrow()
  expect(() => checkClaudeInstall(permission(), { ...native, found: planted })).toThrow(/is writable by the employee/)
})

test("before any permission is built, a harness binary others could change is refused, as doctor checks it before running it", () => {
  const { root, folder } = layout()
  const shared = folder("shared")
  const bin = path.join(shared, "bin/claude")
  fs.writeFileSync(bin, "", { mode: 0o755 })
  const inShared = { run: bin, install: path.dirname(bin) }
  expect(() => checkHarnessBinary("claude", inShared, [])).not.toThrow()
  expect(() => checkHarnessBinary("claude", inShared, [shared])).toThrow(/Claude Code's install folder/)
  // Through a link in another person's writable folder.
  const elsewhere = folder("elsewhere")
  fs.writeFileSync(path.join(elsewhere, "codex"), "", { mode: 0o755 })
  const linked = path.join(shared, "codex")
  fs.symlinkSync(path.join(elsewhere, "codex"), linked)
  const codex = { found: linked, run: path.join(elsewhere, "codex"), install: elsewhere }
  expect(() => checkHarnessBinary("codex", codex, [])).not.toThrow()
  expect(() => checkHarnessBinary("codex", codex, [shared])).toThrow(/the Codex the office runs/)
  // Open to the group or others.
  fs.chmodSync(elsewhere, 0o775)
  expect(() => checkHarnessBinary("codex", codex, [])).toThrow(/others than the user may write/)
  // A relative or null-holding listing names no folder anyone's harness can write.
  expect(() => checkHarnessBinary("claude", inShared, ["shared", "/x\0"])).not.toThrow()
  expect(fs.existsSync(root)).toBe(true)
})

test("the office's home, the home's credential folders and the harnesses' own config folders are denied by name", () => {
  const { root, home, officeHome, permission, filesystem } = layout()
  const entries = filesystem(permission())
  for (const p of [officeHome, path.join(home, ".ssh"), path.join(home, ".codex"), path.join(home, ".claude")]) {
    expect(entries[p]).toBe("deny")
  }
  const start = claudeStart(permission())
  const sandbox = start.settings.sandbox as { filesystem: { denyRead: string[] } }
  expect(sandbox.filesystem.denyRead).toEqual(claudeDenies(home))
  // Claude Code's own tools are held by its rules, not the OS: the same folders get Read denies (not the home, which
  // holds the workspace; its working folders already bound its reads).
  expect((start.settings.permissions as { deny: string[] }).deny).toEqual(expect.arrayContaining(claudeReads(home)))
  expect(JSON.stringify(start.settings.permissions)).not.toContain(`Read(/${home})`)
  // CODEX_HOME and CLAUDE_CONFIG_DIR set apart from the home are denied by name too, in both harnesses.
  const codexHome = path.join(root, "codex-home")
  const claudeHome = path.join(root, "claude-home")
  fs.mkdirSync(codexHome)
  fs.mkdirSync(claudeHome)
  const apart = permission({ harnessHomes: [codexHome, claudeHome] })
  expect(filesystem(apart)[codexHome]).toBe("deny")
  expect(filesystem(apart)[claudeHome]).toBe("deny")
  const settings = claudeStart(apart).settings
  expect((settings.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead).toEqual([
    ...claudeDenies(home),
    codexHome,
    claudeHome,
  ])
  expect((settings.permissions as { deny: string[] }).deny).toEqual(
    expect.arrayContaining([...rules("Read", codexHome), ...rules("Read", claudeHome)]),
  )
  // A session folder in one is refused, as one in the office's home is.
  const inside = path.join(codexHome, "proj")
  fs.mkdirSync(inside)
  expect(() => checkPermission(permission({ workspace: inside, harnessHomes: [codexHome] }))).toThrow(UnsafeWorkspace)
  // An office home outside the home is denied by name too, and a credential folder that is a link by its target.
  const elsewhere = path.join(root, "oc-home")
  const keys = path.join(root, "keys")
  fs.mkdirSync(elsewhere)
  fs.mkdirSync(keys)
  fs.rmSync(path.join(home, ".ssh"), { recursive: true })
  fs.symlinkSync(keys, path.join(home, ".ssh"))
  const moved = filesystem(permission({ officeHome: elsewhere }))
  expect(moved[elsewhere]).toBe("deny")
  expect(moved[keys]).toBe("deny")
  expect(moved[path.join(home, ".ssh")]).toBeUndefined()
})

test("a listed folder is mounted as listed, and one covering a credential folder lifts its deny-by-name, but never the fence", () => {
  const { home, ws, tmp, install, permission, folder, filesystem } = layout()
  const cargo = folder("cargo")
  const envs = folder("envs")
  const ssh = path.join(home, ".ssh")
  const config = path.join(home, ".config")
  fs.mkdirSync(path.join(config, "gh"), { recursive: true })
  // A writable listed folder holding the fence.
  const holder = folder("holder")
  const fence = path.join(holder, "fence")
  fs.writeFileSync(fence, "")
  const covered = permission({
    fence,
    folders: [
      { path: cargo, access: "read" },
      { path: envs, access: "write" },
      { path: ssh, access: "read" },
      { path: holder, access: "write" },
      { path: path.join(config, "gh"), access: "read" },
    ],
  })
  expect(filesystem(covered)).toEqual({
    ":minimal": "read",
    [install]: "read",
    [ws]: "write",
    ...codexKept(ws),
    [tmp]: "write",
    [cargo]: "read",
    [envs]: "write",
    [ssh]: "read",
    [holder]: "write",
    [path.join(config, "gh")]: "read",
    ...codexDenies(home, [ssh]),
    [fence]: "deny",
  })
  const start = claudeStart(covered)
  expect(start.addDirs).toEqual([cargo, envs, ssh, holder, path.join(config, "gh")])
  const sandbox = start.settings.sandbox as { filesystem: Record<string, string[]> }
  expect(sandbox.filesystem.denyRead).toEqual(claudeDenies(home, [ssh]))
  expect(sandbox.filesystem.allowRead).toEqual([ws, tmp, cargo, envs, ssh, holder, path.join(config, "gh")])
  expect(sandbox.filesystem.allowWrite).toEqual([ws, tmp, envs, holder])
  // A Read deny would beat the listed folder inside ~/.config for Claude Code's own tools, so that one isn't mirrored.
  const deny = (start.settings.permissions as { deny: string[] }).deny
  expect(deny).toEqual(expect.arrayContaining(claudeReads(home, [ssh, config])))
  expect(deny.filter((rule) => rule.startsWith(`Read(/${config}`) || rule.startsWith(`Read(/${ssh}`))).toEqual([])
  // Listing the whole home lifts every deny under it, the office's home included; the fence stays.
  const all = filesystem(permission({ folders: [{ path: home, access: "read" }] }))
  expect(Object.entries(all).filter(([, access]) => access === "deny")).toEqual([[permission().fence, "deny"]])
  const wide = claudeStart(permission({ folders: [{ path: home, access: "read" }] })).settings.sandbox as {
    filesystem: Record<string, string[]>
  }
  expect(wide.filesystem.denyRead).toEqual(SOCKETS)
})

test("a worktree's .git file is kept read-only whole, and a kept path that is a link is left out", () => {
  const { root, ws, permission, filesystem } = layout()
  fs.rmSync(path.join(ws, ".git"), { recursive: true })
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${root}/main/.git/worktrees/ws\n`)
  // Both harnesses' Linux sandboxes bind a read-only path onto itself, so a link would mount its target.
  fs.symlinkSync(path.join(root, "home/.ssh"), path.join(ws, ".claude"))
  const kept = Object.keys(filesystem(permission())).filter((p) => p.startsWith(ws + "/"))
  expect(kept).toEqual([".git", ".codex", ".agents", ".mcp.json"].map((rel) => path.join(ws, rel)))
  const { settings } = claudeStart(permission())
  // A .git file has no config below it.
  expect((settings.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite).toEqual(kept)
  // The .git file is a file: its edit deny names it alone.
  const deny = (settings.permissions as { deny: string[] }).deny
  expect(deny).toContain(`Edit(/${path.join(ws, ".git")})`)
  expect(deny).not.toContain(`Edit(/${path.join(ws, ".git")}/**)`)
})

test("a read-only listed folder gets Claude Code's write deny and edit deny; a writable one gets neither", () => {
  const { home, ws, permission, folder } = layout()
  const cargo = folder("cargo")
  const envs = folder("envs")
  const p = permission({
    folders: [
      { path: cargo, access: "read" },
      { path: envs, access: "write" },
    ],
  })
  const { settings } = claudeStart(p)
  const kept = claudeKept(ws)
  const sandbox = settings.sandbox as { filesystem: Record<string, string[]> }
  expect(sandbox.filesystem.denyWrite).toEqual([cargo, ...kept.denyWrite])
  expect((settings.permissions as { deny: string[] }).deny).toEqual([
    ...rules("Edit", cargo),
    ...kept.deny,
    ...claudeReads(home),
    ...CLOSED,
  ])
  expect(JSON.stringify(settings)).not.toContain(`Edit(/${envs}`)
  expect(sandbox.filesystem.denyWrite).not.toContain(envs)
})

test("the harness PATH is the system folders and read-only listed folders' bin, never a writable folder's", () => {
  const { permission, folder } = layout()
  const cargo = folder("cargo")
  const envs = folder("envs")
  const p = permission({
    folders: [
      { path: cargo, access: "read" },
      { path: envs, access: "write" },
    ],
  })
  expect(harnessPath(p)).toBe([...SYSTEM, path.join(cargo, "bin")].join(":"))
  expect(harnessPath(permission())).toBe(SYSTEM.join(":"))
  // A read-only folder's bin that is a link into a writable folder is left off: a program planted there would run
  // as the owner.
  const tools = folder("tools")
  fs.rmSync(path.join(tools, "bin"), { recursive: true })
  fs.symlinkSync(path.join(envs, "bin"), path.join(tools, "bin"))
  const linked = permission({
    folders: [
      { path: tools, access: "read" },
      { path: envs, access: "write" },
    ],
  })
  expect(harnessPath(linked)).toBe(SYSTEM.join(":"))
  // So is a system folder a writable listing covers, whichever way it is reached (/sbin may be a link to it).
  const sbin = harnessPath(permission({ folders: [{ path: "/usr/sbin", access: "write" }] })).split(":")
  expect(sbin).toContain("/usr/bin")
  for (const entry of sbin) expect(fs.realpathSync(entry)).not.toBe(fs.realpathSync("/usr/sbin"))
  // Nothing left on PATH is refused: an empty PATH means the working folder.
  expect(() => harnessPath(permission({ folders: [{ path: "/", access: "write" }] }))).toThrow(/nothing is left/)
})

test("a listed bin folder others can write, or one another person's permission lists as writable, stays off PATH", () => {
  const { permission, folder } = layout()
  const shared = folder("shared")
  const open = folder("open")
  const team = folder("team")
  fs.chmodSync(path.join(shared, "bin"), 0o775)
  fs.chmodSync(open, 0o757)
  const p = permission({
    folders: [
      { path: shared, access: "read" },
      { path: open, access: "read" },
      { path: team, access: "read" },
    ],
  })
  expect(harnessPath(p)).toBe([...SYSTEM, path.join(team, "bin")].join(":"))
  expect(harnessPath({ ...p, othersWritable: [team] })).toBe(SYSTEM.join(":"))
  const inside = harnessPath({ ...p, othersWritable: [path.join(team, "bin", "x")] })
  expect(inside).toBe([...SYSTEM, path.join(team, "bin")].join(":"))
})

test("Claude Code's start turns its sandbox on, fails if it can't start, allows no unsandboxed command, reads only the folder in the home, keeps its file tools to the working folders, and turns auto memory off", () => {
  const { home, ws, tmp, permission } = layout()
  const kept = claudeKept(ws)
  expect(claudeStart(permission())).toEqual({
    settings: {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          denyRead: claudeDenies(home),
          allowRead: [ws, tmp],
          allowWrite: [ws, tmp],
          denyWrite: kept.denyWrite,
        },
        network: { allowedDomains: [], strictAllowlist: true },
      },
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
        deny: [...kept.deny, ...claudeReads(home), ...CLOSED],
      },
      disableAllHooks: true,
      crossSessionInbound: "refuse",
      disableAgentView: true,
    },
    addDirs: [],
    env: {
      PATH: SYSTEM.join(":"),
      TMPDIR: tmp,
      CLAUDE_CODE_TMPDIR: tmp,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    },
  })
})

test("Claude Code's commands can't reach the owner's sockets: /tmp, /run and /dev/shm are hidden but the session's own folders, unless a listed folder covers one", () => {
  const { root, home, ws, tmp, permission } = layout()
  const denyRead = (p: EmployeePermission) =>
    (claudeStart(p).settings.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead
  const allowRead = (p: EmployeePermission) =>
    (claudeStart(p).settings.sandbox as { filesystem: { allowRead: string[] } }).filesystem.allowRead
  expect(SOCKETS).toContain(fs.realpathSync("/tmp"))
  if (fs.existsSync("/var/tmp")) expect(SOCKETS).toContain(fs.realpathSync("/var/tmp"))
  expect(denyRead(permission())).toEqual(claudeDenies(home))
  // The session's folder and temp folder lie under /tmp here: the narrower allow re-opens them.
  expect([ws, tmp].every((p) => p.startsWith(fs.realpathSync("/tmp") + "/"))).toBe(true)
  expect(allowRead(permission())).toEqual([ws, tmp])
  // A listed folder that covers one of them lifts that one alone, as for the home's folders.
  const listed = SOCKETS.find((p) => !ws.startsWith(p + "/"))!
  const covering = permission({ folders: [{ path: listed, access: "read" }] })
  expect(denyRead(covering)).toEqual(claudeDenies(home).filter((p) => p !== listed))
  expect(fs.existsSync(root)).toBe(true)
})

test("Claude Code's start refuses messages from the owner's other sessions, and closes its tools that message or list them", () => {
  const { permission } = layout()
  for (const p of [permission(), permission({ writable: false })]) {
    const { settings } = claudeStart(p)
    expect(settings.crossSessionInbound).toBe("refuse")
    expect((settings.permissions as { deny: string[] }).deny).toEqual(expect.arrayContaining(["SendMessage", "ListAgents"]))
  }
})

test("Claude Code with the network on is refused: its sandbox has no checked way to allow every host", () => {
  const { permission } = layout()
  expect(() => claudeStart(permission({ network: true }))).toThrow(/network on isn't supported yet/)
  expect(() => harnessPath(permission({ network: true }))).not.toThrow()
})

test("the override is nested objects with no dotted key, and its paths are resolved", () => {
  const { root, ws, tmp, fence, permission, thread } = layout()
  const link = (target: string, name: string): string => {
    const p = path.join(root, name)
    fs.symlinkSync(target, p)
    return p
  }
  // Links to the folders are resolved; a temp folder or fence that is itself a link is refused (below).
  const p = permission({
    workspace: link(ws, "ws-link"),
    gitRoot: link(ws, "git-link"),
    fence: path.join(link(root, "root-link"), "fence"),
  })
  const { config } = thread(p)
  for (const key of Object.keys(config)) expect(key).not.toContain(".")
  const filesystem = (config.permissions as Record<string, { filesystem: Record<string, string> }>)["opencorp-s1"]!
    .filesystem
  expect(filesystem[ws]).toBe("write")
  expect(filesystem[tmp]).toBe("write")
  expect(filesystem[fence]).toBe("deny")
  expect(Object.keys(filesystem).filter((k) => k.includes("-link"))).toEqual([])
  expect(config.projects).toEqual({ [ws]: { trust_level: "untrusted" } })
  // Every value is a plain object, array, string or boolean: JSON round-trips it unchanged.
  expect(JSON.parse(JSON.stringify(config))).toEqual(config)
  expect(() => thread(permission(), { id: ":workspace" })).toThrow()
})

test("a workspace that would expose the home, a credential folder or the office is refused", () => {
  const { root, home, officeHome, permission, thread } = layout()
  const tool = path.join(root, "ws/bin/git")
  fs.mkdirSync(path.dirname(tool), { recursive: true })
  fs.writeFileSync(tool, "")
  const custom = path.join(root, "oc")
  fs.mkdirSync(path.join(custom, "office"), { recursive: true })
  const refused: EmployeePermission[] = [
    permission({ workspace: home }),
    permission({ workspace: root }),
    permission({ workspace: path.join(home, ".ssh") }),
    permission({ workspace: path.join(officeHome, "office") }),
    permission({ office: { tools: [tool] } }),
    permission({ workspace: path.join(custom, "office"), officeHome: custom }),
    permission({ workspace: custom, officeHome: path.join(custom, "office") }),
  ]
  for (const p of refused) {
    expect(() => checkPermission(p), p.workspace).toThrow(UnsafeWorkspace)
    expect(() => thread(p)).toThrow(UnsafeWorkspace)
    expect(() => claudeStart(p)).toThrow(UnsafeWorkspace)
  }
  expect(() => checkPermission(permission())).not.toThrow()
})

test("a temp folder or fence that is the shell's, lies in the office's home, isn't empty, is a link or isn't the user's is refused", () => {
  const { root, officeHome, tmp, fence, permission } = layout()
  const shellTmp = path.join(officeHome, "office/sessions/s1/tmp")
  fs.mkdirSync(shellTmp, { recursive: true, mode: 0o700 })
  fs.chmodSync(shellTmp, 0o700)
  const tmpLink = path.join(root, "tmp-link")
  fs.symlinkSync(tmp, tmpLink)
  const full = path.join(root, "full")
  fs.mkdirSync(full, { mode: 0o700 })
  fs.chmodSync(full, 0o700)
  fs.writeFileSync(path.join(full, "left"), "")
  const open = path.join(root, "open")
  fs.mkdirSync(open)
  fs.chmodSync(open, 0o755)
  const inWs = path.join(root, "ws/tmp")
  fs.mkdirSync(inWs, { mode: 0o700 })
  fs.chmodSync(inWs, 0o700)
  const officeFence = path.join(officeHome, "fence")
  fs.writeFileSync(officeFence, "")
  const fenceLink = path.join(root, "fence-link")
  fs.symlinkSync(fence, fenceLink)
  const refused: [string, Partial<EmployeePermission>, RegExp][] = [
    ["the shell's temp folder", { tmpdir: shellTmp }, /temp folder .* lies in /],
    ["a link", { tmpdir: tmpLink }, /temp folder .* isn't a folder/],
    ["not empty", { tmpdir: full }, /isn't empty/],
    ["not private", { tmpdir: open }, /isn't private/],
    ["inside the read-only workspace", { writable: false, tmpdir: inWs }, /temp folder .* lies in the read-only /],
    ["missing", { tmpdir: path.join(root, "nowhere") }, /temp folder .* isn't a folder/],
    ["a fence in the office's home", { fence: officeFence }, /fence .* lies in /],
    ["a fence that is a link", { fence: fenceLink }, /fence .* isn't a file/],
    ["a missing fence", { fence: path.join(root, "no-fence") }, /fence .* isn't a file/],
    ["a fence that is a folder", { fence: open }, /fence .* isn't a file/],
  ]
  // Root owns every file, so only another user can see a file that isn't theirs.
  if (process.getuid?.() !== 0) {
    refused.push(
      ["a temp folder not the user's", { tmpdir: "/usr" }, /temp folder .* isn't the user's/],
      ["a fence not the user's", { fence: "/etc/passwd" }, /fence .* isn't the user's/],
    )
  }
  for (const [what, fields, reason] of refused) {
    expect(() => checkPermission(permission(fields)), what).toThrow(UnsafeProfile)
    expect(() => checkPermission(permission(fields)), what).toThrow(reason)
  }
})

test("a listed folder whose path walks through the writable session folder or another writable listed folder is refused", () => {
  const { root, ws, tmp, permission, folder } = layout()
  const envs = folder("envs")
  const other = folder("other")
  const code = path.join(folder("code"), "proj")
  fs.mkdirSync(code)
  fs.symlinkSync(other, path.join(envs, "link"))
  fs.mkdirSync(path.join(ws, "vendor"))
  const refused: [string, Partial<EmployeePermission>, RegExp][] = [
    [
      "inside the writable workspace",
      { folders: [{ path: path.join(ws, "vendor"), access: "read" }] },
      /is reached through/,
    ],
    [
      "through a link in a writable listed folder",
      {
        folders: [
          { path: envs, access: "write" },
          { path: path.join(envs, "link"), access: "read" },
        ],
      },
      /is reached through/,
    ],
    ["inside the temp folder", { folders: [{ path: path.join(tmp, "x"), access: "read" }] }, /is reached through/],
    // Each folder gets exactly the access set for it: listed twice, or as the workspace, it would have two.
    [
      "listed twice",
      {
        folders: [
          { path: other, access: "read" },
          { path: other, access: "write" },
        ],
      },
      /listed twice/,
    ],
    ["the workspace itself", { writable: false, folders: [{ path: ws, access: "write" }] }, /is the session's folder/],
    // Claude Code's write denies win over its write allows, so a writable folder in a read-only one can't be written.
    [
      "writable inside the read-only workspace",
      { writable: false, folders: [{ path: path.join(ws, "vendor"), access: "write" }] },
      /can't write .* inside the read-only /,
    ],
    [
      "writable inside a read-only listed folder",
      {
        folders: [
          { path: other, access: "read" },
          { path: path.join(other, "bin"), access: "write" },
        ],
      },
      /can't write .* inside the read-only /,
    ],
    [
      "the workspace writable inside a read-only listed folder",
      { workspace: code, gitRoot: null, folders: [{ path: path.dirname(code), access: "read" }] },
      /can't write .* inside the read-only /,
    ],
    ["relative", { folders: [{ path: "envs", access: "read" }] }, /isn't absolute/],
    ["a pattern", { folders: [{ path: path.join(root, "env*"), access: "read" }] }, /as a pattern/],
    ["a null byte", { folders: [{ path: path.join(root, "env\0s"), access: "read" }] }, /holds a null byte/],
  ]
  for (const [what, fields, reason] of refused) {
    expect(() => checkPermission(permission(fields)), what).toThrow(UnsafeProfile)
    expect(() => checkPermission(permission(fields)), what).toThrow(reason)
  }
  // The same folder in a read-only workspace is read as listed.
  expect(() =>
    checkPermission(permission({ writable: false, folders: [{ path: path.join(ws, "vendor"), access: "read" }] })),
  ).not.toThrow()
  const both = permission({
    folders: [
      { path: envs, access: "write" },
      { path: other, access: "read" },
    ],
  })
  expect(() => checkPermission(both)).not.toThrow()
})

/** The paths at `dir` both harnesses keep read-only, as Codex's `read` entries; only `.git` when `gitOnly`. */
function keptAt(dir: string, gitOnly = false): Record<string, string> {
  return gitOnly ? { [path.join(dir, ".git")]: "read" } : codexKept(dir)
}

test("a session folder in a writable listed folder keeps .git read-only in each folder above it there, and the project config at its git root", () => {
  const { root, permission, folder, filesystem } = layout()
  const shared = folder("shared")
  // A session in a subfolder of a repo rooted in the listed folder: git finds a repository in any folder above the
  // session's, and runs its config as the owner.
  const repo = path.join(shared, "repo")
  const proj = path.join(repo, "sub/proj")
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".git/config"), "[core]\n")
  fs.mkdirSync(proj, { recursive: true })
  const listed = [{ path: shared, access: "write" as const }]
  const p = permission({ workspace: proj, gitRoot: repo, folders: listed })
  const kept = {
    ...keptAt(proj),
    ...keptAt(path.join(repo, "sub"), true),
    ...keptAt(repo),
    ...keptAt(shared, true),
  }
  const entries = filesystem(p)
  expect(entries).toEqual(expect.objectContaining({ [proj]: "write", [shared]: "write", ...kept }))
  // Nothing above the listed folder: the harness can't write there.
  const gitsOf = (e: Record<string, string>) => Object.keys(e).filter((p) => p.endsWith("/.git")).sort()
  expect(gitsOf(entries)).toEqual(gitsOf(kept))
  const { settings } = claudeStart(p)
  const sandbox = settings.sandbox as { filesystem: Record<string, string[]> }
  expect(sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining([proj, shared]))
  // A .git folder's config first, so the sandbox holds a missing one as a folder.
  const gits = [proj, path.join(repo, "sub"), repo, shared].flatMap((dir) => [
    path.join(dir, ".git/config"),
    path.join(dir, ".git"),
  ])
  expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([...gits, ...Object.keys(keptAt(repo))]))
  const deny = (settings.permissions as { deny: string[] }).deny
  expect(deny).toEqual(
    expect.arrayContaining([...rules("Edit", path.join(shared, ".git")), ...rules("Edit", path.join(repo, ".claude"))]),
  )
  // The reviewer's case: a session with no repository of its own, straight in the listed folder.
  const bare = path.join(shared, "bare")
  fs.mkdirSync(bare)
  const alone = filesystem(permission({ workspace: bare, gitRoot: null, folders: listed }))
  expect(alone).toEqual(expect.objectContaining({ ...keptAt(bare), ...keptAt(shared, true) }))
  // A read-only session folder there is read-only, its folders above kept as well.
  const readOnly = filesystem(permission({ workspace: bare, gitRoot: null, writable: false, folders: listed }))
  expect(readOnly).toEqual(expect.objectContaining({ [bare]: "read", [shared]: "write", ...keptAt(shared, true) }))
  // A git root no writable folder holds gets no entries: the harness can't write it, and they would open it to reads.
  const outside = path.join(root, "outside")
  const inner = path.join(outside, "inner")
  fs.mkdirSync(path.join(outside, ".git"), { recursive: true })
  fs.mkdirSync(inner)
  expect(filesystem(permission({ workspace: inner, gitRoot: outside }))[path.join(outside, ".git")]).toBeUndefined()
})

test("a session folder reached through a link in a writable listed folder is refused", () => {
  const { root, permission, folder } = layout()
  const shared = folder("shared")
  const elsewhere = folder("elsewhere")
  fs.symlinkSync(elsewhere, path.join(shared, "proj"))
  const through = { workspace: path.join(shared, "proj"), gitRoot: null }
  const refused = permission({ ...through, folders: [{ path: shared, access: "write" }] })
  expect(() => checkPermission(refused)).toThrow(UnsafeWorkspace)
  expect(() => checkPermission(refused)).toThrow(/reached through .* which the harness can write/)
  // A link the harness can't change is followed.
  const readOnly = permission({ ...through, writable: false, folders: [{ path: shared, access: "read" }] })
  expect(() => checkPermission(readOnly)).not.toThrow()
  fs.symlinkSync(shared, path.join(root, "alias"))
  fs.mkdirSync(path.join(shared, "real"))
  const aliased = { workspace: path.join(root, "alias/real"), gitRoot: null }
  expect(() => checkPermission(permission({ ...aliased, folders: [{ path: shared, access: "write" }] }))).not.toThrow()
})

test("the harnesses' own config and the office's home stay read-only where a writable listing covers them, and stay closed where none does", () => {
  const { home, officeHome, fence, permission, folder, filesystem } = layout()
  fs.writeFileSync(path.join(home, ".claude.json"), "{}")
  const held: [string, boolean][] = [
    [officeHome, true],
    [path.join(home, ".codex"), true],
    [path.join(home, ".claude"), true],
    [path.join(home, ".claude.json"), false],
  ]
  const wide = permission({ folders: [{ path: home, access: "write" }] })
  const entries = filesystem(wide)
  expect(entries[home]).toBe("write")
  for (const [p] of held) expect(entries[p], p).toBe("read")
  expect(entries[fence]).toBe("deny")
  const { settings } = claudeStart(wide)
  const sandbox = settings.sandbox as { filesystem: Record<string, string[]> }
  expect(sandbox.filesystem.allowWrite).toContain(home)
  expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining(held.map(([p]) => p)))
  expect((settings.permissions as { deny: string[] }).deny).toEqual(
    expect.arrayContaining(held.flatMap(([p, isFolder]) => rules("Edit", p, isFolder))),
  )
  // CODEX_HOME set apart, in a writable listed folder, and a writable folder listed inside a harness's config.
  const apart = folder("apart")
  const codexHome = path.join(apart, "codex")
  const inside = path.join(home, ".codex/rules")
  fs.mkdirSync(codexHome)
  fs.mkdirSync(inside)
  const both = permission({
    harnessHomes: [codexHome],
    folders: [
      { path: apart, access: "write" },
      { path: inside, access: "write" },
    ],
  })
  const bothEntries = filesystem(both)
  expect([bothEntries[apart], bothEntries[codexHome], bothEntries[inside]]).toEqual(["write", "read", "read"])
  // Not covered, ~/.codex stays denied.
  expect(bothEntries[path.join(home, ".codex")]).toBe("deny")
  const bothSandbox = claudeStart(both).settings.sandbox as { filesystem: Record<string, string[]> }
  const denyWrite = bothSandbox.filesystem.denyWrite
  expect(denyWrite).toEqual(expect.arrayContaining([codexHome, inside]))
  // With nothing covering them they stay denied, never opened by a read entry.
  const plain = filesystem(permission())
  expect(plain[path.join(home, ".claude.json")]).toBeUndefined()
  expect([plain[officeHome], plain[path.join(home, ".codex")]]).toEqual(["deny", "deny"])
  // A read-only listing covering them is read-only already.
  const read = filesystem(permission({ folders: [{ path: home, access: "read" }] }))
  expect(read[path.join(home, ".claude.json")]).toBeUndefined()
})

/** The `codex` a test runs, named by `OPENCORP_TEST_CODEX`. Unset, the real-Codex tests skip, so no run finds the
 *  owner's own Codex by chance; under `OPENCORP_TEST_SANDBOX` they run, and fail without it. Codex's sandbox needs
 *  what the office's does, so they also skip where that can't start (and fail under `OPENCORP_TEST_SANDBOX`). */
const CODEX = process.env.OPENCORP_TEST_CODEX
const NO_CODEX = CODEX === undefined ? !process.env.OPENCORP_TEST_SANDBOX : !sandboxAvailable()
/** The oldest Codex whose sandbox takes a per-thread permission profile in these tests' form. */
const CODEX_FLOOR = [0, 167, 0]

/** What the real-Codex tests run, and Codex's install folder, as the office finds them (`nativeCodex`):
 *  `OPENCORP_TEST_CODEX` may be the native binary, npm's launcher (which needs node, so the native binary it execs runs
 *  instead), or a wrapper script beside a `node_modules` holding Codex. */
function testCodex(): { run: string; install: string } {
  if (CODEX === undefined) throw new Error("OPENCORP_TEST_SANDBOX is set: set OPENCORP_TEST_CODEX to a Codex 0.167.0+")
  return nativeCodex(CODEX)
}

/** Runs the test's Codex with `args` and none of this process's environment: a temp HOME and CODEX_HOME, never the
 *  real ones, the given PATH, and `env`. */
function runCodex(
  args: readonly string[],
  options: { home: string; codexHome: string; path: string; cwd: string; env?: Record<string, string> },
) {
  return spawnSync(testCodex().run, args, {
    cwd: options.cwd,
    env: { HOME: options.home, CODEX_HOME: options.codexHome, PATH: options.path, ...options.env },
    encoding: "utf8",
    timeout: 60_000,
  })
}

/** Throws unless the test's Codex, asked in a fresh temp home, is 0.167.0 or later. */
function checkCodexVersion(): void {
  const scratch = fs.realpathSync(tempDir())
  for (const dir of ["home", "codex"]) fs.mkdirSync(path.join(scratch, dir))
  const version = runCodex(["--version"], {
    home: path.join(scratch, "home"),
    codexHome: path.join(scratch, "codex"),
    path: SYSTEM.join(":"),
    cwd: scratch,
  })
  const found = (version.stdout.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  const first = found.findIndex((n, i) => n !== CODEX_FLOOR[i])
  if (found.length !== 3 || (first >= 0 && found[first]! < CODEX_FLOOR[first]!)) {
    throw new Error(`OPENCORP_TEST_CODEX is ${version.stdout.trim() || version.stderr.trim()}; need 0.167.0 or later`)
  }
}

/** `value` as a TOML value on one line: tables inline, keys quoted. */
function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`
  const entries = Object.entries(value as Record<string, unknown>)
  return `{ ${entries.map(([key, v]) => `${JSON.stringify(key)} = ${toml(v)}`).join(", ")} }`
}

/** Runs `script` with `sh` under Codex's own sandbox, given the employee's override as `-c` flags, with only the temp
 *  home, a scratch CODEX_HOME and the harness PATH in its environment. */
function codexSandbox(p: EmployeePermission, codexHome: string, script: string) {
  checkCodexVersion()
  const { permissions, config } = codexThread(p, "opencorp-t", { install: testCodex().install })
  const flags = Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])
  return runCodex(["sandbox", "-P", permissions, "-C", p.workspace, ...flags, "--", "sh", "-c", script], {
    home: p.home,
    codexHome,
    path: harnessPath(p),
    cwd: p.workspace,
    env: { TMPDIR: p.tmpdir },
  })
}

/** `codexSandbox`, run without blocking: resolves with its stdout and stderr once it exits (60 s at most). */
function codexSandboxAsync(p: EmployeePermission, codexHome: string, script: string): Promise<string> {
  checkCodexVersion()
  const { permissions, config } = codexThread(p, "opencorp-t", { install: testCodex().install })
  const flags = Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])
  const child = spawn(testCodex().run, ["sandbox", "-P", permissions, "-C", p.workspace, ...flags, "--", "bash", "-c", script], {
    cwd: p.workspace,
    env: { HOME: p.home, CODEX_HOME: codexHome, PATH: harnessPath(p), TMPDIR: p.tmpdir },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })
  let output = ""
  child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")))
  child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")))
  return new Promise((resolve) => child.on("close", () => resolve(output)))
}

test.skipIf(NO_CODEX)(
  "under the override, Codex's sandbox runs sh, git and cc in the folder, reads no credential, the office's home or the fence, and writes nothing on the host outside the folder",
  () => {
    const { root, home, ws, fence, permission } = layout()
    fs.rmSync(path.join(ws, ".git"), { recursive: true })
    const init = spawnSync("git", ["init", "-q", ws], { env: { PATH: "/usr/bin:/bin", HOME: home } })
    expect(init.status).toBe(0)
    const gitConfig = fs.readFileSync(path.join(ws, ".git/config"), "utf8")
    fs.writeFileSync(fence, "decoy-fence")
    const codexHome = path.join(root, "codex")
    fs.mkdirSync(codexHome)
    const ownerConfig = '# the owner\'s config\nmodel_reasoning_effort = "low"\n'
    fs.writeFileSync(path.join(codexHome, "config.toml"), ownerConfig)
    const cc = fs.existsSync("/usr/bin/cc")
    // The sandbox's root is a writable scratch file system, so a write outside the folder can succeed in there: only
    // the host side says whether it got out.
    const script = [
      "echo hi > ok.txt && cat ok.txt",
      "git rev-parse --is-inside-work-tree && echo git-ok",
      cc ? "printf 'int main(void){return 0;}\\n' > t.c && cc t.c -o t && ./t && echo cc-ok" : "true",
      `cat ${home}/.ssh/id_test ${home}/.codex/auth.json ${home}/.opencorp/office/connections/main.json ${fence}`,
      `echo x > ${root}/outside.txt; echo x > ${home}/escape.txt`,
      "printf '[core]\\n\\tfsmonitor = planted\\n' > .git/config; mv .git .git-old",
      "mkdir -p .codex && echo planted > .codex/config.toml; echo planted > .mcp.json",
      "mkdir -p .claude && echo planted > .claude/settings.json",
    ].join("\n")
    const result = codexSandbox(permission(), codexHome, script)
    const output = result.stdout + result.stderr
    expect(result.error, output).toBeUndefined()
    expect(result.stdout, output).toContain("hi\n")
    expect(result.stdout, output).toContain("git-ok")
    if (cc) expect(result.stdout, output).toContain("cc-ok")
    expect(output).not.toContain("decoy")
    expect(fs.readFileSync(path.join(ws, "ok.txt"), "utf8")).toBe("hi\n")
    expect(fs.existsSync(path.join(root, "outside.txt"))).toBe(false)
    expect(fs.existsSync(path.join(home, "escape.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(ws, ".git/config"), "utf8")).toBe(gitConfig)
    expect(fs.existsSync(path.join(ws, ".git-old"))).toBe(false)
    for (const rel of [".codex/config.toml", ".mcp.json", ".claude/settings.json"]) {
      expect(fs.existsSync(path.join(ws, rel)), rel).toBe(false)
    }
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(ownerConfig)
  },
)

test.skipIf(NO_CODEX)(
  "in Codex's sandbox a missing .claude or .mcp.json is an empty read-only file git lists, which no command can commit, and the host has it only while a command runs",
  async () => {
    const { root, home, ws, permission } = layout()
    fs.rmSync(path.join(ws, ".git"), { recursive: true })
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", ws, ...args], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" })
    expect(git("init", "-q").status).toBe(0)
    fs.writeFileSync(path.join(ws, "a.txt"), "a\n")
    expect(git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A").status).toBe(0)
    expect(git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "a").status).toBe(0)
    const codexHome = path.join(root, "codex")
    fs.mkdirSync(codexHome)
    const script = [
      "git status --porcelain --untracked-files=all",
      "for f in .claude .mcp.json; do test -f $f && test ! -s $f && echo empty-file $f; done",
      "for d in .codex .agents; do test -d $d && echo empty-folder $d; done",
      "echo x > .mcp.json 2>/dev/null || echo read-only .mcp.json",
      "git add -A 2>&1 | head -1",
      "sleep 2",
    ].join("\n")
    // While the command runs, the host has the empty files Codex mounts its read-only copies onto.
    const running = codexSandboxAsync(permission(), codexHome, script)
    let seen = false
    for (const deadline = Date.now() + 20_000; !seen && Date.now() < deadline; await sleep(50)) {
      seen = fs.existsSync(path.join(ws, ".mcp.json"))
    }
    const output = await running
    expect(output, output).toContain("?? .claude\n")
    expect(output, output).toContain("?? .mcp.json\n")
    expect(output, output).not.toContain("?? .codex")
    expect(output, output).toContain("empty-file .claude")
    expect(output, output).toContain("empty-file .mcp.json")
    expect(output, output).toContain("empty-folder .codex")
    expect(output, output).toContain("read-only .mcp.json")
    // .git is read-only in there: nothing stages or commits the placeholders.
    expect(output, output).toMatch(/index\.lock.*Read-only file system/)
    expect(seen).toBe(true)
    // Once it has run, the host has none of them, and the repository is as it was.
    for (const name of [".claude", ".mcp.json", ".codex", ".agents"]) {
      expect(fs.existsSync(path.join(ws, name)), name).toBe(false)
    }
    expect(git("status", "--porcelain").stdout).toBe("")
  },
  60_000,
)

test.skipIf(NO_CODEX)("in a folder with no .git, Codex's sandbox can't start a repository and plant its config", () => {
  const { root, ws, permission } = layout()
  fs.rmSync(path.join(ws, ".git"), { recursive: true })
  const codexHome = path.join(root, "codex")
  fs.mkdirSync(codexHome)
  const script = "git init -q .; mkdir -p .git && printf '[core]\\n\\tfsmonitor = planted\\n' > .git/config; echo done"
  const result = codexSandbox(permission({ gitRoot: null }), codexHome, script)
  expect(result.stdout, result.stdout + result.stderr).toContain("done")
  expect(fs.existsSync(path.join(ws, ".git/config"))).toBe(false)
  expect(fs.existsSync(path.join(ws, ".git/HEAD"))).toBe(false)
})

test.skipIf(NO_CODEX)(
  "in a session inside a writable listed folder, Codex's sandbox can't start a repository above it, or change the harness's config or the office's home a writable listing covers",
  () => {
    const { root, home, officeHome, permission } = layout()
    const shared = path.join(root, "shared")
    // Codex itself keeps a writable folder's top-level .git read-only; the one between isn't.
    const proj = path.join(shared, "a/proj")
    const codexHome = path.join(shared, "codex")
    fs.mkdirSync(proj, { recursive: true })
    fs.mkdirSync(codexHome)
    const ownerConfig = '# the owner\'s config\nmodel_reasoning_effort = "low"\n'
    fs.writeFileSync(path.join(codexHome, "config.toml"), ownerConfig)
    fs.writeFileSync(path.join(home, ".claude.json"), "{}")
    const p = permission({
      workspace: proj,
      gitRoot: null,
      harnessHomes: [codexHome],
      folders: [
        { path: shared, access: "write" },
        { path: home, access: "write" },
      ],
    })
    const script = [
      "for d in .. ../..; do git init -q $d; mkdir -p $d/.git",
      "  printf '[core]\\n\\tfsmonitor = planted\\n' > $d/.git/config; done",
      `echo planted >> ${codexHome}/config.toml`,
      `mkdir -p ${codexHome}/rules && echo planted > ${codexHome}/rules/x.rules`,
      `echo planted > ${home}/.codex/config.toml; echo planted > ${home}/.claude.json; echo planted > ${officeHome}/x`,
      `echo ok > ../ok.txt; echo ok > ${home}/ok.txt`,
      "echo done",
    ].join("\n")
    const result = codexSandbox(p, codexHome, script)
    const output = result.stdout + result.stderr
    expect(result.stdout, output).toContain("done")
    for (const dir of [path.join(shared, "a"), shared]) {
      expect(fs.existsSync(path.join(dir, ".git/config")), output).toBe(false)
      expect(fs.existsSync(path.join(dir, ".git/HEAD")), output).toBe(false)
    }
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(ownerConfig)
    expect(fs.existsSync(path.join(codexHome, "rules/x.rules"))).toBe(false)
    expect(fs.existsSync(path.join(home, ".codex/config.toml"))).toBe(false)
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe("{}")
    expect(fs.existsSync(path.join(officeHome, "x"))).toBe(false)
    // The listings hold everywhere else.
    expect(fs.readFileSync(path.join(shared, "a/ok.txt"), "utf8")).toBe("ok\n")
    expect(fs.readFileSync(path.join(home, "ok.txt"), "utf8")).toBe("ok\n")
  },
)

test("the git root is the nearest folder holding .git, a worktree's .git file too", () => {
  const root = fs.realpathSync(tempDir())
  const deep = path.join(root, "repo/a/b")
  fs.mkdirSync(deep, { recursive: true })
  expect(gitRootOf(deep)).toBeNull()
  fs.mkdirSync(path.join(root, "repo/.git"))
  expect(gitRootOf(deep)).toBe(path.join(root, "repo"))
  expect(gitRootOf(path.join(root, "repo"))).toBe(path.join(root, "repo"))
  fs.writeFileSync(path.join(root, "repo/a/.git"), "gitdir: ../.git/worktrees/a\n")
  expect(gitRootOf(deep)).toBe(path.join(root, "repo/a"))
})

test("the harnesses' own config folders are those the office's environment sets", () => {
  expect(harnessHomes({ CODEX_HOME: "/c", CLAUDE_CONFIG_DIR: "/d", HOME: "/h" })).toEqual(["/c", "/d"])
  expect(harnessHomes({ CODEX_HOME: "" })).toEqual([])
})

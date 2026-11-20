/** A harness's permission, from its employee's: Codex's per-thread profile and override, Claude Code's settings, the
 *  harnesses' PATH, and the checks before any is built. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import {
  checkPermission,
  claudeStart,
  codexThread,
  type EmployeePermission,
  harnessPath,
} from "../../../src/runtime/sandbox/harness_profile.ts"
import { UnsafeProfile, UnsafeWorkspace } from "../../../src/runtime/sandbox/policy.ts"
import { tempDir } from "../../helpers.ts"
import { sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(60_000)

/** The system folders every harness PATH starts with, on this platform. */
const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
if (process.platform === "darwin") SYSTEM.push("/opt/homebrew/bin")

/** A temp layout: a home holding credentials and an office (`.ssh/id_test`, `.codex/auth.json`, `.claude/`,
 *  `.opencorp/office/connections/`), a workspace `<root>/ws` that is a git repo (a `.git` folder with its config), a
 *  private empty temp folder `<root>/tmp` and the fence `<root>/fence`, all resolved. `permission` builds an
 *  employee's permission over it. */
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
  /** A folder `<root>/<rel>` with a `bin` folder in it. */
  const folder = (rel: string): string => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.join(p, "bin"), { recursive: true })
    return p
  }
  return { root, home, officeHome, ws, tmp, fence, permission, folder }
}

/** The home's credential folders and the office's home under `home`, as Codex's deny entries. */
function codexDenies(home: string, except: readonly string[] = []): Record<string, string> {
  const named = [".opencorp", ".ssh", ".aws", ".gnupg", ".config", "Library", ".claude", ".codex", ".docker", ".kube"]
  const all = [...named, ".netrc"].map((rel) => path.join(home, rel)).filter((p) => !except.includes(p))
  return Object.fromEntries(all.map((p) => [p, "deny"]))
}

/** The same, as Claude Code's `denyRead`: the home first. */
function claudeDenies(home: string, except: readonly string[] = []): string[] {
  return [home, ...Object.keys(codexDenies(home, except))]
}

/** The workspace's paths both harnesses keep read-only, as Codex's `read` entries. */
function codexKept(ws: string): Record<string, string> {
  const kept = [".git/hooks", ".git/config", ".codex", ".agents", ".claude", ".mcp.json"]
  return Object.fromEntries(kept.map((rel) => [path.join(ws, rel), "read"]))
}

/** The same, as Claude Code's `denyWrite` entries and `Edit` denies (a folder's covers what is in it). */
function claudeKept(ws: string): { denyWrite: string[]; deny: string[] } {
  const kept: [string, boolean][] = [
    [".git/hooks", true],
    [".git/config", false],
    [".codex", true],
    [".agents", true],
    [".claude", true],
    [".mcp.json", false],
  ]
  return {
    denyWrite: kept.map(([rel]) => path.join(ws, rel)),
    deny: kept.map(([rel, folder]) => `Edit(/${path.join(ws, rel)}${folder ? "/**" : ""})`),
  }
}

test("a writable employee's Codex override reads the minimal set, writes its folder and temp folder, denies the fence, and pins the folder and its git root untrusted", () => {
  const { home, ws, tmp, fence, permission, root } = layout()
  expect(codexThread(permission(), "opencorp-s1")).toEqual({
    permissions: "opencorp-s1",
    config: {
      permissions: {
        "opencorp-s1": {
          filesystem: {
            ":minimal": "read",
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
      features: { hooks: false, apps: false, plugins: false },
      notify: [],
      web_search: "disabled",
    },
  })
  // A folder inside a repo pins both: Codex keys trust by the folder first, then by its git root.
  const sub = path.join(root, "repo/ws")
  fs.mkdirSync(sub, { recursive: true })
  const nested = codexThread(permission({ workspace: sub, gitRoot: path.join(root, "repo") }), "opencorp-s2")
  expect(nested.config.projects).toEqual({
    [sub]: { trust_level: "untrusted" },
    [path.join(root, "repo")]: { trust_level: "untrusted" },
  })
  // No git root, only the folder.
  const bare = codexThread(permission({ gitRoot: null }), "opencorp-s3")
  expect(bare.config.projects).toEqual({ [ws]: { trust_level: "untrusted" } })
})

test("every Codex override turns hooks, apps, plugins, notify and the given MCP servers off, and web search too with the network off", () => {
  const { permission } = layout()
  for (const writable of [true, false]) {
    for (const network of [true, false]) {
      const { config } = codexThread(permission({ writable, network }), "opencorp-s1", { mcpServers: ["docs", "a.b"] })
      expect(config.features).toEqual({ hooks: false, apps: false, plugins: false })
      expect(config.notify).toEqual([])
      expect(config.mcp_servers).toEqual({ docs: { enabled: false }, "a.b": { enabled: false } })
      if (network) expect("web_search" in config).toBe(false)
      else expect(config.web_search).toBe("disabled")
      const profile = (config.permissions as Record<string, { network: unknown }>)["opencorp-s1"]!
      expect(profile.network).toEqual({ enabled: network })
    }
  }
  // With no servers given there is nothing to turn off, and the key is left out.
  expect("mcp_servers" in codexThread(permission(), "opencorp-s1").config).toBe(false)
})

test("a read-only employee's folder is read-only in both harnesses, Claude Code's Bash write to it denied too", () => {
  const { home, ws, tmp, fence, permission } = layout()
  const p = permission({ writable: false })
  const { config } = codexThread(p, "opencorp-s1")
  const profile = (config.permissions as Record<string, { filesystem: Record<string, string> }>)["opencorp-s1"]!
  expect(profile.filesystem).toEqual({
    ":minimal": "read",
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
    "WebFetch",
    "WebSearch",
  ])
})

test("the office's home and the home's credential folders are denied by name", () => {
  const { root, home, officeHome, permission } = layout()
  const { config } = codexThread(permission(), "opencorp-s1")
  const filesystem = (config.permissions as Record<string, { filesystem: Record<string, string> }>)["opencorp-s1"]!
    .filesystem
  for (const p of [officeHome, path.join(home, ".ssh"), path.join(home, ".codex"), path.join(home, ".claude")]) {
    expect(filesystem[p]).toBe("deny")
  }
  const sandbox = claudeStart(permission()).settings.sandbox as { filesystem: { denyRead: string[] } }
  expect(sandbox.filesystem.denyRead).toEqual(claudeDenies(home))
  // An office home outside the home is denied by name too, and a credential folder that is a link by its target.
  const elsewhere = path.join(root, "oc-home")
  const keys = path.join(root, "keys")
  fs.mkdirSync(elsewhere)
  fs.mkdirSync(keys)
  fs.rmSync(path.join(home, ".ssh"), { recursive: true })
  fs.symlinkSync(keys, path.join(home, ".ssh"))
  const moved = codexThread(permission({ officeHome: elsewhere }), "opencorp-s1").config.permissions as Record<
    string,
    { filesystem: Record<string, string> }
  >
  expect(moved["opencorp-s1"]!.filesystem[elsewhere]).toBe("deny")
  expect(moved["opencorp-s1"]!.filesystem[keys]).toBe("deny")
  expect(moved["opencorp-s1"]!.filesystem[path.join(home, ".ssh")]).toBeUndefined()
})

test("a listed folder is mounted as listed, and one covering a credential folder lifts its deny-by-name, but never the fence", () => {
  const { home, ws, tmp, permission, folder } = layout()
  const cargo = folder("cargo")
  const envs = folder("envs")
  const ssh = path.join(home, ".ssh")
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
    ],
  })
  const { config } = codexThread(covered, "opencorp-s1")
  const filesystem = (config.permissions as Record<string, { filesystem: Record<string, string> }>)["opencorp-s1"]!
    .filesystem
  expect(filesystem).toEqual({
    ":minimal": "read",
    [ws]: "write",
    ...codexKept(ws),
    [tmp]: "write",
    [cargo]: "read",
    [envs]: "write",
    [ssh]: "read",
    [holder]: "write",
    ...codexDenies(home, [ssh]),
    [fence]: "deny",
  })
  const start = claudeStart(covered)
  expect(start.addDirs).toEqual([cargo, envs, ssh, holder])
  const sandbox = start.settings.sandbox as { filesystem: Record<string, string[]> }
  expect(sandbox.filesystem.denyRead).toEqual(claudeDenies(home, [ssh]))
  expect(sandbox.filesystem.allowRead).toEqual([ws, tmp, cargo, envs, ssh, holder])
  expect(sandbox.filesystem.allowWrite).toEqual([ws, tmp, envs, holder])
  // Listing the whole home lifts every deny under it, the office's home included; the fence stays.
  const all = codexThread(permission({ folders: [{ path: home, access: "read" }] }), "opencorp-s1").config
    .permissions as Record<string, { filesystem: Record<string, string> }>
  const denied = Object.entries(all["opencorp-s1"]!.filesystem).filter(([, access]) => access === "deny")
  expect(denied).toEqual([[permission().fence, "deny"]])
  const wide = claudeStart(permission({ folders: [{ path: home, access: "read" }] })).settings.sandbox as {
    filesystem: Record<string, string[]>
  }
  expect(wide.filesystem.denyRead).toEqual([])
})

test("a worktree's .git file is kept read-only whole, and a kept path that is a link is left out", () => {
  const { root, ws, permission } = layout()
  fs.rmSync(path.join(ws, ".git"), { recursive: true })
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${root}/main/.git/worktrees/ws\n`)
  // Both harnesses' Linux sandboxes bind a read-only path onto itself, so a link would mount its target.
  fs.symlinkSync(path.join(root, "home/.ssh"), path.join(ws, ".claude"))
  const { config } = codexThread(permission(), "opencorp-s1")
  const filesystem = (config.permissions as Record<string, { filesystem: Record<string, string> }>)["opencorp-s1"]!
    .filesystem
  const kept = Object.keys(filesystem).filter((p) => p.startsWith(ws + "/"))
  expect(kept).toEqual([".git", ".codex", ".agents", ".mcp.json"].map((rel) => path.join(ws, rel)))
  const sandbox = claudeStart(permission()).settings.sandbox as { filesystem: { denyWrite: string[] } }
  expect(sandbox.filesystem.denyWrite).toEqual(kept)
  // With no .git at all, nothing of git is listed.
  fs.rmSync(path.join(ws, ".git"))
  const none = codexThread(permission(), "opencorp-s1").config.permissions as Record<
    string,
    { filesystem: Record<string, string> }
  >
  expect(Object.keys(none["opencorp-s1"]!.filesystem).filter((p) => p.includes(".git"))).toEqual([])
})

test("a read-only listed folder gets Claude Code's write deny and edit deny; a writable one gets neither", () => {
  const { ws, permission, folder } = layout()
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
    `Edit(/${cargo}/**)`,
    ...kept.deny,
    "WebFetch",
    "WebSearch",
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
  expect(claudeStart(p).env.PATH).toBe(harnessPath(p))
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

test("Claude Code's start turns its sandbox on, fails if it can't start, allows no unsandboxed command, reads only the folder in the home, and turns auto memory off", () => {
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
        deny: [...kept.deny, "WebFetch", "WebSearch"],
      },
      disableAllHooks: true,
    },
    addDirs: [],
    env: {
      PATH: SYSTEM.join(":"),
      TMPDIR: tmp,
      CLAUDE_CODE_TMPDIR: tmp,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  })
  // With the network on, commands may reach any host and the web tools aren't denied.
  const online = claudeStart(permission({ network: true })).settings
  expect((online.sandbox as { network: unknown }).network).toEqual({ allowedDomains: ["*"], strictAllowlist: true })
  expect((online.permissions as { deny: string[] }).deny).toEqual(kept.deny)
})

test("the override is nested objects with no dotted key, and its paths are resolved", () => {
  const { root, ws, tmp, fence, permission } = layout()
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
  const { config } = codexThread(p, "opencorp-s1")
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
  expect(() => codexThread(permission(), ":workspace")).toThrow()
})

test("a workspace that would expose the home, a credential folder or the office is refused", () => {
  const { root, home, officeHome, permission } = layout()
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
    expect(() => codexThread(p, "opencorp-s1")).toThrow(UnsafeWorkspace)
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

/** The `codex` a test runs, named by `OPENCORP_TEST_CODEX`; unset, the real-Codex tests skip, so no run finds the
 *  owner's own Codex by chance. Codex's sandbox needs what the office's does, so they also skip where that can't
 *  start (and fail under `OPENCORP_TEST_SANDBOX`). */
const CODEX = process.env.OPENCORP_TEST_CODEX
const NO_CODEX = CODEX === undefined || !sandboxAvailable()
/** The oldest Codex whose sandbox takes a per-thread permission profile in these tests' form. */
const CODEX_FLOOR = [0, 167, 0]

/** `value` as a TOML value on one line: tables inline, keys quoted. */
function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`
  const entries = Object.entries(value as Record<string, unknown>)
  return `{ ${entries.map(([key, v]) => `${JSON.stringify(key)} = ${toml(v)}`).join(", ")} }`
}

/** Runs `script` with `sh` under Codex's own sandbox, given the employee's override as `-c` flags, with only a temp
 *  home, a scratch CODEX_HOME and the harness PATH in its environment. */
function codexSandbox(p: EmployeePermission, codexHome: string, script: string) {
  const version = spawnSync(CODEX!, ["--version"], { encoding: "utf8", timeout: 30_000, env: { PATH: harnessPath(p) } })
  const found = (version.stdout.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  const first = found.findIndex((n, i) => n !== CODEX_FLOOR[i])
  if (found.length !== 3 || (first >= 0 && found[first]! < CODEX_FLOOR[first]!)) {
    throw new Error(`OPENCORP_TEST_CODEX is ${version.stdout.trim() || version.stderr.trim()}; need 0.167.0 or later`)
  }
  const { permissions, config } = codexThread(p, "opencorp-t")
  const flags = Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])
  return spawnSync(CODEX!, ["sandbox", "-P", permissions, "-C", p.workspace, ...flags, "--", "sh", "-c", script], {
    cwd: p.workspace,
    env: { HOME: p.home, CODEX_HOME: codexHome, PATH: harnessPath(p), TMPDIR: p.tmpdir },
    encoding: "utf8",
    timeout: 60_000,
  })
}

test.skipIf(NO_CODEX)(
  "under the override, Codex's sandbox runs sh, git and cc in the folder, and can't read the office's home, ~/.ssh or ~/.codex, or write outside the folder",
  () => {
    const { root, home, ws, permission } = layout()
    fs.rmSync(path.join(ws, ".git"), { recursive: true })
    expect(spawnSync("git", ["init", "-q", ws], { env: { PATH: "/usr/bin:/bin", HOME: home } }).status).toBe(0)
    const codexHome = path.join(root, "codex")
    fs.mkdirSync(codexHome)
    const cc = fs.existsSync("/usr/bin/cc")
    const script = [
      "echo hi > ok.txt && cat ok.txt",
      "git rev-parse --is-inside-work-tree && echo git-ok",
      cc ? "printf 'int main(void){return 0;}\\n' > t.c && cc t.c -o t && ./t && echo cc-ok" : "true",
      `cat ${home}/.ssh/id_test`,
      `cat ${home}/.codex/auth.json`,
      `ls ${home}/.opencorp/office && echo LEAK-office`,
      `echo x > ${root}/outside.txt && echo LEAK-write`,
      `echo x > ${home}/escape.txt && echo LEAK-home`,
    ].join("\n")
    const result = codexSandbox(permission(), codexHome, script)
    const output = result.stdout + result.stderr
    expect(result.error, output).toBeUndefined()
    expect(result.stdout, output).toContain("hi\n")
    expect(result.stdout, output).toContain("git-ok")
    if (cc) expect(result.stdout, output).toContain("cc-ok")
    expect(output).not.toContain("decoy")
    expect(output).not.toContain("LEAK")
    expect(fs.existsSync(path.join(root, "outside.txt"))).toBe(false)
    expect(fs.existsSync(path.join(home, "escape.txt"))).toBe(false)
    expect(fs.readFileSync(path.join(ws, "ok.txt"), "utf8")).toBe("hi\n")
  },
)

test.skipIf(NO_CODEX)("an allow rule in the scratch CODEX_HOME's rules still runs its command sandboxed", () => {
  // `codex sandbox` always sandboxes; what lets an agent's allowed command stay sandboxed is the deny entry the
  // profile keeps, so this checks the fence is denied with the rule in place.
  const { root, home, fence, permission } = layout()
  fs.writeFileSync(fence, "decoy-fence")
  const codexHome = path.join(root, "codex")
  fs.mkdirSync(path.join(codexHome, "rules"), { recursive: true })
  fs.writeFileSync(path.join(codexHome, "rules/default.rules"), 'prefix_rule(pattern = ["cat"], decision = "allow")\n')
  const result = codexSandbox(permission(), codexHome, `cat ${fence}; cat ${home}/.ssh/id_test; echo done`)
  const output = result.stdout + result.stderr
  expect(result.stdout, output).toContain("done")
  expect(output).not.toContain("decoy")
})

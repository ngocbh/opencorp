/** An employee's permission for their harness, from their person: the folder's access, the network, the folders
 *  their `harness_policy` lists and the MCP servers it allows, as both harnesses take them. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { loadRepo } from "../../../src/company/loader.ts"
import { type Others, employeePermission } from "../../../src/runtime/sessions/permission.ts"
import { claudeStart, codexThread, harnessPath } from "../../../src/runtime/sandbox/harness_profile.ts"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { makeCompany, person } from "../../company/helpers.ts"
import { tempDir } from "../../helpers.ts"

/** A temp layout, all resolved: a home with `.ssh/id_test`, `.cargo/bin`, `miniconda3/envs/ml/bin` and an office
 *  `.opencorp`; a shared `<root>/data/shared`; a workspace `<root>/ws` holding `.git`; a private temp folder, the
 *  fence and a Codex install. `permission` builds `minh`'s permission (or `handle`'s) from `people`, a company's
 *  person files by handle, with `others`, and `notes` gets what it notes. */
function layout() {
  const root = fs.realpathSync(tempDir())
  const home = path.join(root, "home")
  const officeHome = path.join(home, ".opencorp")
  const ws = path.join(root, "ws")
  const tmp = path.join(root, "tmp")
  const fence = path.join(root, "fence")
  const install = path.join(root, "codex-install")
  const cargo = path.join(home, ".cargo")
  const ml = path.join(home, "miniconda3/envs/ml")
  const shared = path.join(root, "data/shared")
  for (const dir of [path.join(cargo, "bin"), path.join(ml, "bin"), shared, path.join(home, ".ssh"), officeHome]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // Only the user may write the bin folders, whatever the umask, so a read-only one goes on PATH.
  for (const dir of [home, cargo, path.join(cargo, "bin"), ml, path.join(ml, "bin")]) fs.chmodSync(dir, 0o755)
  fs.writeFileSync(path.join(home, ".ssh/id_test"), "decoy-ssh-key")
  fs.mkdirSync(path.join(install, "bin"), { recursive: true })
  fs.writeFileSync(path.join(install, "bin/codex"), "")
  // Only the user may change Codex's install, whatever the umask.
  for (const p of [install, path.join(install, "bin"), path.join(install, "bin/codex")]) fs.chmodSync(p, 0o755)
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true })
  fs.mkdirSync(tmp, { mode: 0o700 })
  fs.chmodSync(tmp, 0o700)
  fs.writeFileSync(fence, "")
  const notes: string[] = []
  const permission = (people: Record<string, unknown>, handle = "minh", others: Others = {}) =>
    employeePermission(
      company(people),
      { person: handle, cwd: ws },
      { gitRoot: ws, tmpdir: tmp, fence },
      { home, officeHome, guards: { home } },
      (line) => notes.push(line),
      others,
    )
  return { root, home, officeHome, ws, tmp, fence, install, cargo, ml, shared, notes, permission }
}

/** A loaded company with `people`, person files by handle. */
function company(people: Record<string, unknown>) {
  const files = Object.fromEntries(Object.entries(people).map(([h, file]) => [`people/${h}/person.yaml`, file]))
  return loadRepo(makeCompany(files))
}

/** minh's person file with `harness_policy` set to `policy`. */
function minh(policy: Record<string, unknown> | null): Record<string, unknown> {
  return person("minh", { harness_policy: policy })
}

test("the employee's harness gets the person's folders as listed", () => {
  const { home, officeHome, ws, tmp, fence, install, cargo, ml, shared, notes, permission } = layout()
  const folders = [
    { path: "~/.cargo", access: "read" },
    { path: "~/miniconda3/envs/ml", access: "write" },
    { path: shared, access: "write" },
    // A credential folder is mounted as listed too: nothing is refused for what it holds.
    { path: "~/.ssh", access: "read" },
  ]
  const p = permission({ minh: minh({ sandbox: "workspace-write", network: false, folders }) })
  const listed: { path: string; access: "read" | "write" }[] = [
    { path: cargo, access: "read" },
    { path: ml, access: "write" },
    { path: shared, access: "write" },
    { path: path.join(home, ".ssh"), access: "read" },
  ]
  expect(p).toEqual({
    workspace: ws,
    gitRoot: ws,
    tmpdir: tmp,
    fence,
    writable: true,
    network: false,
    folders: listed,
    home,
    officeHome,
    office: { home },
    othersWritable: [],
    allowedMcp: [],
  })
  expect(notes).toEqual([])
  // Codex mounts each with its access, and lifts the deny-by-name of the credential folder it covers, never the fence.
  const filesystem = (codexThread(p, "opencorp-s1", { install }).config.permissions as any)["opencorp-s1"].filesystem
  for (const folder of listed) expect(filesystem[folder.path]).toBe(folder.access)
  expect(filesystem[fence]).toBe("deny")
  expect(filesystem[officeHome]).toBe("deny")
  // Claude Code adds each (and its temp folder), writes the writable ones only, and denies writes to the read-only ones.
  const claude = claudeStart(p)
  const fsSettings = (claude.settings.sandbox as any).filesystem
  expect(claude.addDirs).toEqual([...listed.map((folder) => folder.path), tmp])
  expect(fsSettings.allowWrite).toEqual([ws, tmp, ml, shared])
  expect(fsSettings.denyWrite).toEqual(expect.arrayContaining([cargo, path.join(home, ".ssh")]))
  expect(fsSettings.denyWrite).not.toContain(ml)
  // A read-only folder's bin joins the harness PATH; a writable one's never does.
  expect(harnessPath(p).split(":")).toContain(path.join(cargo, "bin"))
  expect(harnessPath(p).split(":")).not.toContain(path.join(ml, "bin"))
})

test("a listed folder that doesn't exist is noted and mounts nothing", () => {
  const { root, cargo, install, notes, permission } = layout()
  const file = path.join(root, "a-file")
  fs.writeFileSync(file, "")
  const folders = [
    { path: "~/gone", access: "read" },
    { path: file, access: "write" },
    { path: path.join(file, "below"), access: "read" },
    { path: "~/.cargo", access: "read" },
  ]
  const p = permission({ minh: minh({ folders }) })
  expect(p.folders).toEqual([{ path: cargo, access: "read" }])
  expect(notes).toEqual([
    `@minh's listed folder "~/gone" isn't there, so their harness mounts nothing for it`,
    `@minh's listed folder ${JSON.stringify(file)} isn't a folder, so their harness mounts nothing for it`,
    `@minh's listed folder ${JSON.stringify(path.join(file, "below"))} isn't there, so their harness mounts nothing`
      + " for it",
  ])
  const filesystem = (codexThread(p, "opencorp-s1", { install }).config.permissions as any)["opencorp-s1"].filesystem
  expect(Object.keys(filesystem).filter((entry) => entry.startsWith(root + "/a-file") || entry.endsWith("/gone")))
    .toEqual([])
})

test("another person's writable folders, at the session's commit or at head, and live sessions' folders stay off this one's harness PATH", () => {
  const { cargo, ml, shared, permission } = layout()
  const ann = person("minh", {
    handle: "ann",
    name: "Ann",
    harness_policy: { folders: [{ path: "~/.cargo", access: "write" }, { path: "rel/tools", access: "write" }] },
  })
  const listing = minh({
    folders: [
      { path: "~/.cargo", access: "read" },
      { path: "~/miniconda3/envs/ml", access: "read" },
    ],
  })
  const p = permission({ minh: listing, ann })
  expect(p.folders).toEqual([
    { path: cargo, access: "read" },
    { path: ml, access: "read" },
  ])
  // A path that isn't absolute names no folder anyone can write.
  expect(p.othersWritable).toEqual([cargo])
  expect(harnessPath(p).split(":")).not.toContain(path.join(cargo, "bin"))
  expect(harnessPath(p).split(":")).toContain(path.join(ml, "bin"))
  // At head minh's own listing may have changed too: a session of theirs started since may write it.
  const head = company({ minh: minh({ folders: [{ path: "~/miniconda3/envs/ml", access: "write" }] }) })
  const later = permission({ minh: listing, ann }, "minh", { repos: [head], workspaces: [shared] })
  expect(later.othersWritable).toEqual([cargo, ml, shared])
  expect(harnessPath(later).split(":")).not.toContain(path.join(ml, "bin"))
})

test("the employee's harness may use the MCP servers their person allows, each plain name once; another person's don't count", () => {
  const { install, permission } = layout()
  const ann = person("minh", { handle: "ann", name: "Ann", harness_policy: { mcp_servers: ["docs"] } })
  const mcp_servers = ["github", "a.b", "my server", "linear", "github"]
  const p = permission({ minh: minh({ mcp_servers }), ann })
  // A name that isn't plain allows nothing, as lint says.
  expect(p.allowedMcp).toEqual(["github", "linear"])
  const defined = ["github", "a.b", "my server", "docs", "linear"]
  expect(codexThread(p, "opencorp-s1", { install, mcpServers: defined }).config.mcp_servers).toEqual({
    "a.b": { enabled: false },
    "my server": { enabled: false },
    docs: { enabled: false },
  })
  expect(permission({ minh: minh(null) }).allowedMcp).toEqual([])
})

test("a server revoked at head isn't allowed, whatever the session's commit allows, nor one granted only at head", () => {
  const { permission } = layout()
  const pinned = { minh: minh({ mcp_servers: ["github", "linear", "docs"] }) }
  const head = company({ minh: minh({ mcp_servers: ["linear", "web", "github"] }) })
  // The order is the session's commit's.
  expect(permission(pinned, "minh", { repos: [head] }).allowedMcp).toEqual(["github", "linear"])
  // minh gone at head, or with no policy there: nothing.
  expect(permission(pinned, "minh", { repos: [company({ minh: null })] }).allowedMcp).toEqual([])
  expect(permission(pinned, "minh", { repos: [company({ minh: minh(null) })] }).allowedMcp).toEqual([])
})

test("with no harness policy the folder is read-only and offline, and a path that isn't absolute is refused at start", () => {
  const { ws, install, permission } = layout()
  const bare = permission({ minh: minh(null) })
  expect([bare.writable, bare.network, bare.folders, bare.allowedMcp]).toEqual([false, false, [], []])
  expect(codexThread(bare, "opencorp-s1", { install }).config.projects).toEqual({
    [ws]: { trust_level: "untrusted" },
  })
  // Lint reports each as an error; the harness won't start on it rather than mount something else.
  for (const wrong of ["envs/ml", "/data/a\0b"]) {
    const p = permission({ minh: minh({ sandbox: "workspace-write", folders: [{ path: wrong, access: "write" }] }) })
    expect(p.folders).toEqual([{ path: wrong, access: "write" }])
    expect(() => codexThread(p, "opencorp-s1", { install }), wrong).toThrow(UnsafeProfile)
  }
})

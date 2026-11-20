/** An employee's permission for their harness, from their person: the folder's access, the network and the folders
 *  their `harness_policy` lists, as both harnesses take them. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { loadRepo } from "../../../src/company/loader.ts"
import { employeePermission } from "../../../src/features/codex/permission.ts"
import { claudeStart, codexThread, harnessPath } from "../../../src/runtime/sandbox/harness_profile.ts"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { makeCompany, person } from "../../company/helpers.ts"
import { tempDir } from "../../helpers.ts"

/** A temp layout, all resolved: a home with `.ssh/id_test`, `.cargo/bin`, `miniconda3/envs/ml/bin` and an office
 *  `.opencorp`; a shared `<root>/data/shared`; a workspace `<root>/ws` holding `.git`; a private temp folder, the
 *  fence and a Codex install. `permission` builds `minh`'s permission (or `handle`'s) from `people`, a company's
 *  person files by handle, and `notes` gets what it notes. */
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
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true })
  fs.mkdirSync(tmp, { mode: 0o700 })
  fs.chmodSync(tmp, 0o700)
  fs.writeFileSync(fence, "")
  const notes: string[] = []
  const permission = (people: Record<string, unknown>, handle = "minh") => {
    const files = Object.fromEntries(Object.entries(people).map(([h, file]) => [`people/${h}/person.yaml`, file]))
    const repo = loadRepo(makeCompany(files))
    return employeePermission(
      repo,
      { person: handle, cwd: ws },
      { gitRoot: ws, tmpdir: tmp, fence },
      { home, officeHome, guards: { home } },
      (line) => notes.push(line),
    )
  }
  return { root, home, officeHome, ws, tmp, fence, install, cargo, ml, shared, notes, permission }
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
  })
  expect(notes).toEqual([])
  // Codex mounts each with its access, and lifts the deny-by-name of the credential folder it covers, never the fence.
  const filesystem = (codexThread(p, "opencorp-s1", { install }).config.permissions as any)["opencorp-s1"].filesystem
  for (const folder of listed) expect(filesystem[folder.path]).toBe(folder.access)
  expect(filesystem[fence]).toBe("deny")
  expect(filesystem[officeHome]).toBe("deny")
  // Claude Code adds each, writes the writable ones only, and denies writes to the read-only ones.
  const claude = claudeStart(p)
  const fsSettings = (claude.settings.sandbox as any).filesystem
  expect(claude.addDirs).toEqual(listed.map((folder) => folder.path))
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
    `@minh's listed folder ${JSON.stringify(path.join(file, "below"))} isn't there, so their harness mounts nothing for it`,
  ])
  const filesystem = (codexThread(p, "opencorp-s1", { install }).config.permissions as any)["opencorp-s1"].filesystem
  expect(Object.keys(filesystem).filter((entry) => entry.startsWith(root + "/a-file") || entry.endsWith("/gone")))
    .toEqual([])
})

test("another person's writable folders stay off this one's harness PATH", () => {
  const { cargo, permission } = layout()
  const ann = person("minh", {
    handle: "ann",
    name: "Ann",
    harness_policy: { folders: [{ path: "~/.cargo", access: "write" }, { path: "rel/tools", access: "write" }] },
  })
  const p = permission({ minh: minh({ folders: [{ path: "~/.cargo", access: "read" }] }), ann })
  expect(p.folders).toEqual([{ path: cargo, access: "read" }])
  // A path that isn't absolute names no folder anyone can write.
  expect(p.othersWritable).toEqual([cargo])
  expect(harnessPath(p).split(":")).not.toContain(path.join(cargo, "bin"))
})

test("with no harness policy the folder is read-only and offline, and a path that isn't absolute is refused at start", () => {
  const { ws, install, permission } = layout()
  const bare = permission({ minh: minh(null) })
  expect([bare.writable, bare.network, bare.folders]).toEqual([false, false, []])
  expect(codexThread(bare, "opencorp-s1", { install }).config.projects).toEqual({
    [ws]: { trust_level: "untrusted" },
  })
  // Lint reports it as an error; the harness won't start on it rather than mount something else.
  const relative = permission({ minh: minh({ sandbox: "workspace-write", folders: [{ path: "envs/ml", access: "write" }] }) })
  expect(relative.folders).toEqual([{ path: "envs/ml", access: "write" }])
  expect(() => codexThread(relative, "opencorp-s1", { install })).toThrow(UnsafeProfile)
})

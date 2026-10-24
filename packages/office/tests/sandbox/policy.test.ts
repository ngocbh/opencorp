/** What one sandboxed call may touch: the policy and its workspace checks. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { checkWorkspace, type OfficePaths, SandboxPolicy, UnsafeWorkspace } from "../../src/sandbox/policy.ts"
import { makePolicy } from "./helpers.ts"

/** A read-only, offline policy over `workspace`. */
function policyAt(workspace: string, tmpdir: string, office?: OfficePaths): SandboxPolicy {
  return new SandboxPolicy({ workspace, writable: false, network: false, tmpdir, office })
}

/** Makes the folders `dirs` (with their parents) and returns them. */
function mkdirs(...dirs: string[]): string[] {
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true })
  return dirs
}

test("paths are resolved", () => {
  const { root, ws, tmp } = makePolicy()
  const link = path.join(root, "link")
  fs.symlinkSync(ws, link)
  const policy = new SandboxPolicy({ workspace: link, writable: true, network: false, tmpdir: tmp })
  expect(policy.workspace).toBe(fs.realpathSync(ws))
  expect(policy.tmpdir).toBe(fs.realpathSync(tmp))
  // A backslash is part of a name, not a separator.
  const [backslash] = mkdirs(path.join(root, "a\\b"), path.join(root, "a/b"))
  const named = new SandboxPolicy({ workspace: backslash!, writable: true, network: false, tmpdir: tmp })
  expect(named.workspace).toBe(path.join(fs.realpathSync(root), "a\\b"))
})

test("read only paths are resolved tuples", () => {
  const { root, make } = makePolicy()
  expect(make({ readOnly: [root] }).readOnly).toEqual([fs.realpathSync(root)])
})

test("workspace must exist", () => {
  const { root, tmp } = makePolicy()
  expect(() => policyAt(path.join(root, "missing"), tmp)).toThrow(/workspace/)
  // A path through a file, or a symlink loop, is no directory either.
  const file = path.join(root, "file")
  fs.writeFileSync(file, "")
  const loop = path.join(root, "loop")
  fs.symlinkSync(loop, loop)
  for (const ws of [path.join(file, "sub"), loop]) {
    expect(() => policyAt(ws, tmp)).toThrow(/is not an existing directory/)
    expect(() => policyAt(ws, tmp)).toThrow(/workspace/)
  }
})

test("tmpdir must exist", () => {
  const { root, ws } = makePolicy()
  expect(() => policyAt(ws, path.join(root, "missing"))).toThrow(/tmpdir/)
})

test("root is not a workspace", () => {
  const { tmp } = makePolicy()
  expect(() => policyAt("/", tmp)).toThrow(UnsafeWorkspace)
})

test("home and its ancestors are not workspaces", () => {
  const { root, tmp } = makePolicy()
  const [home] = mkdirs(path.join(root, "home"))
  for (const ws of [home, root]) expect(() => policyAt(ws, tmp, { home })).toThrow(UnsafeWorkspace)
  const [project] = mkdirs(path.join(home, "project"))
  expect(path.basename(policyAt(project, tmp, { home }).workspace)).toBe("project")
  // With no office paths given, the home is the user's.
  expect(() => checkWorkspace(os.homedir())).toThrow(UnsafeWorkspace)
})

test("sensitive home paths are not workspaces", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  for (const rel of [
    ".opencorp",
    ".opencorp/office/runs",
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/yian",
    "Library/Keychains",
    ".claude",
    ".codex",
    ".docker",
    ".kube",
    ".netrc",
  ]) {
    const [ws] = mkdirs(path.join(home, rel))
    expect(() => policyAt(ws, tmp, { home })).toThrow(UnsafeWorkspace)
    expect(() => policyAt(ws, tmp, { home })).toThrow(/sensitive/)
  }
})

test("sensitive paths are compared resolved", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  mkdirs(path.join(home, ".ssh"))
  const link = path.join(root, "innocent")
  fs.symlinkSync(path.join(home, ".ssh"), link)
  const homeLink = path.join(root, "home-link")
  fs.symlinkSync(home, homeLink)
  expect(() => policyAt(link, tmp, { home: homeLink })).toThrow(UnsafeWorkspace)
  // `..` after a link goes to the parent of the link's target, as the OS resolves it.
  mkdirs(path.join(home, ".ssh/keys"), path.join(root, "x"))
  fs.symlinkSync(path.join(home, ".ssh/keys"), path.join(root, "x/link"))
  expect(() => policyAt(`${root}/x/link/..`, tmp, { home })).toThrow(/sensitive/)
  // A backslash is part of a link's name, not a separator.
  const [folder] = mkdirs(path.join(root, "bs"), path.join(root, "bs/a"), path.join(root, "bs/b"))
  fs.symlinkSync(path.join(home, ".ssh"), path.join(folder!, "a\\..\\b"))
  expect(() => policyAt(path.join(folder!, "a\\..\\b"), tmp, { home })).toThrow(/sensitive/)
  // On a case-insensitive volume a sensitive path spelled in another case is still refused.
  if (fs.existsSync(path.join(home, ".SSH"))) {
    mkdirs(path.join(home, ".ssh/x"))
    expect(() => policyAt(path.join(home, ".SSH/x"), tmp, { home })).toThrow(/sensitive/)
    // The existing part gets its on-disk case even when a later name has a backslash.
    mkdirs(path.join(home, ".ssh/a\\b"))
    expect(() => policyAt(path.join(home, ".SSH/a\\b"), tmp, { home })).toThrow(/sensitive/)
  }
  // Every link in a chain is followed, however long, so the chain cannot hide its end (the
  // backslash keeps a final realpath from finishing the chain instead).
  const [chain] = mkdirs(path.join(root, "chain\\dir"))
  for (let i = 0; i < 41; i++) fs.symlinkSync(`c${i + 1}`, path.join(chain!, `c${i}`))
  fs.symlinkSync(path.join(home, ".ssh"), path.join(chain!, "c41"))
  expect(() => checkWorkspace(path.join(chain!, "c0"), { home })).toThrow(
    `workspace ${path.join(home, ".ssh")} is inside the sensitive path ${path.join(home, ".ssh")}; use a project folder`,
  )
  // Names that merely start like a sensitive path are fine.
  const [mounts] = mkdirs(path.join(home, ".sshfs-mounts"))
  expect(path.basename(policyAt(mounts, tmp, { home: homeLink }).workspace)).toBe(".sshfs-mounts")
})

test("protected paths", () => {
  const { make } = makePolicy()
  const policy = make()
  const git = path.join(policy.workspace, ".git")
  expect(policy.protectedPaths).toEqual([git, path.join(git, "hooks"), path.join(git, "config")])
})

test("a workspace that contains the office install is refused", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [app, install] = mkdirs(path.join(root, "app"), path.join(root, "app/install"))
  for (const ws of [app, install]) {
    expect(() => policyAt(ws, tmp, { home, install: [install] })).toThrow(UnsafeWorkspace)
    expect(() => policyAt(ws, tmp, { home, install: [install] })).toThrow(
      `workspace ${ws} contains the office install at ${install}; use a project folder`,
    )
  }
})

test("a workspace inside the office install is refused", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const install = path.join(root, "install")
  const [ws] = mkdirs(path.join(install, "lib/sub"))
  expect(() => policyAt(ws, tmp, { home, install: [install] })).toThrow(UnsafeWorkspace)
  expect(() => policyAt(ws, tmp, { home, install: [install] })).toThrow(
    `workspace ${ws} is inside the office install at ${install}; use a project folder`,
  )
})

test("a workspace that contains a program the office runs is refused", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [opt, bin] = mkdirs(path.join(root, "opt"), path.join(root, "opt/bin"))
  const git = path.join(bin, "git")
  fs.writeFileSync(git, "")
  for (const ws of [opt, bin]) {
    expect(() => policyAt(ws, tmp, { home, tools: [git] })).toThrow(UnsafeWorkspace)
    expect(() => policyAt(ws, tmp, { home, tools: [git] })).toThrow(
      `workspace ${ws} contains ${git}, a program the office runs; use a project folder`,
    )
  }
})

test("a workspace that contains a folder on the office PATH is refused", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [p, pBin, q] = mkdirs(path.join(root, "p"), path.join(root, "p/bin"), path.join(root, "q"))
  // A missing entry still counts: the folder may appear later.
  const missing = path.join(q, "missing-bin")
  const office = { home, path: [pBin, missing] }
  for (const [ws, entry] of [
    [p, pBin],
    [pBin, pBin],
    [q, missing],
  ] as const) {
    expect(() => policyAt(ws, tmp, office)).toThrow(UnsafeWorkspace)
    expect(() => policyAt(ws, tmp, office)).toThrow(
      `workspace ${ws} contains ${entry}, a folder on the office's PATH; use a project folder`,
    )
  }
})

test("a relative office path refuses every workspace", () => {
  const { root, ws, make } = makePolicy()
  const home = path.join(root, "home")
  const cases: [OfficePaths, string][] = [
    [{ home, path: [""] }, `the office's PATH has a relative entry ""`],
    [{ home, path: ["."] }, `the office's PATH has a relative entry "."`],
    [{ home, path: ["/usr/bin", "bin"] }, `the office's PATH has a relative entry "bin"`],
    [{ home, install: ["rel/install"] }, `the office's install has a relative entry "rel/install"`],
    [{ home, tools: ["git"] }, `the office's tool list has a relative entry "git"`],
  ]
  for (const [office, entry] of cases) {
    expect(() => make({ office })).toThrow(UnsafeWorkspace)
    expect(() => make({ office })).toThrow(`workspace ${ws} is refused: ${entry}; use absolute paths`)
  }
})

test("office paths are compared resolved", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [realApp, realInstall, realBin, realPath, target] = mkdirs(
    path.join(root, "real-app"),
    path.join(root, "real-app/install"),
    path.join(root, "real-bin"),
    path.join(root, "real-path"),
    path.join(root, "target"),
  )
  fs.writeFileSync(path.join(realBin, "git"), "")
  const link = (to: string, name: string) => {
    fs.symlinkSync(to, path.join(root, name))
    return path.join(root, name)
  }
  const install = link(realInstall, "install-link")
  const binLink = link(realBin, "bin-link")
  const pathLink = link(mkdirs(path.join(realPath, "bin"))[0]!, "path-link")
  // A dangling link resolves to its target, which may appear later.
  const dangling = link(path.join(target, "bin"), "dangling")
  // A link to itself through a linked folder: past the link limit its folder is still resolved.
  const [loopWs] = mkdirs(path.join(root, "loop-ws"))
  const loopLink = link(loopWs, "loop-link")
  fs.symlinkSync(path.join(loopLink, "a"), path.join(loopWs, "a"))
  // `..` after a link goes to the parent of the link's target: <other>/l/../bin is <dots-ws>/bin.
  const [dotsWs, dotsBin, other] = mkdirs(
    path.join(root, "dots-ws"),
    path.join(root, "dots-ws/bin"),
    path.join(root, "other"),
  )
  fs.symlinkSync(dotsBin!, path.join(other!, "l"))
  const tool = (ws: string, name: string) =>
    `workspace ${ws} contains ${path.join(ws, name)}, a program the office runs; use a project folder`
  const onPath = (ws: string, name: string) =>
    `workspace ${ws} contains ${path.join(ws, name)}, a folder on the office's PATH; use a project folder`
  const cases: [string, OfficePaths, string][] = [
    [
      realApp,
      { install: [install] },
      `workspace ${realApp} contains the office install at ${realInstall}; use a project folder`,
    ],
    [realBin, { tools: [path.join(binLink, "git")] }, tool(realBin, "git")],
    [realBin, { tools: [path.join(binLink, "missing-tool")] }, tool(realBin, "missing-tool")],
    [realPath, { path: [pathLink] }, onPath(realPath, "bin")],
    [target, { path: [dangling] }, onPath(target, "bin")],
    [loopWs, { path: [path.join(loopLink, "a")] }, onPath(loopWs, "a")],
    [dotsWs!, { tools: [`${other}/l/../bin/git`] }, tool(dotsWs!, "bin/git")],
    [dotsWs!, { path: [`${other}/l/../bin`] }, onPath(dotsWs!, "bin")],
  ]
  // On a case-insensitive volume, entries that don't exist yet still get the on-disk case of their folder.
  const [caseWs] = mkdirs(path.join(root, "ws"))
  if (fs.existsSync(path.join(root, "WS"))) {
    cases.push(
      [caseWs!, { path: [path.join(root, "WS/bin")] }, onPath(caseWs!, "bin")],
      [caseWs!, { tools: [path.join(root, "WS/bin/git")] }, tool(caseWs!, "bin/git")],
    )
  }
  for (const [ws, office, message] of cases) {
    expect(() => policyAt(ws, tmp, { home, ...office })).toThrow(UnsafeWorkspace)
    expect(() => policyAt(ws, tmp, { home, ...office })).toThrow(message)
  }
  // A link target that isn't UTF-8 can't be resolved exactly, so the check fails rather than guess.
  if (process.platform === "linux") {
    const badLink = path.join(root, "bad-target")
    fs.symlinkSync(Buffer.from([0xff, 0x2f, 0x2e, 0x2e]), badLink)
    expect(() => checkWorkspace(caseWs!, { home, path: [badLink] })).toThrow(badLink)
  }
})

test("a folder beside the office paths is fine", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [install, toolBin, pathBin] = mkdirs(
    path.join(root, "app/install"),
    path.join(root, "tools/bin"),
    path.join(root, "p/bin"),
  )
  const office = { home, install: [install], tools: [path.join(toolBin, "git")], path: [pathBin] }
  for (const ws of mkdirs(
    path.join(root, "app/sibling"),
    path.join(root, "app/install-notes"),
    path.join(root, "tools/lib"),
    path.join(root, "tools/bin-old"),
    path.join(root, "p/bin-extra"),
  )) {
    expect(policyAt(ws, tmp, office).workspace).toBe(ws)
  }
})

test("the policy keeps the office and helper paths resolved", () => {
  const { root, make } = makePolicy()
  const [real] = mkdirs(path.join(root, "real"))
  for (const name of ["install", "path", "home"]) mkdirs(path.join(real, name))
  for (const name of ["git", "bun", "entry.ts", "opencorp"]) fs.writeFileSync(path.join(real, name), "")
  const link = path.join(root, "link")
  fs.symlinkSync(real, link)
  const office = {
    home: path.join(link, "home"),
    install: [path.join(link, "install")],
    tools: [path.join(link, "git")],
    path: [path.join(link, "path")],
  }
  const resolved = {
    home: path.join(real, "home"),
    install: [path.join(real, "install")],
    tools: [path.join(real, "git")],
    path: [path.join(real, "path")],
  }
  const checkout = make({ office, helper: { bun: path.join(link, "bun"), entry: path.join(link, "entry.ts") } })
  expect(checkout.office).toEqual(resolved)
  expect(checkout.helper).toEqual({ bun: path.join(real, "bun"), entry: path.join(real, "entry.ts") })
  const compiled = make({ office, helper: { binary: path.join(link, "opencorp") } })
  expect(compiled.helper).toEqual({ binary: path.join(real, "opencorp") })
  // Missing lists are empty, and the home defaults to the user's.
  expect(make().office).toEqual({ home: fs.realpathSync(os.homedir()), install: [], tools: [], path: [] })
  expect(make().helper).toBeUndefined()
})

test("a policy rebuilt with a helper keeps its office paths and checks", () => {
  const { root, ws, make } = makePolicy()
  const [real] = mkdirs(path.join(root, "real"))
  fs.writeFileSync(path.join(real, "opencorp"), "")
  const link = path.join(root, "link")
  fs.symlinkSync(real, link)
  const policy = make({ office: { home: path.join(root, "home"), install: [path.join(link, "install")] } })
  const rebuilt = new SandboxPolicy({ ...policy, helper: { binary: path.join(link, "opencorp") } })
  expect(rebuilt.office).toEqual(policy.office)
  expect(rebuilt.helper).toEqual({ binary: path.join(real, "opencorp") })
  expect(rebuilt.workspace).toBe(policy.workspace)

  const bad = { ...policy.office, tools: [path.join(ws, "tool")] }
  const helper = { binary: path.join(real, "opencorp") }
  expect(() => make({ office: bad })).toThrow(UnsafeWorkspace)
  expect(() => make({ office: bad, helper })).toThrow(UnsafeWorkspace)
  expect(() => new SandboxPolicy({ ...policy, office: bad })).toThrow(UnsafeWorkspace)
  expect(() => new SandboxPolicy({ ...policy, office: bad, helper })).toThrow(UnsafeWorkspace)
})

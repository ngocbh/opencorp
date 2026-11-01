/** What one sandboxed call may touch: the policy and its workspace checks. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { checkWorkspace, type OfficePaths, SandboxPolicy, UnsafeWorkspace } from "../../src/sandbox/policy.ts"
import { makePolicy } from "./helpers.ts"

/** A read-only, offline policy over `workspace`. */
function policyAt(workspace: string, tmpdir: string, office?: OfficePaths): SandboxPolicy {
  return new SandboxPolicy({ workspace, writable: false, network: false, tmpdir, office })
}

/** Checks that `checkWorkspace` and a policy over `ws` both refuse it with exactly `message`. */
function expectRefused(ws: string, tmp: string, office: OfficePaths, message: string): void {
  expect(() => checkWorkspace(ws, office)).toThrow(message)
  expect(() => policyAt(ws, tmp, office)).toThrow(UnsafeWorkspace)
  expect(() => policyAt(ws, tmp, office)).toThrow(message)
}

/** The arguments in `args` that occur more than once. */
function repeats(args: string[]): string[] {
  return [...new Set(args.filter((a, i) => args.indexOf(a) !== i))]
}

/** Spies on `fs.realpathSync`, `fs.lstatSync` and `fs.readlinkSync` until the test ends; returns the paths each
 *  was asked about. */
function spyLookups(): { realpath: () => string[]; lstat: () => string[]; readlink: () => string[] } {
  const spies = {
    realpath: spyOn(fs, "realpathSync"),
    lstat: spyOn(fs, "lstatSync"),
    readlink: spyOn(fs, "readlinkSync"),
  }
  onTestFinished(() => {
    for (const spy of Object.values(spies)) spy.mockRestore()
  })
  const args = (spy: { mock: { calls: unknown[][] } }) => () => spy.mock.calls.map((c) => String(c[0]))
  return { realpath: args(spies.realpath), lstat: args(spies.lstat), readlink: args(spies.readlink) }
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
      `workspace ${ws} contains ${install}, where the office or a program it runs is installed; use a project folder`,
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
    `workspace ${ws} is inside ${install}, where the office or a program it runs is installed; use a project folder`,
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
      `workspace ${realApp} contains ${realInstall}, where the office or a program it runs is installed; use a project folder`,
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

test("the policy keeps the install home and helper paths resolved and tools and path entries as given", () => {
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
    tools: [path.join(link, "git")],
    path: [path.join(link, "path")],
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

/** The refusal of a workspace containing `matched`, a program the office runs. */
const runs = (ws: string, matched: string) =>
  `workspace ${ws} contains ${matched}, a program the office runs; use a project folder`

/** The refusal of a workspace containing `matched`, a folder on the office's PATH. */
const onPath = (ws: string, matched: string) =>
  `workspace ${ws} contains ${matched}, a folder on the office's PATH; use a project folder`

test("a workspace holding a link to a tool elsewhere is refused", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [dir, elsewhere] = mkdirs(path.join(root, "dir"), path.join(root, "elsewhere"))
  fs.writeFileSync(path.join(elsewhere!, "git-2.47"), "")
  fs.symlinkSync(path.join(elsewhere!, "git-2.47"), path.join(dir!, "git"))
  expectRefused(dir!, tmp, { home, tools: [path.join(dir!, "git")] }, runs(dir!, path.join(dir!, "git")))
})

test("a workspace holding a linked folder on the way to a tool is refused", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [proj, toolBin] = mkdirs(path.join(root, "proj"), path.join(root, "tools/bin"))
  fs.writeFileSync(path.join(toolBin!, "git"), "")
  const binLink = path.join(proj!, "bin-link")
  fs.symlinkSync(toolBin!, binLink)
  expectRefused(proj!, tmp, { home, tools: [path.join(binLink, "git")] }, runs(proj!, binLink))
  expectRefused(proj!, tmp, { home, path: [binLink] }, onPath(proj!, binLink))
})

test("a workspace holding a link in a tools chain is refused", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [local, proj, elsewhere, x] = mkdirs(
    path.join(root, "local"),
    path.join(root, "proj"),
    path.join(root, "elsewhere"),
    path.join(root, "x"),
  )
  fs.writeFileSync(path.join(elsewhere!, "codex"), "")
  fs.symlinkSync(path.join(proj!, "link"), path.join(local!, "codex"))
  fs.symlinkSync(path.join(elsewhere!, "codex"), path.join(proj!, "link"))
  expectRefused(proj!, tmp, { home, tools: [path.join(local!, "codex")] }, runs(proj!, path.join(proj!, "link")))
  // `..` after a link walks from the link's target, yet the link itself is still on the way.
  mkdirs(path.join(elsewhere!, "sub"), path.join(elsewhere!, "bin"))
  fs.writeFileSync(path.join(elsewhere!, "bin/git"), "")
  fs.symlinkSync(path.join(elsewhere!, "sub"), path.join(proj!, "l"))
  expectRefused(proj!, tmp, { home, tools: [`${proj}/l/../bin/git`] }, runs(proj!, path.join(proj!, "l")))
  // A dangling link is on the way too: its target may appear later.
  fs.symlinkSync(path.join(root, "nowhere/git"), path.join(proj!, "gone"))
  expectRefused(proj!, tmp, { home, tools: [path.join(proj!, "gone")] }, runs(proj!, path.join(proj!, "gone")))
  // A linked folder above a PATH entry's last part.
  fs.symlinkSync(elsewhere!, path.join(x!, "lnk"))
  expectRefused(x!, tmp, { home, path: [path.join(x!, "lnk/bin")] }, onPath(x!, path.join(x!, "lnk")))
  // A plain folder entered and left with `..` is on the way too: it could be replaced by a link.
  const [sub] = mkdirs(path.join(proj!, "sub"))
  fs.writeFileSync(path.join(x!, "git"), "")
  expectRefused(proj!, tmp, { home, tools: [`${sub}/../../x/git`] }, runs(proj!, sub!))
  expectRefused(proj!, tmp, { home, path: [`${sub}/../../x`] }, onPath(proj!, sub!))
})

test("each refusal has a reason that names no path", () => {
  const { root } = makePolicy()
  const home = path.join(root, "home")
  const [ssh, opt, bin, install, pBin] = mkdirs(
    path.join(home, ".ssh"),
    path.join(root, "opt"),
    path.join(root, "opt/bin"),
    path.join(root, "install/lib"),
    path.join(root, "p/bin"),
  )
  const git = path.join(bin!, "git")
  fs.writeFileSync(git, "")
  const reasonOf = (ws: string, office: OfficePaths): string => {
    try {
      checkWorkspace(ws, office)
    } catch (error) {
      if (error instanceof UnsafeWorkspace) return error.reason
      throw error
    }
    throw new Error(`${ws} was not refused`)
  }
  const use = "; use a project folder"
  expect(reasonOf(root, { home })).toBe(`it contains the home directory${use}`)
  expect(reasonOf(ssh!, { home })).toBe(`it is inside a sensitive folder of the home directory${use}`)
  expect(reasonOf(opt!, { home, tools: [git] })).toBe(`it contains a program the office runs${use}`)
  const installed = "a folder where the office or a program it runs is installed"
  expect(reasonOf(path.dirname(install!), { home, install: [install!] })).toBe(`it contains ${installed}${use}`)
  expect(reasonOf(install!, { home, install: [path.dirname(install!)] })).toBe(`it is inside ${installed}${use}`)
  expect(reasonOf(path.dirname(pBin!), { home, path: [pBin!] })).toBe(`it contains a folder on the office's PATH${use}`)
  expect(reasonOf(opt!, { home, tools: ["git"] })).toBe(
    "the office's tool list has a relative entry; the office needs absolute paths",
  )
})

/** Office paths with tools, install and PATH entries deep under `root`, so their walks share long prefixes; each
 *  walk goes through the link `deep/l` to `deep/a`. */
function deepOffice(root: string): OfficePaths {
  mkdirs(path.join(root, "deep/a/b/c/bin1"), path.join(root, "deep/a/b/c/bin2"), path.join(root, "deep/a/b/c/lib"))
  for (const name of ["git", "tmux"]) fs.writeFileSync(path.join(root, "deep/a/b/c/bin1", name), "")
  fs.symlinkSync("a", path.join(root, "deep/l"))
  const c = path.join(root, "deep/l/b/c")
  return {
    home: path.join(root, "home"),
    tools: [path.join(c, "bin1/git"), path.join(c, "bin1/tmux")],
    install: [path.join(c, "lib")],
    path: [path.join(c, "bin1"), path.join(c, "bin2")],
  }
}

test("one check asks the OS about each path once", () => {
  const { root, ws } = makePolicy()
  const office = deepOffice(root)
  const spy = spyLookups()
  checkWorkspace(ws, office)
  expect(repeats(spy.realpath())).toEqual([])
  expect(repeats(spy.lstat())).toEqual([])
  expect(spy.readlink()).toHaveLength(1)
})

test("a policy build asks the OS about each path once", () => {
  const { root, ws, tmp } = makePolicy()
  const office = deepOffice(root)
  const spy = spyLookups()
  new SandboxPolicy({ workspace: ws, writable: false, network: false, tmpdir: tmp, readOnly: office.install, office })
  expect(repeats(spy.realpath())).toEqual([])
  expect(repeats(spy.lstat())).toEqual([])
  expect(spy.readlink()).toHaveLength(1)
})

test("each check looks at the disk again", () => {
  const { root, tmp } = makePolicy()
  const home = path.join(root, "home")
  const [proj, p] = mkdirs(path.join(root, "proj"), path.join(root, "p"))
  mkdirs(path.join(p!, "bin"), path.join(proj!, "bin"))
  const office = { home, path: [path.join(p!, "bin")] }
  checkWorkspace(proj!, office)
  // The PATH entry's folder becomes a link into the workspace after a check passed.
  fs.rmSync(p!, { recursive: true })
  fs.symlinkSync(proj!, p!)
  const message = onPath(proj!, path.join(proj!, "bin"))
  expect(() => checkWorkspace(proj!, office)).toThrow(message)
  expect(() => policyAt(proj!, tmp, office)).toThrow(message)
})

test("withHelper resolves only the helper and checks nothing again", () => {
  const { root, make } = makePolicy()
  const [real] = mkdirs(path.join(root, "real"))
  fs.writeFileSync(path.join(real!, "opencorp"), "")
  const link = path.join(root, "link")
  fs.symlinkSync(real!, link)
  // An absent PATH entry: the check is the only thing that looks it up.
  const marker = path.join(root, "marker-bin")
  const office = { home: path.join(root, "home"), install: [path.join(link, "install")], path: [marker] }
  const policy = make({ office })
  const helper = { binary: path.join(link, "opencorp") }
  const lstat = spyOn(fs, "lstatSync")
  onTestFinished(() => lstat.mockRestore())
  const result = policy.withHelper(helper)
  expect(lstat.mock.calls.map((c) => String(c[0])).filter((p) => p === marker)).toEqual([])
  expect(result).toBeInstanceOf(SandboxPolicy)
  expect(result.helper).toEqual({ binary: path.join(real!, "opencorp") })
  const rebuilt = new SandboxPolicy({ ...policy, helper })
  for (const key of ["office", "workspace", "writable", "network", "tmpdir", "readOnly"] as const) {
    expect(result[key]).toEqual(rebuilt[key])
  }
  expect(result.protectedPaths).toEqual(policy.protectedPaths)
  expect(policy.helper).toBeUndefined()
  expect(result.withHelper(undefined).helper).toBeUndefined()
})

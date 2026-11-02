/** Offboarding this machine: what it finds, what it asks, what it removes and keeps, and the launchers it reports. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import type { Device } from "@opencorp/protocol"
import { addDevice } from "../../src/auth/devices.ts"
import { deviceName, readIdentity } from "../../src/auth/identity.ts"
import { tokenSha256 } from "../../src/auth/tokens.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { type Owner, writeCompany } from "../../src/company_template/index.ts"
import * as fallback from "../../src/install/fallback.ts"
import { type Env, launch, officeAnswers, which } from "../../src/install/launch.ts"
import * as launchd from "../../src/install/launchd.ts"
import { CONFIRM, Declined, KEEP, launchers, OffboardError, offboard, REMOVE } from "../../src/install/offboard.ts"
import { makeDevice, makeHome } from "../../src/install/onboard.ts"
import { sameProcess } from "../../src/install/proc.ts"
import * as service from "../../src/install/service.ts"
import { selfSpawnEnv } from "../../src/platform.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { daemonHost, killedAtEnd, makeHost, Runner, Script } from "./helpers.ts"

/** An office's folders. */
interface Paths {
  home: string
  company: string
  office: string
  worktrees: string
}

/** An office as `opencorp init` leaves it: a company with this device listed for @me, identity.json, office
 *  state. */
async function office(home: string, { device = true }: { device?: boolean } = {}): Promise<Paths> {
  makeHome(home)
  const real = fs.realpathSync(home)
  const paths = {
    home: real,
    company: path.join(real, "company"),
    office: path.join(real, "office"),
    worktrees: path.join(real, "office", "worktrees"),
  }
  let owner: Owner = { handle: "me", name: "Me" }
  if (device) owner = await makeDevice(real, owner)
  await writeCompany(paths.company, paths.worktrees, { company: "Acme", owner })
  fs.mkdirSync(path.join(paths.office, "connections"), { recursive: true })
  fs.writeFileSync(path.join(paths.office, "connections", "office.json"), '{"provider": "anthropic"}')
  fs.writeFileSync(path.join(paths.office, "office.log"), "started\n")
  fs.mkdirSync(path.join(real, "tui"))
  return paths
}

/** Pushes the company to a new bare repo, tracking it; the bare repo's path. */
function publish(paths: Paths, dir: string): string {
  const remote = path.join(dir, "acme.git")
  git(dir, "init", "-q", "--bare", "-b", "main", remote)
  git(paths.company, "remote", "add", "origin", remote)
  git(paths.company, "push", "-q", "-u", "origin", "main")
  return remote
}

/** The names of @me's devices in the company repo. */
function devices(paths: Paths): string[] {
  return loadRepo(paths.company).people.get("me")!.devices.map((d) => d.name)
}

/** The subjects of `repo`'s commits, newest first. */
function subjects(repo: string): string[] {
  return git(repo, "log", "--format=%s").split("\n")
}

/** An env whose `PATH` holds only git, so no launcher is found; an empty `PATH` won't do, since the user's git
 *  would then search this process's. */
function gitOnly(dir: string): Env {
  const bin = path.join(dir, "gitbin")
  fs.mkdirSync(bin, { recursive: true })
  if (!fs.existsSync(path.join(bin, "git"))) {
    fs.symlinkSync(fs.realpathSync(which("git", process.env.PATH)!), path.join(bin, "git"))
  }
  return { ...gitEnv(process.env), PATH: bin }
}

test("offboard says what it will remove and no keeps everything", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  const ask = new Script([""])
  const done = offboard(paths.home, ask, { host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  await expect(done).rejects.toThrow(OffboardError)
  await expect(done).rejects.toThrow(Declined)
  await expect(done).rejects.toThrow("nothing was removed")
  const said = ask.seen.join("\n")
  expect(said).toContain(`this device (${deviceName()}) from @me in the company repo`)
  expect(said).toContain(
    `${paths.office} (the office's store, connections (the model provider's among them), sign-ins, logs, and ` +
      "worktrees)",
  )
  expect(said).toContain(`${path.join(paths.home, "identity.json")} (this device's identity and token)`)
  expect(said).toContain(`${path.join(paths.home, "tui")} (opencorp's own state)`)
  expect(said).toContain(`Keeping the company repo at ${paths.company}: it has no remote, so this is its only copy`)
  expect(ask.seen.at(-1)).toBe(CONFIRM)
  expect(ask.offered).toEqual([[KEEP, REMOVE]])
  expect(devices(paths)).toEqual([deviceName()])
  expect(fs.existsSync(path.join(paths.office, "connections", "office.json"))).toBe(true)
  expect(fs.existsSync(path.join(paths.home, "identity.json"))).toBe(true)
  expect(fs.existsSync(path.join(paths.home, "tui"))).toBe(true)
}, 30_000)

test("offboard removes the device and the office but keeps a company with no remote", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  const ask = new Script(["2"])
  await offboard(paths.home, ask, { host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(devices(paths)).toEqual([])
  expect(subjects(paths.company)[0]).toBe(`devices(@me): remove ${deviceName()}`)
  expect(fs.readdirSync(paths.home).sort()).toEqual(["company"])
  expect(git(paths.company, "worktree", "list").split("\n")).toHaveLength(1)
  expect(ask.seen).toContain(`Kept the company repo at ${paths.company}: it has no remote, so this is its only copy.`)
}, 30_000)

test("offboard deletes a pushed company and then the empty home", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  const remote = publish(paths, dir)
  const pushed = git(remote, "rev-parse", "main")
  await offboard(paths.home, new Script(), { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(fs.existsSync(paths.home)).toBe(false)
  // Offboard never pushes.
  expect(git(remote, "rev-parse", "main")).toBe(pushed)
}, 30_000)

test("this devices own commits dont count as unpushed", async () => {
  // A company joined with `opencorp onboard --from` has this device's commit on top of what it cloned.
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"), { device: false })
  publish(paths, dir)
  const me = await makeDevice(paths.home, { handle: "me", name: "Me" })
  await addDevice(new CompanyGit(paths.company, paths.worktrees), "me", me.devices![0]!, "me")
  const ask = new Script()
  await offboard(paths.home, ask, { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(fs.existsSync(paths.home)).toBe(false)
  expect(ask.seen.join("\n")).toContain(`the company repo at ${paths.company} (everything in it is pushed)`)
}, 30_000)

test.each([
  ["commit", "it has 1 commit not pushed to its remote"],
  ["edit", "it has uncommitted changes"],
  ["untracked", "it has uncommitted changes"],
  ["branch", "its branch drafts isn't pushed anywhere"],
  ["stash", "it has stashed changes"],
])(
  "offboard keeps a company with work that isnt pushed [%s]",
  async (change, why) => {
    const dir = tempDir()
    const paths = await office(path.join(dir, "home"))
    publish(paths, dir)
    const notes = path.join(paths.company, "notes.md")
    if (["commit", "stash", "edit"].includes(change)) {
      fs.writeFileSync(notes, "notes\n")
      git(paths.company, "add", "notes.md")
    }
    if (change === "commit") git(paths.company, "commit", "-qm", "notes")
    else if (change === "stash") git(paths.company, "stash", "-q")
    else if (change === "untracked") fs.writeFileSync(notes, "notes\n")
    else if (change === "branch") git(paths.company, "branch", "drafts")
    const ask = new Script()
    await offboard(paths.home, ask, { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
    expect(fs.readdirSync(paths.home).sort()).toEqual(["company"])
    const said = ask.seen.join("\n")
    expect(said).toContain(`Keeping the company repo at ${paths.company}: ${why}`)
    expect(said).toContain("--delete-company")
  },
  30_000,
)

test("delete company deletes it even with unpushed work", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  fs.writeFileSync(path.join(paths.company, "notes.md"), "notes\n")
  const ask = new Script()
  await offboard(paths.home, ask, {
    yes: true,
    deleteCompany: true,
    host: makeHost(dir, new Runner()),
    environ: gitOnly(dir),
  })
  expect(fs.existsSync(paths.home)).toBe(false)
  expect(ask.seen.join("\n")).toContain(
    `the company repo at ${paths.company}, even though it has no remote, so this is its only copy`,
  )
}, 30_000)

test("a second offboard finds nothing and asks nothing", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  await offboard(paths.home, new Script(), { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  let ask = new Script()
  await offboard(paths.home, ask, { host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(ask.seen).toContain(`Nothing of this office to remove at ${paths.home}.`)
  expect(ask.seen.some((line) => line.startsWith(`Keeping the company repo at ${paths.company}`))).toBe(true)
  expect(ask.seen).not.toContain(CONFIRM)
  expect(ask.offered).toEqual([])
  expect(subjects(paths.company)[0]).toBe(`devices(@me): remove ${deviceName()}`)
  ask = new Script()
  const nowhere = path.join(dir, "nowhere")
  await offboard(nowhere, ask, { host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(ask.seen).toContain(`Nothing of this office to remove at ${nowhere}.`)
}, 30_000)

test("offboard cleans up a half made office", async () => {
  // Onboarding that stopped before the company leaves only the office dir.
  const dir = tempDir()
  const home = path.join(dir, "home")
  makeHome(home)
  fs.mkdirSync(path.join(home, ".company-clone"))
  await offboard(home, new Script(), { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(fs.existsSync(home)).toBe(false)
})

test("offboard with an identity the company doesnt list skips the device", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"), { device: false })
  // identity.json only
  await makeDevice(paths.home, { handle: "me", name: "Me" })
  const ask = new Script()
  await offboard(paths.home, ask, { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(ask.seen.some((line) => line.includes("from @me in the company repo"))).toBe(false)
  expect(subjects(paths.company)).toEqual(["init: create the company"])
}, 30_000)

test("offboard with an identity it can't read skips the device", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  fs.chmodSync(path.join(paths.home, "identity.json"), 0o644)
  const ask = new Script()
  await offboard(paths.home, ask, { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(ask.seen.some((line) => line.includes("from @me in the company repo"))).toBe(false)
  expect(devices(paths)).toEqual([deviceName()])
  expect(fs.existsSync(path.join(paths.home, "identity.json"))).toBe(false)
}, 30_000)

test("offboard uninstalls a launchd office through the host", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  const run = launch(paths.home, { userHome: dir })
  const runner = new Runner()
  const host = makeHost(dir, runner)
  const plist = launchd.plistPath(run, host)
  expect(plist.startsWith(dir + path.sep)).toBe(true)
  fs.mkdirSync(path.dirname(plist), { recursive: true })
  fs.writeFileSync(plist, launchd.plist(run))
  fs.writeFileSync(path.join(paths.office, "install.json"), '{"mode": "launchd"}')
  const ask = new Script()
  await offboard(paths.home, ask, { yes: true, host, environ: gitOnly(dir) })
  expect(runner.calls).toContainEqual(["launchctl", "bootout", `gui/501/${launchd.label(run)}`])
  expect(fs.existsSync(plist)).toBe(false)
  expect(ask.seen.join("\n")).toContain(`the office's launchd service (${plist})`)
}, 30_000)

test("an office that wont stop keeps its state", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  const host = makeHost(dir, new Runner(), { answers: async () => true })
  const done = offboard(paths.home, new Script(), { yes: true, host, environ: gitOnly(dir) })
  await expect(done).rejects.toThrow(OffboardError)
  await expect(done).rejects.toThrow("still answers")
  // The online removal finds no server on the temp socket, so the device stays.
  expect(devices(paths)).toEqual([deviceName()])
  expect(fs.existsSync(path.join(paths.office, "connections", "office.json"))).toBe(true)
  expect(fs.existsSync(path.join(paths.home, "identity.json"))).toBe(true)
}, 30_000)

test(
  "offboard removes the device through a running office",
  async () => {
    const spawned = killedAtEnd()
    const dir = shortDir()
    const paths = await office(path.join(dir, "home"))
    // Python's `no_web_port`: HQ stays off its TCP port, which the owner's own office holds.
    fs.writeFileSync(path.join(paths.office, "hq.json"), '{"tcp": false}')
    const environ = { ...gitEnv(selfSpawnEnv(process.env)), HOME: tempDir() }
    const run = launch(paths.home, { environ, userHome: dir })
    const host = daemonHost(dir, spawned)
    try {
      await service.install(run, host, "background")
      await service.wait(run, host)
      const me = (await readIdentity(path.join(paths.home, "identity.json")))!
      const ask = new Script()
      // The user's git must run, and no launcher of this checkout may be found on PATH.
      await offboard(paths.home, ask, { yes: true, host, environ: { ...environ, PATH: gitOnly(dir).PATH } })
      expect(devices(paths)).toEqual([])
      expect(subjects(paths.company)[0]).toBe(`devices(@me): remove ${me.device}`)
      expect(ask.seen).toContain(`Removed this device (${me.device}) from @me through the office.`)
      expect(await officeAnswers(run.socket)).toBe(false)
      expect(fs.readdirSync(paths.home).sort()).toEqual(["company"])
    } finally {
      await fallback.stopProcess(run)
    }
  },
  120_000,
)

test(
  "offboard stops a running office whose pidfile is wrong",
  async () => {
    const spawned = killedAtEnd()
    const dir = shortDir()
    const paths = await office(path.join(dir, "home"))
    fs.writeFileSync(path.join(paths.office, "hq.json"), '{"tcp": false}')
    const environ = { ...gitEnv(selfSpawnEnv(process.env)), HOME: tempDir() }
    const run = launch(paths.home, { environ, userHome: dir })
    const host = daemonHost(dir, spawned)
    await service.install(run, host, "background")
    await service.wait(run, host)
    const pid = Number(fs.readFileSync(path.join(paths.office, "office.pid"), "utf8"))
    fs.writeFileSync(path.join(paths.office, "office.pid"), "1\n")
    const ask = new Script()
    await offboard(paths.home, ask, { yes: true, host, environ: { ...environ, PATH: gitOnly(dir).PATH } })
    expect(ask.seen).toContain(`  - the running office (pid ${pid})`)
    expect(ask.seen).toContain(`Stopped: background: stopped the office (pid ${pid})`)
    expect(await officeAnswers(run.socket)).toBe(false)
    expect(spawned.every((d) => !sameProcess(d.pid, d.started))).toBe(true)
  },
  120_000,
)

test("offboard reports how opencorp was put on path and keeps the checkout", async () => {
  const dir = tempDir()
  const repo = path.join(dir, "checkout")
  const main = path.join(repo, "packages", "cli", "src", "main.ts")
  fs.mkdirSync(path.dirname(main), { recursive: true })
  fs.writeFileSync(main, "")
  const wrapper = path.join(dir, "local")
  const linked = path.join(dir, "bun")
  const other = path.join(dir, "sbin")
  for (const folder of [wrapper, linked, other]) fs.mkdirSync(folder)
  fs.writeFileSync(path.join(wrapper, "opencorp"), `#!/bin/bash\nexec bun ${repo}/packages/cli/src/main.ts "$@"\n`)
  fs.symlinkSync(main, path.join(linked, "opencorp"))
  fs.writeFileSync(path.join(other, "opencorp"), "\x7fELF not ours")
  const found = launchers({ PATH: [wrapper, linked, other].join(":") }, repo)
  expect(found).toEqual([path.join(wrapper, "opencorp"), path.join(linked, "opencorp")])
  const ask = new Script()
  await offboard(path.join(dir, "nowhere"), ask, {
    host: makeHost(dir, new Runner()),
    repo,
    environ: { PATH: wrapper },
  })
  const said = ask.seen.join("\n")
  expect(said).toContain(`rm ${path.join(wrapper, "opencorp")}`)
  expect(said).toContain(`The checkout at ${repo} stays`)
})

test("offboard with no launcher on path says so", async () => {
  const dir = tempDir()
  const ask = new Script()
  await offboard(path.join(dir, "nowhere"), ask, { host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(ask.seen.some((line) => line.includes("No `opencorp` launcher from"))).toBe(true)
})

test("offboard never prints the token or the provider", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"))
  const token = (await readIdentity(path.join(paths.home, "identity.json")))!.token
  const ask = new Script()
  await offboard(paths.home, ask, { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  const said = ask.seen.join("\n")
  expect(said).not.toContain(token)
  expect(said).not.toContain(tokenSha256(token))
  expect(said).not.toContain("anthropic")
}, 30_000)

test("a device named like another doesnt hide this ones commits", async () => {
  const dir = tempDir()
  const paths = await office(path.join(dir, "home"), { device: false })
  publish(paths, dir)
  const other: Device = { name: "laptop", token_sha256: "0".repeat(64) }
  await addDevice(new CompanyGit(paths.company, paths.worktrees), "me", other, "me")
  await makeDevice(paths.home, { handle: "me", name: "Me" })
  const ask = new Script()
  await offboard(paths.home, ask, { yes: true, host: makeHost(dir, new Runner()), environ: gitOnly(dir) })
  expect(ask.seen.join("\n")).toContain("it has 1 commit not pushed to its remote")
}, 30_000)

test("launchers finds another name and entry", () => {
  const dir = tempDir()
  const repo = path.join(dir, "repo")
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "old"), `#!/bin/bash\nexec bun ${repo}/packages/old/main.ts "$@"\n`)
  fs.writeFileSync(path.join(bin, "opencorp"), `#!/bin/bash\nexec bun ${repo}/packages/cli/src/main.ts "$@"\n`)
  const found = launchers({ PATH: bin }, repo, { name: "old", entries: [path.join("packages", "old", "main.ts")] })
  expect(found).toEqual([path.join(bin, "old")])
})

test("launchers finds a link to the checkout wrapper and a script naming it", async () => {
  const dir = tempDir()
  const repo = path.join(dir, "checkout")
  const wrapper = path.join(repo, "packages", "cli", "bin", "opencorp")
  const other = path.join(dir, "checkout2", "packages", "cli", "bin", "opencorp")
  for (const file of [wrapper, other]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "#!/bin/sh\n")
  }
  const a = path.join(dir, "a")
  const b = path.join(dir, "b")
  const c = path.join(dir, "c")
  const d = path.join(dir, "d")
  for (const folder of [a, b, c, d]) fs.mkdirSync(folder)
  fs.symlinkSync(wrapper, path.join(a, "opencorp"))
  fs.writeFileSync(path.join(b, "opencorp"), `#!/bin/sh\nexec ${repo}/packages/cli/bin/opencorp "$@"\n`)
  fs.writeFileSync(path.join(c, "opencorp"), "#!/bin/sh\necho hello\n")
  fs.symlinkSync(other, path.join(d, "opencorp"))
  const found = launchers({ PATH: [a, b, c, d].join(":") }, repo)
  expect(found).toEqual([path.join(a, "opencorp"), path.join(b, "opencorp")])
  const ask = new Script()
  await offboard(path.join(dir, "nowhere"), ask, { host: makeHost(dir, new Runner()), repo, environ: { PATH: a } })
  const said = ask.seen.join("\n")
  expect(said).toContain(`a link to ${fs.realpathSync(wrapper)}`)
  expect(said).toContain(`rm ${path.join(a, "opencorp")}`)
})

test("offboard outside a checkout reports no launchers", async () => {
  const dir = tempDir()
  const repo = path.join(dir, "empty")
  fs.mkdirSync(repo)
  const ask = new Script()
  await offboard(path.join(dir, "nowhere"), ask, { host: makeHost(dir, new Runner()), repo, environ: gitOnly(dir) })
  expect(ask.seen).toEqual([`Nothing of this office to remove at ${path.join(dir, "nowhere")}.`])
})

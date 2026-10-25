/** Offboarding this machine: what it finds, what it asks, what it removes and keeps, and the launchers it reports. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { deviceName } from "../../src/auth/identity.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { type Owner, writeCompany } from "../../src/company_template/index.ts"
import { type Env, which } from "../../src/install/launch.ts"
import { CONFIRM, Declined, KEEP, launchers, OffboardError, offboard, REMOVE } from "../../src/install/offboard.ts"
import { makeDevice, makeHome } from "../../src/install/onboard.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { makeHost, Runner, Script } from "./helpers.ts"

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
  fs.writeFileSync(path.join(paths.office, "provider.json"), '{"provider": "anthropic"}')
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
    `${paths.office} (the office's store, provider.json, connections and sign-ins, logs, and worktrees)`,
  )
  expect(said).toContain(`${path.join(paths.home, "identity.json")} (this device's identity and token)`)
  expect(said).toContain(`${path.join(paths.home, "tui")} (opencorp's own state)`)
  expect(said).toContain(`Keeping the company repo at ${paths.company}: it has no remote, so this is its only copy`)
  expect(ask.seen.at(-1)).toBe(CONFIRM)
  expect(ask.offered).toEqual([[KEEP, REMOVE]])
  expect(devices(paths)).toEqual([deviceName()])
  expect(fs.existsSync(path.join(paths.office, "provider.json"))).toBe(true)
  expect(fs.existsSync(path.join(paths.home, "identity.json"))).toBe(true)
  expect(fs.existsSync(path.join(paths.home, "tui"))).toBe(true)
})

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

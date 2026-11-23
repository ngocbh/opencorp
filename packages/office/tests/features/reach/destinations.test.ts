/** The saved destinations: which there are, the name a first path is saved under, and `opencorp hq --list`,
 *  `--rename` and `--forget`. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import {
  FORGET,
  KEEP,
  manage,
  type ManageDeps,
  nameAfter,
  portShared,
  readCmId,
  reservePort,
  savedDestinations,
  socketId,
  sweepTemps,
} from "../../../src/features/reach/destinations.ts"
import { isSocket, runChild, sshEnv, startMaster, waitForSocket } from "../../../src/features/reach/ssh.ts"
import { STATUS_STALE_MS } from "../../../src/features/reach/state.ts"
import { fakeControlName } from "../../../src/testing/fake_ssh.ts"
import { fakeHome, reachCtx } from "./helpers.ts"
import { claimCm, makeDirs, ReachPaths, tempName } from "../../../src/features/reach/paths.ts"
import { type Access, sha256, takeLock, writeAccess } from "../../../src/features/reach/state.ts"
import { writePrivate } from "../../../src/util/private_files.ts"
import { shortDir } from "../../helpers.ts"
import { Script } from "../setup/helpers.ts"

/** Saves destination `name` in `home`: its folder, its socket folder, reach.sh and, unless `access` is null, an
 *  access.json with `access` in it. */
async function save(home: string, name: string, access: Partial<Access> | null = {}): Promise<ReachPaths> {
  const found = new ReachPaths(home, name)
  makeDirs(found)
  const paths = found.withCm(claimCm(found.root, new Set()))
  await writePrivate(paths.cmRecord, `${paths.cmId}\n`)
  await writePrivate(paths.script, "exit 3\n")
  if (access !== null)
    await writeAccess(paths, {
      port: 49381,
      sha256: sha256("exit 3\n"),
      learned_at: "2026-11-01T10:00:00.000Z",
      last_used_at: null,
      signed_in_at: null,
      cm: paths.cmId!,
      ...access,
    })
  return paths
}

/** `manage`'s deps for `home`, answering `answers`, with what it printed and said. */
function deps(home: string, answers: string[] = [], interactive = true) {
  const printed: string[] = []
  const errors: string[] = []
  const prompter = new Script(answers, { interactive })
  const d: ManageDeps = { home, prompter, print: (l) => void printed.push(l), error: (l) => void errors.push(l) }
  return { d, printed, errors, prompter }
}

test("the saved destinations are hq's folders with a name and a reach.sh, by name, each with its access.json", async () => {
  const home = path.join(shortDir(), "h")
  expect(await savedDestinations(home)).toEqual([])
  await save(home, "misha", { host: "node1", port: 49382 })
  await save(home, "alpha")
  // The old single path's files, a learning run's folder, a socket folder and a folder without reach.sh aren't.
  fs.writeFileSync(path.join(home, "hq", "reach.sh"), "exit 3\n")
  for (const name of ["ssh", "cm-0a1b2c", tempName(), "empty"]) fs.mkdirSync(path.join(home, "hq", name), { recursive: true })
  fs.writeFileSync(path.join(home, "hq", "ssh", "reach.sh"), "exit 3\n")
  const broken = await save(home, "zeta")
  fs.writeFileSync(broken.access, "{nope", { mode: 0o600 })
  const saved = await savedDestinations(home)
  expect(saved.map((s) => [s.paths.name, s.access?.port ?? null, s.problem])).toEqual([
    ["alpha", 49381, null],
    ["misha", 49382, null],
    ["zeta", null, `${broken.access} isn't JSON`],
  ])
})

test("a first path is named after its first jump host, or its host with none, made safe for a name", () => {
  const none = () => false
  expect(nameAfter({ host: "node1", jump: ["me@login1.cluster.edu:2222"] }, none)).toBe("login1")
  expect(nameAfter({ host: "me@misha.ycrc.yale.edu" }, none)).toBe("misha")
  expect(nameAfter({ host: "10.0.0.5" }, none)).toBe("10-0-0-5")
  expect(nameAfter({ host: "Login_Node" }, none)).toBe("login-node")
  expect(nameAfter({ host: "_" }, none)).toBe("hq")
  expect(nameAfter({ host: "a".repeat(40) }, none)).toBe("a".repeat(32))
  // A reserved word or a name taken gets -2, -3, ..., within 32 characters.
  expect(nameAfter({ host: "list" }, none)).toBe("list-2")
  const taken = (n: string) => ["login1", "login1-2"].includes(n)
  expect(nameAfter({ host: "node1", jump: ["login1"] }, taken)).toBe("login1-3")
  expect(nameAfter({ host: "a".repeat(32) }, (n) => n === "a".repeat(32))).toBe(`${"a".repeat(30)}-2`)
})

test("--list prints each name, its host, local port and last use, and says how to relearn a broken one", async () => {
  const home = path.join(shortDir(), "h")
  let run = deps(home)
  expect(await manage({ list: true }, run.d)).toBe(0)
  expect(run.printed).toEqual(["No destinations saved. `opencorp hq NAME` learns one."])
  await save(home, "misha", { host: "me@node1", port: 49382, last_used_at: "2026-11-22T09:00:00.000Z" })
  await save(home, "login1")
  await save(home, "mine", null)
  const broken = await save(home, "zeta")
  fs.writeFileSync(broken.access, "{nope", { mode: 0o600 })
  run = deps(home)
  expect(await manage({ list: true }, run.d)).toBe(0)
  expect(run.printed).toEqual([
    "NAME    HOST      PORT   LAST USED",
    "login1  -         49381  never",
    "mine    -         -      not approved yet",
    "misha   me@node1  49382  2026-11-22T09:00:00.000Z",
    `zeta    broken: ${broken.access} isn't JSON; \`opencorp hq zeta --relearn\` learns it again`,
  ])
  expect(run.errors).toEqual([])
})

test("--rename renames the folder and keeps its socket folder; refused to a taken name, while open, or for one not saved", async () => {
  const home = path.join(shortDir(), "h")
  const misha = await save(home, "misha")
  await save(home, "login1")
  let run = deps(home)
  expect(await manage({ rename: ["misha", "login1"] }, run.d)).toBe(1)
  expect(run.errors).toEqual(["opencorp hq: 'login1' is taken; pick another name or forget it first"])
  run = deps(home)
  expect(await manage({ rename: ["nope", "x"] }, run.d)).toBe(2)
  expect(run.errors).toEqual(["opencorp hq: no saved destination 'nope'; saved: login1, misha"])
  const lock = takeLock(misha)!
  run = deps(home)
  expect(await manage({ rename: ["misha", "cluster"] }, run.d)).toBe(1)
  expect(run.errors).toEqual([
    "opencorp hq: misha is open in another `opencorp hq`; end it with Ctrl-C there before renaming it.",
  ])
  lock.release()
  run = deps(home)
  expect(await manage({ rename: ["misha", "cluster"] }, run.d)).toBe(0)
  expect(run.printed).toEqual(["Renamed misha to cluster."])
  expect(fs.existsSync(misha.dir)).toBe(false)
  const [cluster] = (await savedDestinations(home)).filter((s) => s.paths.name === "cluster")
  expect(cluster!.access?.cm).toBe(misha.cmId!)
  expect(fs.existsSync(misha.cm)).toBe(true)
})

test("--forget asks first, Keep by default, then deletes the folder and its socket folder; refused while open or without a terminal", async () => {
  const home = path.join(shortDir(), "h")
  const misha = await save(home, "misha")
  const other = await save(home, "login1")
  let run = deps(home, [""])
  expect(await manage({ forget: "misha" }, run.d)).toBe(1)
  expect(run.prompter.seen).toEqual([`Forget misha? This deletes ${misha.dir} and the path saved there.`])
  expect(run.prompter.offered).toEqual([[FORGET, KEEP]])
  expect(run.errors).toEqual(["opencorp hq: kept misha."])
  expect(fs.existsSync(misha.dir)).toBe(true)
  run = deps(home, [], false)
  expect(await manage({ forget: "misha" }, run.d)).toBe(1)
  expect(run.errors).toEqual(["opencorp hq: --forget asks first, and there's no terminal to ask; run it in one"])
  const lock = takeLock(misha)!
  onTestFinished(() => lock.release())
  run = deps(home, [FORGET])
  expect(await manage({ forget: "misha" }, run.d)).toBe(1)
  expect(run.errors).toEqual([
    "opencorp hq: misha is open in another `opencorp hq`; end it with Ctrl-C there before forgetting it.",
  ])
  expect(run.prompter.seen).toEqual([])
  lock.release()
  run = deps(home, [FORGET])
  expect(await manage({ forget: "misha" }, run.d)).toBe(0)
  expect(run.printed).toEqual(["Forgot misha."])
  expect([fs.existsSync(misha.dir), fs.existsSync(misha.cm)]).toEqual([false, false])
  // Another destination, and the shared sign-in's folder, stay.
  expect([fs.existsSync(other.dir), fs.existsSync(other.cm)]).toEqual([true, true])
})

/** A learning run's temporary folder in `home`, with a control-socket folder claimed and recorded (`id` when given),
 *  last changed `ago` ms before now. */
async function temp(home: string, ago: number, id?: string): Promise<ReachPaths> {
  const found = new ReachPaths(home, tempName())
  makeDirs(found)
  const paths = found.withCm(id ?? claimCm(found.root, new Set()))
  makeDirs(paths)
  await writePrivate(paths.cmRecord, `${paths.cmId}\n`)
  const when = new Date(Date.now() - ago)
  fs.utimesSync(found.dir, when, when)
  return paths
}

test("a learning run's folder abandoned long ago goes, with its socket folder; a fresh or held one stays", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const abandoned = await temp(dir, STATUS_STALE_MS + 1000)
  const fresh = await temp(dir, 0)
  const held = await temp(dir, STATUS_STALE_MS + 1000)
  const lock = takeLock(held)
  expect(lock).not.toBeNull()
  onTestFinished(() => lock!.release())
  await sweepTemps(ctx, Date.now())
  expect([abandoned, fresh, held].map((p) => [fs.existsSync(p.dir), fs.existsSync(p.cm)])).toEqual([
    [false, false],
    [true, true],
    [true, true],
  ])
  // A saved destination's folder is never a learning run's.
  expect([fs.existsSync(ctx.paths.dir), fs.existsSync(ctx.paths.cm)]).toEqual([true, true])
})

test("the sweep never follows a symlinked socket folder: what it leads to stays, and so does the link", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const outside = shortDir()
  fs.writeFileSync(path.join(outside, "keep"), "mine\n")
  const stale = await temp(dir, STATUS_STALE_MS + 1000)
  fs.rmSync(stale.cm, { recursive: true })
  fs.symlinkSync(outside, stale.cm)
  await sweepTemps(ctx, Date.now())
  expect(fs.existsSync(stale.dir)).toBe(false)
  expect(fs.lstatSync(stale.cm).isSymbolicLink()).toBe(true)
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("mine\n")
  expect(fake.calls()).toEqual([])
})

test("a sweep beside a live visit leaves its masters and sockets, even when a stale run records the same socket folder", async () => {
  const { dir, fake } = fakeHome()
  const live = await reachCtx(dir, fake)
  // The live visit's masters: the login node's, in its socket folder, and the node's.
  const hop = await runChild([live.paths.wrapper, "login1", "true"], { env: sshEnv(live), cwd: live.paths.dir, timeoutMs: 10_000 })
  expect(hop.code).toBe(0)
  const node = startMaster(live, { host: "node1", jump: ["login1"], opencorp: "/o/opencorp" }, { quiet: true })
  onTestFinished(() => node.kill())
  expect(await waitForSocket(node, 5000)).toBe("up")
  await writePrivate(live.paths.script, "exit 3\n")
  // A stale learning run that records the live destination's folder (a copy, or a collision).
  const copy = await temp(dir, STATUS_STALE_MS + 1000, live.paths.cmId!)
  const other = await reachCtx(dir, fake, { name: "login1" })
  await sweepTemps(other, Date.now())
  expect(fs.existsSync(copy.dir)).toBe(false)
  expect([isSocket(live.paths.node), isSocket(path.join(live.paths.cm, fakeControlName("login1")))]).toEqual([true, true])
  expect(fake.calls().filter((argv) => argv.includes("-O"))).toEqual([])
})

test("a folder's socket id is the one it records, unless another folder records it too; then a fresh one, recorded", async () => {
  const home = path.join(shortDir(), "h")
  const misha = await save(home, "misha")
  expect(await socketId(misha, null)).toBe(misha.cmId!)
  // A copy of misha's folder records the same id: it gets one of its own, skipping any taken or recorded.
  fs.cpSync(misha.dir, path.join(home, "hq", "copy"), { recursive: true })
  const copy = new ReachPaths(home, "copy")
  const recordedElsewhere = await save(home, "login1")
  const draws = [misha.cmId!, recordedElsewhere.cmId!, "abcdef"]
  const id = await socketId(copy, { ...(await savedDestinations(home)).find((s) => s.paths.name === "copy")!.access! }, () => draws.shift()!)
  expect(id).toBe("abcdef")
  expect(readCmId(copy)).toBe("abcdef")
  expect(fs.statSync(path.join(home, "hq", "cm-abcdef")).isDirectory()).toBe(true)
  // A first learn's folder records none yet: it claims one.
  const run = new ReachPaths(home, tempName())
  makeDirs(run)
  const fresh = await socketId(run, null)
  expect(readCmId(run)).toBe(fresh)
  expect([misha.cmId, recordedElsewhere.cmId, "abcdef"]).not.toContain(fresh)
})

test("overlapping learning runs each hold a port of their own under hq/ports.lock; an abandoned one's is free again", async () => {
  const home = path.join(shortDir(), "h")
  await save(home, "misha", { port: 49381 })
  const first = new ReachPaths(home, tempName())
  makeDirs(first)
  const firstLock = takeLock(first)!
  expect(await reservePort(first)).toBe(49382)
  expect(fs.readFileSync(first.portRecord, "utf8")).toBe("49382\n")
  const second = new ReachPaths(home, tempName())
  makeDirs(second)
  const secondLock = takeLock(second)!
  onTestFinished(() => secondLock.release())
  expect(await reservePort(second)).toBe(49383)
  // --port that another run holds, or a saved destination has, is refused.
  expect(await reservePort(second, 49382)).toBe("port 49382 is another learning run's; pick another with --port N")
  expect(await reservePort(second, 49381)).toBe("port 49381 is misha's; pick another with --port N")
  expect(await reservePort(second, 50001)).toBe(50001)
  // Once the first run is gone (its lock free), its port is free again.
  firstLock.release()
  const third = new ReachPaths(home, tempName())
  makeDirs(third)
  const thirdLock = takeLock(third)!
  onTestFinished(() => thirdLock.release())
  expect(await reservePort(third)).toBe(49382)
})

test("a port two saved destinations share is named, with how to move one", () => {
  const saved = [
    { paths: new ReachPaths("/h", "misha"), access: { port: 49381 } as Access, problem: null },
    { paths: new ReachPaths("/h", "login1"), access: { port: 49382 } as Access, problem: null },
  ]
  expect(portShared(saved, "misha", 49381)).toBeNull()
  expect(portShared(saved, "misha", 49382)).toBe(
    "opencorp hq: port 49382 is login1's too, so the two share a browser sign-in and can't be open at once; move one with `opencorp hq misha --port N`.",
  )
})

test("manage checks the names it's given itself", async () => {
  const home = path.join(shortDir(), "h")
  await save(home, "misha")
  for (const command of [{ forget: "../misha" }, { rename: ["misha", "Bad"] as [string, string] }, { rename: ["x y", "z"] as [string, string] }]) {
    const run = deps(home, [FORGET])
    expect(await manage(command, run.d)).toBe(2)
    expect(run.errors[0]).toStartWith("opencorp hq: ")
    expect(run.errors[0]).toContain("isn't a destination's name")
    expect(run.prompter.seen).toEqual([])
  }
  expect(fs.existsSync(path.join(home, "hq", "misha"))).toBe(true)
})

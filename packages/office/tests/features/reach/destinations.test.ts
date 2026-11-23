/** The saved destinations: which there are, the name a first path is saved under, and `opencorp hq --list`,
 *  `--rename` and `--forget`. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { FORGET, KEEP, manage, type ManageDeps, nameAfter, savedDestinations } from "../../../src/features/reach/destinations.ts"
import { cmIdOf, makeDirs, ReachPaths, tempName } from "../../../src/features/reach/paths.ts"
import { type Access, sha256, takeLock, writeAccess } from "../../../src/features/reach/state.ts"
import { writePrivate } from "../../../src/util/private_files.ts"
import { shortDir } from "../../helpers.ts"
import { Script } from "../setup/helpers.ts"

/** Saves destination `name` in `home`: its folder, its socket folder, reach.sh and, unless `access` is null, an
 *  access.json with `access` in it. */
async function save(home: string, name: string, access: Partial<Access> | null = {}): Promise<ReachPaths> {
  const found = new ReachPaths(home, name)
  makeDirs(found)
  const paths = found.withCm(cmIdOf(found.dir))
  makeDirs(paths)
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

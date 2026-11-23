/** Each destination's folder under the home's hq folder, the sign-in they share, names, and the limits SSH puts on
 *  the home's path. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import {
  cmIdOf,
  isTemp,
  MAX_HOME_BYTES,
  makeDirs,
  NAME_RULE,
  nameProblem,
  pathProblem,
  ReachPaths,
  tempName,
} from "../../../src/features/reach/paths.ts"
import { PrivateFileError } from "../../../src/util/private_files.ts"
import { shortDir } from "../../helpers.ts"

test("a destination's files are under hq/<name>/, while the model's sign-in stays in hq/, shared", () => {
  const paths = new ReachPaths("/h", "misha", "0a1b2c")
  expect(paths.home).toBe("/h")
  expect(paths.name).toBe("misha")
  expect(paths.root).toBe("/h/hq")
  expect(paths.dir).toBe("/h/hq/misha")
  expect({
    script: paths.script,
    approved: paths.approved,
    candidate: paths.candidate,
    notes: paths.notes,
    access: paths.access,
    provider: paths.provider,
    auth: paths.auth,
    ssh: paths.ssh,
    config: paths.config,
    batchConfig: paths.batchConfig,
    agentConfig: paths.agentConfig,
    bin: paths.bin,
    wrapper: paths.wrapper,
    status: paths.status(42),
    agentStatus: paths.agentStatus(42),
    cm: paths.cm,
    node: paths.node,
    lock: paths.lock,
    sessions: paths.sessions,
  }).toEqual({
    script: "/h/hq/misha/reach.sh",
    approved: "/h/hq/misha/reach.approved.sh",
    candidate: "/h/hq/misha/reach.new.sh",
    notes: "/h/hq/misha/notes.md",
    access: "/h/hq/misha/access.json",
    provider: "/h/hq/provider.json",
    auth: "/h/hq/auth.json",
    ssh: "/h/hq/misha/ssh",
    config: "/h/hq/misha/ssh/config",
    batchConfig: "/h/hq/misha/ssh/config.batch",
    agentConfig: "/h/hq/misha/ssh/agent.config",
    bin: "/h/hq/misha/ssh/bin",
    wrapper: "/h/hq/misha/ssh/bin/ssh",
    status: "/h/hq/misha/ssh/status.42",
    agentStatus: "/h/hq/misha/ssh/agent-status.42",
    cm: "/h/hq/cm-0a1b2c",
    node: "/h/hq/cm-0a1b2c/node",
    lock: "/h/hq/misha/lock",
    sessions: "/h/hq/sessions",
  })
  // Two destinations share only the sign-in and the sessions' records.
  const other = new ReachPaths("/h", "login1", "ffffff")
  expect([other.provider, other.auth]).toEqual([paths.provider, paths.auth])
  expect(other.dir).not.toBe(paths.dir)
  expect(other.cm).not.toBe(paths.cm)
})

test("a destination's control sockets are in hq/cm-<6 hex>, which its paths learn once its id is known", () => {
  const paths = new ReachPaths("/h", "misha")
  expect(paths.cmId).toBeNull()
  expect(() => paths.cm).toThrow("no control-socket folder")
  const withCm = paths.withCm("abcdef")
  expect(withCm.cm).toBe("/h/hq/cm-abcdef")
  expect(withCm.dir).toBe(paths.dir)
  for (const id of ["", "abcde", "abcdefa", "ABCDEF", "../x00"]) expect(() => paths.withCm(id)).toThrow("6 hex digits")
})

test("a session's folder is hq/sessions/<id>", () => {
  const paths = new ReachPaths("/h", "misha")
  expect(paths.session("01JD7Z0Q2K")).toBe("/h/hq/sessions/01JD7Z0Q2K")
  // An id is one plain name: it can't lead out of hq/sessions.
  for (const id of ["", ".", "..", "../x", "a/b", "a\nb"]) expect(() => paths.session(id)).toThrow("a session's id")
})

test("a name is 1 to 32 lowercase letters, digits and dashes, and never one of hq's own words", () => {
  for (const name of ["misha", "a", "login1", "x-2", "0", "a".repeat(32), "my-cluster"]) expect([name, nameProblem(name)]).toEqual([name, null])
  for (const name of ["", "-a", "A", "Misha", "a b", "a.b", "a_b", "a/b", "..", ".new-abcdef", "a".repeat(33), "é"]) {
    expect([name, nameProblem(name)]).toEqual([name, expect.stringContaining(NAME_RULE)])
  }
  // Words a name can't be: hq's own folders and files, and words that read as a command.
  for (const name of ["list", "rename", "forget", "relearn", "help", "check", "json", "sessions", "ssh", "cm", "lock", "cm-0a1b2c"]) {
    expect([name, nameProblem(name)]).toEqual([name, expect.stringContaining("reserved")])
  }
  expect(nameProblem("cm-login")).toBeNull()
  // Paths are only ever made for a name or a learning run's temporary folder.
  for (const name of ["", "../x", "A", ".new-x", "a/b"]) expect(() => new ReachPaths("/h", name)).toThrow()
})

test("a first learn works in a temporary folder, hq/.new-<6 hex>", () => {
  const name = tempName()
  expect(name).toMatch(/^\.new-[0-9a-f]{6}$/)
  expect(isTemp(name)).toBe(true)
  expect(isTemp("misha")).toBe(false)
  expect(tempName()).not.toBe(name)
  expect(new ReachPaths("/h", name).dir).toBe(`/h/hq/${name}`)
})

test("a folder's control-socket id is 6 hex digits from its device and inode, so it survives a rename", () => {
  const root = shortDir()
  const a = path.join(root, "a")
  fs.mkdirSync(a)
  const id = cmIdOf(a)
  expect(id).toMatch(/^[0-9a-f]{6}$/)
  fs.renameSync(a, path.join(root, "b"))
  expect(cmIdOf(path.join(root, "b"))).toBe(id)
  fs.mkdirSync(path.join(root, "c"))
  expect(cmIdOf(path.join(root, "c"))).not.toBe(id)
})

test("a home of 32 bytes fits the control sockets, whatever the name's length, and one of 33 doesn't", () => {
  expect(MAX_HOME_BYTES).toBe(32)
  const fits = "/tmp/" + "a".repeat(27)
  expect(Buffer.byteLength(fits)).toBe(32)
  const longest = new ReachPaths(fits, "a".repeat(32), "0a1b2c")
  expect(pathProblem(longest)).toBeNull()
  // The longest control socket ssh binds, `<cm>/<40 hex>.<16 random>`, fits macOS's 104 bytes with its NUL, for a
  // 32-character name too: the name isn't in a socket's path.
  expect(Buffer.byteLength(`${longest.cm}/${"f".repeat(40)}.${"x".repeat(16)}`) + 1).toBe(104)
  const problem = pathProblem(new ReachPaths(fits + "a", "misha"))
  expect(problem).toContain("OPENCORP_HOME")
  expect(problem).toContain("33 bytes")
  expect(problem).toContain("32")
  expect(problem).toContain("104")
})

test("a home with a space or a percent sign is refused, naming OPENCORP_HOME", () => {
  for (const home of ["/tmp/a b", "/tmp/a%C", "/tmp/a:b", "relative"]) {
    const problem = pathProblem(new ReachPaths(home, "misha"))
    expect([home, problem]).toEqual([home, expect.stringContaining("OPENCORP_HOME")])
    expect(problem).toContain("unquoted")
  }
})

test("makeDirs makes hq, the destination's folders and its socket folder 0700, and refuses one open to others", () => {
  const paths = new ReachPaths(path.join(shortDir(), "h"), "misha", "0a1b2c")
  makeDirs(paths)
  for (const dir of [paths.root, paths.dir, paths.ssh, paths.bin, paths.cm]) expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  makeDirs(paths)
  fs.chmodSync(paths.cm, 0o755)
  expect(() => makeDirs(paths)).toThrow(PrivateFileError)
  // Before its socket folder's id is known, it makes the rest.
  const first = new ReachPaths(paths.home, "login1")
  makeDirs(first)
  expect(fs.statSync(first.ssh).isDirectory()).toBe(true)
})

/** Changing a human's devices and password in their person.yaml, one commit each. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import type { Device } from "@opencorp/protocol"
import { addDevice, DeviceRefused, login, removeDevice, setPassword } from "../../src/auth/devices.ts"
import { Roster } from "../../src/auth/roster.ts"
import { newToken, tokenSha256 } from "../../src/auth/tokens.ts"
import { readYaml } from "../../src/company/flow_yaml.ts"
import { CompanyGit, CompanyGitError, CompanyRepoBusy } from "../../src/company/git.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { tempDir } from "../helpers.ts"
import { company, failingGit, git, gitStatus, makeCompany, person, startMerge } from "../company/helpers.ts"

setDefaultTimeout(30_000)

const PERSON = "people/ngocbh/person.yaml"
const PASSWORD = "correct horse battery"
const AVA = {
  "people/ava/person.yaml": person("ngocbh", { handle: "ava", name: "Ava", title: "Eng", manager: "ngocbh" }),
}

/** A committed company (the base one, or with `overrides`) and a `CompanyGit` on it. */
function setup(overrides?: Record<string, unknown>) {
  const tmp = tempDir()
  const root = overrides ? makeCompany(overrides, tmp) : company(tmp)
  return { root, g: new CompanyGit(root, path.join(tmp, "worktrees")) }
}

/** A device named `name` with a fresh token's hash. */
function device(name: string): Device {
  return { name, token_sha256: tokenSha256(newToken()) }
}

/** `[status, code, message]` of the `DeviceRefused` that `change` rejects with. */
async function refusal(change: Promise<unknown>): Promise<[number, string, string]> {
  const error = await change.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(error instanceof DeviceRefused)) throw new Error(`expected a DeviceRefused, got ${String(error)}`)
  return [error.status, error.code, error.message]
}

const head = (root: string) => git(root, "rev-parse", "HEAD")
const subject = (root: string) => git(root, "log", "-1", "--format=%s")
const fields = (root: string) => readYaml(fs.readFileSync(path.join(root, PERSON), "utf8")) as Record<string, unknown>

test("adding a device commits it and keeps the files key order", async () => {
  const { root, g } = setup()
  const before = head(root)
  const mac = device("mac")
  const added = await addDevice(g, "ngocbh", mac, "ngocbh")
  expect(added.devices).toEqual([mac])
  const after = head(root)
  expect(after).not.toBe(before)
  expect(subject(root)).toBe("devices(@ngocbh): add mac")
  expect(Object.keys(fields(root))).toEqual(["handle", "name", "kind", "title", "manager", "devices"])
  expect(fields(root).devices).toEqual([mac])

  expect(await addDevice(g, "ngocbh", { ...mac }, "ngocbh")).toEqual(added)
  expect(head(root)).toBe(after)
  expect(git(root, "status", "--porcelain")).toBe("")
})

test("a device name with another hash or a hash someone lists is refused", async () => {
  const { g } = setup(AVA)
  const mac = device("mac")
  await addDevice(g, "ngocbh", mac, "ngocbh")
  expect(await refusal(addDevice(g, "ngocbh", device("mac"), "ngocbh"))).toEqual([
    409,
    "device_exists",
    "@ngocbh already has a device named mac",
  ])
  expect(await refusal(addDevice(g, "ava", { name: "laptop", token_sha256: mac.token_sha256 }, "ava"))).toEqual([
    409,
    "token_in_use",
    "another device already lists this token",
  ])
})

test("only the person or the ceo changes a humans devices", async () => {
  const { root, g } = setup(AVA)
  const before = head(root)
  expect(await refusal(addDevice(g, "nobody", device("mac"), "ngocbh"))).toEqual([
    404,
    "not_found",
    "no person @nobody",
  ])
  expect(await refusal(addDevice(g, "minh", device("mac"), "ngocbh"))).toEqual([
    422,
    "not_a_human",
    "the person is an agent; agents have no devices",
  ])
  expect(await refusal(addDevice(g, "ngocbh", device("mac"), "ava"))).toEqual([
    403,
    "forbidden",
    "only @ngocbh or the CEO can change @ngocbh's devices",
  ])
  expect(await refusal(setPassword(g, "minh", PASSWORD, "ngocbh"))).toEqual([
    422,
    "not_a_human",
    "the person is an agent; agents have no password",
  ])
  expect(await refusal(setPassword(g, "ngocbh", PASSWORD, "ava"))).toEqual([
    403,
    "forbidden",
    "only @ngocbh or the CEO can change @ngocbh's password",
  ])
  expect(head(root)).toBe(before)

  // The CEO changes anyone's devices.
  expect((await addDevice(g, "ava", device("laptop"), "ngocbh")).devices.map((d) => d.name)).toEqual(["laptop"])
})

test("devices of a person whose file doesn't load answer the doctor hint", async () => {
  const { root, g } = setup(AVA)
  await addDevice(g, "ava", device("mac"), "ngocbh")
  fs.writeFileSync(path.join(root, "people/ava/person.yaml"), "handle: [SECRETVALUE\n")
  git(root, "commit", "-qam", "break ava")
  const before = head(root)
  const hint: [number, string, string] = [404, "not_found", "@ava's person.yaml doesn't load; run `opencorp doctor`"]
  expect(await refusal(addDevice(g, "ava", device("pc"), "ngocbh"))).toEqual(hint)
  expect(await refusal(removeDevice(g, "ava", "mac", "ngocbh"))).toEqual(hint)
  expect(await refusal(setPassword(g, "ava", PASSWORD, "ngocbh"))).toEqual(hint)
  expect(await refusal(removeDevice(g, "nobody", "mac", "ngocbh"))).toEqual([404, "not_found", "no person @nobody"])
  expect(head(root)).toBe(before)
})

test("removing a device commits it and an unknown name is not found", async () => {
  const { root, g } = setup()
  await addDevice(g, "ngocbh", device("mac"), "ngocbh")
  expect(Roster.of("h", "ngocbh", loadRepo(root).people.values()).enforced).toBe(true)
  expect(await refusal(removeDevice(g, "ngocbh", "pc", "ngocbh"))).toEqual([
    404,
    "not_found",
    "@ngocbh has no device named pc",
  ])

  expect((await removeDevice(g, "ngocbh", "mac", "ngocbh")).devices).toEqual([])
  expect(subject(root)).toBe("devices(@ngocbh): remove mac")
  expect(Object.hasOwn(fields(root), "devices")).toBe(false)
  expect(Roster.of("h", "ngocbh", loadRepo(root).people.values()).enforced).toBe(false)
})

test("a failed commit restores the person file", async () => {
  const { root, g } = setup()
  const original = fs.readFileSync(path.join(root, PERSON))
  const before = head(root)
  const lock = path.join(root, ".git/index.lock")
  fs.writeFileSync(lock, "")
  try {
    const error = await addDevice(g, "ngocbh", device("mac"), "ngocbh").then(
      () => null,
      (e: unknown) => e,
    )
    // `git add` runs after the file is written, and gives up on the lock.
    expect(error).toBeInstanceOf(CompanyRepoBusy)
    expect((error as CompanyRepoBusy).status).toBe(503)
    expect(fs.readFileSync(path.join(root, PERSON)).equals(original)).toBe(true)
    expect(head(root)).toBe(before)
  } finally {
    fs.rmSync(lock, { force: true })
  }
})

/** Each change that writes a human's person.yaml, made as themselves. */
const CHANGES: [string, (g: CompanyGit) => Promise<unknown>][] = [
  ["add device", (g) => addDevice(g, "ngocbh", device("mac"), "ngocbh")],
  ["set password", (g) => setPassword(g, "ngocbh", PASSWORD, "ngocbh")],
]

test.each(CHANGES)("a change mid-merge is refused and stays out of the index [%s]", async (_, change) => {
  const { root, g } = setup()
  startMerge(root, "groups/eng.yaml")
  const original = fs.readFileSync(path.join(root, PERSON))
  const error = await change(g).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CompanyRepoBusy)
  expect((error as CompanyRepoBusy).status).toBe(409)
  expect(git(root, "diff", "--cached", "--name-only")).not.toContain(PERSON)
  expect(fs.readFileSync(path.join(root, PERSON)).equals(original)).toBe(true)
  expect(gitStatus(root, "merge", "--abort")).toBe(0)
})

test.each(CHANGES)("a refused change never reaches the human's merge commit [%s]", async (_, change) => {
  const { root, g } = setup()
  startMerge(root, "groups/eng.yaml")
  await expect(change(g)).rejects.toBeInstanceOf(CompanyRepoBusy)
  fs.writeFileSync(path.join(root, "groups/eng.yaml"), "resolved\n")
  git(root, "add", "groups/eng.yaml")
  git(root, "commit", "-q", "--no-edit")
  expect(git(root, "show", `HEAD:${PERSON}`)).toBe(git(root, "show", `HEAD~1:${PERSON}`))
  expect(git(root, "status", "--porcelain")).toBe("")
})

test("a change whose commit fails after staging leaves the repo clean", async () => {
  const tmp = tempDir()
  const root = company(tmp)
  const failing = failingGit(tmp, "--cleanup=whitespace", "exit 1")
  const g = new CompanyGit(root, path.join(tmp, "worktrees"), { git: failing })
  const original = fs.readFileSync(path.join(root, PERSON))
  const error = await addDevice(g, "ngocbh", device("mac"), "ngocbh").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(CompanyGitError)
  expect(error).not.toBeInstanceOf(CompanyRepoBusy)
  expect(git(root, "status", "--porcelain")).toBe("")
  expect(fs.readFileSync(path.join(root, PERSON)).equals(original)).toBe(true)
})

test.each([["file"], ["folder"]])("a symlinked person file is never written through [%s]", async (link) => {
  const tmp = tempDir()
  const root = company(tmp)
  const g = new CompanyGit(root, path.join(tmp, "worktrees"))
  const outside = path.join(tmp, "outside")
  fs.mkdirSync(outside)
  let target: string
  if (link === "file") {
    target = path.join(outside, "person.yaml")
    fs.renameSync(path.join(root, PERSON), target)
    fs.symlinkSync(target, path.join(root, PERSON))
  } else {
    target = path.join(outside, "ngocbh", "person.yaml")
    fs.renameSync(path.join(root, "people/ngocbh"), path.join(outside, "ngocbh"))
    fs.symlinkSync(path.join(outside, "ngocbh"), path.join(root, "people/ngocbh"))
  }
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "link")
  // The loader reads through the link, so the change reaches the write.
  expect(loadRepo(root).people.has("ngocbh")).toBe(true)
  const original = fs.readFileSync(target)
  const before = head(root)
  expect(await refusal(addDevice(g, "ngocbh", device("mac"), "ngocbh"))).toEqual([
    422,
    "invalid_body",
    "person.yaml must be a regular file in the repo",
  ])
  expect(fs.readFileSync(target).equals(original)).toBe(true)
  expect(head(root)).toBe(before)
})

test("a refused change never echoes a value", async () => {
  const { root, g } = setup()
  const original = fs.readFileSync(path.join(root, PERSON))
  const before = head(root)
  const bad = { name: "mac", token_sha256: "secret-marker-123" } as Device
  const error = await addDevice(g, "ngocbh", bad, "ngocbh").then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DeviceRefused)
  const refused = error as DeviceRefused
  expect([refused.status, refused.code, refused.message]).toEqual([
    422,
    "invalid_body",
    "devices: isn't in the right format",
  ])
  expect(refused.message).not.toContain("secret-marker-123")
  expect(String(refused)).not.toContain("secret-marker-123")
  expect(head(root)).toBe(before)
  expect(fs.readFileSync(path.join(root, PERSON)).equals(original)).toBe(true)
})

test("login adds the device once the password checks out", async () => {
  const { root, g } = setup()
  const mac = device("mac")
  const request = { handle: "ngocbh", password: PASSWORD, device: "mac", token_sha256: mac.token_sha256 }
  expect(await refusal(login(g, request))).toEqual([
    409,
    "no_password",
    "@ngocbh has no password; set one with `opencorp password`",
  ])
  expect(await refusal(setPassword(g, "ngocbh", "short-pass1", "ngocbh"))).toEqual([
    422,
    "invalid_body",
    "use at least 12 characters",
  ])

  await setPassword(g, "ngocbh", PASSWORD, "ngocbh")
  expect(subject(root)).toBe("password(@ngocbh): set")
  expect(fs.readFileSync(path.join(root, PERSON), "utf8")).not.toContain(PASSWORD)
  expect(fields(root).password_hash).toMatch(/^\$scrypt\$/)

  expect(await refusal(login(g, { ...request, password: "not the password" }))).toEqual([
    401,
    "bad_login",
    "wrong handle or password",
  ])
  expect((await login(g, request)).devices).toEqual([mac])
  expect(subject(root)).toBe("devices(@ngocbh): add mac")
})

test("an unknown handle costs one password check", async () => {
  const { g } = setup()
  for (const handle of ["nobody", "minh"]) {
    const start = performance.now()
    const request = { handle, password: PASSWORD, device: "mac", token_sha256: device("mac").token_sha256 }
    expect(await refusal(login(g, request))).toEqual([401, "bad_login", "wrong handle or password"])
    // A lower bound: scrypt at the office's cost takes far longer, and load only slows it.
    expect(performance.now() - start).toBeGreaterThanOrEqual(20)
  }
})

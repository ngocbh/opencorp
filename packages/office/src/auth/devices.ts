/** Changing a human's devices and password in their `person.yaml`, one commit each. */
import fs from "node:fs"
import path from "node:path"
import {
  type Device,
  type ErrorCode,
  type LoginRequest,
  Person as PersonSchema,
  validationMessage,
} from "@opencorp/protocol"
import type { z } from "zod"
import { readYaml, writeYaml, YamlError } from "../company/flow_yaml.ts"
import type { CompanyGit, LockedGit } from "../company/git.ts"
import { type CompanyRepo, loadRepo } from "../company/loader.ts"
import { checkPassword, DUMMY_HASH, hashPassword, passwordProblem } from "./passwords.ts"

type Person = z.output<typeof PersonSchema>

/** A device or password change that can't be made: `status` and `code` are the HTTP error's. */
export class DeviceRefused extends Error {
  override name = "DeviceRefused"

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** The human `handle`, if `actor` may change their `what`: themselves, or the CEO for anyone. */
function person(repo: CompanyRepo, handle: string, actor: string, what = "devices"): Person {
  const found = repo.people.get(handle)
  if (found === undefined) throw new DeviceRefused(404, "not_found", `no person @${handle}`)
  if (found.kind !== "human") {
    // A 422 names the field, not its value.
    throw new DeviceRefused(422, "not_a_human", `the person is an agent; agents have no ${what}`)
  }
  const ceo = repo.company?.ceo ?? null
  if (actor !== handle && actor !== ceo) {
    throw new DeviceRefused(403, "forbidden", `only @${handle} or the CEO can change @${handle}'s ${what}`)
  }
  return found
}

/** Replaces the existing file `file`'s contents with `data`. A symlink swapped in after `write`'s check isn't
 *  followed: the open fails instead. */
function overwrite(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW)
  try {
    fs.writeFileSync(fd, data)
  } finally {
    fs.closeSync(fd)
  }
}

/** Sets `key` in `handle`'s `person.yaml` (an empty device list drops the key) and commits it through `locked`;
 *  the file is restored if that fails, unless the commit is known to have landed. */
async function write(
  locked: LockedGit,
  git: CompanyGit,
  handle: string,
  key: string,
  value: Device[] | string,
  subject: string,
): Promise<Person> {
  const root = git.root
  const rel = `people/${handle}/person.yaml`
  const file = path.join(root, rel)
  // The loader follows a symlinked file or folder, but a write through one would change a file outside the repo.
  const inRepo = fs.realpathSync(path.dirname(file)) === path.join(fs.realpathSync(root), "people", handle)
  if (!inRepo || !fs.lstatSync(file).isFile()) {
    throw new DeviceRefused(422, "invalid_body", "person.yaml must be a regular file in the repo")
  }
  const before = fs.readFileSync(file)
  // The lock doesn't stop a hand edit between loadRepo's read and this one, so the file is checked again.
  let read: unknown
  try {
    read = readYaml(new TextDecoder("utf-8", { fatal: true }).decode(before))
  } catch (error) {
    // A decode error is a TypeError; either way the text is fixed, since the file can hold a password hash.
    if (!(error instanceof TypeError || error instanceof YamlError)) throw error
    read = undefined
  }
  if (read === null || typeof read !== "object" || Array.isArray(read)) {
    throw new DeviceRefused(422, "invalid_body", "person.yaml can't be read")
  }
  const fields = read as Record<string, unknown>
  if (Array.isArray(value) && value.length === 0) delete fields[key]
  else fields[key] = value
  const parsed = PersonSchema.safeParse(fields)
  if (!parsed.success) {
    throw new DeviceRefused(422, "invalid_body", validationMessage(PersonSchema, parsed.error, fields))
  }
  const head = await git.head().catch(() => null)
  try {
    overwrite(file, writeYaml(fields))
    await locked.commit([rel], subject)
  } catch (error) {
    // Put back over a commit that landed, the old file would be read, and committed, by the next change.
    const now = head === null ? null : await git.head().catch(() => null)
    if (now === null || now === head) overwrite(file, before)
    throw error
  }
  return parsed.data
}

/** Adds `device` to `handle`'s devices as `actor`; the same name and hash again changes nothing.
 *  Throws `DeviceRefused`: 409 `device_exists` for the name with another hash; 409 `token_in_use` for a
 *  hash someone already lists, since the office can't tell who it acts as. */
export async function addDevice(git: CompanyGit, handle: string, device: Device, actor: string): Promise<Person> {
  return git.locked(async (locked) => {
    await locked.commitHandEdits()
    const repo = loadRepo(git.root)
    const found = person(repo, handle, actor)
    for (const d of found.devices) {
      if (d.name !== device.name) continue
      if (d.token_sha256 === device.token_sha256) return found
      throw new DeviceRefused(409, "device_exists", `@${handle} already has a device named ${device.name}`)
    }
    if ([...repo.people.values()].some((p) => p.devices.some((d) => d.token_sha256 === device.token_sha256))) {
      throw new DeviceRefused(409, "token_in_use", "another device already lists this token")
    }
    const devices = [...found.devices, { name: device.name, token_sha256: device.token_sha256 }]
    return write(locked, git, handle, "devices", devices, `devices(@${handle}): add ${device.name}`)
  })
}

/** Removes the device `name` from `handle`'s devices as `actor`. Removing the last device of the last
 *  human with one turns enforcement off again. */
export async function removeDevice(git: CompanyGit, handle: string, name: string, actor: string): Promise<Person> {
  return git.locked(async (locked) => {
    await locked.commitHandEdits()
    const found = person(loadRepo(git.root), handle, actor)
    const kept = found.devices.filter((d) => d.name !== name)
    if (kept.length === found.devices.length) {
      throw new DeviceRefused(404, "not_found", `@${handle} has no device named ${name}`)
    }
    return write(locked, git, handle, "devices", kept, `devices(@${handle}): remove ${name}`)
  })
}

/** Adds `request`'s device to its human's devices once their password checks out. Throws `DeviceRefused`:
 *  401 `bad_login` for an unknown handle, an agent or a wrong password, told apart by no one; 409
 *  `no_password` for a human without a password; or what `addDevice` throws. */
export async function login(git: CompanyGit, request: LoginRequest): Promise<Person> {
  const found = await git.locked(async () => loadRepo(git.root).people.get(request.handle))
  const human = found?.kind === "human" ? found : undefined
  if (human !== undefined && human.password_hash === null) {
    const hint = "set one with `opencorp password`"
    throw new DeviceRefused(409, "no_password", `@${request.handle} has no password; ${hint}`)
  }
  // An unknown handle or an agent still costs one check, so the time taken doesn't tell them apart.
  const ok = await checkPassword(request.password, human !== undefined ? human.password_hash : DUMMY_HASH)
  if (human === undefined || !ok) throw new DeviceRefused(401, "bad_login", "wrong handle or password")
  const device = { name: request.device, token_sha256: request.token_sha256 }
  return addDevice(git, request.handle, device, request.handle)
}

/** Sets `handle`'s password as `actor`, keeping only its hash. Throws `DeviceRefused`: 422 `invalid_body`
 *  for a password too short to be one; or what changing a person refuses. */
export async function setPassword(git: CompanyGit, handle: string, password: string, actor: string): Promise<Person> {
  const problem = passwordProblem(password)
  if (problem !== null) throw new DeviceRefused(422, "invalid_body", problem)
  const hash = await hashPassword(password) // slow on purpose, so outside the lock
  return git.locked(async (locked) => {
    await locked.commitHandEdits()
    person(loadRepo(git.root), handle, actor, "password")
    return write(locked, git, handle, "password_hash", hash, `password(@${handle}): set`)
  })
}

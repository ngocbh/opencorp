// This device's identity: the person it acts as, its device name, and its token, in
// `identity.json` (0600). The office knows only the token's sha256, listed in the person's
// `person.yaml`. The token is never printed, logged, or taken from argv or the environment.
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Identity = { handle: string; device: string; token: string }

/** A device name: within one person, as the office's `Device.name` allows. */
export const DEVICE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/
/** A token hash, as `person.yaml` lists it. */
export const TOKEN_SHA256 = /^[0-9a-f]{64}$/

/** A new device token: `act_` and 32 random bytes in unpadded base64url. */
export function newToken() {
  return "act_" + randomBytes(32).toString("base64url")
}

/** The lowercase hex sha256 of `token`: what the office lists. */
export function tokenSha256(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

/** A device name from the host's short name, lowercased, with what a name can't hold made '-'. */
export function deviceName(hostname = os.hostname()) {
  const short = hostname.split(".")[0].toLowerCase()
  return (
    short
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 63) || "device"
  )
}

/**
 * The identity in `file`, or undefined if there is none. A file others can read still loads,
 * with a warning: refusing would lock the owner out over a mode they can fix.
 *
 * Throws when the file exists but isn't an identity.
 */
export function readIdentity(file: string, warn: (message: string) => void = console.error): Identity | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw e
  }
  const mode = fs.statSync(file).mode & 0o777
  if (mode & 0o077) warn(`warning: ${file} is readable by others (mode ${mode.toString(8)}); run \`chmod 600 ${file}\``)
  let data: Partial<Identity>
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON; run \`ac login --force\``)
  }
  const { handle, device, token } = data
  if (typeof handle !== "string" || typeof device !== "string" || typeof token !== "string")
    throw new Error(`${file} lacks a handle, device or token; run \`ac login --force\``)
  return { handle, device, token }
}

/** Replaces `file` with `identity` atomically; the file is 0600 before the token is written to it. */
export function writeIdentity(file: string, identity: Identity) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  fs.rmSync(tmp, { force: true }) // left by a crashed run with the same pid
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    fs.fchmodSync(fd, 0o600) // the umask may have narrowed it; never widened
    fs.writeSync(fd, JSON.stringify(identity, null, 2) + "\n")
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.closeSync(fd)
    } catch {}
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

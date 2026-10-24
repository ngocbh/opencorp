/** This device's identity: `<home>/identity.json` (0600) holds the handle, device name and token.
 *
 *  `opencorp` reads and writes the same file. The token in it is never printed, logged or committed. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"
import { readPrivate, writePrivate } from "../secrets.ts"

/** Where the device identity lives under an OpenCorp home. */
export function identityPath(home: string): string {
  return path.join(home, "identity.json")
}

/** A device name from the host's short name, lowercased, with what a name can't hold made '-'. */
export function deviceName(hostname: string = os.hostname()): string {
  const short = hostname.split(".")[0]!.toLowerCase()
  const name = short.replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 63)
  return name || "device"
}

/** Who this device acts as, its name, and its token; shown and serialized without the token. */
export class Identity {
  constructor(
    readonly handle: string,
    readonly device: string,
    readonly token: string,
  ) {}

  /** The header that makes a request act as this device's person. */
  headers(): { Authorization: string } {
    return { Authorization: `Bearer ${this.token}` }
  }

  /** The handle and device, never the token. */
  toJSON(): { handle: string; device: string } {
    return { handle: this.handle, device: this.device }
  }

  /** The handle and device, never the token. */
  [inspect.custom](): string {
    return `Identity(handle=${JSON.stringify(this.handle)}, device=${JSON.stringify(this.device)})`
  }
}

/** Replaces the identity file with `identity`, atomically, as a 0600 file; creates its folder, mode 0700, if
 *  missing (an existing folder is left as is, and refused unless private). */
export async function writeIdentity(file: string, identity: Identity): Promise<void> {
  const dir = path.dirname(path.resolve(file))
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.chmodSync(dir, 0o700) // the umask may have narrowed it
  } catch (error) {
    // Another call may create it at the same time.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  // Spelled out: toJSON leaves the token out.
  const { handle, device, token } = identity
  await writePrivate(file, JSON.stringify({ handle, device, token }, null, 2) + "\n")
}

/** The identity in `file`, or undefined if there is none, it isn't one, the file or its folder isn't
 *  private, or the folder's lock can't be taken (yian's `FileLockError` after its 30 s wait). */
export async function readIdentity(file: string): Promise<Identity | undefined> {
  let data: unknown
  try {
    // ignoreBOM keeps a leading BOM, so JSON.parse refuses it as Python's json.loads does.
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readPrivate(file)))
  } catch {
    return undefined
  }
  if (typeof data !== "object" || data === null) return undefined
  const { handle, device, token } = data as Record<string, unknown>
  if (typeof handle !== "string" || typeof device !== "string" || typeof token !== "string") return undefined
  return new Identity(handle, device, token)
}

/** This device's identity: `<home>/identity.json` (0600) holds the handle, device name and token.
 *
 *  `opencorp` reads and writes the same file. The token in it is never printed, logged or committed. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"
import { FileLockError } from "@ngocbh/yian/platform"
import { makePrivateFolder, readPrivate, writePrivate } from "../secrets.ts"

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
  makePrivateFolder(path.dirname(path.resolve(file)))
  // Spelled out: toJSON leaves the token out.
  const { handle, device, token } = identity
  await writePrivate(file, JSON.stringify({ handle, device, token }, null, 2) + "\n")
}

/** The identity file exists but can't be used; the message says why and what to run, never what the file holds. */
export class IdentityUnreadable extends Error {
  override name = "IdentityUnreadable"

  constructor(
    readonly reason: "folder" | "file" | "lock" | "invalid" | "other",
    message: string,
  ) {
    super(message)
  }
}

/** The identity in `file`, or undefined if there is none. Rejects with `IdentityUnreadable` when the file is there
 *  but its folder or the file isn't private, the folder's lock can't be taken (yian's `FileLockError`, after its
 *  30 s wait for a busy one), it isn't an identity, or it can't be read. A missing file takes no lock. `read`
 *  stands in for `readPrivate` in tests. */
export async function loadIdentity(
  file: string,
  read: (file: string) => Promise<Buffer> = readPrivate,
): Promise<Identity | undefined> {
  file = path.resolve(file)
  try {
    fs.lstatSync(file)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    // Anything else is for the read to report.
  }
  let bytes: Buffer
  try {
    bytes = await read(file)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined
    throw unreadable(file, error)
  }
  // The message is fixed: a parse error can quote the file, token and all.
  const invalid = new IdentityUnreadable("invalid", `${file} isn't a valid identity; run \`opencorp login --force\``)
  let data: unknown
  try {
    // ignoreBOM keeps a leading BOM, so JSON.parse refuses it as Python's json.loads does.
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    throw invalid
  }
  if (typeof data !== "object" || data === null) throw invalid
  const { handle, device, token } = data as Record<string, unknown>
  if (typeof handle !== "string" || typeof device !== "string" || typeof token !== "string") throw invalid
  return new Identity(handle, device, token)
}

/** The identity in `file`, or undefined if there is none, it isn't one, the file or its folder isn't
 *  private, or the folder's lock can't be taken (yian's `FileLockError` after its 30 s wait). */
export async function readIdentity(file: string): Promise<Identity | undefined> {
  try {
    return await loadIdentity(file)
  } catch {
    return undefined
  }
}

function errnoCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** `path`'s stats without following a symlink, or undefined when they can't be read. */
function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p)
  } catch {
    return undefined
  }
}

/** Why reading `file` failed with `error`, and the fix. The folder and file are looked at again here, so the
 *  reason is advisory: either can change between the read and this look. */
function unreadable(file: string, error: unknown): IdentityUnreadable {
  if (error instanceof FileLockError) {
    if (error.reason === "busy") {
      return new IdentityUnreadable("lock", `another opencorp command holds ${error.path}; wait for it, then try again`)
    }
    return new IdentityUnreadable("lock", error.message)
  }
  const dir = path.dirname(file)
  const me = process.geteuid!()
  const folder = lstat(dir)
  if (folder !== undefined) {
    if (!folder.isDirectory() || folder.uid !== me) {
      return new IdentityUnreadable("folder", `${dir} must be a directory of yours, not a symlink`)
    }
    if ((folder.mode & 0o777) !== 0o700) {
      const mode = (folder.mode & 0o777).toString(8).padStart(4, "0")
      return new IdentityUnreadable("folder", `${dir} is mode ${mode}, not 0700; run \`chmod 700 ${dir}\``)
    }
  }
  const st = lstat(file)
  if (st !== undefined) {
    if (st.isFile() && st.uid === me && (st.mode & 0o777) !== 0o600) {
      const mode = (st.mode & 0o777).toString(8).padStart(4, "0")
      return new IdentityUnreadable("file", `${file} is mode ${mode}, not 0600; run \`chmod 600 ${file}\``)
    }
    if (!st.isFile() || st.uid !== me) {
      // Not `login --force`: the CLI reads the file before replacing it, and a FIFO would block that read.
      return new IdentityUnreadable(
        "file",
        `${file} isn't a regular 0600 file of yours; remove it, then run \`opencorp login\``,
      )
    }
  }
  return new IdentityUnreadable("other", `can't read ${file}: ${error instanceof Error ? error.message : String(error)}`)
}

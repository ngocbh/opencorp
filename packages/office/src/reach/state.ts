/** A visit's state in the hq folder: the lock that lets one `opencorp hq` run at a time, `access.json`, the redirect
 *  files that sign a browser in, and the clean-up a new visit starts with. */
import { createHash } from "node:crypto"
import { type FileLock, FileLockError, lockFile } from "@ngocbh/yian/platform"
import { Timestamp } from "@opencorp/protocol"
import { z } from "zod"
import { readPrivate, writePrivate } from "../secrets.ts"
import type { ReachPaths } from "./paths.ts"

/** Takes `hq/lock` for this visit, or null when another `opencorp hq` holds it. It's yian's `lockFile`, a SQLite
 *  exclusive transaction: the kernel frees it when this process dies however it dies, and no child holds it (POSIX
 *  locks aren't inherited, and SQLite opens the file close-on-exec). */
export function takeLock(paths: ReachPaths): FileLock | null {
  try {
    return lockFile(paths.lock, { private: true })
  } catch (error) {
    if (error instanceof FileLockError && error.reason === "busy") return null
    throw error
  }
}

/** The CLI's `LOCAL_PORT`, its printed socket forwards' port; the cookie is tied to it. */
export const DEFAULT_PORT = 49381

/** `access.json`: the local port HQ is forwarded to, the approved reach.sh's sha256, and when the path was learned,
 *  last used, and last signed a browser in. */
export const Access = z.strictObject({
  port: z.int().min(1024).max(65535),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  learned_at: Timestamp,
  last_used_at: Timestamp.nullable(),
  signed_in_at: Timestamp.nullable(),
})
export type Access = z.output<typeof Access>

/** `access.json` isn't JSON or isn't an `Access`. */
export class AccessError extends Error {
  override name = "AccessError"
}

/** `access.json`, or null when there's none yet. Rejects with `AccessError` when it's invalid, and with
 *  `PrivateFileError` when it or its folder isn't private. */
export async function readAccess(paths: ReachPaths): Promise<Access | null> {
  let text: string
  try {
    text = (await readPrivate(paths.access)).toString("utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new AccessError(`${paths.access} isn't JSON`)
  }
  const parsed = Access.safeParse(data)
  if (!parsed.success)
    throw new AccessError(`${paths.access} isn't valid: ${parsed.error.issues.map((i) => i.path.map(String).join(".") || "it").join(", ")}`)
  return parsed.data
}

/** Writes `access.json` (0600), after checking it. */
export async function writeAccess(paths: ReachPaths, access: Access): Promise<void> {
  await writePrivate(paths.access, JSON.stringify(Access.parse(access), null, 2) + "\n")
}

/** The sha256 of `bytes`, in hex. */
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

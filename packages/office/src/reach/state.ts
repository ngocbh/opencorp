/** A visit's state in the hq folder: the lock that lets one `opencorp hq` run at a time, `access.json`, the redirect
 *  files that sign a browser in, and the clean-up a new visit starts with. */
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type FileLock, FileLockError, lockFile } from "@ngocbh/yian/platform"
import { PairCode, Timestamp } from "@opencorp/protocol"
import { z } from "zod"
import { redirectPage, TTL } from "../hq/pairing.ts"
import { readPrivate, writePrivate } from "../secrets.ts"
import type { ReachPaths } from "./paths.ts"
import { exitAll, type ReachContext } from "./ssh.ts"

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

/** A one-time code as `PairCodes.mint` makes it: 16 random bytes in base64url. */
export const CODE = /^[A-Za-z0-9_-]{22}$/

/** The code in a remote `opencorp hq --json`'s `PairCode`, or null. Its `url` and `path` never reach the HTML: the
 *  link is built here. */
export function codeFrom(data: unknown): string | null {
  const parsed = PairCode.safeParse(data)
  if (!parsed.success || !parsed.data.path.startsWith("/pair#")) return null
  const code = parsed.data.path.slice("/pair#".length)
  return CODE.test(code) ? code : null
}

/** `hq/pair-<16 hex>.html` (0600, `redirectPage`) to `http://127.0.0.1:<port>/pair#<code>`; resolves to its path. */
export async function writeRedirect(paths: ReachPaths, port: number, code: string): Promise<string> {
  if (!CODE.test(code)) throw new Error("a pairing code is 22 base64url characters")
  const file = path.join(paths.dir, `pair-${randomBytes(8).toString("hex")}.html`)
  await writePrivate(file, redirectPage(`http://127.0.0.1:${port}/pair#${code}`))
  return file
}

/** Deletes `file` once its code expired, never sooner: the browser reads it after `open` returns. A process that ends
 *  first leaves the 0600 file, holding only an expired code by then, to the next visit's sweep. */
export function removeAtExpiry(file: string, ms: number = TTL): void {
  setTimeout(() => fs.rmSync(file, { force: true }), ms).unref()
}

const REDIRECTS = [/^pair-.*\.html$/, /^\.pair-.*\.html\..*\.tmp$/]

/** Deletes `pair-*.html` and `.pair-*.html.*.tmp` in `hq/` older than `TTL`. */
export function sweepRedirects(paths: ReachPaths, now: number): void {
  removeOlder(paths.dir, (name) => REDIRECTS.some((re) => re.test(name)), now - TTL)
}

/** How old a status file or a learning run's candidate must be before a new visit deletes it. */
export const STATUS_STALE_MS = 10 * 60_000

/** The lock holder's start: `exitAll`, `sweepRedirects`, and `ssh/status.*` and `reach.new.sh` older than
 *  `STATUS_STALE_MS`. */
export async function cleanUp(ctx: ReachContext, now: number): Promise<void> {
  const { paths } = ctx
  await exitAll(ctx)
  sweepRedirects(paths, now)
  removeOlder(paths.ssh, (name) => /^status\.[0-9]+$/.test(name), now - STATUS_STALE_MS)
  removeOlder(paths.dir, (name) => name === path.basename(paths.candidate), now - STATUS_STALE_MS)
}

/** Deletes the files in `dir` whose names `match` and that were last changed before `before` (ms). */
function removeOlder(dir: string, match: (name: string) => boolean, before: number): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  for (const name of names) {
    if (!match(name)) continue
    const file = path.join(dir, name)
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (st !== undefined && st.mtimeMs < before) fs.rmSync(file, { force: true })
  }
}

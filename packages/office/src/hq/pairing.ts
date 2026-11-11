/** One-time pairing codes (5 minutes), with an optional redirect file to open, so a code never sits in a process's
 *  arguments. There's no failure throttle: 128 bits can't be guessed in 5 minutes, redeeming costs one hash lookup,
 *  and a throttle would only let a co-tenant lock the owner out. */
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { logLine } from "../daemon/http.ts"
import { writePrivate } from "../secrets.ts"
import { escapeHtml } from "./static.ts"

/** How long a code lives, in ms. */
export const TTL = 5 * 60_000
/** The most codes waiting at once; minting past it drops the oldest. */
export const MAX_PENDING = 16

const LEFTOVER = [/^pair-.*\.html$/, /^\.pair-.*\.html\..*\.tmp$/]

/** A page that sends the browser on to `link` at once, its link escaped: what a redirect file holds, so the code never
 *  sits in an opener's arguments. */
export function redirectPage(link: string): string {
  const href = escapeHtml(link)
  return (
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}">` +
    `<title>OpenCorp HQ</title><a href="${href}">Open OpenCorp HQ</a>\n`
  )
}

/** Who a code signs a browser in as, who asked for it, the commit they were checked at, and until when. */
export interface Pending {
  handle: string
  issuer: string
  sha: string
  expiresAt: Date
  file: string | null
}

/** A new code, its expiry, and its redirect file if one was written. */
export interface Minted {
  code: string
  expiresAt: Date
  file: string | null
}

function key(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

/** The codes waiting to be used, by their sha256, in memory only. */
export class PairCodes {
  readonly officeDir: string
  readonly #clock: () => Date
  readonly #log: (line: string) => void
  // A Map keeps insertion order, so its first key is the oldest code.
  readonly #pending = new Map<string, { pending: Pending; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    officeDir: string,
    { clock = () => new Date(), log }: { clock?: () => Date; log: (line: string) => void },
  ) {
    this.officeDir = officeDir
    this.#clock = clock
    this.#log = log
  }

  /** A new code for `handle`, checked at commit `sha`; with `openFile` and a URL for it, a 0600 redirect file in the
   *  office dir. */
  async mint(
    handle: string,
    {
      issuer,
      url,
      openFile,
      sha,
    }: { issuer: string; url: (code: string) => string | null; openFile: boolean; sha: string },
  ): Promise<Minted> {
    const code = randomBytes(16).toString("base64url")
    const link = url(code)
    let file: string | null = null
    if (openFile && link !== null) {
      file = path.join(this.officeDir, `pair-${randomBytes(8).toString("hex")}.html`)
      await writePrivate(file, redirectPage(link))
    }
    // After the write, so other mints that ran meanwhile count toward the cap.
    this.sweep()
    while (this.#pending.size >= MAX_PENDING) this.#drop(this.#pending.keys().next().value!)
    const expiresAt = new Date(this.#clock().getTime() + TTL)
    // A second past expiry, so the sweep sees the code as expired.
    const timer = setTimeout(() => this.sweep(), TTL + 1000)
    timer.unref()
    this.#pending.set(key(code), { pending: { handle, issuer, sha, expiresAt, file }, timer })
    // Never the code.
    this.#log(logLine("INFO", "opencorp.hq.pairing", `pairing code minted for @${handle} by @${issuer}`))
    return { code, expiresAt, file }
  }

  /** Spends `code`: who it signs in as, or null if it's wrong, used or expired. */
  redeem(code: string): Pending | null {
    this.sweep()
    return this.#drop(key(code))
  }

  /** Forgets expired codes and deletes their files. */
  sweep(): void {
    const now = this.#clock().getTime()
    for (const [k, { pending }] of this.#pending) if (pending.expiresAt.getTime() <= now) this.#drop(k)
  }

  /** Forgets every code, deletes the files and clears the timers (the office is stopping). */
  close(): void {
    for (const k of this.#pending.keys()) this.#drop(k)
  }

  /** Deletes redirect files, and their temporary files, that a crashed office left in the office dir. */
  removeLeftovers(): void {
    let names: string[]
    try {
      names = fs.readdirSync(this.officeDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const name of names) {
      if (LEFTOVER.some((re) => re.test(name))) fs.rmSync(path.join(this.officeDir, name), { force: true })
    }
  }

  /** Shows the office dir and how many codes wait, never a code or its key. */
  toJSON(): { officeDir: string; pending: number } {
    return { officeDir: this.officeDir, pending: this.#pending.size }
  }

  /** Shows the office dir and how many codes wait, never a code or its key. */
  [inspect.custom](): { officeDir: string; pending: number } {
    return this.toJSON()
  }

  /** Forgets the code with key `k`, deletes its file and clears its timer; what it was, or null if none. */
  #drop(k: string): Pending | null {
    const entry = this.#pending.get(k)
    if (entry === undefined) return null
    this.#pending.delete(k)
    clearTimeout(entry.timer)
    if (entry.pending.file) fs.rmSync(entry.pending.file, { force: true })
    return entry.pending
  }
}

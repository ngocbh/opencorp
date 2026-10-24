/** One-time pairing codes (5 minutes), with an optional redirect file to open, so a code never sits in a process's
 *  arguments. There's no failure throttle: 128 bits can't be guessed in 5 minutes, redeeming costs one hash lookup,
 *  and a throttle would only let a co-tenant lock the owner out. */
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { logLine } from "../daemon/http.ts"
import { writePrivate } from "../secrets.ts"
import { escapeHtml } from "./static.ts"

/** How long a code lives, in ms. */
export const TTL = 5 * 60_000
/** The most codes waiting at once; minting past it drops the oldest. */
export const MAX_PENDING = 16

const LEFTOVER = [/^pair-.*\.html$/, /^\.pair-.*\.html\..*\.tmp$/]

/** Who a code signs a browser in as, who asked for it, and until when. */
export interface Pending {
  handle: string
  issuer: string
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
  readonly #pending = new Map<string, Pending>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    officeDir: string,
    { clock = () => new Date(), log }: { clock?: () => Date; log: (line: string) => void },
  ) {
    this.officeDir = officeDir
    this.#clock = clock
    this.#log = log
  }

  /** A new code for `handle`; with `openFile` and a URL for it, a 0600 redirect file in the office dir. */
  async mint(
    handle: string,
    { issuer, url, openFile }: { issuer: string; url: (code: string) => string | null; openFile: boolean },
  ): Promise<Minted> {
    const code = randomBytes(16).toString("base64url")
    const link = url(code)
    let file: string | null = null
    if (openFile && link !== null) {
      file = path.join(this.officeDir, `pair-${randomBytes(8).toString("hex")}.html`)
      const href = escapeHtml(link)
      const page =
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}">` +
        `<title>OpenCorp HQ</title><a href="${href}">Open OpenCorp HQ</a>\n`
      await writePrivate(file, page)
    }
    // After the write, so other mints that ran meanwhile count toward the cap.
    this.sweep()
    while (this.#pending.size >= MAX_PENDING) this.#drop(this.#pending.keys().next().value!)
    const expiresAt = new Date(this.#clock().getTime() + TTL)
    this.#pending.set(key(code), { handle, issuer, expiresAt, file })
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      this.sweep()
    }, TTL + 1000)
    timer.unref()
    this.#timers.add(timer)
    // Never the code.
    this.#log(logLine("INFO", "opencorp.hq.pairing", `pairing code minted for @${handle} by @${issuer}`))
    return { code, expiresAt, file }
  }

  /** Spends `code`: who it signs in as, or null if it's wrong, used or expired. */
  redeem(code: string): Pending | null {
    this.sweep()
    const k = key(code)
    const pending = this.#pending.get(k) ?? null
    if (pending !== null) this.#drop(k)
    return pending
  }

  /** Forgets expired codes and deletes their files. */
  sweep(): void {
    const now = this.#clock().getTime()
    for (const [k, p] of this.#pending) if (p.expiresAt.getTime() <= now) this.#drop(k)
  }

  /** Forgets every code, deletes the files and clears the timers (the office is stopping). */
  close(): void {
    for (const k of this.#pending.keys()) this.#drop(k)
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
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
  [Symbol.for("nodejs.util.inspect.custom")](): { officeDir: string; pending: number } {
    return this.toJSON()
  }

  #drop(k: string): void {
    const pending = this.#pending.get(k)
    this.#pending.delete(k)
    if (pending?.file) fs.rmSync(pending.file, { force: true })
  }
}

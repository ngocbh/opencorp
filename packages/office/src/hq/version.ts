/** The ids that keep the web app and the office in step: the `api` compatibility key and the app's build. */
import fs from "node:fs"
import path from "node:path"
import { AppBuild } from "@opencorp/protocol"
import { apiId } from "@opencorp/protocol/version"

/** The checkout this code runs from (`packages/office/src/hq` up four). */
export const CHECKOUT = path.resolve(import.meta.dirname, "../../../..")

let api: string | undefined

/** The compatibility key (`apiId()`), computed once and kept: it hashes the protocol's JSON Schema. */
export function officeApi(): string {
  api ??= apiId()
  return api
}

/** The largest build.json read; a bigger one isn't valid. */
export const MAX_BUILD_JSON = 64 * 1024

/** Up to `MAX_BUILD_JSON + 1` bytes of `file`; null when it isn't a regular file. */
function readUpTo(file: string): Buffer | null {
  const { O_RDONLY, O_NONBLOCK } = fs.constants
  // O_NONBLOCK so a FIFO in its place can't hang the open; fstat then refuses it.
  const fd = fs.openSync(file, O_RDONLY | O_NONBLOCK)
  try {
    if (!fs.fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(MAX_BUILD_JSON + 1)
    let size = 0
    while (size < buf.length) {
      const n = fs.readSync(fd, buf, size, buf.length - size, null)
      if (n === 0) break // a short read isn't the end of the file; only 0 is
      size += n
    }
    return buf.subarray(0, size)
  } finally {
    fs.closeSync(fd)
  }
}

/** The built app's `build.json` under `appDir`, parsed again only when its content changes. */
export class BuildInfo {
  readonly path: string | null
  // The bytes last read and what they parsed to.
  private cache: [Buffer, AppBuild | null] | null = null

  constructor(appDir: string | null) {
    this.path = appDir === null ? null : path.join(appDir, "build.json")
  }

  /** The app's build and key; null when it isn't built or the file isn't valid. */
  read(): AppBuild | null {
    if (this.path === null) return null
    // A few hundred bytes, read once per /api/health. Comparing bytes, not the mtime: two builds within one tick
    // of Linux's coarse inode clock have the same mtime.
    let raw: Buffer | null = null
    try {
      raw = readUpTo(this.path)
    } catch {}
    if (raw === null || raw.length > MAX_BUILD_JSON) {
      this.cache = null
      return null
    }
    const cache = this.cache
    if (cache !== null && cache[0].equals(raw)) return cache[1]
    let build: AppBuild | null = null
    try {
      // ignoreBOM keeps a leading BOM, so JSON.parse refuses it rather than the file being repaired.
      const parsed = AppBuild.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)))
      build = parsed.success ? parsed.data : null
    } catch {} // bad UTF-8 or JSON, or a RangeError from deep nesting
    this.cache = [raw, build]
    return build
  }
}

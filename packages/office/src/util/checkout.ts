/** The OpenCorp checkout this code runs from, its source, and the source a build was stamped with. */
import fs from "node:fs"
import path from "node:path"
import { selfBinary } from "../platform.ts"

/** Where `packages/cli/script/build.ts` puts a checkout's binary by default, which is where install.sh runs it. */
const BUILT = /^(\/.+)\/packages\/cli\/dist\/npm\/opencorp-[a-z0-9]+-[a-z0-9]+\/bin\/opencorp$/

/** The checkout the binary at `binary` (a realpath) was built in: `<checkout>` for
 *  `<checkout>/packages/cli/dist/npm/opencorp-<os>-<cpu>/bin/opencorp`; null for a binary anywhere else (npm's). */
export function binaryCheckout(binary: string): string | null {
  return BUILT.exec(binary)?.[1] ?? null
}

const binary = selfBinary()

/** The checkout this code runs from: four folders up from this file's (`packages/office/src/util`); for the compiled
 *  binary, whose files aren't on disk, the one it was built in, or `/` for one built elsewhere. */
export const CHECKOUT =
  binary === null ? path.resolve(import.meta.dirname, "../../../..") : (binaryCheckout(binary) ?? "/")

/** The source folders of the code the office runs from `checkout`: the office, protocol, CLI and Yian sources. */
export function sourceRoots(checkout: string): string[] {
  return ["office", "protocol", "cli", "yian"].map((pkg) => path.join(checkout, "packages", pkg, "src"))
}

/** The newest modification time (ms) of the source the office runs from `checkout`: the files under its
 *  `sourceRoots`. 0 when nothing is found, as for an npm install, which holds no source. */
export function newestSource(checkout: string): number {
  return Math.max(0, ...sourceRoots(checkout).map(newestUnder))
}

/** The newest modification time (ms) of the regular files under `dir`, at any depth; 0 when there are none. What
 *  can't be read is skipped. */
function newestUnder(dir: string): number {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let newest = 0
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestUnder(file))
    else if (entry.isFile()) {
      try {
        newest = Math.max(newest, fs.statSync(file).mtimeMs)
      } catch {
        // removed while this ran, or unreadable
      }
    }
  }
  return newest
}

/** The build's stamp: its checkout's `newestSource` as the build began, which `packages/cli/script/build.ts` defines. */
declare const OPENCORP_SOURCE: number | undefined

/** The newest source (ms) of the checkout the running binary was built from, which no copy or touch of its file
 *  changes; null when this code runs from source. */
export const BUILT_FROM: number | null = typeof OPENCORP_SOURCE === "undefined" ? null : OPENCORP_SOURCE

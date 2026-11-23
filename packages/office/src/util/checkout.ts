/** The OpenCorp checkout this code runs from. */
import path from "node:path"
import { selfBinary } from "../platform.ts"

/** Where `packages/cli/script/build.ts` puts a checkout's binary by default, which is where install.sh runs it. */
const BUILT = /^(\/.+)\/packages\/cli\/dist\/npm\/opencorp-[a-z0-9]+-[a-z0-9]+\/bin\/opencorp$/

/** The checkout the binary at `binary` (a realpath) was built in: `<checkout>` for
 *  `<checkout>/packages/cli/dist/npm/opencorp-<os>-<cpu>/bin/opencorp`; null for a binary anywhere else (npm's). */
export function binaryCheckout(binary: string): string | null {
  return BUILT.exec(binary)?.[1] ?? null
}

/** The checkout this code runs from: four folders up from this file's (`packages/office/src/util`). The compiled
 *  binary's files sit at `/$bunfs/root`, so its checkout is the one it was built in, or `/` for one built elsewhere. */
export const CHECKOUT = import.meta.dirname.startsWith("/$bunfs")
  ? (binaryCheckout(selfBinary() ?? "") ?? "/")
  : path.resolve(import.meta.dirname, "../../../..")

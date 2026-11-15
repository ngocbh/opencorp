/** The OpenCorp checkout this code runs from. */
import path from "node:path"

/** The checkout this code runs from: four folders up from this file's (`packages/office/src/util`); `/` in the
 *  compiled binary, whose files sit at `/$bunfs/root`. */
export const CHECKOUT = path.resolve(import.meta.dirname, "../../../..")

/** `opencorp offboard`: take this machine's office away again, leaving the company's history where it is safe. */
import fs from "node:fs"
import path from "node:path"
import type { Env } from "./launch.ts"

/** What the owner is asked before anything is removed, and the two answers. */
export const CONFIRM = "Remove all this?"
export const KEEP = "No, keep it all"
export const REMOVE = "Yes, remove it"

/** What an `opencorp` launcher runs, relative to the checkout: the wrapper, or the CLI's entry. */
export const LAUNCHERS: readonly string[] = [
  path.join("packages", "cli", "bin", "opencorp"),
  path.join("packages", "cli", "src", "main.ts"),
]

/** The checkout this module runs from; `/` in the compiled binary, which holds none of `LAUNCHERS`. */
export const REPO = path.resolve(import.meta.dirname, "../../../..")

/** Offboarding stopped; the message says why and what was left. */
export class OffboardError extends Error {
  override name = "OffboardError"
}

/** The answer to whether to remove it all was no. */
export class Declined extends OffboardError {
  override name = "Declined"
}

/** Whether `file` is `dir` or inside it, compared by path components. */
function inside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file)
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}

/** The `name` files on `PATH` that run the checkout at `repo`: links into it, or scripts naming one of its
 *  `entries`; in `PATH` order. */
export function launchers(
  environ: Env,
  repo: string,
  { name = "opencorp", entries = LAUNCHERS }: { name?: string; entries?: readonly string[] } = {},
): string[] {
  let realRepo: string
  try {
    realRepo = fs.realpathSync(repo)
  } catch {
    realRepo = path.resolve(repo)
  }
  const found: string[] = []
  for (const folder of (environ.PATH ?? "").split(":")) {
    if (!folder) continue
    const file = path.join(folder, name)
    let ours = false
    try {
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) {
        // A dangling link throws here, so it isn't ours.
        ours = inside(fs.realpathSync(file), realRepo)
      } else if (stat.isFile() && stat.size < 4096) {
        const text = new TextDecoder().decode(fs.readFileSync(file))
        ours = entries.some((e) => text.includes(path.join(repo, e)) || text.includes(path.join(realRepo, e)))
      }
    } catch {
      ours = false
    }
    if (ours && !found.includes(file)) found.push(file)
  }
  return found
}

import fs from "fs/promises"
import fuzzysort from "fuzzysort"
import path from "path"

const SKIP = new Set([".git", "node_modules"])

/** How many matching files a search collects before it stops scanning. */
export const FILE_SCAN_LIMIT = 200

/** Files under `cwd` (as `/`-separated relative paths) that fuzzily match `query`, best first. Collects at most `limit` matches and skips `.git` and `node_modules`. */
export async function findFiles(cwd: string, query: string, limit = FILE_SCAN_LIMIT): Promise<string[]> {
  const found: string[] = []
  const take = (rel: string) => {
    const file = rel.split(path.sep).join("/")
    if (file.split("/").some((s) => SKIP.has(s))) return
    if (query && !fuzzysort.single(query, file)) return
    found.push(file)
  }
  try {
    // Scan the top level first so the big skipped trees at the root are never walked.
    const dirs: string[] = []
    for await (const name of new Bun.Glob("*").scan({ cwd, onlyFiles: false, dot: true })) {
      if (SKIP.has(name)) continue
      const stat = await fs.stat(path.join(cwd, name)).catch(() => undefined)
      if (stat?.isDirectory()) dirs.push(name)
      else if (stat) take(name)
      if (found.length >= limit) break
    }
    for (const dir of dirs.sort()) {
      if (found.length >= limit) break
      for await (const rel of new Bun.Glob("**/*").scan({ cwd: path.join(cwd, dir), dot: true })) {
        take(path.join(dir, rel))
        if (found.length >= limit) break
      }
    }
  } catch {
    return []
  }
  if (!query) return found
  return fuzzysort.go(query, found).map((r) => r.target)
}

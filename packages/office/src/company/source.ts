/** The company repo's files at the HEADs the office served, for HQ's read-only Source view, shown as stored. */
import type { CompanyFile as CompanyFileSchema, CompanyTree as CompanyTreeSchema } from "@opencorp/protocol"
import type { z } from "zod"
import { type CompanyGit, isCommitId, type TreeEntry } from "./git.ts"

type CompanyFile = z.output<typeof CompanyFileSchema>
type CompanyTree = z.output<typeof CompanyTreeSchema>

/** How many served HEADs a file can be read at. */
export const RING = 8
/** How many rendered files are kept, by commit and path. */
export const RENDERED = 32
/** The most entries a tree response carries. */
export const TREE_CAP = 5000
/** The largest file read, in bytes; a bigger one is `too_large`. */
export const MAX_FILE = 1 << 20
/** The largest symlink target read, in bytes; a bigger one is `too_large`. */
export const MAX_LINK = 4 << 10

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

/** A file request the Source view refuses: `status` and `code` as the API returns them. */
export class SourceError extends Error {
  override name = "SourceError"
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Whether `path` isn't a repo-relative, `/`-separated path with no empty, `.` or `..` segment or NUL. */
export function badPath(path: unknown): boolean {
  if (typeof path !== "string" || !path || path.includes("\0")) return true
  return path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
}

/** `data` as text: strict UTF-8 with no C0 control character but tab, LF and CR; null means binary. A BOM is
 *  kept, as stored. */
function asText(data: Uint8Array): string | null {
  let text: string
  try {
    text = UTF8.decode(data)
  } catch {
    return null
  }
  return CONTROL.test(text) ? null : text
}

/** A HEAD the tree route listed: its readable entries by path and the tree response. */
interface Served {
  readonly listing: Map<string, TreeEntry>
  readonly tree: CompanyTree
}

/**
 * The Source view's reads: trees at HEADs, loaded once per commit, and files at the last `RING` of them.
 *
 * Only commits the tree route lists enter the ring, so a file read never reaches a commit, ref or revision
 * expression from a request.
 */
export class CompanySource {
  readonly git: CompanyGit
  readonly #treeCap: number
  // Maps iterate in insertion order: re-setting a key makes it the newest, and the first key is the oldest.
  readonly #ring = new Map<string, Served>()
  readonly #loading = new Map<string, Promise<Served>>()
  readonly #rendered = new Map<string, CompanyFile>()

  constructor(git: CompanyGit, { treeCap = TREE_CAP }: { treeCap?: number } = {}) {
    this.git = git
    this.#treeCap = treeCap
  }

  /** The listing and tree response at `sha`, a HEAD the office read itself. */
  async #load(sha: string): Promise<Served> {
    const listing = new Map<string, TreeEntry>()
    let skipped = 0
    for (const entry of await this.git.listTree(sha)) {
      // A name that wasn't UTF-8 holds lone surrogates, which can't go to a browser or be asked for back.
      if (!entry.path.isWellFormed() || badPath(entry.path)) skipped += 1
      else listing.set(entry.path, entry)
    }
    const commit = await this.git.commitInfo(sha)
    const depth = (path: string) => path.split("/").length - 1
    const ordered = [...listing.values()].sort((a, b) =>
      depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const tree: CompanyTree = {
      commit,
      entries: ordered.slice(0, this.#treeCap).map((e) => ({ path: e.path, type: e.type, size: e.size })),
      truncated: ordered.length > this.#treeCap,
      skipped,
    }
    return { listing, tree }
  }

  /** The tree at `sha`, a HEAD the office read itself; it becomes the newest commit files can be read at. */
  async tree(sha: string): Promise<CompanyTree> {
    let served = this.#ring.get(sha)
    if (served === undefined) {
      let load = this.#loading.get(sha)
      if (load === undefined) {
        load = this.#load(sha)
        this.#loading.set(sha, load)
        // Callers await `load` itself and see its error; this only settles the bookkeeping.
        const settle = () => this.#loading.delete(sha)
        load.then(settle, settle)
      }
      served = await load
    }
    this.#ring.delete(sha)
    this.#ring.set(sha, served)
    while (this.#ring.size > RING) this.#ring.delete(this.#ring.keys().next().value!)
    return served.tree
  }

  /**
   * The file at `path` in the listing of served HEAD `at`.
   *
   * `SourceError`: 400 `bad_path` for a malformed path, 409 `stale_commit` when `at` isn't in the ring, 404
   * `no_file` for a path not in that listing or a folder.
   */
  async file(at: unknown, path: unknown): Promise<CompanyFile> {
    if (badPath(path)) throw new SourceError(400, "bad_path", "the path isn't a repo-relative file path")
    // A plain string match against commits the office listed: never resolved by git.
    const served = isCommitId(at) ? this.#ring.get(at) : undefined
    if (served === undefined) {
      throw new SourceError(409, "stale_commit", "that commit isn't one the office served lately; refetch the tree")
    }
    const entry = served.listing.get(path as string)
    if (entry === undefined || entry.type === "folder") {
      throw new SourceError(404, "no_file", "no such file in that commit")
    }
    const key = `${at}:${entry.path}`
    const done = this.#rendered.get(key)
    if (done !== undefined) {
      this.#rendered.delete(key)
      this.#rendered.set(key, done)
      return done
    }
    const found = await this.#render(at as string, entry)
    this.#rendered.set(key, found)
    while (this.#rendered.size > RENDERED) this.#rendered.delete(this.#rendered.keys().next().value!)
    return found
  }

  /** The file response for `entry` at `sha`: its text as stored, or why it has none. */
  async #render(sha: string, entry: TreeEntry): Promise<CompanyFile> {
    const out = (content: CompanyFile["content"], fields: Partial<CompanyFile> = {}): CompanyFile => ({
      path: entry.path,
      commit: sha,
      content,
      text: null,
      target: null,
      reason: null,
      rewritten: false,
      ...fields,
    })
    if (entry.type === "submodule") return out("submodule")
    if ((entry.size ?? 0) > (entry.type === "symlink" ? MAX_LINK : MAX_FILE)) return out("too_large")
    const data = await this.git.readBlob(entry.blob)
    if (data === null) throw new Error(`the clone has no blob for ${JSON.stringify(entry.path)} at ${sha}`)
    const text = asText(data)
    if (text === null) return out("binary")
    if (entry.type === "symlink") return out("symlink", { target: text }) // shown, never followed
    return out("text", { text })
  }
}

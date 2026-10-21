// The company repo's files as Source shows them: the flat listing as a tree, and paths in the one path format
// (repo-relative, `/`-separated, no leading or trailing `/`, the root ""). Pure, so it's tested without a browser.
import type { CompanyFile, CompanyTreeEntry } from "@opencorp/protocol"

export type EntryType = CompanyTreeEntry["type"]

/** A tree item: its id is its path. Only folders have children. */
export type Entry = { id: string; name: string; type: EntryType; children: Entry[] }

/** The last segment of `path`. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** The folder holding `path`; "" for the root's entries. */
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))

/** Folders first, then everything else, each by name. */
const order = (a: Entry, b: Entry) =>
  Number(b.type === "folder") - Number(a.type === "folder") || a.name.localeCompare(b.name)

/** The listing as a tree. A folder the listing left out (past the cap) is made from its entries' paths. */
export function buildFiles(entries: CompanyTreeEntry[]): Entry[] {
  const root: Entry = { id: "", name: "", type: "folder", children: [] }
  const byPath = new Map<string, Entry>([["", root]])
  const folder = (path: string): Entry => {
    let e = byPath.get(path)
    if (!e) {
      e = { id: path, name: nameOf(path), type: "folder", children: [] }
      byPath.set(path, e)
      folder(parentOf(path)).children.push(e)
    }
    return e
  }
  for (const { path, type } of entries) {
    if (type === "folder") folder(path)
    else if (!byPath.has(path)) {
      const e: Entry = { id: path, name: nameOf(path), type, children: [] }
      byPath.set(path, e)
      folder(parentOf(path)).children.push(e)
    }
  }
  const sort = (list: Entry[]) => (list.sort(order), list.forEach((e) => sort(e.children)))
  sort(root.children)
  return root.children
}

/** `path`'s type in the listing: the root is a folder; a path the listing doesn't hold has none. */
export const typeOf = (types: Map<string, EntryType>, path: string): EntryType | undefined =>
  path === "" ? "folder" : types.get(path)

/** The folders above `path`, outermost first; the root isn't one. */
export function ancestors(path: string): string[] {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))
}

/** A breadcrumb's segments for `path`, each with the path it opens; none for the root. */
export const crumbs = (path: string) => (path ? [...ancestors(path), path].map((p) => ({ path: p, name: nameOf(p) })) : [])

/** The closest folder above `path` that `isFolder` accepts; the root when there's none. */
export function nearestFolder(path: string, isFolder: (path: string) => boolean): string {
  return ancestors(path).reverse().find(isFolder) ?? ""
}

/** What the pane says about a file it can't show as written, or undefined for plain text. */
export function noteOf(f: Pick<CompanyFile, "content" | "target">): string | undefined {
  switch (f.content) {
    case "binary":
      return "Binary file."
    case "too_large":
      return "Too large to show."
    case "symlink":
      return `Symlink to ${f.target ?? "an unknown target"}.`
    case "submodule":
      return "Submodule."
  }
}

/** A file's lines: LF or CRLF; a final newline doesn't start another line. */
export function lines(text: string): string[] {
  const all = text.split(/\r?\n/)
  if (all.length > 1 && all[all.length - 1] === "") all.pop()
  return all
}

import { expect, test } from "bun:test"
import type { CompanyTreeEntry } from "@opencorp/protocol"
import { ancestors, buildFiles, crumbs, lines, nearestFolder, noteOf, typeOf, type Entry } from "../src/company/files"
import { moveFocus, visibleRows } from "../src/company/rows"

const entries: CompanyTreeEntry[] = [
  { path: "people", type: "folder" },
  { path: "README.md", type: "file", size: 10 },
  { path: "assets", type: "folder" },
  { path: "people/kai", type: "folder" },
  { path: "people/kai/person.yaml", type: "file", size: 80 },
  { path: "people/kai/profile.md", type: "file", size: 20 },
  { path: "people/ann", type: "folder" },
  { path: "docs", type: "symlink", size: 9 },
  { path: "vendor", type: "submodule" },
  { path: "company.yaml", type: "file", size: 30 },
]

const shape = (list: Entry[]): unknown => list.map((e) => (e.type === "folder" ? [e.name, shape(e.children)] : e.name))

test("folders first, then files (symlinks and submodules with them), each sorted by name", () => {
  expect(shape(buildFiles(entries))).toEqual([
    ["assets", []],
    ["people", [["ann", []], ["kai", ["person.yaml", "profile.md"]]]],
    "company.yaml",
    "docs",
    "README.md",
    "vendor",
  ])
})

test("an entry's id is its path; a folder the listing left out is made from its children's paths", () => {
  const roots = buildFiles([{ path: "a/b/c.txt", type: "file", size: 1 }])
  expect(roots[0]).toMatchObject({ id: "a", name: "a", type: "folder" })
  expect(roots[0].children[0].children[0]).toMatchObject({ id: "a/b/c.txt", name: "c.txt", type: "file" })
})

test("the tree's keys work on files: right opens a folder, then moves into it", () => {
  const roots = buildFiles(entries)
  const closed = visibleRows(roots, () => false)
  expect(moveFocus(closed, "people", "ArrowRight")).toEqual({ open: "people", to: true })
  const open = visibleRows(roots, (e) => e.id === "people")
  expect(open.map((r) => r.item.id)).toEqual(["assets", "people", "people/ann", "people/kai", "company.yaml", "docs", "README.md", "vendor"])
  expect(moveFocus(open, "people", "ArrowRight")).toEqual({ focus: "people/ann" })
  expect(moveFocus(open, "people/kai", "ArrowLeft")).toEqual({ focus: "people" })
})

test("a path's type: the root and listed folders are folders; an unlisted path has none", () => {
  const types = new Map(entries.map((e) => [e.path, e.type]))
  expect(typeOf(types, "")).toBe("folder")
  expect(typeOf(types, "people/kai")).toBe("folder")
  expect(typeOf(types, "docs")).toBe("symlink")
  expect(typeOf(types, "gone.md")).toBeUndefined()
})

test("ancestors, breadcrumb segments and the nearest folder that still exists", () => {
  expect(ancestors("people/kai/person.yaml")).toEqual(["people", "people/kai"])
  expect(ancestors("README.md")).toEqual([])
  expect(crumbs("people/kai")).toEqual([{ path: "people", name: "people" }, { path: "people/kai", name: "kai" }])
  expect(crumbs("")).toEqual([])
  const folders = new Set(["people"])
  expect(nearestFolder("people/zed/person.yaml", (p) => folders.has(p))).toBe("people")
  expect(nearestFolder("gone/deep/file", (p) => folders.has(p))).toBe("")
})

test("each content state's note; plain text has none", () => {
  expect(noteOf({ content: "text" })).toBeUndefined()
  expect(noteOf({ content: "binary" })).toBe("Binary file.")
  expect(noteOf({ content: "too_large" })).toBe("Too large to show.")
  expect(noteOf({ content: "symlink", target: "../README.md" })).toBe("Symlink to ../README.md.")
  expect(noteOf({ content: "submodule" })).toBe("Submodule.")
})

test("a file's lines: a final newline doesn't add an empty line; CRLF splits too", () => {
  expect(lines("a\nb\n")).toEqual(["a", "b"])
  expect(lines("a\r\n\nb")).toEqual(["a", "", "b"])
  expect(lines("")).toEqual([""])
})

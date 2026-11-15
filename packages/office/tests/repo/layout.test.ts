/**
 * The office's folder layout (ARCHITECTURE.md, "Where tests live" and "Feature folders"): `tests/` mirrors `src/`,
 * every test file at an old path is placed in `TEST_PLACES`, and each feature folder keeps its shape.
 */
import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PLACES, TEST_PLACES } from "./places.ts"
import { CODE, filesUnder, importsOf, SRC, TESTS } from "./scan.ts"

/** Test folders with no `src/` folder of their own. */
const UNMIRRORED = /^(e2e|fixtures|repo)(\/|$)/

const SRC_FILES = filesUnder(SRC)
const TEST_FILES = filesUnder(TESTS).filter((file) => !UNMIRRORED.test(file))

/** The folder `file` is in, as a path under its root (`""` for the root). */
function folderOf(file: string): string {
  const dir = path.posix.dirname(file)
  return dir === "." ? "" : dir
}

/** Whether `dir`, a path under `src/`, is a folder there. */
const srcFolder = (dir: string): boolean => fs.statSync(path.join(SRC, dir), { throwIfNoEntry: false })?.isDirectory() ?? false

/** The old `src/` folders: each that directly holds a `PLACES` entry. */
const OLD = new Set(Object.keys(PLACES).map(folderOf).filter((dir) => dir !== ""))

/** Whether the test file `file` is in an old test folder: the nearest of its folders that `src/` also has is old. */
function inOldFolder(file: string): boolean {
  for (let dir = folderOf(file); dir !== ""; dir = folderOf(dir)) if (srcFolder(dir)) return OLD.has(dir)
  return false
}

test("every test folder that holds a ts file has its src folder", () => {
  const folders = new Set(TEST_FILES.filter((file) => CODE.test(file)).map(folderOf))
  expect([...folders].filter((dir) => dir !== "" && !srcFolder(dir))).toEqual([])
})

test("every test file in an old folder is placed, once, at a free path", () => {
  const problems: string[] = []
  for (const file of TEST_FILES) {
    if (inOldFolder(file) && !(file in TEST_PLACES)) problems.push(`${file} is in an old folder but not in TEST_PLACES`)
  }
  for (const [from, to] of Object.entries(TEST_PLACES)) {
    if (!TEST_FILES.includes(from)) problems.push(`TEST_PLACES names ${from}, which doesn't exist`)
    if (TEST_FILES.includes(to) && !(to in TEST_PLACES)) problems.push(`TEST_PLACES moves ${from} onto ${to}, which exists`)
  }
  const finals = Object.values(TEST_PLACES)
  for (const to of new Set(finals.filter((to, i) => finals.indexOf(to) !== i))) problems.push(`two files go to ${to}`)
  expect(problems).toEqual([])
})

/** What a feature folder may hold at its top, besides JS or TS modules and the data files they embed. */
const FEATURE_FOLDERS = new Set(["flows", "tools", "skills"])

test("each feature folder holds only flows, tools, skills, modules and the files they embed", () => {
  const places = SRC_FILES.map((file) => ({ file, place: PLACES[file] ?? file }))
  const problems: string[] = []
  for (const { file, place } of places.filter(({ place }) => place.startsWith("features/"))) {
    const [, feature, ...rest] = place.split("/")
    if (rest.length > 1 && FEATURE_FOLDERS.has(rest[0]!)) continue
    if (rest.length > 1) {
      problems.push(`${place}: a feature folder holds only ${[...FEATURE_FOLDERS].join(", ")} as folders`)
      continue
    }
    if (CODE.test(place)) continue
    // A data file is embedded by a module of the same feature folder, with `with { type: "file" }`.
    const embedded = places.some(
      (other) =>
        other.place.startsWith(`features/${feature}/`) &&
        other.place.split("/").length === 3 &&
        CODE.test(other.place) &&
        importsOf(fs.readFileSync(path.join(SRC, other.file), "utf8")).some(
          (imp) => imp.data && path.posix.join(path.posix.dirname(other.file), imp.specifier) === file,
        ),
    )
    if (!embedded) problems.push(`${place}: no module of features/${feature} embeds it`)
  }
  expect(problems).toEqual([])
})

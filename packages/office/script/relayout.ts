/**
 * Moves one category's files from their old folders to their final paths, and rewrites every path that names them
 * (ARCHITECTURE.md, "The office's layers"). Run it in `packages/office` of a clean checkout:
 *
 *   bun script/relayout.ts <category> [--dry-run]
 *
 * It `git mv`s each `src/` file whose `PLACES` path is in the category and each test whose `TEST_PLACES` path is
 * under `tests/<category>/`, then rewrites: relative import specifiers (`/// <reference path>`s too); strings that
 * start with `./` or `../` and name a path that exists, and the all-dots roots passed with `import.meta` on their
 * line; strings equal to a moved file's `src/`-relative path; strings and root-doc code spans equal to its
 * `packages/office/src/` path; the package's export keys and their consumers; and the category's `REPLACE` entries.
 * It deletes the moved entries from `tests/repo/places.ts`, stages everything, and fails if any specifier, or any
 * relative string that named a path before the move, no longer resolves, or a moved test's folder lacks its `src/`
 * folder. Before it changes anything it fails on an all-dots path from a moved file's folder that it can't rewrite
 * and that would name another folder, a moved `places.ts` entry that isn't one line, and an export key it can't find
 * to rename. With `--dry-run` it makes every check that needs no move, prints what it would move, rewrite and keep,
 * and changes nothing. It refuses any other argument, and a checkout whose `packages/yian` submodule isn't checked
 * out: a relative string is rewritten only when it names a path that exists, and tests name files in yian.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { CYCLES, PLACES, TEST_PLACES, UPWARD } from "../tests/repo/places.ts"
import { blank, CODE, filesUnder, importsOf, literals } from "../tests/repo/scan.ts"

const CATEGORIES = ["util", "company", "runtime", "models", "tools", "features", "server"]
const OFFICE = path.resolve(import.meta.dirname, "..")
const REPO = path.resolve(OFFICE, "../..")
const SRC = path.join(OFFICE, "src")
const TESTS = path.join(OFFICE, "tests")
/** The office's own files the codemod never rewrites: the tables it reads, and itself. */
const KEEP = [path.join(TESTS, "repo"), path.join(OFFICE, "script")]
/** The packages whose files may name the office's paths or exports. */
const PACKAGES = ["office", "cli", "tui", "app", "client", "protocol"]

/** One edit no rule derives: in `file` (under `packages/office`, at its path before the move), `count`
 *  occurrences of `old` become `new`. */
interface Replace {
  file: string
  old: string
  new: string
  count: number
}

/** The pins each category's move must edit by hand, applied after the rules. */
const REPLACE: Readonly<Record<string, readonly Replace[]>> = {
  runtime: [
    // hostImports' worker-only modules, as module ids under src/.
    {
      file: "tests/chat/session_actor.test.ts",
      old: 'new Set(["worker/main", "chat/history"])',
      new: 'new Set(["runtime/worker/main", "runtime/worker/history"])',
      count: 1,
    },
    {
      file: "tests/chat/session_actor.test.ts",
      old: 'mod === "worker/main")',
      new: 'mod === "runtime/worker/main")',
      count: 1,
    },
    // Its fixtures: specifiers relative to made-up files, and what they resolve to.
    {
      file: "tests/chat/session_actor.test.ts",
      old: '["../worker/main.ts", "../worker/main.js", "../worker/main"]',
      new: '["../runtime/worker/main.ts", "../runtime/worker/main.js", "../runtime/worker/main"]',
      count: 1,
    },
    { file: "tests/chat/session_actor.test.ts", old: '"a/b.ts: worker/main.ts"', new: '"a/b.ts: runtime/worker/main.ts"', count: 2 },
    {
      file: "tests/chat/session_actor.test.ts",
      old: `'await import("../worker/main.ts")'`,
      new: `'await import("../runtime/worker/main.ts")'`,
      count: 1,
    },
    {
      file: "tests/chat/session_actor.test.ts",
      old: `hostImports("chat/b.ts", 'import { readSeed } from "./history.js"')).toEqual(["chat/b.ts: chat/history.ts"])`,
      new: `hostImports("runtime/worker/b.ts", 'import { readSeed } from "./history.js"')).toEqual([\n    "runtime/worker/b.ts: runtime/worker/history.ts",\n  ])`,
      count: 1,
    },
    {
      file: "tests/chat/session_actor.test.ts",
      old: `'export { readSeed } from "../chat/history"')).toEqual(["a/b.ts: chat/history.ts"])`,
      new: `'export { readSeed } from "../runtime/worker/history"')).toEqual([\n    "a/b.ts: runtime/worker/history.ts",\n  ])`,
      count: 1,
    },
    {
      file: "tests/chat/session_actor.test.ts",
      old: `'export * from "../chat/history.ts"')).toEqual(["a/b.ts: chat/history.ts"])`,
      new: `'export * from "../runtime/worker/history.ts"')).toEqual([\n    "a/b.ts: runtime/worker/history.ts",\n  ])`,
      count: 1,
    },
    {
      file: "tests/chat/session_actor.test.ts",
      old: `'import type { WorkerEnv } from "../worker/main.ts"'`,
      new: `'import type { WorkerEnv } from "../runtime/worker/main.ts"'`,
      count: 1,
    },
    {
      file: "tests/chat/session_actor.test.ts",
      old: `'import type { Seeded } from "../chat/history.ts"'`,
      new: `'import type { Seeded } from "../runtime/worker/history.ts"'`,
      count: 1,
    },
    {
      file: "tests/chat/session_actor.test.ts",
      old: `'await import("./worker/main.ts")'`,
      new: `'await import("./runtime/worker/main.ts")'`,
      count: 1,
    },
    { file: "tests/chat/session_actor.test.ts", old: '!file.startsWith("worker/")', new: '!file.startsWith("runtime/worker/")', count: 1 },
  ],
  features: [
    // The reach flows' labels: a folder prefix, which rule 4 doesn't match.
    { file: "tests/reach/flows.test.ts", old: "`reach/flows/${name}.yaml`", new: "`features/reach/flows/${name}.yaml`", count: 1 },
  ],
}

/** Runs git in the checkout; its output, trimmed. */
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim()
}

/** Whether `p` is a file or a folder. */
const exists = (p: string): boolean => fs.existsSync(p)
const isDir = (p: string): boolean => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false

/** `to` from the folder `dir`, as a relative specifier: `./x` or `../x`, `/`-separated. */
function relative(dir: string, to: string): string {
  const rel = path.relative(dir, to).split(path.sep).join("/")
  return rel === "" ? "." : rel.startsWith("../") || rel === ".." ? rel : `./${rel}`
}

function fail(message: string): never {
  console.error(`relayout: ${message}`)
  process.exit(1)
}

const [category = "", ...flags] = process.argv.slice(2)
if (!CATEGORIES.includes(category)) fail(`name a category: ${CATEGORIES.join(", ")}`)
if (flags.some((flag) => flag !== "--dry-run")) fail(`unknown argument in ${flags.join(" ")}: the only option is --dry-run`)
const dryRun = flags.length > 0
if (!exists(path.join(REPO, "packages/yian/package.json")))
  fail("packages/yian is empty: run `git submodule update --init packages/yian` first")
if (UPWARD.length || CYCLES.length) fail("UPWARD and CYCLES in tests/repo/places.ts must be empty first")
if (git("status", "--porcelain")) fail("the checkout has changes; commit or stash them first")

/** This move's files, absolute old path to absolute new path. */
const moves = new Map<string, string>()
for (const [from, to] of Object.entries(PLACES)) if (to.startsWith(`${category}/`)) moves.set(path.join(SRC, from), path.join(SRC, to))
for (const [from, to] of Object.entries(TEST_PLACES))
  if (to.startsWith(`${category}/`)) moves.set(path.join(TESTS, from), path.join(TESTS, to))
if (moves.size === 0) fail(`nothing left to move into ${category}/`)

// places.ts without the moved entries, which the codemod deletes by line, so each must be one line.
const placesFile = path.join(TESTS, "repo/places.ts")
const movedKeys = new Set(
  [...moves.keys()].map((file) =>
    JSON.stringify(path.relative(file.startsWith(`${SRC}${path.sep}`) ? SRC : TESTS, file).split(path.sep).join("/")),
  ),
)
const placesLines = fs.readFileSync(placesFile, "utf8").split("\n")
const placesKept = placesLines.filter((line) => !movedKeys.has(line.match(/^ {2}("[^"]+"): "[^"]+",$/)?.[1] ?? ""))
if (placesLines.length - placesKept.length !== moves.size)
  fail(
    `tests/repo/places.ts: ${moves.size} entries move, but ${placesLines.length - placesKept.length} of its lines are theirs; write each entry on one line`,
  )

/** Where the file or folder at `p` (absolute) is after the move. A folder moves only when every file under it
 *  moves to the same new folder, or stays when none leaves it; one that splits fails. */
function where(p: string): string {
  const moved = moves.get(p)
  if (moved) return moved
  if (!isDir(p)) return p
  const inside = filesUnder(p).map((rel) => path.join(p, rel))
  if (inside.every((file) => (moves.get(file) ?? file).startsWith(`${p}${path.sep}`))) return p
  const to = path.dirname(moves.get(inside[0]!) ?? inside[0]!)
  const base = path.join(to, path.relative(path.dirname(inside[0]!), p))
  if (inside.every((file) => moves.get(file) === path.join(base, path.relative(p, file)))) return base
  return fail(`${path.relative(REPO, p)} splits in this move; give its strings a REPLACE entry`)
}

/** One span of a file's text and what replaces it. */
interface Edit {
  start: number
  end: number
  text: string
}

/** Old `src/`-relative path to new, for this move's `src/` files. */
const srcMoves = new Map([...moves].filter(([from]) => from.startsWith(`${SRC}${path.sep}`)).map(([from, to]) => [
  path.relative(SRC, from).split(path.sep).join("/"),
  path.relative(SRC, to).split(path.sep).join("/"),
]))

const ALL_DOTS = /^\.\.(\/\.\.)*\/?$/
const IMPORT_META = /import\.meta\.(url|dirname|dir)\b/

/** Each relative string that named a path before the move, as its file's new path and its new text: after the move
 *  each must still resolve. */
const anchored: { file: string; value: string }[] = []

/** Each all-dots path from a moved file's folder that the move would leave naming another folder, as `file:line`. */
const unrewritten: string[] = []

/** The brackets around offset `at` in `code` (`blank`'s text): the innermost `(…)`, `[…]` or `{…}`, from its opener
 *  to its closer, or none at the top level. */
function group(code: string, at: number): { open: number; close: number } | undefined {
  let open = -1
  for (let i = at - 1, depth = 0; i >= 0 && open < 0; i--) {
    if (")]}".includes(code[i]!)) depth++
    else if ("([{".includes(code[i]!) && depth-- === 0) open = i
  }
  if (open < 0) return undefined
  let close = code.length
  for (let i = open + 1, depth = 0; i < code.length && close === code.length; i++) {
    if ("([{".includes(code[i]!)) depth++
    else if (")]}".includes(code[i]!) && depth-- === 0) close = i
  }
  return { open, close }
}

/** Whether the string literal at `start` in `code` is a path from its file's folder: it sits in one call's arguments
 *  or one array with `import.meta.url`, `.dir` or `.dirname`, or in the arguments of `join`, `resolve` or `new URL`.
 *  A comparison such as `rel === ".."` is neither. */
function fromOwnFolder(code: string, start: number): boolean {
  const around = group(code, start)
  if (!around || code[around.open] === "{") return false
  if (IMPORT_META.test(code.slice(around.open, around.close))) return true
  return code[around.open] === "(" && /(?:(?<![\w$])(?:join|resolve)|(?<![\w$])new\s+URL)\s*$/.test(code.slice(0, around.open))
}

/** The edits rules 2 to 5 make to `file` (absolute), a JS or TS file. */
function edits(file: string, text: string): Edit[] {
  const office = file.startsWith(`${OFFICE}${path.sep}`)
  const dir = path.dirname(file)
  const newDir = path.dirname(where(file))
  const found: Edit[] = []
  const specifiers = new Set<number>()
  if (office) {
    for (const imp of importsOf(text)) {
      if (!imp.specifier.startsWith(".")) continue
      specifiers.add(imp.start)
      const target = path.resolve(dir, imp.specifier)
      if (!exists(target)) fail(`${path.relative(REPO, file)}:${imp.line}: ${imp.specifier} names nothing`)
      const next = relative(newDir, where(target))
      if (next !== imp.specifier) found.push({ start: imp.start, end: imp.end, text: next })
    }
  }
  const code = office ? blank(text) : ""
  for (const { start, end } of literals(text)) {
    if (specifiers.has(start)) continue
    const value = text.slice(start, end)
    let next: string | undefined
    if (office && ALL_DOTS.test(value)) {
      // A package or checkout root: only when passed with import.meta (`.url`, `.dir`, `.dirname`) on its line.
      const line = text.slice(text.lastIndexOf("\n", start) + 1, text.indexOf("\n", end))
      if (IMPORT_META.test(line)) {
        next = relative(newDir, path.resolve(dir, value)) + (value.endsWith("/") ? "/" : "")
        anchored.push({ file: where(file), value: next })
      } else if (path.resolve(newDir, value) !== path.resolve(dir, value) && fromOwnFolder(code, start)) {
        unrewritten.push(`${path.relative(REPO, file)}:${text.slice(0, start).split("\n").length}: "${value}"`)
      }
    } else if (office && /^\.\.?\//.test(value) && exists(path.resolve(dir, value))) {
      next = relative(newDir, where(path.resolve(dir, value))) + (value.endsWith("/") ? "/" : "")
      anchored.push({ file: where(file), value: next })
    } else if (office && srcMoves.has(value)) {
      next = srcMoves.get(value)
    } else if (value.startsWith("packages/office/src/") && srcMoves.has(value.slice("packages/office/src/".length))) {
      next = `packages/office/src/${srcMoves.get(value.slice("packages/office/src/".length))}`
    }
    if (next !== undefined && next !== value) found.push({ start, end, text: next })
  }
  return found
}

/** `text` with `found` applied. */
function apply(text: string, found: Edit[]): string {
  let out = text
  for (const edit of [...found].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

// The export keys this move renames: `./runs/index_thread` to `./runtime/runs/index_thread`, for each file that moves.
const pkgFile = path.join(OFFICE, "package.json")
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { exports: Record<string, string> }
const keys = new Map<string, string>()
for (const [key, value] of Object.entries(pkg.exports)) {
  const from = value.replace(/^\.\/src\//, "")
  const to = srcMoves.get(from)
  if (to && key === `./${from.replace(/\.ts$/, "")}`) keys.set(key.slice(2), to.replace(/\.ts$/, ""))
}

const changed = new Map<string, string>()
const sources = PACKAGES.flatMap((name) =>
  filesUnder(path.join(REPO, "packages", name))
    .filter((rel) => CODE.test(rel))
    .map((rel) => path.join(REPO, "packages", name, rel)),
).filter((file) => !KEEP.some((dir) => file.startsWith(`${dir}${path.sep}`)))
for (const file of sources) {
  const text = fs.readFileSync(file, "utf8")
  let next = apply(text, edits(file, text))
  for (const [from, to] of keys) next = next.replace(new RegExp(`@opencorp/office/${from}(?![\\w/.-])`, "g"), `@opencorp/office/${to}`)
  if (next !== text) changed.set(file, next)
}
if (unrewritten.length)
  fail(
    `these paths from a moved file's folder would name another folder, and only one passed with import.meta.url, .dir or .dirname on its line is rewritten:\n${unrewritten.join("\n")}`,
  )
// Root docs: a code span naming a moved file by its repo path.
for (const name of fs.readdirSync(REPO).filter((name) => name.endsWith(".md"))) {
  const file = path.join(REPO, name)
  if (fs.lstatSync(file).isSymbolicLink()) continue
  const text = fs.readFileSync(file, "utf8")
  const next = text.replace(/`packages\/office\/src\/([^`]+)`/g, (span, rel: string) =>
    srcMoves.has(rel) ? `\`packages/office/src/${srcMoves.get(rel)}\`` : span,
  )
  if (next !== text) changed.set(file, next)
}
if (keys.size) {
  const text = fs.readFileSync(pkgFile, "utf8")
  let next = text
  for (const [from, to] of keys) {
    const entry = `"./${from}": "./src/${from}.ts"`
    if (!next.includes(entry)) fail(`packages/office/package.json has no ${entry} to rename; write each export as one "key": "value"`)
    next = next.replace(entry, `"./${to}": "./src/${to}.ts"`)
  }
  changed.set(pkgFile, next)
}
for (const entry of REPLACE[category] ?? []) {
  const file = path.join(OFFICE, entry.file)
  const text = changed.get(file) ?? fs.readFileSync(file, "utf8")
  const count = text.split(entry.old).length - 1
  if (count !== entry.count) fail(`${entry.file}: REPLACE expects ${entry.count} of ${entry.old}, found ${count}`)
  changed.set(file, text.split(entry.old).join(entry.new))
}

if (dryRun) {
  const src = [...moves.keys()].filter((file) => file.startsWith(`${SRC}${path.sep}`)).length
  const kept = Object.keys(PLACES).length + Object.keys(TEST_PLACES).length - moves.size
  console.log(
    `relayout ${category} (dry run): would move ${src} + ${moves.size - src} = ${moves.size} files, rewrite ${changed.size}; places.ts would keep ${kept} entries`,
  )
  process.exit(0)
}

// Write the edits at the old paths, then move.
for (const [file, text] of changed) fs.writeFileSync(file, text)
for (const [from, to] of moves) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  git("mv", from, to)
}
// Folders the move emptied.
for (const from of moves.keys()) {
  for (let dir = path.dirname(from); dir !== SRC && dir !== TESTS; dir = path.dirname(dir)) {
    if (!exists(dir) || fs.readdirSync(dir).length) break
    fs.rmdirSync(dir)
  }
}
// The moved entries leave places.ts.
fs.writeFileSync(placesFile, placesKept.join("\n"))
git("add", "-A", "packages/office", ...PACKAGES.map((name) => `packages/${name}`), ...fs.readdirSync(REPO).filter((n) => n.endsWith(".md")))

// Everything still resolves, and tests/ still mirrors src/.
const problems: string[] = []
for (const { file, value } of anchored)
  if (!exists(path.resolve(path.dirname(file), value))) problems.push(`${path.relative(REPO, file)}: "${value}"`)
for (const file of [...filesUnder(SRC).map((rel) => path.join(SRC, rel)), ...filesUnder(TESTS).map((rel) => path.join(TESTS, rel))]) {
  if (!CODE.test(file)) continue
  const text = fs.readFileSync(file, "utf8")
  for (const imp of importsOf(text)) {
    if (imp.specifier.startsWith(".") && !exists(path.resolve(path.dirname(file), imp.specifier)))
      problems.push(`${path.relative(REPO, file)}:${imp.line}: ${imp.specifier}`)
  }
}
for (const [, to] of moves) {
  if (!to.startsWith(`${TESTS}${path.sep}`) || !CODE.test(to)) continue
  const dir = path.relative(TESTS, path.dirname(to))
  if (!isDir(path.join(SRC, dir))) problems.push(`tests/${dir} has no src/${dir}`)
}
if (problems.length) fail(`these no longer resolve:\n${[...new Set(problems)].join("\n")}`)
console.log(`relayout ${category}: moved ${moves.size} files, rewrote ${changed.size}`)

/**
 * The office's layers and import rules (ARCHITECTURE.md, "The office's layers").
 *
 * Every file has a layer; imports go down or stay in their layer; inside a category the folders import one way;
 * util stays generic. Also here: the Bun lints, no `require()`, the sandbox helper's imports, what the daemon loads
 * before it re-execs, and the folder cards' columns.
 */
import { expect, onTestFinished, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { blank, CODE, filesUnder, type Import, importsOf, resolveIn, SRC } from "./scan.ts"

/** The categories, lowest first; `main.ts` sits above them all. */
const CATEGORIES = ["util", "company", "runtime", "models", "tools", "features", "server"] as const
/** The files directly in `src/` that have a layer: `platform.ts` and `files.d.ts` are util's, `main.ts` the top. */
const ROOT_FILES: Readonly<Record<string, number>> = { "platform.ts": 1, "files.d.ts": 1, "main.ts": 8 }
/** `testing/`'s layer: outside the order, it may import anything. */
const TESTING = 9

/** The layer of a path under `src/`: 1 for util up to 7 for server, 8 for `main.ts`, 9 for `testing/`, 0 for none. */
function layerOf(file: string): number {
  if (!file.includes("/")) return ROOT_FILES[file] ?? 0
  const top = file.split("/")[0]!
  if (top === "testing") return TESTING
  return CATEGORIES.indexOf(top as (typeof CATEGORIES)[number]) + 1
}

/** A path's folder inside its category: `features/chat` for `features/chat/x.ts`, and the category itself
 *  for its root files (`platform.ts` and `files.d.ts` are util's). */
function folderOf(file: string): string {
  const parts = file.split("/")
  if (parts.length === 1) return "util"
  return parts.length === 2 ? parts[0]! : `${parts[0]}/${parts[1]}`
}

/** Every file under `src/`, as paths relative to it. */
const FILES = filesUnder(SRC)

/** The text of `file`, a path under `src/`. */
const source = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8")

/** Every JS or TS file under the office's src, as paths relative to it. */
function sourceFiles(): string[] {
  return FILES.filter((name) => CODE.test(name))
}

/** One relative import: who imports, what it names (both paths under `src/`), and how. */
interface Edge {
  from: string
  to: string
  imp: Import
}

/** Every relative import of the JS and TS files under `src/`. */
function edges(): Edge[] {
  return sourceFiles().flatMap((from) =>
    importsOf(source(from))
      .filter((imp) => imp.specifier.startsWith("."))
      .map((imp) => ({ from, to: resolveIn(from, imp.specifier), imp })),
  )
}

test("importsOf reads every kind of import, and none in comments or strings", () => {
  const text = [
    'import fs from "node:fs"',
    'import type { A } from "./a.ts"',
    'import { type B, type C as D } from "./b.ts"',
    'import { e, type F } from "./e.ts"',
    'export * from "./g.ts"',
    'export { h as i } from "./h.ts"',
    'import "./side.ts"',
    'import sql from "./x.sql" with { type: "file" }',
    'import flow from "./flow.yaml" with {',
    '  type: "file",',
    "}",
    'const m = await import("./m.ts")',
    '/// <reference path="../files.d.ts" />',
    "/// <reference path='./more.d.ts' />",
    '// import { no } from "./comment.ts"',
    'const s = \'import { no } from "./string.ts"\'',
    "export const x = 1",
  ].join("\n")
  const got = importsOf(text).map(({ kind, specifier, typeOnly, data, names }) => ({ kind, specifier, typeOnly, data, names }))
  expect(got).toEqual([
    { kind: "static", specifier: "node:fs", typeOnly: false, data: false, names: ["default"] },
    { kind: "static", specifier: "./a.ts", typeOnly: true, data: false, names: ["A"] },
    { kind: "static", specifier: "./b.ts", typeOnly: true, data: false, names: ["B", "C"] },
    { kind: "static", specifier: "./e.ts", typeOnly: false, data: false, names: ["e", "F"] },
    { kind: "static", specifier: "./g.ts", typeOnly: false, data: false, names: ["*"] },
    { kind: "static", specifier: "./h.ts", typeOnly: false, data: false, names: ["h"] },
    { kind: "side", specifier: "./side.ts", typeOnly: false, data: false, names: [] },
    { kind: "static", specifier: "./x.sql", typeOnly: false, data: true, names: ["default"] },
    { kind: "static", specifier: "./flow.yaml", typeOnly: false, data: true, names: ["default"] },
    { kind: "dynamic", specifier: "./m.ts", typeOnly: false, data: false, names: ["import()"] },
    { kind: "reference", specifier: "../files.d.ts", typeOnly: true, data: false, names: [] },
    { kind: "reference", specifier: "./more.d.ts", typeOnly: true, data: false, names: [] },
  ])
})

test("filesUnder skips node_modules, .git and a package's dist, not a dist inside src", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-scan-"))
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of ["package.json", "dist/main.js", "node_modules/x/index.ts", ".git/HEAD", "src/a.ts", "src/dist/b.mts"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), "")
  }
  expect(filesUnder(root)).toEqual(["package.json", "src/a.ts", "src/dist/b.mts"])
  expect(filesUnder(path.join(root, "src")).filter((file) => CODE.test(file))).toEqual(["a.ts", "dist/b.mts"])
})

test("every file has a layer", () => {
  expect(FILES.filter((file) => layerOf(file) === 0)).toEqual([])
  expect(layerOf("server/hq/x.ts")).toBe(7)
  expect(layerOf("hq/x.ts")).toBe(0)
  expect(layerOf("x.ts")).toBe(0)
})

test("every relative import names a file", () => {
  const missing = edges().filter(({ to }) => !FILES.includes(to))
  expect(missing.map(({ from, imp }) => `${from}: ${imp.specifier}`)).toEqual([])
})

// `require()` loads a module the import scan doesn't see, so src never calls it: not bare, not as `module.require`
// or Bun's `import.meta.require`, and not through `createRequire`.
const REQUIRE = /(?<![\w$])require\s*\(|\bcreateRequire\b/

test("src loads modules only with import, never require", () => {
  for (const sample of [
    'const m = require("../daemon/office.ts")',
    "module.require(x)",
    'import.meta.require("./x.ts")',
    "const load = createRequire(import.meta.url)",
  ])
    expect(blank(sample)).toMatch(REQUIRE)
  for (const sample of ['// require("../daemon/office.ts")', 'const s = \'require("x")\'', "requireAuth(x)", "const required = (x)"])
    expect(blank(sample)).not.toMatch(REQUIRE)
  const found = sourceFiles().filter((file) => REQUIRE.test(blank(source(file))))
  expect(found).toEqual([])
})

// The import scan reads a dynamic import's specifier only when it is one quoted string, so src never computes one:
// not a template, a variable or a sum. An `import(` not followed by a lone quoted string and `,` or `)` fails.
const COMPUTED_IMPORT = /(?<![\w$.])import\s*\((?!\s*(["'])[^"'\n]*\1\s*[,)])/

test("every dynamic import in src names its module in one quoted string", () => {
  for (const sample of ["await import(`../daemon/office.ts`)", "import(name)", 'import("../daemon/" + name)', "import(\n  file,\n)"])
    expect(blank(sample)).toMatch(COMPUTED_IMPORT)
  for (const sample of [
    'await import("../daemon/office.ts")',
    "import('./x.ts')",
    'import(\n  "./x.ts",\n)',
    'import("./x.yaml", { with: { type: "file" } })',
    'type T = typeof import("./x.ts")',
    "import.meta.url",
    "loader.import(name)",
    "// import(name)",
  ])
    expect(blank(sample)).not.toMatch(COMPUTED_IMPORT)
  const found = sourceFiles().filter((file) => COMPUTED_IMPORT.test(blank(source(file))))
  expect(found).toEqual([])
})

test("imports go down or stay in their layer", () => {
  const up = edges().filter(({ from, to }) => {
    const layer = layerOf(from)
    return layer !== TESTING && layerOf(to) > layer
  })
  expect(up.map(({ from, to }) => `${from} -> ${to}`)).toEqual([])
})

test("nothing in src imports testing", () => {
  const into = edges().filter(({ from, to }) => layerOf(from) !== TESTING && layerOf(to) === TESTING)
  expect(into.map(({ from, to }) => `${from} -> ${to}`)).toEqual([])
})

/** The folder cycles inside each category, each as its folders sorted. */
function cycles(): string[][] {
  const next = new Map<string, Set<string>>()
  for (const { from, to } of edges()) {
    if (layerOf(from) !== layerOf(to) || layerOf(from) > CATEGORIES.length || folderOf(from) === folderOf(to)) continue
    if (!next.has(folderOf(from))) next.set(folderOf(from), new Set())
    next.get(folderOf(from))!.add(folderOf(to))
  }
  // Tarjan's strongly connected components; a component of two or more folders is a cycle.
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const found: string[][] = []
  const visit = (node: string): void => {
    index.set(node, index.size)
    low.set(node, index.get(node)!)
    stack.push(node)
    for (const to of next.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to)
        low.set(node, Math.min(low.get(node)!, low.get(to)!))
      } else if (stack.includes(to)) {
        low.set(node, Math.min(low.get(node)!, index.get(to)!))
      }
    }
    if (low.get(node) !== index.get(node)) return
    const component: string[] = []
    let top: string
    do {
      top = stack.pop()!
      component.push(top)
    } while (top !== node)
    if (component.length > 1) found.push(component.sort())
  }
  for (const node of [...next.keys()].sort()) if (!index.has(node)) visit(node)
  return found
}

test("inside a category the folders have no cycles", () => {
  expect(cycles()).toEqual([])
})

/** The folder that holds only data files (no `.ts`) is part of the folder that embeds it, so it has no card. */
const DATA_ONLY = new Set(
  [...new Set(FILES.filter((file) => file.split("/").length > 2).map((file) => file.split("/").slice(0, 2).join("/")))]
    .filter((dir) => !FILES.some((file) => file.startsWith(`${dir}/`) && file.endsWith(".ts"))),
)

/** The card `file` belongs to: `main.ts`, a category's root (`runtime`, with `platform.ts` in `util`), or one of
 *  its folders (`runtime/store`); null for `testing/` and `files.d.ts`, which have none. */
function cardOf(file: string): string | null {
  const parts = file.split("/")
  if (parts.length === 1) return file === "main.ts" ? "main.ts" : file === "platform.ts" ? "util" : null
  if (parts[0] === "testing") return null
  if (parts.length === 2) return parts[0]!
  const dir = `${parts[0]}/${parts[1]}`
  return DATA_ONLY.has(dir) ? parts[0]! : dir
}

/** `cards` in the cards' format, by category lowest first: `runtime` for its root files, `runtime/store` for one
 *  folder, `runtime/{a, b}` for several, `runtime (root, a, b)` for the root and folders, `main.ts`; `—` for none. */
function cell(cards: ReadonlySet<string> | undefined): string {
  if (!cards?.size) return "—"
  const out: string[] = []
  for (const category of [...CATEGORIES, "main.ts"]) {
    const mine = [...cards].filter((card) => card === category || card.startsWith(`${category}/`))
    if (!mine.length) continue
    const folders = mine.filter((card) => card !== category).map((card) => card.slice(category.length + 1)).sort()
    if (!folders.length) out.push(category)
    else if (mine.includes(category)) out.push(`${category} (root, ${folders.join(", ")})`)
    else out.push(folders.length === 1 ? `${category}/${folders[0]}` : `${category}/{${folders.join(", ")}}`)
  }
  return out.join(", ")
}

/** Each card's "Depends on" and "Used by", from the imports. */
function cardColumns(): Map<string, { depends: string; usedBy: string }> {
  const deps = new Map<string, Set<string>>()
  const users = new Map<string, Set<string>>()
  for (const { from, to } of edges()) {
    const [a, b] = [cardOf(from), cardOf(to)]
    if (a === null || b === null || a === b) continue
    if (!deps.has(a)) deps.set(a, new Set())
    if (!users.has(b)) users.set(b, new Set())
    deps.get(a)!.add(b)
    users.get(b)!.add(a)
  }
  const cards = [...new Set([...deps.keys(), ...users.keys()])].sort()
  return new Map(cards.map((card) => [card, { depends: cell(deps.get(card)), usedBy: cell(users.get(card)) }]))
}

const ARCHITECTURE = path.resolve(SRC, "../../../ARCHITECTURE.md")

/** The folder cards' rows in ARCHITECTURE.md, by folder (`runtime` for "`runtime/` root files"): their "Depends on"
 *  and "Used by", each up to a `;`, after which come users outside the office package. */
function cardRows(): Map<string, { depends: string; usedBy: string }> {
  const text = fs.readFileSync(ARCHITECTURE, "utf8")
  const start = text.indexOf("| Folder | Is | Does | Depends on | Used by |")
  expect(start).toBeGreaterThanOrEqual(0)
  const rows = new Map<string, { depends: string; usedBy: string }>()
  for (const line of text.slice(start).split("\n").slice(2)) {
    if (!line.startsWith("|")) break
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
    const folder = cells[0]!.match(/^`([^`]+?)\/?`/)?.[1]
    const upTo = (cell: string) => cell.split(";")[0]!.trim() || "—"
    if (folder !== undefined) rows.set(folder, { depends: upTo(cells[3]!), usedBy: upTo(cells[4]!) })
  }
  return rows
}

test("each folder card in ARCHITECTURE.md names what its folder imports and what imports it", () => {
  const rows = cardRows()
  const columns = cardColumns()
  const problems: string[] = []
  for (const [card, want] of columns) {
    if (!/^(runtime|models|tools|features|server)(\/|$)/.test(card)) continue
    const row = rows.get(card)
    if (row === undefined) problems.push(`${card}: no card | ${want.depends} | ${want.usedBy}`)
    else if (row.depends !== want.depends || row.usedBy !== want.usedBy)
      problems.push(`${card}: | ${want.depends} | ${want.usedBy}`)
  }
  for (const folder of rows.keys())
    if (!DATA_ONLY.has(folder) && !columns.has(folder)) problems.push(`${folder}: a card for no folder`)
  expect(problems).toEqual([])
})

/** The packages util may import besides `node:` builtins, and the subpaths of protocol. */
const UTIL_PACKAGES = /^(node:.+|@ngocbh\/yian\/platform|@opencorp\/protocol(\/.+)?)$/

test("util imports only builtins, platform.ts, util, yian's platform and the protocol", () => {
  const problems: string[] = []
  for (const from of sourceFiles().filter((file) => layerOf(file) === 1)) {
    for (const imp of importsOf(source(from))) {
      if (!imp.specifier.startsWith(".")) {
        const bun = from === "platform.ts" && /^bun:/.test(imp.specifier)
        if (!bun && !UTIL_PACKAGES.test(imp.specifier)) problems.push(`${from}: ${imp.specifier}`)
        continue
      }
      if (layerOf(resolveIn(from, imp.specifier)) !== 1) problems.push(`${from}: ${imp.specifier}`)
    }
  }
  expect(problems).toEqual([])
})

// The patterns read source text, so they can't see a specifier built at run time,
// `globalThis["Bu" + "n"]`, or a cast other than `(Bun as T)`; review catches those. They also scan
// comments, so a comment outside platform.ts says "Bun's" or "the Bun runtime", never "Bun" then a dot
// and a name. BUN_MODULE refuses any string literal naming the bun module or a bun: module.
const BUN_API =
  /(?<![\w$])Bun\s*(?:\?\.|[.[])|=\s*Bun\b|\bglobalThis\s*\??\.\s*Bun\b|\bglobalThis\s*\[\s*["'`]Bun\b|\(\s*Bun\s+as\b/
const BUN_MODULE = /["'`]bun(?::[\w-]+)?["'`]/

test("no Bun or bun: API outside platform.ts", () => {
  for (const sample of [
    "Bun.spawn(",
    'globalThis.Bun["file"]',
    "Bun?.file(p)",
    "const { spawn } = Bun",
    "const B = globalThis.Bun",
    'globalThis["Bun"].spawn',
    "(Bun as any).spawn",
  ])
    expect(sample).toMatch(BUN_API)
  for (const sample of [
    'import { Database } from "bun:sqlite"',
    "await import('bun:ffi')",
    'import { file } from "bun"',
    'require("bun:test")',
    "import(`bun:ffi`)",
  ])
    expect(sample).toMatch(BUN_MODULE)
  for (const sample of [
    "type F = BunFile",
    "// Bun reads .env",
    'import { x } from "./bun.ts"',
    "// the file. Bun loads it",
    "// Bun's loader",
  ]) {
    expect(sample).not.toMatch(BUN_API)
    expect(sample).not.toMatch(BUN_MODULE)
  }
  const files = sourceFiles()
  expect(files).toContain("platform.ts")
  expect(files).toContain("main.ts")
  expect(source("platform.ts")).toMatch(BUN_API)
  for (const name of files) {
    if (name === "platform.ts") continue
    const text = source(name)
    expect(BUN_API.test(text), `${name} uses a Bun API`).toBe(false)
    expect(BUN_MODULE.test(text), `${name} imports a bun module`).toBe(false)
  }
})

// Refuses any mention of execPath, argv0 or execve, `process.argv[0]` (also by `.at(0)` or
// destructuring) and `fork` (a call, or a name in braces): `child_process.fork()` spawns process.execPath
// with the parent's whole env and cwd, and `process.execve` is reexec's job. It can't see a spawn of bun by
// name from PATH (BUN_MODULE refuses only a bare "bun" literal) or a name built at run time; review catches
// those.
const SELF =
  /\b(?:execPath|argv0|execve)\b|process\.argv\s*(?:\[\s*0\s*\]|\.at\s*\(\s*0\s*\))|\[[^\]]*\]\s*=\s*process\.argv\b|\bfork\s*\(|\{[^}]*(?<![\w-])fork\b[^}]*\}/

test("no spawn of process.execPath outside platform.ts", () => {
  for (const sample of [
    "process.argv[0]",
    "const { execPath } = process",
    'fork("./x.ts")',
    "child_process.fork(m)",
    'process.execve("/bin/sh")',
    'import { execPath } from "node:process"',
    "proc.execPath",
    'process["execPath"]',
    "const [bin] = process.argv",
    "process.argv.at(0)",
    'import { fork as f } from "node:child_process"',
  ])
    expect(sample).toMatch(SELF)
  for (const sample of [
    "process.argv[2]",
    "process.argv.slice(2)",
    "selfCommand()",
    "forked(x)",
    "forkSession(id)",
    `{ "(allow process-exec process-fork)" }`,
  ])
    expect(sample).not.toMatch(SELF)
  expect(source("platform.ts")).toMatch(SELF)
  for (const name of sourceFiles()) {
    if (name === "platform.ts") continue
    expect(SELF.test(source(name)), `${name} names the office's own executable`).toBe(false)
  }
})

test("the sandbox helper imports only node builtins", () => {
  // The sandbox exposes only Bun and the helper's own file to it (`helperFiles` in runtime/sandbox/policy.ts).
  const specifiers = importsOf(source("runtime/sandbox/fs_helper.ts")).map((imp) => imp.specifier)
  expect(specifiers.length).toBeGreaterThan(0)
  expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([])
})

/** What each file the daemon loads before it re-execs may import, by path: `node:` builtins (and `bun:` for
 *  `platform.ts`), and the files listed. Type-only imports count, except `platform.ts`'s, which load nothing. */
const PRE_REEXEC: Readonly<Record<string, { files: readonly string[]; bun?: true; values?: true }>> = {
  "runtime/service/launch.ts": { files: ["platform.ts", "util/sockets.ts", "util/proc.ts", "util/env.ts"] },
  "util/proc.ts": { files: ["platform.ts"] },
  "util/sockets.ts": { files: [] },
  "util/env.ts": { files: [] },
  "platform.ts": { files: [], bun: true, values: true },
}

test("the daemon loads only builtins and the pre-re-exec files before it re-execs", () => {
  const problems: string[] = []
  for (const [file, rule] of Object.entries(PRE_REEXEC)) {
    for (const imp of importsOf(source(file))) {
      if (rule.values && imp.typeOnly) continue
      if (!imp.specifier.startsWith(".")) {
        if (!/^node:/.test(imp.specifier) && !(rule.bun && /^bun:/.test(imp.specifier)))
          problems.push(`${file}: ${imp.specifier}`)
      } else if (!rule.files.includes(resolveIn(file, imp.specifier))) {
        problems.push(`${file}: ${imp.specifier}`)
      }
    }
  }
  expect(problems).toEqual([])
  // What loading launch.ts loads: its value imports, followed.
  const reached = new Set<string>()
  const walk = (file: string): void => {
    if (reached.has(file)) return
    reached.add(file)
    for (const imp of importsOf(source(file))) {
      if (!imp.typeOnly && imp.specifier.startsWith(".")) walk(resolveIn(file, imp.specifier))
    }
  }
  walk("runtime/service/launch.ts")
  expect([...reached].sort()).toEqual(Object.keys(PRE_REEXEC).sort())
})

test("daemonMain pins the daemon before it loads the daemon", () => {
  const main = source("main.ts")
  expect(importsOf(main).filter((imp) => imp.kind !== "dynamic")).toEqual([])
  const start = main.indexOf("export const daemonMain")
  const body = main.slice(start, main.indexOf("\n}\n", start))
  const pinAt = body.indexOf('import("./runtime/service/launch.ts")')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(pinAt).toBeGreaterThanOrEqual(0)
  expect(body.indexOf('import("./server/daemon/main.ts")')).toBeGreaterThan(pinAt)
})

/**
 * The office's layers and import rules (ARCHITECTURE.md, "The office's layers"), held on each file's final path.
 *
 * Every file has a layer; imports go down or stay in their layer; inside a category the folders import one way;
 * util stays generic. `places.ts` maps today's paths to final ones, and its `UPWARD` and `CYCLES` list what still
 * breaks a rule, exactly. Also here: the Bun lints, no `require()`, the sandbox helper's imports, and what the
 * daemon loads before it re-execs.
 */
import { expect, onTestFinished, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CYCLES, PLACES, UPWARD } from "./places.ts"
import { blank, CODE, filesUnder, type Import, importsOf, resolveIn, SRC } from "./scan.ts"

/** The categories, lowest first; `main.ts` sits above them all. */
const CATEGORIES = ["util", "company", "runtime", "models", "tools", "features", "server"] as const
/** The files directly in `src/` that have a layer: `platform.ts` and `files.d.ts` are util's, `main.ts` the top. */
const ROOT_FILES: Readonly<Record<string, number>> = { "platform.ts": 1, "files.d.ts": 1, "main.ts": 8 }
/** `testing/`'s layer: outside the order, it may import anything. */
const TESTING = 9

/** A `src/` file's final path: its `PLACES` entry, or where it is. */
const final = (file: string): string => PLACES[file] ?? file

/** Where the file whose final path is `place` is today. */
function current(place: string): string {
  return Object.entries(PLACES).find(([, to]) => to === place)?.[0] ?? place
}

/** The layer of a final path: 1 for util up to 7 for server, 8 for `main.ts`, 9 for `testing/`, 0 for none. */
function layerOf(place: string): number {
  if (!place.includes("/")) return ROOT_FILES[place] ?? 0
  const top = place.split("/")[0]!
  if (top === "testing") return TESTING
  return CATEGORIES.indexOf(top as (typeof CATEGORIES)[number]) + 1
}

/** A final path's folder inside its category: `features/chat` for `features/chat/x.ts`, and the category itself
 *  for its root files (`platform.ts` and `files.d.ts` are util's). */
function folderOf(place: string): string {
  const parts = place.split("/")
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

/** One relative import: who imports, what it names (both today's paths under `src/`), and how. */
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

/** `edge`'s lines in `UPWARD`'s format, one per name. */
function lines({ from, to, imp }: Edge): string[] {
  return (imp.names.length ? imp.names : ["import"]).map((name) => `${from} -> ${to} ${name}`)
}

/** Whether every line of `edge` is in `UPWARD`, which exempts it from the layer and util rules. */
const exempt = (edge: Edge): boolean => lines(edge).every((line) => UPWARD.includes(line))

/** The folder `file` (a path under `src/`) is in, under `src/`: `""` for `src/` itself. */
function folderOfFile(file: string): string {
  const dir = path.posix.dirname(file)
  return dir === "." ? "" : dir
}

/** The old folders: each folder under `src/` that directly holds a `PLACES` entry. */
const OLD = new Set(Object.keys(PLACES).map(folderOfFile).filter((dir) => dir !== ""))

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
  const problems: string[] = []
  for (const file of FILES) {
    if (OLD.has(folderOfFile(file)) && !(file in PLACES)) problems.push(`${file} is in an old folder but not in PLACES`)
    if (layerOf(final(file)) === 0) problems.push(`${file} (final path ${final(file)}) is in no layer`)
  }
  for (const [from, to] of Object.entries(PLACES)) {
    if (!FILES.includes(from)) problems.push(`PLACES names ${from}, which doesn't exist`)
    if (FILES.includes(to) && !(to in PLACES)) problems.push(`PLACES moves ${from} onto ${to}, which exists`)
  }
  const finals = Object.values(PLACES)
  for (const to of new Set(finals.filter((to, i) => finals.indexOf(to) !== i))) problems.push(`two files go to ${to}`)
  expect(problems).toEqual([])
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
    const layer = layerOf(final(from))
    return layer !== TESTING && layerOf(final(to)) > layer
  })
  expect([...new Set(up.flatMap(lines))].sort()).toEqual([...UPWARD].sort())
})

test("nothing in src imports testing", () => {
  const into = edges().filter(({ from, to }) => layerOf(final(from)) !== TESTING && layerOf(final(to)) === TESTING)
  expect(into.map(({ from, to }) => `${from} -> ${to}`)).toEqual([])
})

/** The folder cycles inside each category, each as its folders sorted, the cycles sorted. */
function cycles(): string[][] {
  const next = new Map<string, Set<string>>()
  for (const { from, to } of edges()) {
    const [a, b] = [final(from), final(to)]
    if (layerOf(a) !== layerOf(b) || layerOf(a) > CATEGORIES.length || folderOf(a) === folderOf(b)) continue
    if (!next.has(folderOf(a))) next.set(folderOf(a), new Set())
    next.get(folderOf(a))!.add(folderOf(b))
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
  return sortCycles(found)
}

/** `cycles` sorted by their folders, so two lists compare equal whatever order they were found in. */
function sortCycles(cycles: readonly (readonly string[])[]): string[][] {
  return cycles.map((cycle) => [...cycle].sort()).sort((a, b) => (a.join() < b.join() ? -1 : a.join() > b.join() ? 1 : 0))
}

test("inside a category the folders have no cycles", () => {
  expect(cycles()).toEqual(sortCycles(CYCLES))
})

/** The packages util may import besides `node:` builtins, and the subpaths of protocol. */
const UTIL_PACKAGES = /^(node:.+|@ngocbh\/yian\/platform|@opencorp\/protocol(\/.+)?)$/

test("util imports only builtins, platform.ts, util, yian's platform and the protocol", () => {
  const problems: string[] = []
  for (const from of sourceFiles().filter((file) => layerOf(final(file)) === 1)) {
    for (const imp of importsOf(source(from))) {
      if (!imp.specifier.startsWith(".")) {
        const bun = final(from) === "platform.ts" && /^bun:/.test(imp.specifier)
        if (!bun && !UTIL_PACKAGES.test(imp.specifier)) problems.push(`${from}: ${imp.specifier}`)
        continue
      }
      const edge = { from, to: resolveIn(from, imp.specifier), imp }
      if (layerOf(final(edge.to)) !== 1 && !exempt(edge)) problems.push(`${from}: ${imp.specifier}`)
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
  const helper = current("runtime/sandbox/fs_helper.ts")
  const specifiers = importsOf(source(helper)).map((imp) => imp.specifier)
  expect(specifiers.length).toBeGreaterThan(0)
  expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([])
})

/** What each file the daemon loads before it re-execs may import, by final path: `node:` builtins (and `bun:` for
 *  `platform.ts`), and the final paths listed. Type-only imports count, except `platform.ts`'s, which load nothing. */
const PRE_REEXEC: Readonly<Record<string, { files: readonly string[]; bun?: true; values?: true }>> = {
  "runtime/service/launch.ts": { files: ["platform.ts", "util/sockets.ts", "util/proc.ts"] },
  "util/proc.ts": { files: ["platform.ts"] },
  "util/sockets.ts": { files: [] },
  "platform.ts": { files: [], bun: true, values: true },
}

test("the daemon loads only builtins and the pre-re-exec files before it re-execs", () => {
  const problems: string[] = []
  for (const [place, rule] of Object.entries(PRE_REEXEC)) {
    const file = current(place)
    for (const imp of importsOf(source(file))) {
      if (rule.values && imp.typeOnly) continue
      if (!imp.specifier.startsWith(".")) {
        if (!/^node:/.test(imp.specifier) && !(rule.bun && /^bun:/.test(imp.specifier)))
          problems.push(`${place}: ${imp.specifier}`)
      } else if (!rule.files.includes(final(resolveIn(file, imp.specifier)))) {
        problems.push(`${place}: ${imp.specifier}`)
      }
    }
  }
  expect(problems).toEqual([])
  // What loading launch.ts loads: its value imports, followed.
  const reached = new Set<string>()
  const walk = (file: string): void => {
    if (reached.has(final(file))) return
    reached.add(final(file))
    for (const imp of importsOf(source(file))) {
      if (!imp.typeOnly && imp.specifier.startsWith(".")) walk(resolveIn(file, imp.specifier))
    }
  }
  walk(current("runtime/service/launch.ts"))
  expect([...reached].sort()).toEqual(Object.keys(PRE_REEXEC).sort())
})

test("daemonMain pins the daemon before it loads the daemon", () => {
  const main = source("main.ts")
  expect(importsOf(main).filter((imp) => imp.kind !== "dynamic")).toEqual([])
  const start = main.indexOf("export const daemonMain")
  const body = main.slice(start, main.indexOf("\n}\n", start))
  const pinAt = body.indexOf(`import("./${current("runtime/service/launch.ts")}")`)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(pinAt).toBeGreaterThanOrEqual(0)
  expect(body.indexOf(`import("./${current("server/daemon/main.ts")}")`)).toBeGreaterThan(pinAt)
})

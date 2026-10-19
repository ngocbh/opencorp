import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const SRC = path.join(import.meta.dir, "../src")
const transpiler = new Bun.Transpiler({ loader: "ts" })

/** The module specifiers `file` imports or re-exports, type-only ones included. */
function imports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^"']*?\bfrom\s+["']([^"']+)["']/gm)].map(
    (m) => m[1],
  )
}

/**
 * The modules `file` loads at run time: static, side-effect and dynamic imports, re-exports and
 * `require` calls, without type-only imports.
 */
const runtimeImports = (file: string) => transpiler.scanImports(readFileSync(file, "utf8")).map((i) => i.path)

/** Every source file `entry` loads at run time through relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const todo = [path.join(SRC, entry)]
  while (todo.length) {
    const file = todo.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of runtimeImports(file))
      if (spec.startsWith(".")) todo.push(path.resolve(path.dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`))
  }
  return seen
}

test("the browser entry loads only the client's own files and @opencorp/protocol", () => {
  const offenders = [...reachable("index.ts")].flatMap((f) =>
    runtimeImports(f)
      .filter((s) => !s.startsWith(".") && s !== "@opencorp/protocol")
      .map((s) => `${path.basename(f)} imports ${s}`),
  )
  expect(offenders).toEqual([])
})

test("no file the browser entry loads uses Node's or Bun's globals", () => {
  // The transpiled code, so comments and types don't count.
  const offenders = [...reachable("index.ts")].flatMap((f) =>
    [...transpiler.transformSync(readFileSync(f, "utf8")).matchAll(/\b(process|Bun)\./g)].map(
      (m) => `${path.basename(f)} uses ${m[1]}`,
    ),
  )
  expect(offenders).toEqual([])
})

test("the client never imports office, TUI, CLI or app code", () => {
  const offenders = readdirSync(SRC).flatMap((f) =>
    imports(path.join(SRC, f)).filter((s) => /corp_office|@opencorp\/(tui|cli|app)\b|\.\.\/\.\./.test(s)),
  )
  expect(offenders).toEqual([])
})

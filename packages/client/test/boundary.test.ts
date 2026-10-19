import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const SRC = path.join(import.meta.dir, "../src")

/** The module specifiers `file` imports or re-exports, type-only ones included. */
function imports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^"']*?\bfrom\s+["']([^"']+)["']/gm)].map(
    (m) => m[1],
  )
}

/** Every source file `entry` reaches through relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const todo = [path.join(SRC, entry)]
  while (todo.length) {
    const file = todo.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of imports(file))
      if (spec.startsWith(".")) todo.push(path.resolve(path.dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`))
  }
  return seen
}

test("the browser entry never reaches node:*", () => {
  const offenders = [...reachable("index.ts")].flatMap((f) =>
    imports(f)
      .filter((s) => s.startsWith("node:"))
      .map((s) => `${path.basename(f)} imports ${s}`),
  )
  expect(offenders).toEqual([])
})

test("the client never imports office, TUI, CLI or app code", () => {
  const offenders = readdirSync(SRC).flatMap((f) =>
    imports(path.join(SRC, f)).filter((s) => /corp_office|@opencorp\/(tui|cli|app)\b|\.\.\/\.\./.test(s)),
  )
  expect(offenders).toEqual([])
})

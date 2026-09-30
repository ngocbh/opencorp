import { expect, test } from "bun:test"
import path from "path"

// The TUI makes no network requests of its own: syntax highlighting uses only the
// parsers bundled with @opentui/core.
test("sources register no remote tree-sitter parsers or queries", async () => {
  const root = path.join(import.meta.dir, "../src")
  const offenders: string[] = []
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    const text = await Bun.file(path.join(root, file)).text()
    if (/addDefaultParsers|https?:\/\/\S+\.(wasm|scm)\b/.test(text)) offenders.push(file)
  }
  expect(offenders).toEqual([])
})

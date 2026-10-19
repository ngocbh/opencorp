// vite-plugin-solid takes babel-preset-solid ^1.8.4, which resolves to the newest 1.9.x, while the runtime is the
// repo's patched solid-js 1.9.10. A compiler newer than its runtime can emit a helper the runtime lacks; these tests
// compile the app with exactly the preset vite-plugin-solid resolves and check the pair. If they fail, pin
// babel-preset-solid 1.9.10 and babel-plugin-jsx-dom-expressions 0.40.3 in a root "overrides".
import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const APP = path.join(import.meta.dir, "..")
/** Resolves `spec` the way `from`'s package would. */
const resolveFrom = (spec: string, from: string) => Bun.resolveSync(spec, from)
const plugin = path.dirname(resolveFrom("vite-plugin-solid/package.json", APP))
const { transformSync } = require(resolveFrom("@babel/core", plugin))
const preset = require(resolveFrom("babel-preset-solid", plugin))

/** Every .tsx file under src/. */
function sources(dir = path.join(APP, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : [],
  )
}

/** The names in every `{ … }` that `re` matches: for `export { a, b as c }`, ["a", "c"]. */
const names = (code: string, re: RegExp) =>
  [...code.matchAll(re)].flatMap((m) =>
    m[1]
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/).at(-1)!)
      .filter(Boolean),
  )

test("the runtime is the repo's patched solid-js 1.9.10", () => {
  const pkg = JSON.parse(readFileSync(resolveFrom("solid-js/package.json", APP), "utf8"))
  expect(pkg.version).toBe("1.9.10")
})

test("every solid-js/web helper the compiler emits for the app exists in the runtime's browser build", () => {
  // Under bun, "solid-js/web" resolves to the server build; the browser build sits next to it.
  const web = readFileSync(path.join(path.dirname(resolveFrom("solid-js/web", APP)), "web.js"), "utf8")
  const exported = new Set(names(web, /export\s*\{([^}]*)\}/g))
  const missing = sources().flatMap((file) => {
    const { code } = transformSync(readFileSync(file, "utf8"), {
      filename: file,
      babelrc: false,
      configFile: false,
      presets: [[preset, { generate: "dom" }]],
      parserOpts: { plugins: ["jsx", "typescript"] },
    })
    const used = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']solid-js\/web["']/g)].flatMap((m) =>
      m[1]
        .split(",")
        .map((n: string) => n.trim().split(/\s+as\s+/)[0])
        .filter(Boolean),
    )
    return used.filter((n: string) => !exported.has(n)).map((n: string) => `${path.relative(APP, file)}: ${n}`)
  })
  expect(missing).toEqual([])
})

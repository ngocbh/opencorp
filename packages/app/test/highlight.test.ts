import { expect, test } from "bun:test"
import { lines } from "../src/company/files"
import hljs from "highlight.js/lib/core"
import {
  byteLength,
  colorWith,
  languageOf,
  MAX_COLORED,
  MAX_LINE,
  plainReason,
  sizeText,
  tokenLines,
  type Token,
} from "../src/company/highlight"

/** A line's text, as the page shows it. */
const textOf = (tokens: Token[]): string =>
  tokens.map((t) => (typeof t === "string" ? t : textOf(t.children))).join("")

/** The spans of `tokens`, as [class, text] pairs, outermost first. */
const spans = (tokens: Token[]): [string, string][] =>
  tokens.flatMap((t) => (typeof t === "string" ? [] : [[t.class, textOf(t.children)] as [string, string], ...spans(t.children)]))

test("the language comes from the extension, any case; anything else is plain", () => {
  const cases: [string, string | undefined][] = [
    ["flows/hire.yaml", "yaml"],
    ["company.YML", "yaml"],
    ["README.md", "markdown"],
    ["notes.markdown", "markdown"],
    ["office/hq.json", "json"],
    ["tools/run.py", "python"],
    ["stubs/x.pyi", "python"],
    ["bin/setup.sh", "bash"],
    ["bin/a.bash", "bash"],
    ["bin/b.zsh", "bash"],
    ["src/app.ts", "typescript"],
    ["src/app.tsx", "typescript"],
    ["src/x.mts", "typescript"],
    ["src/x.cts", "typescript"],
    ["web/main.js", "javascript"],
    ["web/main.jsx", "javascript"],
    ["web/x.mjs", "javascript"],
    ["web/x.cjs", "javascript"],
    ["LICENSE", undefined],
    ["data.csv", undefined],
    ["page.html", undefined],
    [".env", undefined],
    ["yaml", undefined],
    ["dir.yaml/file", undefined],
  ]
  for (const [path, id] of cases) expect([path, languageOf(path)?.id]).toEqual([path, id])
  expect(languageOf("a.yaml")?.name).toBe("YAML")
  expect(languageOf("a.sh")?.name).toBe("Shell")
})

test("a file over 512 KB isn't colored; one at the limit is", () => {
  expect(MAX_COLORED).toBe(512 * 1024)
  const full = `${"x".repeat(1023)}\n`.repeat(512)
  expect(byteLength(full)).toBe(MAX_COLORED)
  expect(colorWith("a.yaml", full)).toBe("yaml")
  expect(plainReason(full)).toBeUndefined()
  expect(colorWith("a.yaml", `${full}x`)).toBeUndefined()
  expect(plainReason(`${full}x`)).toBe("over 512 KB")
  expect(colorWith("a.txt", "a: 1")).toBeUndefined()
  expect(colorWith("a.yaml", "a: 1")).toBe("yaml")
  expect(byteLength("é")).toBe(2)
})

test("a file with a line over 5,000 characters isn't colored; highlight.js is slow on such lines", () => {
  expect(MAX_LINE).toBe(5000)
  const at = `a: ${"word ".repeat(1000)}`.slice(0, MAX_LINE)
  expect(at.length).toBe(MAX_LINE)
  expect(colorWith("a.yaml", `x: 1\n${at}\ny: 2\n`)).toBe("yaml")
  expect(colorWith("a.yaml", `x: 1\r\n${at}\r\ny: 2\r\n`)).toBe("yaml")
  expect(colorWith("a.yaml", `x: 1\n${at}w\ny: 2\n`)).toBeUndefined()
  expect(plainReason(`x: 1\n${at}w\n`)).toBe("a line over 5,000 characters")
  // Size comes first when both apply.
  expect(plainReason(`a: ${"x".repeat(MAX_COLORED)}`)).toBe("over 512 KB")
})

test("a long YAML line of words stays fast: it isn't colored at all", () => {
  const text = `a: ${"word ".repeat(100_000)}\n`
  const start = performance.now()
  const got = tokenLines(text, colorWith("a.yaml", text))
  expect(performance.now() - start).toBeLessThan(1000)
  expect(got).toEqual([[text.slice(0, -1)]])
})

test("if highlight.js's token tree isn't there, the file shows plain", () => {
  const highlight = hljs.highlight
  try {
    for (const emitter of [{}, { root: {} }, { root: { children: [{ scope: "attr" }] } }, { root: null }]) {
      hljs.highlight = ((code: string, opts: { language: string }) => ({ ...highlight(code, opts), _emitter: emitter })) as typeof hljs.highlight
      expect(tokenLines("a: 1\nb: 2\n", "yaml")).toEqual([["a: 1"], ["b: 2"]])
    }
  } finally {
    hljs.highlight = highlight
  }
})

test("a size reads in bytes, KB or MB", () => {
  expect(sizeText(1)).toBe("1 byte")
  expect(sizeText(63)).toBe("63 bytes")
  expect(sizeText(1024)).toBe("1.0 KB")
  expect(sizeText(1536)).toBe("1.5 KB")
  expect(sizeText(1024 * 1024)).toBe("1.0 MB")
})

test("token lines show the same text as the plain lines, colored or not", () => {
  const texts = [
    "",
    "\n",
    "a",
    "a\n",
    "a\r\nb\r\n",
    "kind: !Person\nname: |\n  one\n  two\n\nlast: 1",
    '{\n  "a": [1, true, null],\n  "b": "c"\n}\n',
    "# T\n\n*a* `b`\n```\ncode\n```\n",
    "def f(x):\n    \"\"\"Doc\n    more\"\"\"\n    return x\n",
  ]
  for (const text of texts)
    for (const id of [undefined, "yaml", "json", "markdown", "python", "bash", "typescript", "javascript"])
      expect(tokenLines(text, id).map(textOf)).toEqual(lines(text))
})

test("YAML keys, tags, strings, numbers, booleans and comments get highlight.js classes", () => {
  const got = tokenLines("# c\nkind: !Person\nname: \"Kai\"\nn: 3\nok: true\nx: !str 4\n", "yaml").flatMap(spans)
  expect(got).toEqual([
    ["hljs-comment", "# c"],
    ["hljs-attr", "kind:"],
    ["hljs-type", "!Person"],
    ["hljs-attr", "name:"],
    ["hljs-string", '"Kai"'],
    ["hljs-attr", "n:"],
    ["hljs-number", "3"],
    ["hljs-attr", "ok:"],
    ["hljs-literal", "true"],
    ["hljs-attr", "x:"],
    ["hljs-type", "!str"],
    ["hljs-number", "4"],
  ])
})

test("a token over several lines is cut into one span per line, with no empty span", () => {
  const got = tokenLines("a: |\n  one\n  two\nb: 1\n", "yaml")
  expect(got.map(spans)).toEqual([
    [["hljs-attr", "a:"], ["hljs-string", "|"]],
    [["hljs-string", "  one"]],
    [["hljs-string", "  two"]],
    [["hljs-attr", "b:"], ["hljs-number", "1"]],
  ])
  // A span that opens right before a line end has nothing on that line.
  expect(tokenLines("function f(\n  a,\n  b\n) {}\n", "typescript").map(spans)).toEqual([
    [["hljs-keyword", "function"], ["hljs-title function_", "f"]],
    [["hljs-params", "  a,"]],
    [["hljs-params", "  b"]],
    [],
  ])
  const empty = (tokens: Token[]): boolean =>
    tokens.some((t) => typeof t !== "string" && (t.children.length === 0 || empty(t.children)))
  for (const [text, id] of [
    ["function f(\n  a\n) {}\n", "typescript"],
    ['x = (\n  "a"\n)\ns = """\nline\n"""\n', "python"],
    ["a: |\n  one\n\nb: >\n  two\n", "yaml"],
    ["```\ncode\n```\n", "markdown"],
  ])
    expect([text, tokenLines(text, id).some(empty)]).toEqual([text, false])
})

test("a tiered scope gets highlight.js's classes", () => {
  const got = tokenLines("function f() {}\n", "javascript").flatMap(spans)
  expect(got).toContainEqual(["hljs-title function_", "f"])
})

test("HTML in a file stays text: no token is markup", () => {
  const text = '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n{{ secret }}\n'
  for (const id of [undefined, "markdown", "yaml"]) {
    const got = tokenLines(text, id)
    expect(got.map(textOf)).toEqual(lines(text))
    // Every string is the file's own text; classes come only from highlight.js scopes.
    for (const [cls] of got.flatMap(spans)) expect(cls).toMatch(/^(hljs-[\w-]+|language-\w+)( \w+_+)*$/)
  }
})

test("a file's (hidden) is plain text like any other", () => {
  for (const id of [undefined, "yaml"]) {
    const [line] = tokenLines("token: (hidden)", id)
    expect(textOf(line)).toBe("token: (hidden)")
    expect(JSON.stringify(line)).not.toContain('"hidden":')
  }
})

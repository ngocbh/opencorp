/** Reading company files and flows as YAML 1.2 with yian's merge keys, an alias cap and a nesting limit. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import { MAX_NESTING, readFlow, readYaml, YamlError } from "../../src/company/flow_yaml.ts"

const SRC = fileURLToPath(new URL("../../src", import.meta.url))
const INVALID = (line: number) => `isn't valid YAML (line ${line})`
const TOO_DEEP = "is nested too deeply to read"
const RECURSIVE = (line: number) => `has an alias inside the node it names (line ${line})`
const BAD_MERGE = (line: number) => `has a merge key whose value isn't a mapping or a list of mappings (line ${line})`

/** The message of the `YamlError` that `read` throws; fails the test on any other outcome. */
function refusal(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    expect(error).toBeInstanceOf(YamlError)
    return (error as Error).message
  }
  throw new Error("expected a YamlError")
}

/** The fastest of three runs of `run`, in ms. */
function fastest(run: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    run()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

describe("YAML 1.2 readings", () => {
  test("yes no on and off are text and dates stay text", () => {
    const text = "{a: yes, b: off, c: 2026-01-01, d: 1:30, e: no, f: on}"
    const want = { a: "yes", b: "off", c: "2026-01-01", d: "1:30", e: "no", f: "on" }
    expect(readYaml(text)).toEqual(want)
    expect(readFlow(text)).toEqual(want)
  })

  test("a leading zero int is decimal and 0o and 0x are octal and hex", () => {
    expect(readYaml("[0755, 0o755, 0x1f]")).toEqual([755, 493, 31])
  })

  test("core booleans nulls and floats", () => {
    expect(readYaml("[true, False, ~, null, 1.5, .inf]")).toEqual([true, false, null, null, 1.5, Infinity])
  })

  test("missing values read as null and a null key is refused", () => {
    expect(readYaml("{a}")).toEqual({ a: null })
    expect(readYaml("a:\n")).toEqual({ a: null })
    expect(readYaml("- \n")).toEqual([null])
    expect(readYaml("")).toBeNull()
    expect(readYaml("# only a comment\n")).toBeNull()
    expect(refusal(() => readYaml("{: 1}"))).toBe(INVALID(1))
    expect(refusal(() => readYaml("a: 1\n? \n"))).toBe(INVALID(2))
    expect(refusal(() => readYaml("a: 1\n~: 2\n"))).toBe(INVALID(2))
    expect(refusal(() => readYaml("{[a]: 1}"))).toBe(INVALID(1))
    expect(refusal(() => readFlow("a: &k [x]\nb: {*k : 1}\n"))).toBe(INVALID(2))
  })

  test("a lone cr is a line break", () => {
    expect(readYaml("a: 1\rb: 2\r")).toEqual({ a: 1, b: 2 })
    expect(readYaml("a: 1\r\nb: 2\r\n")).toEqual({ a: 1, b: 2 })
    expect(refusal(() => readYaml("a: 1\rb: 2\ra: 3\r"))).toBe(INVALID(3))
  })

  test("more than one document is an error", () => {
    expect(refusal(() => readYaml("a: 1\n---\nb: 2\n"))).toBe(INVALID(2))
    expect(refusal(() => readFlow("a: 1\n---\nb: 2\n"))).toBe(INVALID(2))
  })

  test("errors never quote the text", () => {
    expect(refusal(() => readYaml("a: 1\nb: [$scrypt$secret-hash\n"))).toBe(INVALID(3))
    const repeated = refusal(() => readYaml("hunter2: 1\nhunter2: 2\n"))
    expect(repeated).toBe(INVALID(2))
    expect(repeated).not.toContain("hunter2")
  })
})

describe("aliases, the node cap and nesting", () => {
  test("an alias bomb is refused", () => {
    const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"]
    for (let i = 1; i <= 10; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]`)
    const text = lines.join("\n")
    let flow = ""
    let company = ""
    expect(fastest(() => (flow = refusal(() => readFlow(text))))).toBeLessThan(1000)
    expect(fastest(() => (company = refusal(() => readYaml(text))))).toBeLessThan(1000)
    expect(flow).toBe("expands to more than 100000 nodes")
    expect(company).toBe("expands to more than 100000 nodes")
  })

  test("a recursive alias is refused", () => {
    expect(refusal(() => readYaml("&a [*a]"))).toBe(RECURSIVE(1))
    expect(refusal(() => readFlow("a: 1\nb: &a [1, {c: *a}]\n"))).toBe(RECURSIVE(2))
    expect(refusal(() => readFlow("&s {<<: *s, a: 1}"))).toBe(RECURSIVE(1))
    expect(refusal(() => readYaml("&l [{<<: [*l]}]"))).toBe(RECURSIVE(1))
  })

  test("an undefined alias is refused", () => {
    expect(refusal(() => readYaml("a: &x 1\nb: *nope"))).toBe(INVALID(2))
    expect(refusal(() => readFlow("a: *x\nb: &x 1\n"))).toBe(INVALID(1))
  })

  test("an alias names the latest node anchored before it", () => {
    expect(readYaml("[&a 1, *a, &a 2, *a]")).toEqual([1, 1, 2, 2])
  })

  test("many anchors and aliases read in linear time", () => {
    const n = 20_000
    const anchors = Array.from({ length: n }, (_, i) => `&a${i} ${i}`)
    const aliases = Array.from({ length: n }, (_, i) => `*a${i}`)
    const text = `[${anchors.join(", ")}, ${aliases.join(", ")}]`
    let value: unknown
    expect(fastest(() => (value = readYaml(text)))).toBeLessThan(1000)
    expect((value as number[]).length).toBe(2 * n)
    expect((value as number[])[2 * n - 1]).toBe(n - 1)
  })

  test("a mapping of many keys reads in linear time", () => {
    const text = Array.from({ length: 40_000 }, (_, i) => `k${i}: ${i}`).join("\n")
    let value: unknown
    expect(fastest(() => (value = readYaml(text)))).toBeLessThan(1000)
    expect(Object.keys(value as object).length).toBe(40_000)
  })

  test("nesting past the limit is refused and 100000 brackets do not overflow the stack", () => {
    const nested = (levels: number) => "[".repeat(levels) + "]".repeat(levels)
    expect(refusal(() => readYaml(nested(MAX_NESTING + 1)))).toBe(TOO_DEEP)
    let value = readYaml(nested(MAX_NESTING))
    for (let i = 1; i < MAX_NESTING; i++) value = (value as unknown[])[0]
    expect(value).toEqual([])
    expect(refusal(() => readYaml("[".repeat(100_000) + "]".repeat(100_000)))).toBe(TOO_DEEP)
    expect(refusal(() => readFlow("[".repeat(100_000)))).toBe(TOO_DEEP)
    // Nesting counts the expanded tree: 102 levels written, 202 once the alias is followed.
    const aliased = `[&x ${nested(101)}, ${"[".repeat(100)}*x${"]".repeat(100)}]`
    expect(refusal(() => readYaml(aliased))).toBe(TOO_DEEP)
  })
})

describe("tags, keys and merges", () => {
  test("a tagged scalar in a flow reads as its text", () => {
    expect(readFlow("a: !int 5\nb: !str\nc: ! foo\nd: !Foo {e: 1}\nf: !list [1]\n")).toEqual({
      a: "!int 5",
      b: "!str",
      c: "foo",
      d: { e: 1 },
      f: [1],
    })
    expect(readFlow("!!timestamp 2026-01-01")).toBe("2026-01-01")
    expect(readFlow("!!binary aGk=")).toBe("aGk=")
    expect(readFlow("a: !!merge x")).toEqual({ a: "x" })
    expect(readFlow("!!omap [{a: 1}]")).toEqual([{ a: 1 }])
    expect(readFlow("!!set {a}")).toEqual({ a: null })
    expect(readFlow("!!str 5")).toBe("5")
  })

  test("a type tagged key reads as its text", () => {
    expect(readFlow("{!str paths: 1}")).toEqual({ paths: 1 })
    expect(readFlow("{!!int 5: a, ! b: c}")).toEqual({ 5: "a", b: "c" })
  })

  test("a company file refuses a tag outside the core schema", () => {
    for (const text of ["a: !int 5", "!!timestamp 2026-01-01", "!!omap [{a: 1}]", "!!set {a}", "!!int paths"])
      expect(refusal(() => readYaml(text))).toBe(INVALID(1))
    expect(refusal(() => readYaml("a: 1\nb: {!str c: 2}\n"))).toBe(INVALID(2))
    expect(readYaml("!!str 5")).toBe("5")
    expect(readYaml("! foo")).toBe("foo")
    expect(readYaml("! {a: 1}")).toEqual({ a: 1 })
  })

  test("merge keys follow yian and pyyaml order", () => {
    const anchors = "a: &a {x: 1, y: 1}\nb: &b {x: 2, z: 2}\n"
    const merged = (text: string) => (readFlow(anchors + "c: " + text) as Record<string, unknown>).c
    expect(merged("{<<: *a, x: 3}")).toEqual({ x: 3, y: 1 })
    expect(merged("{x: 3, <<: *a}")).toEqual({ x: 3, y: 1 })
    expect(Object.keys(merged("{y: 3, <<: *a}") as object)).toEqual(["x", "y"])
    expect(merged("{<<: [*a, *b]}")).toEqual({ x: 1, y: 1, z: 2 })
    expect(merged("{<<: *a, <<: *b}")).toEqual({ x: 2, y: 1, z: 2 })
    expect(readFlow("a: &a {x: 1}\nb: &b {<<: *a, y: 2}\nc: {<<: *b, z: 3}\n")).toEqual({
      a: { x: 1 },
      b: { x: 1, y: 2 },
      c: { x: 1, y: 2, z: 3 },
    })
    expect(readFlow('{<<: {a: 1}, "<<": 2}')).toEqual({ a: 1, "<<": 2 })
    expect(readFlow("{!!merge x: {a: 1}}")).toEqual({ a: 1 })
    expect(readFlow("{! <<: 1}")).toEqual({ "<<": 1 })
    expect(readFlow("{!str <<: 2}")).toEqual({ "<<": 2 })
    expect(readYaml("{!!str <<: 1}")).toEqual({ "<<": 1 })
    expect(readYaml("a: &a {x: 1}\nb: {<<: *a}\n")).toEqual({ a: { x: 1 }, b: { x: 1 } })
    expect(readFlow("a: &a !Foo {x: 1}\nb: {<<: !list [*a]}\n")).toEqual({ a: { x: 1 }, b: { x: 1 } })
  })

  test("a merge value that isnt a mapping is an error", () => {
    expect(refusal(() => readYaml("<<: 5"))).toBe(BAD_MERGE(1))
    expect(refusal(() => readYaml("a: 1\n<<: [5]\n"))).toBe(BAD_MERGE(2))
    expect(refusal(() => readYaml("<<: [{a: 1}, [b]]"))).toBe(BAD_MERGE(1))
    expect(refusal(() => readYaml("<<:\n"))).toBe(BAD_MERGE(1))
    expect(refusal(() => readFlow("a: &a 5\nb: {<<: *a}\n"))).toBe(BAD_MERGE(2))
  })

  test("a repeated key is an error but several merge keys are not", () => {
    expect(refusal(() => readYaml("a: 1\na: 2\n"))).toBe(INVALID(2))
    expect(refusal(() => readFlow("a:\n  b: 1\n  c: 2\n  b: 3\n"))).toBe(INVALID(4))
    expect(readYaml("<<: {a: 1}\n<<: {b: 2}\n")).toEqual({ a: 1, b: 2 })
    expect(readYaml('<<: {a: 1}\n"<<": 2\n')).toEqual({ a: 1, "<<": 2 })
    // A repeat through an alias key, or of the same text from a different value, reads with the later value.
    expect(readYaml("- &k a\n- {*k : 1, *k : 2}\n")).toEqual(["a", { a: 2 }])
    expect(readYaml('{"1": a, 1: b}')).toEqual({ 1: "b" })
  })
})

describe("safety", () => {
  test("a proto key is an own key", () => {
    const value = readYaml("__proto__: {polluted: 1}\n") as object
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.hasOwn(value, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ polluted: 1 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const merged = (readFlow("a: &a {__proto__: {polluted: 1}}\nb: {<<: *a}\n") as Record<string, object>).b
    expect(Object.hasOwn(merged, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
  })

  test("only flow_yaml imports yaml", () => {
    const IMPORTS_YAML = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']yaml(?:\/[^"']*)?["']/
    // Guards the regex: a pattern that matched nothing would let any importer through.
    for (const sample of ['import { parse } from "yaml"', "await import('yaml/util')", 'require("yaml")'])
      expect(sample).toMatch(IMPORTS_YAML)
    const files = fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((name) => /\.[cm]?[jt]sx?$/.test(name))
    const importers = files.filter((name) => IMPORTS_YAML.test(fs.readFileSync(path.join(SRC, name), "utf8")))
    expect(importers).toEqual([path.join("company", "flow_yaml.ts")])
  })
})

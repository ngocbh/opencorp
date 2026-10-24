/** The parity ledger: every Python test id is accounted for, and every ledger row is true. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const HERE = path.join(ROOT, "packages/office/tests")
const PY_PREFIX = "packages/corp_office/tests/"
const NONE = "—"
const HEADER = "python\tstatus\tts\treason\titem"
const STATUSES = new Set(["open", "ported", "changed", "dropped", "deferred: learning", "new"])
const FILE_STATUSES = new Set(["open", "ported", "dropped", "deferred: learning"])
const ID_STATUSES = new Set(["changed", "dropped", "deferred: learning"])
const ITEM = /^(?:O[0-5][ab]?-\d+[ab]?|Y\d[a-c]?)$/
// The snapshot is of a frozen tree, so a change to these counts is on purpose.
const PYTHON_IDS = 3513
const PYTHON_FILES = 179

type Row = {
  line: number
  cells: number
  python: string
  status: string
  ts: string
  reason: string
  item: string
}

/** The Python test ids of the frozen tree, relative to its tests folder. */
function pythonIds(): string[] {
  const lines = fs.readFileSync(path.join(HERE, "python_ids.txt"), "utf8").split("\n").filter(Boolean)
  return lines.map((line) => {
    if (!line.startsWith(PY_PREFIX)) throw new Error(`python_ids.txt: ${line} is not under ${PY_PREFIX}`)
    return line.slice(PY_PREFIX.length)
  })
}

/** The ledger's rows, header checked. */
function ledger(): Row[] {
  const text = fs.readFileSync(path.join(HERE, "parity.tsv"), "utf8")
  if (text.includes("\r")) throw new Error("parity.tsv: holds a \\r (use LF)")
  if (!text.endsWith("\n")) throw new Error("parity.tsv: no final newline")
  const lines = text.slice(0, -1).split("\n")
  if (lines[0] !== HEADER) throw new Error(`parity.tsv: the first line is not ${JSON.stringify(HEADER)}`)
  return lines.slice(1).map((line, i) => {
    const cells = line.split("\t")
    const [python = "", status = "", ts = "", reason = "", item = ""] = cells
    return { line: i + 2, cells: cells.length, python, status, ts, reason, item }
  })
}

/** `name` reduced to its words: no leading `test_`, no trailing `[case]`, every run of
 *  non-alphanumeric characters as one space, trimmed, lower case. */
function words(name: string): string {
  return name
    .replace(/^test_/, "")
    .replace(/\[[\s\S]*\]$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

// The reader's regex: a test call starts its line (after indentation), so a commented-out `// test(` or
// `x.it(`/`RE.test(` gives no name; the lazy argument group is allowed only after .each/.if/.skipIf/.todoIf.
// Names must be string literals. A test-shaped line inside a multi-line `/* */` block or a template string
// still counts: stripping those would break on strings like "src/**/*.ts", so review catches them.
// Known limits: `"a " + b` reads as "a"; after `test.each(X)(nonLiteral, …)` the lazy group runs to the next call.
const TEST_CALL =
  /^[ \t]*(?:test|it)((?:\.(?:skip|only|todo|concurrent|serial|failing))*)(?:\.(each|if|skipIf|todoIf)\([\s\S]*?\)(?=\())?\(\s*(["'`])((?:(?!\3)[^\\]|\\.)*)\3/gm
// Groups: 1 the plain modifiers, 2 the argument modifier (todoIf doesn't count), 3 the quote, 4 the name.

// A test under `describe.skip`/`describe.todo` never runs, so a file holding one is refused; the reader
// doesn't track blocks. `describe.if`, `describe.skipIf` and `describe.each` stay allowed.
const SKIPPED_DESCRIBE = /^[ \t]*describe(?:\.\w+)*\.(?:skip|todo)\b/m

/** The tests in TS source text, read statically. `counts` is false for `.skip`, `.todo`, `.failing`
 *  and `.todoIf(…)`: a test that never runs, or passes only by failing, ports nothing. */
function testsIn(text: string): { name: string; counts: boolean }[] {
  return [...text.matchAll(TEST_CALL)].map((m) => ({
    name: words(m[4]!),
    counts: !/\.(?:skip|todo|failing)/.test(m[1]!) && m[2] !== "todoIf",
  }))
}

const tsCache = new Map<string, { name: string; counts: boolean }[]>()
/** The tests of a repo-relative TS file. */
function tsTests(file: string): { name: string; counts: boolean }[] {
  if (!tsCache.has(file)) tsCache.set(file, testsIn(fs.readFileSync(path.join(ROOT, file), "utf8")))
  return tsCache.get(file)!
}

/** `file` (repo-relative) holds a `describe.skip` or `describe.todo` block. */
function skipsDescribe(file: string): boolean {
  return SKIPPED_DESCRIBE.test(fs.readFileSync(path.join(ROOT, file), "utf8"))
}

/** How `name` (words) stands in `file`: "counts", "skipped", or "missing". */
function lookup(file: string, name: string): "counts" | "skipped" | "missing" {
  const found = tsTests(file).filter((t) => t.name === name)
  return found.some((t) => t.counts) ? "counts" : found.length ? "skipped" : "missing"
}

/** `file` is a normalized repo-relative path to a `.test.ts` file, so one test has one spelling to claim. */
function isTestPath(file: string): boolean {
  return (
    file.endsWith(".test.ts") &&
    !/\s/.test(file) &&
    path.posix.normalize(file) === file &&
    !path.posix.isAbsolute(file) &&
    !file.startsWith("../")
  )
}

const fileOf = (id: string) => id.split("::")[0]!
const baseOf = (id: string) => id.split("[")[0]!

test("every Python id is covered", () => {
  const ids = pythonIds()
  expect(ids).toHaveLength(PYTHON_IDS)
  expect(new Set(ids).size).toBe(PYTHON_IDS)
  expect(new Set(ids.map(fileOf)).size).toBe(PYTHON_FILES)
  const rows = new Set(ledger().map((row) => row.python))
  expect(ids.filter((id) => !rows.has(id) && !rows.has(baseOf(id)) && !rows.has(fileOf(id)))).toEqual([])
})

test("every row is true", () => {
  expect(words("test_a_steer_reaches_the_running_reply[x-1]")).toBe("a steer reaches the running reply")
  expect(words("a docs-only change [%s]")).toBe("a docs only change")
  const counted = [
    'test("a b", () => {})',
    "it('a b', () => {})",
    'test.if(ok)("a b", () => {})',
    'test(\n  "a b",\n  () => {},\n)',
    "test.each(PERSON_CHANGES.map((change) => [JSON.stringify(change), change] as const))(\n" +
      '  "generated models keep constraints [%s]",',
    'test.each([["RunSummary", "reason"], ["RunNode", "error"]] as const)(\n' +
      '  "a reason and a node error are capped at 200 characters [%s]",',
    'test.each(PATTERNS)("each pattern is checked against the fixtures [$site]", ({ def }) => {',
  ]
  expect(counted.map((text) => testsIn(text))).toEqual(
    [
      "a b",
      "a b",
      "a b",
      "a b",
      "generated models keep constraints",
      "a reason and a node error are capped at 200 characters",
      "each pattern is checked against the fixtures",
    ].map((name) => [{ name, counts: true }]),
  )
  for (const text of ['test.skip("a b", () => {})', 'test.todo("a b")', 'test.failing("a b", () => {})'])
    expect(testsIn(text)).toEqual([{ name: "a b", counts: false }])
  const ignored = [
    'describe("x", () => {})',
    'expect(RE_X.test("a")).toBe(true)',
    '// test("a b", () => {})',
    '/* test("a b") */',
  ]
  for (const text of ignored) expect(testsIn(text)).toEqual([])
  for (const text of ['describe.skip("x", () => {})', '  describe.todo("x")', 'describe.only.skip("x", () => {})'])
    expect(SKIPPED_DESCRIBE.test(text)).toBe(true)
  const notSkipped = [
    'describe("x", () => {})',
    'describe.if(ok)("x", () => {})',
    'describe.skipIf(ok)("x", () => {})',
    'describe.each([1])("x %d", () => {})',
    '// describe.skip("x", () => {})',
  ]
  for (const text of notSkipped) expect(SKIPPED_DESCRIBE.test(text)).toBe(false)

  const ids = pythonIds()
  const idsOf = new Map<string, string[]>()
  for (const id of ids) idsOf.set(fileOf(id), [...(idsOf.get(fileOf(id)) ?? []), id])
  const rows = ledger()
  const problems: string[] = []
  const claims = new Map<string, string>()
  const claim = (row: Row, claimant: string, file: string, name: string) => {
    const key = `${file}::${name}`
    const other = claims.get(key)
    if (other !== undefined && other !== claimant)
      problems.push(`line ${row.line}: ${claimant} and ${other} both claim ${key}`)
    else claims.set(key, claimant)
  }
  // On disk as spelled: on macOS a case variant also exists, and with a symlinked spelling it would be a second
  // name for one test, dodging the double claim. ROOT is resolved too, as it may sit under a symlink (/tmp).
  const realRoot = fs.realpathSync.native(ROOT)
  const exists = (file: string) => {
    try {
      const real = fs.realpathSync.native(path.join(ROOT, file))
      return real === path.join(realRoot, file) && fs.statSync(real).isFile()
    } catch {
      return false
    }
  }

  rows.forEach((row, i) => {
    const say = (what: string) => problems.push(`line ${row.line}: ${what}`)
    const cells = [row.python, row.status, row.ts, row.reason, row.item]
    if (row.cells !== 5 || cells.some((cell) => !cell)) return say("needs 5 non-empty columns")
    const prev = rows[i - 1]
    if (prev && !(prev.python < row.python || (prev.python === row.python && prev.ts < row.ts)))
      say("sorts before the row above it")
    if (row.python !== NONE && rows.some((other) => other !== row && other.python === row.python))
      say(`${row.python} has another row`)
    if (!ITEM.test(row.item)) say(`item ${row.item} is not a plan item`)
    if (!STATUSES.has(row.status)) return say(`status ${row.status} is unknown`)
    if (row.reason === NONE && row.status !== "open" && row.status !== "ported") say("needs a reason")
    const kind = row.python === NONE ? "new" : row.python.includes("::") ? "id" : "file"
    const allowed =
      kind === "new" ? row.status === "new" : (kind === "id" ? ID_STATUSES : FILE_STATUSES).has(row.status)
    if (!allowed) return say(`status ${row.status} is not allowed on a ${kind} row`)

    if (kind === "file" && !idsOf.has(row.python)) say(`${row.python} has no Python ids`)
    if (kind === "id" && !ids.some((id) => id === row.python || baseOf(id) === row.python))
      say(`${row.python} matches no Python id`)

    if (row.status === "ported") {
      const files = row.ts.split(",")
      if (!files.every(isTestPath) || new Set(files).size !== files.length)
        return say(`ts ${row.ts} is not distinct .test.ts paths`)
      const missing = files.filter((f) => !exists(f))
      if (missing.length) return say(`${missing.join(", ")} does not exist`)
      for (const f of files) if (skipsDescribe(f)) say(`${f} has a skipped describe block`)
      const used = new Set<string>()
      const own = new Set(rows.filter((r) => r.python.startsWith(`${row.python}::`)).map((r) => r.python))
      const bases = new Set(
        (idsOf.get(row.python) ?? []).filter((id) => !own.has(id) && !own.has(baseOf(id))).map(baseOf),
      )
      for (const base of bases) {
        const name = words(base.split("::")[1]!)
        const file = files.find((f) => lookup(f, name) === "counts")
        if (file) {
          used.add(file)
          claim(row, base, file, name)
        } else if (files.some((f) => lookup(f, name) === "skipped"))
          say(`${base} matches only a skipped test in ${row.ts}`)
        else say(`${base} matches no test in ${row.ts}`)
      }
      for (const r of rows)
        if (r.status === "changed" && r.python.startsWith(`${row.python}::`)) used.add(r.ts.split("::")[0]!)
      for (const f of files) if (!used.has(f)) say(`${f} supplies no match`)
    } else if (row.status === "changed" || row.status === "new") {
      const cut = row.ts.indexOf("::")
      const file = row.ts.slice(0, cut)
      if (cut < 0 || !isTestPath(file) || !row.ts.slice(cut + 2))
        return say(`ts ${row.ts} is not <path>.test.ts::<test name>`)
      if (!exists(file)) return say(`${file} does not exist`)
      if (skipsDescribe(file)) say(`${file} has a skipped describe block`)
      const name = words(row.ts.slice(cut + 2))
      const found = lookup(file, name)
      if (found !== "counts")
        return say(`${row.ts} ${found === "skipped" ? "matches only a skipped test" : "is not a test in it"}`)
      claim(row, row.status === "new" ? `the new row on line ${row.line}` : baseOf(row.python), file, name)
    } else if (row.ts !== NONE) say(`ts must be ${NONE} for ${row.status}`)
  })
  expect(problems).toEqual([])
})

// Turned on when the port closes: then every Python test is ported, changed, dropped or deferred.
test.skip("no row is open", () => {
  expect(ledger().filter((row) => row.status === "open").map((row) => `line ${row.line}: ${row.python}`)).toEqual([])
})

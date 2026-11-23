/**
 * Tests' environments (CONTRIBUTING.md, "Tests"): a test or a test helper gives each child it starts an explicit
 * environment and never changes its own, and a helper never names the real home, so no test reads or writes the
 * owner's home, config, cache or Codex folders.
 *
 * The scan reads source text, with comments and strings blanked. It sees `process.env` or `Bun.env` used whole or
 * written, and a helper's `homedir()`, `userInfo()` or read of a home variable. It can't see a whole environment that
 * reaches a child under another name (a variable holding it, or a default in src such as `options.env ??
 * process.env` that a test leaves unset), and it doesn't check a test file's mentions of the real home: those assert
 * the office's own defaults and refusals, and touch nothing there.
 */
import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { blank, CODE, filesUnder, OFFICE } from "./scan.ts"

const PACKAGES = path.resolve(OFFICE, "..")

/** The folders that hold tests and test helpers, under `packages/`. */
const ROOTS = ["*/test", "*/tests", "*/e2e", "office/src/testing"]

/** A test file, not a helper. */
const TEST_FILE = /\.(test|pw)\.tsx?$/

const ENV = String.raw`\b(?:process|Bun)\.env\b`
/** This process's whole environment, as a value: anything but a read or write of one variable. */
const WHOLE = new RegExp(`${ENV}(?!\\s*(\\?\\.|\\.|\\[))`)
/** A write to this process's environment. */
const WRITE = new RegExp(`${ENV}(\\.\\w+|\\[[^\\]]+\\])?\\s*=(?!=)|\\bdelete\\s+${ENV}`)
/** The real home, or a folder of the owner's that a variable of this process's names. */
const HOME = new RegExp(String.raw`\bhomedir\(\)|\buserInfo\(\)|${ENV}\.(HOME|XDG_\w+|CODEX_HOME|CLAUDE_CONFIG_DIR)\b`)

/** Helpers that run as the harness the office starts: their environment is the one the test gave them, which they
 *  pass on as the real program would. */
const CHILDREN = new Set(["office/src/testing/fake_claude.ts", "office/src/testing/fake_ssh.ts"])

/** Lines that read the whole environment and pass it to nothing, with why. */
const READS = [
  { file: "office/tests/features/reach/run.test.ts", text: "expect(deps.env).toBe(process.env)", why: "the default" },
  { file: "office/tests/server/local/serve.test.ts", text: "JSON.stringify(process.env)", why: "no token in it" },
]

/** Test files that still write this process's environment, because the code they test reads it there and takes none,
 *  with why. */
const WRITERS = new Map([
  ["tui/test/preload.ts", "the TUI reads its home from $OPENCORP_HOME: every TUI test gets a temp one"],
  ["tui/test/core/global.test.ts", "the TUI's Global reads $OPENCORP_HOME"],
  ["tui/test/editor.test.ts", "the TUI's editor reads $VISUAL and $EDITOR"],
  ["tui/test/routes/profile/profile-frame.test.tsx", "the TUI's editor reads $VISUAL and $EDITOR"],
  ["app/test/runs-query.test.ts", "a local day follows $TZ, which only the environment sets"],
])

/** Each test and test helper file under `packages/`, as a path from there. */
function testFiles(): string[] {
  const roots = ROOTS.flatMap((root) => {
    const [pkg, ...rest] = root.split("/")
    const pkgs = pkg === "*" ? fs.readdirSync(PACKAGES) : [pkg!]
    return pkgs.map((name) => path.join(name, ...rest))
  })
  return roots
    .filter((root) => !root.startsWith("yian/") && fs.existsSync(path.join(PACKAGES, root)))
    .flatMap((root) => filesUnder(path.join(PACKAGES, root)).map((file) => path.posix.join(root, file)))
    .filter((file) => CODE.test(file) && !/(^|\/)(node_modules|dist)\//.test(file))
}

test("no test gives a child this process's whole environment or changes its own, and no helper names the real home", () => {
  const files = testFiles()
  for (const file of ["office/tests/e2e/helpers.ts", "office/src/testing/office.ts", "cli/test/main.test.ts"]) {
    expect(files).toContain(file)
  }
  const problems: string[] = []
  for (const file of files) {
    if (CHILDREN.has(file)) continue
    const raw = fs.readFileSync(path.join(PACKAGES, file), "utf8").split("\n")
    blank(raw.join("\n"))
      .split("\n")
      .forEach((line, i) => {
        const read = READS.some((r) => r.file === file && raw[i]!.includes(r.text))
        if (WHOLE.test(line) && !read && !WRITE.test(line)) problems.push(`${file}:${i + 1}: passes the env whole`)
        if (WRITE.test(line) && !WRITERS.has(file)) problems.push(`${file}:${i + 1}: changes this process's env`)
        if (HOME.test(line) && !TEST_FILE.test(file)) problems.push(`${file}:${i + 1}: names the real home`)
      })
  }
  expect(problems).toEqual([])
  // Each exception still holds: one that no longer applies goes.
  for (const r of READS) expect(fs.readFileSync(path.join(PACKAGES, r.file), "utf8")).toContain(r.text)
  for (const file of WRITERS.keys()) {
    expect(WRITE.test(blank(fs.readFileSync(path.join(PACKAGES, file), "utf8"))), file).toBe(true)
  }
})

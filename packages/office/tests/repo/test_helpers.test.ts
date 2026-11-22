/**
 * The test helpers' environments (CONTRIBUTING.md, "Tests"): a helper gives each child it starts an explicit
 * environment and never names the real home, so no test reads or writes the owner's home, config, cache or Codex
 * folders.
 */
import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { blank, CODE, filesUnder, OFFICE } from "./scan.ts"

const PACKAGES = path.resolve(OFFICE, "..")

/** The folders that hold test helpers, under `packages/`. */
const HELPER_ROOTS = ["*/test", "*/tests", "*/e2e", "office/src/testing"]

/** A test file, not a helper. */
const TEST_FILE = /\.(test|pw)\.tsx?$/

/** Helpers that run as the harness the office starts: their environment is the one the test gave them, which they
 *  pass on as the real program would. */
const CHILDREN = new Set(["office/src/testing/fake_claude.ts", "office/src/testing/fake_ssh.ts"])

/** This process's whole environment, as a value: anything but a read of one variable. */
const WHOLE_ENV = /\bprocess\.env\b(?!\s*(\?\.|\.|\[))/
/** The real home, or a folder of the owner's that a variable of this process's names. */
const HOME = /\bhomedir\(\)|\bprocess\.env\.(HOME|XDG_\w+|CODEX_HOME|CLAUDE_CONFIG_DIR)\b/

/** Each helper file under `packages/`, as a path from there. */
function helpers(): string[] {
  const roots = HELPER_ROOTS.flatMap((root) => {
    const [pkg, ...rest] = root.split("/")
    const pkgs = pkg === "*" ? fs.readdirSync(PACKAGES) : [pkg!]
    return pkgs.map((name) => path.join(name, ...rest))
  })
  return roots
    .filter((root) => !root.startsWith("yian/") && fs.existsSync(path.join(PACKAGES, root)))
    .flatMap((root) => filesUnder(path.join(PACKAGES, root)).map((file) => path.posix.join(root, file)))
    .filter((file) => CODE.test(file) && !TEST_FILE.test(file) && !/(^|\/)(node_modules|dist)\//.test(file))
}

test("no test helper gives a child this process's whole environment or names the real home", () => {
  const files = helpers()
  expect(files).toContain("office/tests/e2e/helpers.ts")
  expect(files).toContain("office/src/testing/office.ts")
  const problems: string[] = []
  for (const file of files) {
    if (CHILDREN.has(file)) continue
    const lines = blank(fs.readFileSync(path.join(PACKAGES, file), "utf8")).split("\n")
    lines.forEach((line, i) => {
      if (WHOLE_ENV.test(line)) problems.push(`${file}:${i + 1}: passes process.env whole`)
      if (HOME.test(line)) problems.push(`${file}:${i + 1}: names the real home`)
    })
  }
  expect(problems).toEqual([])
})

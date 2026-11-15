/**
 * The relayout codemod (`script/relayout.ts`), run on a small checkout each test makes: what a move rewrites, and
 * what it refuses before it changes anything.
 */
import { expect, onTestFinished, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OFFICE } from "./scan.ts"

/** The packages the codemod reads besides the office; `git add` fails on one that's missing. */
const OTHERS = ["cli", "tui", "app", "client", "protocol"]

/** The text of a `places.ts` with these tables, one entry per line, and `UPWARD` and `CYCLES` empty. */
function places(src: Record<string, string>, tests: Record<string, string> = {}): string {
  const table = (entries: Record<string, string>): string =>
    Object.entries(entries)
      .map(([from, to]) => `  ${JSON.stringify(from)}: ${JSON.stringify(to)},\n`)
      .join("")
  return [
    `export const PLACES: Readonly<Record<string, string>> = {\n${table(src)}}`,
    `export const TEST_PLACES: Readonly<Record<string, string>> = {\n${table(tests)}}`,
    "export const UPWARD: readonly string[] = []",
    "export const CYCLES: readonly (readonly string[])[] = []",
    "",
  ].join("\n")
}

/** A committed checkout holding the codemod, its scanner, `placesText` as `tests/repo/places.ts`, and `files` (paths
 *  under `packages/office`); and a `run` of the codemod there with `args`, giving its exit code and output. */
function checkout(placesText: string, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayout-"))
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, "repo")
  const office = path.join(repo, "packages/office")
  const env = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" }
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), text)
  }
  write("packages/yian/package.json", "{}\n")
  for (const name of OTHERS) write(`packages/${name}/package.json`, "{}\n")
  write("packages/office/package.json", '{\n  "exports": {}\n}\n')
  write("packages/office/script/relayout.ts", fs.readFileSync(path.join(OFFICE, "script/relayout.ts"), "utf8"))
  write("packages/office/tests/repo/scan.ts", fs.readFileSync(path.join(OFFICE, "tests/repo/scan.ts"), "utf8"))
  write("packages/office/tests/repo/places.ts", placesText)
  for (const [rel, text] of Object.entries(files)) write(`packages/office/${rel}`, text)
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: repo, env, stdio: "pipe" })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture")
  const run = (...args: string[]): { code: number | null; out: string } => {
    const child = spawnSync(process.execPath, ["script/relayout.ts", ...args], { cwd: office, env, encoding: "utf8", timeout: 60_000 })
    return { code: child.status, out: `${child.stdout}${child.stderr}` }
  }
  const read = (rel: string): string => fs.readFileSync(path.join(office, rel), "utf8")
  return { run, read }
}

test("relayout moves a file, rewrites its imports, its roots and its export, and deletes its places entry", () => {
  const { run, read } = checkout(places({ "old/a.ts": "util/deep/a.ts", "old/b.ts": "company/b.ts" }), {
    "package.json": '{\n  "exports": {\n    "./old/a": "./src/old/a.ts"\n  }\n}\n',
    "src/old/a.ts": [
      'import path from "node:path"',
      'import { b } from "./b.ts"',
      'export const ROOT = path.resolve(import.meta.dirname, "../..")',
      "export const UP = [import.meta.dirname, \"..\"]",
      "export const a = b",
      "",
    ].join("\n"),
    "src/old/b.ts": "export const b = 1\n",
  })
  const moved = run("util")
  expect(moved.out).toContain("relayout util: moved 1 files")
  expect(moved.code).toBe(0)
  expect(read("src/util/deep/a.ts")).toBe(
    [
      'import path from "node:path"',
      'import { b } from "../../old/b.ts"',
      'export const ROOT = path.resolve(import.meta.dirname, "../../..")',
      "export const UP = [import.meta.dirname, \"../..\"]",
      "export const a = b",
      "",
    ].join("\n"),
  )
  expect(read("package.json")).toContain('"./util/deep/a": "./src/util/deep/a.ts"')
  expect(read("tests/repo/places.ts")).toBe(places({ "old/b.ts": "company/b.ts" }))
})

test("relayout refuses a path from a moved file's folder that it doesn't rewrite, naming the file and line", () => {
  const { run } = checkout(places({ "old/a.ts": "util/deep/a.ts", "old/same.ts": "util/same.ts" }), {
    "src/old/a.ts": [
      'import path from "node:path"',
      "export const ROOT = path.resolve(",
      "  import.meta.dirname,",
      '  "../..",',
      ")",
      "const HERE = import.meta.dirname",
      'export const UP = path.join(HERE, "..")',
      'export const isUp = (rel: string) => rel === ".." || rel.split("/").includes("..")',
      "",
    ].join("\n"),
    // At the same depth, `..` still names the same folder.
    "src/old/same.ts": 'import path from "node:path"\nconst HERE = import.meta.dirname\nexport const UP = path.join(HERE, "..")\n',
  })
  const refused = run("util", "--dry-run")
  expect(refused.code).toBe(1)
  expect(refused.out).toContain('packages/office/src/old/a.ts:4: "../.."')
  expect(refused.out).toContain('packages/office/src/old/a.ts:7: ".."')
  expect(refused.out).not.toContain("a.ts:8")
  expect(refused.out).not.toContain("same.ts")
})

test("relayout refuses a line that passes import.meta with several all-dots strings, naming the file and line", () => {
  const { run } = checkout(places({ "old/a.ts": "util/deep/a.ts" }), {
    "src/old/a.ts": 'import path from "node:path"\nexport const ROOT = path.join(import.meta.dirname, "..", "..")\n',
  })
  const refused = run("util", "--dry-run")
  expect(refused.code).toBe(1)
  expect(refused.out).toContain("packages/office/src/old/a.ts:2")
})

test("relayout refuses a places entry that spans lines, which it couldn't delete", () => {
  const { run } = checkout(places({}).replace("= {\n}", '= {\n  "old/a.ts":\n    "util/a.ts",\n}'), {
    "src/old/a.ts": "export const a = 1\n",
  })
  const refused = run("util", "--dry-run")
  expect(refused.code).toBe(1)
  expect(refused.out).toContain("tests/repo/places.ts: 1 entries move, but 0 of its lines are theirs")
})

test("relayout refuses an export of a moved file that it can't rename", () => {
  const { run } = checkout(places({ "old/a.ts": "util/a.ts" }), {
    "package.json": '{"exports":{"./old/a":"./src/old/a.ts"}}\n',
    "src/old/a.ts": "export const a = 1\n",
  })
  const refused = run("util", "--dry-run")
  expect(refused.code).toBe(1)
  expect(refused.out).toContain('package.json has no "./old/a": "./src/old/a.ts" to rename')
})

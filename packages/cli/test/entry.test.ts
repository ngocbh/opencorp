import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

setDefaultTimeout(30_000)

const CHECKOUT = fs.realpathSync(fileURLToPath(new URL("../../..", import.meta.url)))
const WRAPPER = path.join(CHECKOUT, "packages/cli/bin/opencorp")
const ENTRY = path.join(CHECKOUT, "packages/cli/src/main.ts")

let tmp = ""
let proj = ""

/** Quotes `s` as one `sh` word. */
const sq = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-entry-")))
  proj = path.join(tmp, "proj")
  // A folder a model could have written: Bun loads them if it reads the folder.
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, ".env"), "PLANTED=1\n")
  fs.writeFileSync(path.join(proj, ".env.local"), "PLANTED_LOCAL=1\n")
  fs.writeFileSync(path.join(proj, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
  fs.writeFileSync(
    path.join(proj, "evil.ts"),
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(path.join(proj, "MARKER"))}, "")\n`,
  )
  const probe = path.join(tmp, "probe.ts")
  fs.writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(path.join(tmp, "seen.json"))}, ` +
      `JSON.stringify({ planted: process.env.PLANTED ?? null, local: process.env.PLANTED_LOCAL ?? null, ` +
      `argv: process.argv.slice(1) }))\n`,
  )
  // A stand-in `bun` that records what the real one saw, so the real wrapper runs the real entry.
  fs.mkdirSync(path.join(tmp, "bin"))
  fs.writeFileSync(path.join(tmp, "bin/bun"), `#!/bin/sh\nexec ${sq(process.execPath)} --preload ${sq(probe)} "$@"\n`, {
    mode: 0o755,
  })
  // The chain `bun link` makes: a link to a link, through a symlinked folder, with spaces.
  fs.mkdirSync(path.join(tmp, "global dir"))
  fs.symlinkSync(path.join(CHECKOUT, "packages/cli"), path.join(tmp, "global dir/opencorp"))
  fs.mkdirSync(path.join(tmp, "my bin/deep"), { recursive: true })
  fs.symlinkSync("../../global dir/opencorp/bin/opencorp", path.join(tmp, "my bin/deep/opencorp"))
  fs.mkdirSync(path.join(tmp, "links"))
  fs.symlinkSync(path.join(tmp, "my bin/deep/opencorp"), path.join(tmp, "links/opencorp"))
  fs.mkdirSync(path.join(proj, "link"))
  fs.symlinkSync(path.relative(path.join(proj, "link"), WRAPPER), path.join(proj, "link/opencorp"))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Runs `command` in the planted folder with only `env` (and HOME); returns what Bun saw. */
function run(command: string, args: string[], env: Record<string, string>) {
  const marker = path.join(proj, "MARKER")
  const seenFile = path.join(tmp, "seen.json")
  fs.rmSync(marker, { force: true })
  fs.rmSync(seenFile, { force: true })
  const result = spawnSync(command, args, { cwd: proj, env: { HOME: tmp, ...env }, encoding: "utf8", timeout: 20_000 })
  if (!fs.existsSync(seenFile))
    throw new Error(`Bun never ran (status ${result.status}, ${result.error ?? "no spawn error"}):\n${result.stderr}`)
  const seen = JSON.parse(fs.readFileSync(seenFile, "utf8")) as {
    planted: string | null
    local: string | null
    argv: string[]
  }
  return { result, seen, marker: fs.existsSync(marker) }
}

test("the wrapper is an executable sh script that execs Bun with the no-autoload flags on the entry", () => {
  expect(fs.statSync(WRAPPER).mode & 0o111).toBe(0o111)
  const text = fs.readFileSync(WRAPPER, "utf8")
  expect(text.split("\n")[0]).toBe("#!/bin/sh")
  expect(text).toContain(
    'exec "${OPENCORP_BUN:-bun}" --no-install --no-env-file --config=/dev/null "$checkout/packages/cli/src/main.ts" "$@"',
  )
  const pkg = JSON.parse(fs.readFileSync(path.join(CHECKOUT, "packages/cli/package.json"), "utf8")) as {
    bin: { opencorp: string }
  }
  expect(pkg.bin.opencorp).toBe("bin/opencorp")
})

test("plain bun from a folder holding .env and a bunfig.toml preload loads both", () => {
  const { seen, marker } = run(path.join(tmp, "bin/bun"), [ENTRY, "--help"], { PATH: "/usr/bin:/bin" })
  expect(seen.planted).toBe("1")
  expect(seen.local).toBe("1")
  expect(marker).toBe(true)
})

test("opencorp --help from a folder holding .env and a bunfig.toml preload sees neither", () => {
  const { result, seen, marker } = run(WRAPPER, ["--help"], { PATH: `${path.join(tmp, "bin")}:/usr/bin:/bin` })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("Usage: opencorp [command] [options]")
  expect(seen.planted).toBeNull()
  expect(seen.local).toBeNull()
  expect(marker).toBe(false)
  expect(seen.argv).toEqual([ENTRY, "--help"])
})

test("opencorp through a bun link symlink chain with OPENCORP_BUN gets args with spaces intact", () => {
  const { result, seen, marker } = run(path.join(tmp, "links/opencorp"), ["--help", "x y", "", "$HOME *"], {
    PATH: "/usr/bin:/bin",
    OPENCORP_BUN: path.join(tmp, "bin/bun"),
  })
  expect(result.status).toBe(0)
  expect(seen.argv).toEqual([ENTRY, "--help", "x y", "", "$HOME *"])
  expect(seen.planted).toBeNull()
  expect(seen.local).toBeNull()
  expect(marker).toBe(false)
})

test("opencorp run by a relative path with CDPATH set still finds the checkout", () => {
  const { result, seen } = run("/bin/sh", ["-c", 'link/opencorp "$@"', "sh", "--help"], {
    PATH: "/usr/bin:/bin",
    OPENCORP_BUN: path.join(tmp, "bin/bun"),
    CDPATH: proj,
  })
  expect(result.status).toBe(0)
  expect(seen.argv).toEqual([ENTRY, "--help"])
  expect(seen.local).toBeNull()
})

// Builds the npm packages of `opencorp` into an outdir (default `dist/npm` here); publishes nothing.
//   opencorp/             the sh shim (`bin/opencorp-npm`) that execs the platform package's binary
//   opencorp-<os>-<cpu>/  the compiled binary, with OpenTUI's native library and assets beside it
//
// From packages/cli: `bun run build [--outdir DIR] [target...]`. With no target it builds one
// package, for this machine, with the running Bun.
import solidPlugin from "@opentui/solid/bun-plugin"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const
type Target = (typeof TARGETS)[number]
const isTarget = (t: string): t is Target => (TARGETS as readonly string[]).includes(t)

type NodeAssets = { getNodeAssets(target: { platform: string; arch: string }): readonly { key: string; source: string }[] }

const CLI = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LICENSE = path.join(CLI, "../../LICENSE")
const { version, license } = JSON.parse(fs.readFileSync(path.join(CLI, "package.json"), "utf8")) as {
  version: string
  license: string
}
const description = "OpenCorp: run a company of AI employees on your machine"

/** Prints `message` as one line on stderr and exits with `code`. */
function fail(message: string, code: number): never {
  console.error(`opencorp build: ${message}`)
  process.exit(code)
}

let values: { outdir?: string }
let positionals: string[]
try {
  ;({ values, positionals } = parseArgs({ options: { outdir: { type: "string" } }, allowPositionals: true }))
} catch (e) {
  fail(e instanceof Error ? e.message : String(e), 2)
}
const outdir = path.resolve(values.outdir ?? path.join(CLI, "dist/npm"))
const names: Target[] = []
for (const t of new Set(positionals)) {
  if (!isTarget(t)) fail(`unknown target ${t} (one of ${TARGETS.join(", ")})`, 2)
  names.push(t)
}
const host = `${process.platform}-${process.arch}`
if (!names.length) {
  // The main package lists only TARGETS, so a package for another host would never be installed.
  if (!isTarget(host)) fail(`no package for this machine (${host}); name a target`, 2)
  names.push(host)
}
// No target: the running Bun's own platform, so no Bun for another platform is downloaded.
const builds = names.map((name) => {
  const [os = "", cpu = ""] = name.split("-")
  return { name, os, cpu, target: positionals.length ? (`bun-${name}` as const) : undefined }
})

// Each output folder is deleted and rewritten, and `opencorp` is also the default clone name: an outdir above a
// checkout must not delete it. So a folder is replaced only when it holds the package this build writes there.
for (const pkgName of ["opencorp", ...builds.map(({ name }) => `opencorp-${name}`)]) {
  const dir = path.join(outdir, pkgName)
  if (!fs.existsSync(dir)) continue
  let found: unknown
  try {
    found = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown }).name
  } catch {}
  if (found !== pkgName) fail(`refusing to replace ${dir}: it isn't a package this build wrote`, 1)
}

/** The package an asset key starts with (`@scope/name` or `name`), and the key's path inside it. */
function splitKey(key: string) {
  const parts = key.split("/")
  const n = key.startsWith("@") ? 2 : 1
  return { owner: parts.slice(0, n).join("/"), inner: parts.slice(n).join("/") }
}

// OpenTUI's own list of what it loads at run time; @opentui/core is the TUI's dependency, not ours.
const nodeAssets = Bun.resolveSync(
  "@opentui/core/node-assets",
  path.dirname(fileURLToPath(import.meta.resolve("@opencorp/tui"))),
)
const { getNodeAssets } = (await import(nodeAssets)) as NodeAssets
/** OpenTUI's assets for one target, or one `opencorp build:` line when its native package isn't installed. */
function assetsFor(name: string, platform: string, arch: string) {
  try {
    return getNodeAssets({ platform, arch })
  } catch (e) {
    const native = `@opentui/core-${name}`
    if (String(e).includes(native)) fail(`${name} needs ${native} installed (bun install --os='*' --cpu='*')`, 1)
    throw e
  }
}
// Every target's assets, and the LICENSE of each package they come from, are found before anything is written.
const assetsOf = new Map(
  builds.map(({ name, os, cpu }) => {
    const assets = assetsFor(name, os, cpu)
    const licenses = new Map<string, string>()
    for (const { key, source } of assets) {
      const { owner, inner } = splitKey(key)
      if (!source.endsWith(path.sep + inner)) fail(`${source} is not ${inner} in a package`, 1)
      const file = path.join(source.slice(0, -inner.length), "LICENSE")
      if (!fs.existsSync(file)) fail(`${owner} has no LICENSE (${file})`, 1)
      licenses.set(owner, file)
    }
    return [name, { assets, licenses }] as const
  }),
)

/** Copies `from` to `to`, making `to`'s folder. */
function copy(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

/** Writes `data` as `<dir>/package.json`. */
function writePackage(dir: string, data: object) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(data, null, 2) + "\n")
}

for (const { name, os, cpu, target } of builds) {
  const dir = path.join(outdir, `opencorp-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const result = await Bun.build({
    // The CODE worker and the run index thread start from their own files beside the main bundle.
    entrypoints: [
      path.join(CLI, "src/main.ts"),
      path.join(CLI, "src/nodes/code/worker.ts"),
      path.join(CLI, "src/runs_indexer.ts"),
    ],
    plugins: [solidPlugin],
    compile: {
      ...(target ? { target } : {}),
      outfile: path.join(dir, "bin/opencorp"),
      // The binary never reads the caller's folder: a project's .env or bunfig.toml (and its preloads) can be
      // model-written.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  // The binary sets OTUI_ASSET_ROOT to `../assets`, so OpenTUI loads these instead of extracting copies to $TMPDIR.
  const { assets, licenses } = assetsOf.get(name)!
  for (const { key, source } of assets) copy(source, path.join(dir, "assets", key))
  for (const [owner, file] of licenses) copy(file, path.join(dir, "assets", owner, "LICENSE"))
  fs.copyFileSync(LICENSE, path.join(dir, "LICENSE"))
  writePackage(dir, {
    name: `opencorp-${name}`,
    version,
    description,
    license,
    os: [os],
    cpu: [cpu],
    files: ["bin", "assets", "LICENSE"],
  })
  console.log(`built ${dir}`)
}

const main = path.join(outdir, "opencorp")
fs.rmSync(main, { recursive: true, force: true })
copy(path.join(CLI, "bin/opencorp-npm"), path.join(main, "bin/opencorp"))
fs.chmodSync(path.join(main, "bin/opencorp"), 0o755)
fs.copyFileSync(LICENSE, path.join(main, "LICENSE"))
writePackage(main, {
  name: "opencorp",
  version,
  description,
  license,
  bin: { opencorp: "bin/opencorp" },
  files: ["bin", "LICENSE"],
  optionalDependencies: Object.fromEntries([...TARGETS].sort().map((t) => [`opencorp-${t}`, version])),
})
console.log(`built ${main}`)

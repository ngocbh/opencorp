import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { officeApi } from "@opencorp/office/server/hq/version"
import { apiId } from "@opencorp/protocol/version"
import { hqBuild } from "../vite.hq"

/** The `build.json` a fresh `hqBuild()` emits, and the `__HQ_BUILD__` it defines for a build. */
function emitBuild() {
  const plugin = hqBuild() as any
  const define = plugin.config({}, { command: "build" }).define.__HQ_BUILD__
  const emitted: any[] = []
  plugin.generateBundle.call({ emitFile: (f: any) => emitted.push(f) })
  expect(emitted[0].fileName).toBe("build.json")
  return { define, json: JSON.parse(emitted[0].source) }
}

test("the app build and the office compute the same key", () => {
  const { json } = emitBuild()
  expect(json.api).toBe(officeApi())
})

test("a build gets a fresh nonce in __HQ_BUILD__ and in build.json, with the api key", () => {
  const { define, json } = emitBuild()
  expect(JSON.parse(define)).toBe(json.build)
  expect(json.api).toBe(apiId())
  expect((hqBuild() as any).config({}, { command: "build" }).define.__HQ_BUILD__).not.toBe(define)
  expect((hqBuild() as any).config({}, { command: "serve" }).define.__HQ_BUILD__).toBe('"dev"')
})

test("the build targets the minimum browsers and inlines no asset, which the CSP would refuse as data:", () => {
  // In a child process, since importing Vite inside bun test fails. On this Bun, which the build script runs Vite on
  // too, rather than the host's `node`, which may be older than Vite's floor (^20.19 || >=22.12; Misha's is 20.12,
  // and rolldown fails on it at import). The runner loader, as the build scripts use: Vite's default loader bundles
  // the config and leaves the workspace packages for Node, which can't load their TS. A cold start of Bun, Vite and
  // rolldown on a loaded host can take more than bun test's 5 s default, hence the longer timeouts.
  const script = `const { loadConfigFromFile } = await import("vite")
const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, "vite.config.ts", undefined, "silent", undefined, "runner")
console.log(JSON.stringify(loaded.config.build))`
  const out = Bun.spawnSync([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", script], {
    cwd: path.join(import.meta.dir, ".."),
    // Under the test's own, so a hung load still fails with its stderr.
    timeout: 55_000,
  })
  if (out.exitCode !== 0) {
    const how = out.exitedDueToTimeout ? "timed out" : `ended with ${out.exitCode ?? out.signalCode}`
    throw new Error(`the config load ${how}: ${out.stderr.toString()}`)
  }
  const build = JSON.parse(out.stdout.toString())
  expect(build.target).toEqual(["es2022", "chrome116", "safari17.4", "firefox124"])
  expect(build.assetsInlineLimit).toBe(0)
}, 60_000)

test("the build runs Vite on Bun, so a node first on PATH never runs", () => {
  // The `node` first on PATH stands in for one older than Vite's floor, like Misha's conda Node 20.12: it notes that
  // it ran and fails. The build has to write the whole app without running it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-app-build-"))
  try {
    const bin = path.join(root, "bin")
    const ran = path.join(root, "node-ran")
    const out = path.join(root, "dist")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\necho "$*" >>'${ran}'\nexit 1\n`, { mode: 0o755 })
    const argv = ["--no-install", "--no-env-file", "--config=/dev/null", "run", "build", "--outDir", out, "--emptyOutDir"]
    const build = Bun.spawnSync([process.execPath, ...argv], {
      cwd: path.join(import.meta.dir, ".."),
      // The script calls `bun` by name, as install.sh's PATH lets it; a temp HOME keeps the user's Bun config out.
      env: { HOME: root, TMPDIR: root, PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":") },
      timeout: 110_000,
    })
    const ranWith = fs.existsSync(ran) ? fs.readFileSync(ran, "utf8") : null
    expect(ranWith).toBeNull()
    if (build.exitCode !== 0) {
      const how = build.exitedDueToTimeout ? "timed out" : `ended with ${build.exitCode ?? build.signalCode}`
      throw new Error(`the build ${how}: ${build.stderr.toString()}`)
    }
    expect(fs.readdirSync(out)).toEqual(expect.arrayContaining(["assets", "build.json", "index.html"]))
    expect(JSON.parse(fs.readFileSync(path.join(out, "build.json"), "utf8")).api).toBe(apiId())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

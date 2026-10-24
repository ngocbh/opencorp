import { expect, test } from "bun:test"
import path from "node:path"
import { officeApi } from "@opencorp/office/hq/version"
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
  expect(json.api).toBe(apiId())
})

test("a build gets a fresh nonce in __HQ_BUILD__ and in build.json, with the api key", () => {
  const { define, json } = emitBuild()
  expect(JSON.parse(define)).toBe(json.build)
  expect(json.api).toBe(apiId())
  expect((hqBuild() as any).config({}, { command: "build" }).define.__HQ_BUILD__).not.toBe(define)
  expect((hqBuild() as any).config({}, { command: "serve" }).define.__HQ_BUILD__).toBe('"dev"')
})

test("the build targets the minimum browsers and inlines no asset, which the CSP would refuse as data:", () => {
  // Under Node, as `vite build` loads it: importing Vite inside bun test fails. The runner loader, as the build
  // scripts use: Vite's default loader bundles the config and leaves the workspace packages for Node, which can't
  // load their TS.
  const script = `const { loadConfigFromFile } = await import("vite")
const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, "vite.config.ts", undefined, "silent", undefined, "runner")
console.log(JSON.stringify(loaded.config.build))`
  const out = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: path.join(import.meta.dir, "..") })
  expect(out.exitCode).toBe(0)
  const build = JSON.parse(out.stdout.toString())
  expect(build.target).toEqual(["es2022", "chrome116", "safari17.4", "firefox124"])
  expect(build.assetsInlineLimit).toBe(0)
})

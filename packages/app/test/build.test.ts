import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { apiId, hqBuild } from "../vite.hq"

test("apiId is the pyproject version and 12 hex of the schema's sha256", () => {
  const repo = mkdtempSync("/tmp/oca-")
  try {
    writeFileSync(
      path.join(repo, "pyproject.toml"),
      '[project]\nname = "opencorp"\nversion = "1.2.3"\n\n[tool.x]\nversion = "9"\n',
    )
    mkdirSync(path.join(repo, "packages/protocol/schema"), { recursive: true })
    writeFileSync(path.join(repo, "packages/protocol/schema/protocol.schema.json"), '{"$defs": {}}')
    expect(apiId(repo)).toBe("1.2.3+" + createHash("sha256").update('{"$defs": {}}').digest("hex").slice(0, 12))
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("a build gets a fresh nonce in __HQ_BUILD__ and in build.json, with the api key", () => {
  const plugin = hqBuild() as any
  const define = plugin.config({}, { command: "build" }).define.__HQ_BUILD__
  const emitted: any[] = []
  plugin.generateBundle.call({ emitFile: (f: any) => emitted.push(f) })
  const json = JSON.parse(emitted[0].source)
  expect(emitted[0].fileName).toBe("build.json")
  expect(JSON.parse(define)).toBe(json.build)
  expect(json.api).toBe(apiId())
  expect((hqBuild() as any).config({}, { command: "build" }).define.__HQ_BUILD__).not.toBe(define)
  expect((hqBuild() as any).config({}, { command: "serve" }).define.__HQ_BUILD__).toBe('"dev"')
})

test("the build targets the minimum browsers and inlines no asset, which the CSP would refuse as data:", () => {
  // Under Node, as `vite build` loads it: importing Vite inside bun test fails.
  const out = Bun.spawnSync(
    ["node", "--input-type=module", "-e", 'console.log(JSON.stringify((await import("./vite.config.ts")).default.build))'],
    { cwd: path.join(import.meta.dir, "..") },
  )
  expect(out.exitCode).toBe(0)
  const build = JSON.parse(out.stdout.toString())
  expect(build.target).toEqual(["es2022", "chrome116", "safari17.4", "firefox124"])
  expect(build.assetsInlineLimit).toBe(0)
})

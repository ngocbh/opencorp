/** HQ's settings in office/hq.json. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { DEFAULT_PORT, loadConfig } from "../../src/hq/config.ts"
import { tempDir } from "../helpers.ts"

function write(officeDir: string, data: unknown): void {
  fs.mkdirSync(officeDir, { recursive: true })
  fs.writeFileSync(path.join(officeDir, "hq.json"), typeof data === "string" ? data : JSON.stringify(data))
}

/** `loadConfig` on `officeDir` with `checkout: officeDir`, and the lines it logged. */
function load(officeDir: string, platform = "darwin") {
  const lines: string[] = []
  const config = loadConfig(officeDir, { platform, checkout: officeDir, log: (line) => lines.push(line) })
  return { config, lines }
}

test.each([
  ["darwin", true],
  ["linux", false],
] as const)("tcp is on by default only on macos [%s]", (platform, tcp) => {
  const { config, lines } = load(tempDir(), platform)
  expect([config.tcp, config.port, config.devOrigins, config.problem]).toEqual([tcp, DEFAULT_PORT, [], null])
  expect(lines).toEqual([])
})

test("the app dir defaults to the checkouts dist and is none outside a checkout", () => {
  const tmp = tempDir()
  expect(load(tmp).config.appDir).toBeNull()
  fs.mkdirSync(path.join(tmp, "packages", "app"), { recursive: true })
  expect(load(tmp).config.appDir).toBe(path.join(tmp, "packages", "app", "dist"))
})

test("settings override the defaults", () => {
  const tmp = tempDir()
  write(tmp, { tcp: true, port: 0, app_dir: "web", dev_origins: ["http://localhost:5173"] })
  const { config } = load(tmp, "linux")
  expect([config.tcp, config.port, config.appDir, config.devOrigins]).toEqual([
    true,
    0,
    path.join(tmp, "web"),
    ["http://localhost:5173"],
  ])
})

const BAD: [string, unknown][] = [
  ["{", "{"],
  ["[]", "[]"],
  ['{"tcp":"yes"}', { tcp: "yes" }],
  ['{"port":70000}', { port: 70000 }],
  ['{"port":true}', { port: true }],
  ['{"colour":1}', { colour: 1 }],
  ['{"dev_origins":["localhost:5173"]}', { dev_origins: ["localhost:5173"] }],
  ['{"dev_origins":["http://a/b"]}', { dev_origins: ["http://a/b"] }],
  ['{"app_dir":"~nosuchuser-opencorp/dist"}', { app_dir: "~nosuchuser-opencorp/dist" }],
  ["deeply-nested", "[".repeat(100_000) + "]".repeat(100_000)],
]

test.each(BAD)("a bad file is ignored and says why [%s]", (_shown, bad) => {
  const tmp = tempDir()
  write(tmp, bad)
  const { config, lines } = load(tmp)
  expect(config.tcp).toBe(true)
  expect(config.port).toBe(DEFAULT_PORT)
  expect(config.problem).toContain("hq.json")
  expect(lines.some((line) => line.includes("hq.json"))).toBe(true)
})

test("a problem never quotes the files values", () => {
  const secret = "sk-sentinel-0123456789"
  for (const text of [`{"tcp": "${secret}"`, `{"tcp": "${secret}"}`]) {
    const tmp = tempDir()
    write(tmp, text)
    const { config, lines } = load(tmp)
    expect(config.problem).toContain("hq.json")
    expect(config.problem).not.toContain("sk-sentinel")
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join("\n")).not.toContain("sk-sentinel")
  }
})

test("app dir expands the home folder", () => {
  const tmp = tempDir()
  write(tmp, { app_dir: "~/web" })
  const { config } = load(tmp)
  expect(config.problem).toBeNull()
  expect(config.appDir).toBe(path.join(os.homedir(), "web"))
})

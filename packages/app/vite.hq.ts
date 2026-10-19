// The ids that keep the built app and the office in step: `api`, the compatibility key the office computes the same
// way (opencorp/hq/version.py), and `build`, a nonce per build.
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

const REPO = path.resolve(import.meta.dirname, "../..")

/** `[project] version` from pyproject.toml. */
function projectVersion(toml: string) {
  let inProject = false
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) inProject = line.trim() === "[project]"
    const m = inProject && /^version\s*=\s*"([^"]+)"/.exec(line.trim())
    if (m) return m[1]
  }
  throw new Error("pyproject.toml has no [project] version")
}

/** `<version>+<first 12 hex of sha256(protocol.schema.json)>`: a docs-only commit changes neither part. */
export function apiId(repo = REPO) {
  const version = projectVersion(readFileSync(path.join(repo, "pyproject.toml"), "utf8"))
  const schema = readFileSync(path.join(repo, "packages/protocol/schema/protocol.schema.json"))
  return `${version}+${createHash("sha256").update(schema).digest("hex").slice(0, 12)}`
}

/** Defines `__HQ_BUILD__` (a new nonce per build; "dev" under vite dev) and writes it with `apiId()` to build.json. */
export function hqBuild(): Plugin {
  const build = randomUUID()
  return {
    name: "opencorp-hq-build",
    config: (_config, env) => ({ define: { __HQ_BUILD__: JSON.stringify(env.command === "build" ? build : "dev") } }),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify({ build, api: apiId() }) + "\n" })
    },
  }
}

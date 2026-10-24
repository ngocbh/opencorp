// The ids that keep the built app and the office in step: `api`, the compatibility key `apiId()` that the office
// computes too, and `build`, a nonce per build.
import { randomUUID } from "node:crypto"
import { apiId } from "@opencorp/protocol/version"
import type { Plugin } from "vite"

/** Defines `__HQ_BUILD__` (a new nonce per build; "dev" under vite dev) and writes it with `apiId()` to build.json. */
export function hqBuild(): Plugin {
  // One nonce per plugin, and `define` is read once per config: `vite build --watch` would reuse it on every rebuild,
  // so an open tab would never reload for one. Watch mode isn't supported; run `bun run build`.
  const build = randomUUID()
  return {
    name: "opencorp-hq-build",
    config: (_config, env) => ({ define: { __HQ_BUILD__: JSON.stringify(env.command === "build" ? build : "dev") } }),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify({ build, api: apiId() }) + "\n" })
    },
  }
}

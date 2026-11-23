import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "../../src/core/global"

/** The TUI's kv.json, under the preload's OPENCORP_HOME, which every test file shares. */
const kvFile = () => path.join(Global.Path.state, "kv.json")

/** What kv.json holds now. */
export function readKV(): Record<string, unknown> {
  return existsSync(kvFile()) ? JSON.parse(readFileSync(kvFile(), "utf8")) : {}
}

/** Sets each key of `values` in kv.json, or takes it out where its value is undefined, keeping other keys. */
export function writeKV(values: Record<string, unknown>) {
  const next = { ...readKV() }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  mkdirSync(Global.Path.state, { recursive: true })
  writeFileSync(kvFile(), JSON.stringify(next))
}

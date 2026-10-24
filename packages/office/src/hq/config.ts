/** HQ's settings: `$OPENCORP_HOME/office/hq.json`, read when the office starts (restart to apply). */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { logLine } from "../daemon/http.ts"
import { CHECKOUT } from "./version.ts"

/** A fixed port, so a bookmark and an SSH forward keep working across restarts. */
export const DEFAULT_PORT = 49380

const ORIGIN = /^https?:\/\/[^/\s]+$/u
const KEYS = ["app_dir", "dev_origins", "port", "tcp"]

/** Whether HQ listens on TCP and on which port (0: any free one), where the built app is, the extra origins `/api`
 *  accepts (a Vite dev server), and why `hq.json` was ignored, when it was. */
export interface HqConfig {
  tcp: boolean
  port: number
  appDir: string | null
  devOrigins: readonly string[]
  problem: string | null
}

/** `<checkout>/packages/app/dist` in a checkout; null outside one. */
export function defaultAppDir(checkout: string = CHECKOUT): string | null {
  const app = path.join(checkout, "packages", "app")
  try {
    return fs.statSync(app).isDirectory() ? path.join(app, "dist") : null
  } catch {
    return null
  }
}

/** A JSON list of `names`, as `["a", "b"]`. */
function quoted(names: string[]): string {
  return `[${names.map((name) => JSON.stringify(name)).join(", ")}]`
}

/**
 * `appDir` with a leading `~` expanded. Node can't look up another account's home, so only `~`, `~/…` and this
 * account's own `~<name>` expand; null for any other `~name`.
 */
function expandHome(appDir: string): string | null {
  if (!appDir.startsWith("~")) return appDir
  const slash = appDir.indexOf("/")
  const name = appDir.slice(1, slash < 0 ? undefined : slash)
  if (name !== "") {
    let me: string
    try {
      me = os.userInfo().username
    } catch {
      return null
    }
    if (name !== me) return null
  }
  return os.homedir() + (slash < 0 ? "" : appDir.slice(slash))
}

/** `defaults` with the settings in `data`; throws an Error naming the first bad setting. */
function apply(defaults: HqConfig, data: unknown, officeDir: string): HqConfig {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("must be a JSON object")
  const settings = data as Record<string, unknown>
  const unknown = Object.keys(settings).filter((key) => !KEYS.includes(key))
  if (unknown.length) throw new Error(`unknown keys ${quoted(unknown.sort())}; known: ${quoted([...KEYS].sort())}`)
  const config = { ...defaults }
  if (Object.hasOwn(settings, "tcp")) {
    if (typeof settings.tcp !== "boolean") throw new Error("tcp must be true or false")
    config.tcp = settings.tcp
  }
  if (Object.hasOwn(settings, "port")) {
    const port = settings.port
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("port must be an integer from 0 (any free port) to 65535")
    }
    config.port = port
  }
  if (Object.hasOwn(settings, "app_dir")) {
    const value = settings.app_dir
    if (typeof value !== "string" || !value) throw new Error("app_dir must be a path")
    const appDir = expandHome(value)
    if (appDir === null) throw new Error(`app_dir ${JSON.stringify(value)} can't be expanded`)
    config.appDir = path.isAbsolute(appDir) ? appDir : path.join(officeDir, appDir)
  }
  if (Object.hasOwn(settings, "dev_origins")) {
    const origins = settings.dev_origins
    if (!Array.isArray(origins) || !origins.every((o) => typeof o === "string" && ORIGIN.test(o))) {
      throw new Error("dev_origins must be a list of origins such as http://localhost:5173")
    }
    config.devOrigins = [...origins]
  }
  return config
}

/**
 * `officeDir/hq.json` over the defaults. A file that isn't valid is ignored, logged through `log`, and named in
 * `problem`; the problem never quotes the parser or a setting's value, except unknown key names and an app_dir that
 * can't be expanded, as Python does.
 *
 * TCP is on by default only on macOS: on a host with other users, whoever holds the port while the office doesn't
 * is the origin the browser trusts, so HQ listens there on `hq.sock` alone unless the owner opts in.
 */
export function loadConfig(
  officeDir: string,
  { platform = process.platform, checkout = CHECKOUT, log }: { platform?: string; checkout?: string; log: (line: string) => void },
): HqConfig {
  const defaults: HqConfig = {
    tcp: platform === "darwin",
    port: DEFAULT_PORT,
    appDir: defaultAppDir(checkout),
    devOrigins: [],
    problem: null,
  }
  const ignored = (why: string): HqConfig => {
    log(logLine("ERROR", "opencorp.hq.config", `ignoring HQ settings: ${why}`))
    return { ...defaults, problem: why }
  }
  const file = path.join(officeDir, "hq.json")
  let raw: Buffer
  try {
    raw = fs.readFileSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === "ENOENT") return defaults
    return ignored(`${file} can't be read: ${code ?? "error"}`)
  }
  let data: unknown
  try {
    // ignoreBOM keeps a leading BOM, so JSON.parse refuses it as Python's json.loads does.
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw))
  } catch {
    // Bad UTF-8, bad JSON, or a RangeError from deep nesting; the parser's text can quote the file.
    return ignored(`${file} can't be read: not valid JSON`)
  }
  try {
    return apply(defaults, data, officeDir)
  } catch (error) {
    return ignored(`${file}: ${(error as Error).message}`)
  }
}

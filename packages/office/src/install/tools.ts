/** The programs the daemon runs, resolved once at start on the daemon's `PATH` to absolute realpaths, so a
 *  folder a sandboxed call can write can't plant one; and the paths every workspace must stay clear of. */
import fs from "node:fs"
import path from "node:path"
import { selfCommand } from "../platform.ts"
import { type OfficePaths as SandboxOfficePaths, realPath } from "../sandbox/policy.ts"
import { type Env, which } from "./launch.ts"

/** The programs the daemon, its workers and Codex run. */
export const TOOL_NAMES = ["git", "codex", "tmux", "bwrap", "ps", "who"] as const

/** One of `TOOL_NAMES`. */
export type ToolName = (typeof TOOL_NAMES)[number]

/** Each tool found, as its absolute realpath; a missing one is absent. */
export type Tools = { readonly [K in ToolName]?: string }

/** An npm platform package's folder name, `opencorp-<os>-<cpu>`. */
const PLATFORM_PACKAGE = /^opencorp-[a-z0-9]+-[a-z0-9]+$/

/**
 * Each tool as `env.PATH`'s absolute entries find it, resolved to its realpath. Codex is `OPENCORP_CODEX_BIN` when
 * set (a name looked up on the path, or an absolute path; a relative path finds nothing), else `codex`; a missing
 * override never falls back to `codex`.
 */
export function resolveTools(env: Env): Tools {
  const tools: { [K in ToolName]?: string } = {}
  for (const name of TOOL_NAMES) {
    const found = which(name === "codex" ? env.OPENCORP_CODEX_BIN || "codex" : name, env.PATH)
    if (found !== null) tools[name] = realPath(found)
  }
  return tools
}

/**
 * The office's install folders, as realpaths. A checkout command
 * (`[bun, ...flags, <checkout>/packages/cli/src/main.ts]`) is the checkout root. A compiled binary at
 * `<pkg>/bin/opencorp`, with `<pkg>` an `opencorp-<os>-<cpu>` package, is that package, plus the `opencorp` shim
 * package when npm's layouts put it there: hoisted beside `<pkg>` in the same `node_modules`, or nested, with `<pkg>`
 * in the `node_modules` of a shim that itself sits in a `node_modules`. pnpm's store isn't searched: a workspace
 * containing the store already contains the package. Any other binary is its own folder.
 */
export function installPaths([program, ...rest]: readonly [string, ...string[]] = selfCommand()): string[] {
  const entry = rest.at(-1)
  if (entry !== undefined) return [path.dirname(path.dirname(path.dirname(path.dirname(realPath(entry)))))]
  const binary = realPath(program)
  const bin = path.dirname(binary)
  const pkg = path.dirname(bin)
  const inPackage =
    path.basename(binary) === "opencorp" && path.basename(bin) === "bin" && PLATFORM_PACKAGE.test(path.basename(pkg))
  if (!inPackage) return [bin]
  const parent = path.dirname(pkg)
  if (path.basename(parent) !== "node_modules") return [pkg]
  const sibling = path.join(parent, "opencorp")
  if (fs.existsSync(sibling)) return [pkg, realPath(sibling)]
  const shim = path.dirname(parent)
  // A project folder that happens to be named opencorp is not the shim; npm's nested shim is itself a package.
  if (path.basename(shim) === "opencorp" && path.basename(path.dirname(shim)) === "node_modules") return [pkg, shim]
  return [pkg]
}

/**
 * What every workspace must stay clear of: the install, the resolved tools plus the program running the office
 * (`command[0]`: the binary, or a checkout's Bun), and the absolute entries of `env.PATH`. The policy realpaths each
 * entry; a relative `PATH` entry is already gone (`daemonEnv`), and would refuse every workspace if kept.
 */
export function workspaceGuards(
  tools: Tools,
  env: Env,
  command: readonly [string, ...string[]] = selfCommand(),
): SandboxOfficePaths {
  return {
    install: installPaths(command),
    tools: [...Object.values(tools).filter((tool) => tool !== undefined), realPath(command[0])],
    path: (env.PATH ?? "").split(":").filter((entry) => entry.startsWith("/")),
  }
}

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
 * `<pkg>/bin/opencorp`, with `<pkg>` an `opencorp-<os>-<cpu>` package, is that package plus the `opencorp` shim
 * package beside it (hoisted) or holding it (nested in its `node_modules`); any other binary is its own folder.
 */
export function installPaths(command: readonly string[] = selfCommand()): string[] {
  if (command.length > 1) {
    const entry = realPath(command[command.length - 1]!)
    return [path.dirname(path.dirname(path.dirname(path.dirname(entry))))]
  }
  const binary = realPath(command[0]!)
  const bin = path.dirname(binary)
  const pkg = path.dirname(bin)
  const inPackage =
    path.basename(binary) === "opencorp" && path.basename(bin) === "bin" && PLATFORM_PACKAGE.test(path.basename(pkg))
  if (!inPackage) return [bin]
  const parent = path.dirname(pkg)
  if (path.basename(parent) === "node_modules" && path.basename(path.dirname(parent)) === "opencorp") {
    return [pkg, path.dirname(parent)]
  }
  const sibling = path.join(parent, "opencorp")
  return fs.existsSync(sibling) ? [pkg, realPath(sibling)] : [pkg]
}

/**
 * What every workspace must stay clear of: the install, the resolved tools plus the program running the office
 * (`command[0]`: the binary, or a checkout's Bun), and the absolute entries of `env.PATH`. The policy realpaths each
 * entry; a relative `PATH` entry is already gone (`daemonEnv`), and would refuse every workspace if kept.
 */
export function workspaceGuards(
  tools: Tools,
  env: Env,
  command: readonly string[] = selfCommand(),
): SandboxOfficePaths {
  return {
    install: installPaths(command),
    tools: [...Object.values(tools).filter((tool) => tool !== undefined), realPath(command[0]!)],
    path: (env.PATH ?? "").split(":").filter((entry) => entry.startsWith("/")),
  }
}

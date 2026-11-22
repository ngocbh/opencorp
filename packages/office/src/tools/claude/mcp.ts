/** The owner's MCP servers for Claude Code, and the file that hands an employee's start the ones their person allows.
 *
 *  Claude Code keeps the owner's user-scope servers (`claude mcp add --scope user`) under `mcpServers` in its
 *  `.claude.json`: in the home, or in `CLAUDE_CONFIG_DIR` when that is set (Claude Code's docs, claude-directory). A
 *  definition can hold the owner's secrets (a token in `env`, a header), so none ever goes on a command line or in a
 *  log: a start gets them in a 0600 file in a private folder its commands can't read (`EmployeePermission.secrets`),
 *  which goes when Claude Code exits. With `--strict-mcp-config` Claude Code loads only that file's servers. */
import fs from "node:fs"
import path from "node:path"
import { MCP_SERVER_NAME } from "../../company/naming.ts"
import { readRegular } from "../../util/files.ts"

/** The most of `.claude.json` read: it also holds Claude Code's state for each project, which grows. */
const CLAUDE_JSON_MAX_BYTES = 64 * 1024 * 1024
/** The start's file, in the private folder it is given. */
const FILE = "opencorp.mcp.json"

/** Where Claude Code keeps the owner's own config, MCP servers among it: `.claude.json` in `environ`'s
 *  `CLAUDE_CONFIG_DIR` when that is set, else in `home`. */
export function claudeJson(environ: Record<string, string | undefined>, home: string): string {
  return path.join(environ.CLAUDE_CONFIG_DIR || home, ".claude.json")
}

/** The owner's user-scope MCP servers in `file` (`claudeJson`), each definition by name, as Claude Code keeps them:
 *  none when there is no file or it defines none, and null when it can't be read (not a regular file, too big, not a
 *  JSON object, or its `mcpServers` not one). A link is followed: the file is the owner's. A definition that isn't an
 *  object is left out. What the file holds is never put in an error. */
export function ownerMcpServers(file: string): Record<string, unknown> | null {
  let real: string
  try {
    real = fs.realpathSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? {} : null
  }
  let parsed: unknown
  try {
    const bytes = readRegular(real, CLAUDE_JSON_MAX_BYTES)
    if (bytes === null) return null
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    // A parse error's message can quote the file, tokens included.
    return null
  }
  if (!isObject(parsed)) return null
  const servers = parsed.mcpServers
  if (servers === undefined) return {}
  if (!isObject(servers)) return null
  return Object.fromEntries(Object.entries(servers).filter(([, definition]) => isObject(definition)))
}

/** The definitions in `defined` (`ownerMcpServers`'s; null for unknown) of the servers `allowed` names, and the
 *  allowed names that pick none: not defined there, or not a plain name (`MCP_SERVER_NAME`). */
export function mcpServersOf(
  defined: Record<string, unknown> | null,
  allowed: readonly string[],
): { servers: Record<string, unknown>; missing: string[] } {
  const found = (name: string) => MCP_SERVER_NAME.test(name) && defined !== null && Object.hasOwn(defined, name)
  return {
    servers: Object.fromEntries(allowed.filter(found).map((name) => [name, defined![name]])),
    missing: allowed.filter((name) => !found(name)),
  }
}

/** Writes `{ mcpServers: servers }` to `opencorp.mcp.json` in `dir`, a private folder of the office's: made fresh and
 *  0600, whatever was there (a link included) removed first, never written through. Returns its path. */
export function writeMcpConfig(dir: string, servers: Record<string, unknown>): string {
  const file = path.join(dir, FILE)
  fs.rmSync(file, { force: true })
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify({ mcpServers: servers }))
  } finally {
    fs.closeSync(fd)
  }
  return file
}

/** The permission rule that lets Claude Code run every tool of server `name` without asking: the wildcard form,
 *  which takes a name holding `__` whole (Claude Code's docs, permissions). */
export function mcpAllowRule(name: string): string {
  return `mcp__${name}__*`
}

/** Whether `tool` (a name in a turn's `system`/`init` line) is a tool of one of `servers`: `mcp__<server>__<tool>`. */
export function mcpTool(tool: string, servers: readonly string[]): boolean {
  return servers.some((server) => tool.startsWith(`mcp__${server}__`) && tool.length > `mcp__${server}__`.length)
}

/** A plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

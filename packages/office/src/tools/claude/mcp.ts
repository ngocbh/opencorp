/** The owner's MCP servers for Claude Code, and the file that hands an employee's start the ones their person allows.
 *
 *  Claude Code keeps the owner's user-scope servers (`claude mcp add --scope user`) under `mcpServers` in its
 *  `.claude.json`: in the home, or in `CLAUDE_CONFIG_DIR` when that is set (Claude Code's docs, claude-directory). A
 *  definition can hold the owner's secrets (a token in `env`, a header), so none ever goes on a command line or in a
 *  log: a start gets them in a 0600 file in the office's MCP folder of the start, which its commands can't read
 *  (`EmployeePermission.mcpHome`), and which goes when Claude Code exits. With `--strict-mcp-config` Claude Code loads
 *  only that file's servers.
 *
 *  Claude Code starts a server in its own working folder, the employee's, where a launcher (npx's `node_modules` and
 *  `.npmrc`, uvx's `pyproject.toml`, python's `sys.path`) would load what the employee planted, and runs the server
 *  as the owner, outside the sandbox. Its definitions take no folder, so each program starts through `sh`, which
 *  first moves to the office's empty folder (`startIn`). */
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

/** The definitions in `defined` (`ownerMcpServers`'s; null for unknown) of the servers `allowed` names, each started
 *  in `cwd` (`startIn`), and the allowed names that pick none: not defined there, not a plain name (`MCP_SERVER_NAME`),
 *  or of a kind that can't be started there. */
export function mcpServersOf(
  defined: Record<string, unknown> | null,
  allowed: readonly string[],
  cwd: string,
): { servers: Record<string, unknown>; missing: string[] } {
  const servers: Record<string, unknown> = {}
  const missing: string[] = []
  for (const name of allowed) {
    const found = MCP_SERVER_NAME.test(name) && defined !== null && Object.hasOwn(defined, name)
    const definition = found ? defined[name] : null
    const started = isObject(definition) ? startIn(definition, cwd) : null
    if (started === null) missing.push(name)
    // A plain name has no __, so it is never __proto__.
    else servers[name] = started
  }
  return { servers, missing }
}

/** The script `sh` runs before a server's own command: into the folder given (its first argument), or no start. It
 *  holds no `${…}`, which Claude Code would expand. */
const START = 'cd -- "$1" || exit 1; shift; exec "$@"'

/** `definition` as it starts in `cwd`, not in Claude Code's own working folder: a program (`stdio`, or no `type`)
 *  through `/bin/sh` with `START`, its own command, arguments and env as they were; one reached by URL (`http`,
 *  `sse`) as it is, but the `headersHelper` command Claude Code runs for it through a shell moving there first. Null
 *  for a program with no command, or a kind OpenCorp doesn't know. */
export function startIn(definition: Record<string, unknown>, cwd: string): Record<string, unknown> | null {
  const type = definition.type ?? "stdio"
  if (type === "stdio") {
    if (typeof definition.command !== "string") return null
    const args = Array.isArray(definition.args) ? definition.args : []
    return { ...definition, command: "/bin/sh", args: ["-c", START, "opencorp-mcp", cwd, definition.command, ...args] }
  }
  if (type !== "http" && type !== "sse") return null
  if (definition.headersHelper === undefined) return { ...definition }
  if (typeof definition.headersHelper !== "string") return null
  return { ...definition, headersHelper: `cd -- ${shellQuote(cwd)} || exit 1\n${definition.headersHelper}` }
}

/** `text` as one word to a POSIX shell. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
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

/** A plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

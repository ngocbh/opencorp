/** The owner's MCP servers for Claude Code, read by name from `.claude.json`, and the 0600 file that hands an employee's
 *  start only those their person allows, which no argument and no log line ever holds. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import {
  claudeJson,
  mcpAllowRule,
  mcpServersOf,
  ownerMcpServers,
  startIn,
  writeMcpConfig,
} from "../../../src/tools/claude/mcp.ts"
import { tempDir } from "../../helpers.ts"

/** Server definitions as `claude mcp add --scope user` keeps them, two holding a token. */
const SERVERS = {
  github: { type: "stdio", command: "gh-mcp", args: [], env: { GITHUB_TOKEN: "ghp_decoy-token" } },
  docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer decoy-bearer" } },
  web: { type: "stdio", command: "web-mcp" },
}

test("Claude Code's own config is .claude.json in the home, or in CLAUDE_CONFIG_DIR when the office sets one", () => {
  expect(claudeJson({}, "/home/o")).toBe("/home/o/.claude.json")
  expect(claudeJson({ CLAUDE_CONFIG_DIR: "" }, "/home/o")).toBe("/home/o/.claude.json")
  expect(claudeJson({ CLAUDE_CONFIG_DIR: "/srv/claude-work" }, "/home/o")).toBe("/srv/claude-work/.claude.json")
})

test("the owner's user-scope servers are .claude.json's mcpServers, a project's own left out, through a link too", () => {
  const root = fs.realpathSync(tempDir())
  const file = path.join(root, ".claude.json")
  const project = { mcpServers: { local: { command: "local-mcp" } } }
  fs.writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: SERVERS, projects: { "/w": project } }))
  expect(ownerMcpServers(file)).toEqual(SERVERS)
  const link = path.join(root, "link.json")
  fs.symlinkSync(file, link)
  expect(ownerMcpServers(link)).toEqual(SERVERS)
  // A definition that isn't an object is left out, as Claude Code couldn't load it.
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { ...SERVERS, odd: "x", none: null } }))
  expect(Object.keys(ownerMcpServers(file)!)).toEqual(["github", "docs", "web"])
})

test("no .claude.json, or none with servers, defines none; one that can't be read is unknown", () => {
  const root = fs.realpathSync(tempDir())
  const file = path.join(root, ".claude.json")
  expect(ownerMcpServers(file)).toEqual({})
  fs.writeFileSync(file, JSON.stringify({ numStartups: 1 }))
  expect(ownerMcpServers(file)).toEqual({})
  for (const text of ["{not json", "[]", JSON.stringify({ mcpServers: [] }), JSON.stringify({ mcpServers: "x" })]) {
    fs.writeFileSync(file, text)
    expect(ownerMcpServers(file), text).toBeNull()
  }
  fs.rmSync(file)
  fs.mkdirSync(file)
  expect(ownerMcpServers(file)).toBeNull()
})

test("the start's file holds only the allowed servers that are defined, under mcpServers, fresh and 0600 in the folder given", () => {
  const root = fs.realpathSync(tempDir())
  const dir = path.join(root, "s1.mcp")
  fs.mkdirSync(dir, { mode: 0o700 })
  const cwd = path.join(dir, "cwd")
  const picked = mcpServersOf(SERVERS, ["github", "linear", "web"], cwd)
  const started = { github: startIn(SERVERS.github, cwd), web: startIn(SERVERS.web, cwd) }
  expect(picked).toEqual({ servers: started, missing: ["linear"] })
  const file = writeMcpConfig(dir, picked.servers)
  expect(file).toBe(path.join(dir, "opencorp.mcp.json"))
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: started })
  const stat = fs.statSync(file)
  expect([stat.mode & 0o777, stat.uid]).toEqual([0o600, process.getuid!()])
  // A link planted where the file goes is replaced, never written through.
  const outside = path.join(root, "outside.json")
  fs.writeFileSync(outside, "keep")
  fs.rmSync(file)
  fs.symlinkSync(outside, file)
  writeMcpConfig(dir, picked.servers)
  expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
  expect(fs.readFileSync(outside, "utf8")).toBe("keep")
})

test("a name that isn't plain picks nothing, even one the owner's config defines", () => {
  const odd = { "my.server": { command: "x" }, "a b": { command: "y" }, ok: { command: "z" }, "gh__x": { command: "w" } }
  expect(mcpServersOf(odd, ["my.server", "a b", "ok", "gh__x", "__proto__", "constructor"], "/c")).toEqual({
    servers: { ok: startIn(odd.ok, "/c") },
    missing: ["my.server", "a b", "gh__x", "__proto__", "constructor"],
  })
  expect(mcpServersOf(null, ["ok"], "/c")).toEqual({ servers: {}, missing: ["ok"] })
})

test("a server Claude Code starts as a program starts in the folder given, through sh, its own command, arguments and env as they were", () => {
  const root = fs.realpathSync(tempDir())
  const cwd = path.join(root, "o's cwd")
  fs.mkdirSync(cwd)
  const definition = { command: "sh", args: ["-c", 'pwd; echo "$1 ${O5}"', "x", "it's"], env: { O5: "set" }, timeout: 9 }
  const started = startIn(definition, cwd) as { command: string; args: string[]; env: unknown; timeout: unknown }
  expect(started.command).toBe("/bin/sh")
  expect(started.args.slice(3)).toEqual([cwd, "sh", ...definition.args])
  expect([started.env, started.timeout]).toEqual([definition.env, definition.timeout])
  // The script itself holds no ${...}, which Claude Code would expand.
  expect(started.args[1]).not.toContain("${")
  // Run as Claude Code runs it: in the employee's folder, with the definition's env.
  const ws = path.join(root, "ws")
  fs.mkdirSync(ws)
  const ran = spawnSync(started.command, started.args, { cwd: ws, env: { PATH: "/usr/bin:/bin", O5: "set" }, encoding: "utf8" })
  expect(ran.stdout).toBe(`${cwd}\nit's set\n`)
  // A folder that isn't there starts nothing, rather than starting in the employee's.
  const gone = startIn(definition, path.join(root, "gone")) as { command: string; args: string[] }
  const refused = spawnSync(gone.command, gone.args, { cwd: ws, encoding: "utf8" })
  expect([refused.status !== 0, refused.stdout]).toEqual([true, ""])
  // stdio is a program too; one with no command can't be started anywhere.
  expect((startIn({ type: "stdio", command: "x" }, cwd) as { command: string }).command).toBe("/bin/sh")
  expect(startIn({ args: ["x"] }, cwd)).toBeNull()
})

test("a server Claude Code reaches by URL is left as it is, but the headers helper it runs starts in the folder given", () => {
  const root = fs.realpathSync(tempDir())
  const cwd = path.join(root, "o's cwd")
  fs.mkdirSync(cwd)
  for (const type of ["http", "sse"]) {
    const plain = { type, url: "https://e.example/mcp", headers: { A: "b" } }
    expect(startIn(plain, cwd)).toEqual(plain)
    const helped = startIn({ ...plain, headersHelper: "pwd; echo done" }, cwd) as { headersHelper: string }
    const ws = path.join(root, `ws-${type}`)
    fs.mkdirSync(ws)
    const ran = spawnSync("/bin/sh", ["-c", helped.headersHelper], { cwd: ws, encoding: "utf8" })
    expect(ran.stdout).toBe(`${cwd}\ndone\n`)
  }
  // A kind OpenCorp doesn't know isn't loaded.
  expect(startIn({ type: "ws", url: "wss://e.example" }, cwd)).toBeNull()
})

test("an allowed server's tools are allowed by one rule each", () => {
  expect(mcpAllowRule("github")).toBe("mcp__github__*")
  expect(mcpAllowRule("my_docs-2")).toBe("mcp__my_docs-2__*")
})

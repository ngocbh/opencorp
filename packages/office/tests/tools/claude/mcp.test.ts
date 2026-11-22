/** The owner's MCP servers for Claude Code, read by name from `.claude.json`, and the 0600 file that hands an employee's
 *  start only those their person allows, which no argument and no log line ever holds. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import {
  claudeJson,
  mcpAllowRule,
  mcpServersOf,
  mcpTool,
  ownerMcpServers,
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
  const picked = mcpServersOf(SERVERS, ["github", "linear", "web"])
  expect(picked).toEqual({ servers: { github: SERVERS.github, web: SERVERS.web }, missing: ["linear"] })
  const file = writeMcpConfig(dir, picked.servers)
  expect(file).toBe(path.join(dir, "opencorp.mcp.json"))
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { github: SERVERS.github, web: SERVERS.web } })
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
  const odd = { "my.server": { command: "x" }, "a b": { command: "y" }, ok: { command: "z" } }
  expect(mcpServersOf(odd, ["my.server", "a b", "ok", "__proto__", "constructor"])).toEqual({
    servers: { ok: odd.ok },
    missing: ["my.server", "a b", "__proto__", "constructor"],
  })
  expect(mcpServersOf(null, ["ok"])).toEqual({ servers: {}, missing: ["ok"] })
})

test("an allowed server's tools are allowed by one rule each, and are its tools alone", () => {
  expect(mcpAllowRule("github")).toBe("mcp__github__*")
  // Claude Code reads the short form of a name holding __ as another server's: the wildcard form takes it whole.
  expect(mcpAllowRule("reports__v2")).toBe("mcp__reports__v2__*")
  expect(mcpTool("mcp__github__create_issue", ["github"])).toBe(true)
  expect(mcpTool("mcp__github__", ["github"])).toBe(false)
  expect(mcpTool("mcp__githubx__create_issue", ["github"])).toBe(false)
  expect(mcpTool("mcp__claude_ai_Gmail__send", ["github"])).toBe(false)
  expect(mcpTool("Bash", ["github"])).toBe(false)
  expect(mcpTool("mcp__github__create_issue", [])).toBe(false)
})

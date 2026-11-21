/** The owner's and the project's CLAUDE.md, passed to Claude Code as appended system prompt text, since no settings
 *  source loads: read by the office, never written, and written to a file only the user can read or write. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { INSTRUCTIONS_MAX_CHARS, claudeInstructions, writeInstructions } from "../../../src/tools/claude/instructions.ts"
import { tempDir } from "../../helpers.ts"

/** A config folder, a repository with a project folder in it, each with a CLAUDE.md. */
function layout() {
  const root = fs.realpathSync(tempDir())
  const config = path.join(root, "home/.claude")
  const repo = path.join(root, "repo")
  const ws = path.join(repo, "app")
  for (const dir of [config, ws]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(config, "CLAUDE.md"), "Use British spelling.\n")
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "Run `make test`. See @docs/rules.md\n")
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "The app is in TypeScript.\n")
  return { root, config, repo, ws }
}

test("the owner's CLAUDE.md, then the repository root's and the project folder's, each named, with imports left as written", () => {
  const { config, repo, ws } = layout()
  const text = claudeInstructions({ configDir: config, workspace: ws, gitRoot: repo })!
  const at = (s: string) => text.indexOf(s)
  expect(text).toContain("an @ import in them isn't followed")
  expect(at(path.join(config, "CLAUDE.md"))).toBeLessThan(at("Use British spelling."))
  expect(at("Use British spelling.")).toBeLessThan(at(path.join(repo, "CLAUDE.md")))
  expect(at("See @docs/rules.md")).toBeGreaterThan(at(path.join(repo, "CLAUDE.md")))
  expect(at("The app is in TypeScript.")).toBeGreaterThan(at("See @docs/rules.md"))
  // The project folder as its own repository root is read once.
  const once = claudeInstructions({ configDir: config, workspace: ws, gitRoot: ws })!
  expect(once.split("The app is in TypeScript.").length).toBe(2)
  expect(once).not.toContain("make test")
})

test("with no CLAUDE.md in the project, its AGENTS.md is read instead, as Claude Code reads it; with none at all, nothing", () => {
  const { config, repo, ws } = layout()
  fs.rmSync(path.join(repo, "CLAUDE.md"))
  fs.rmSync(path.join(ws, "CLAUDE.md"))
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "Agents: keep commits small.\n")
  const text = claudeInstructions({ configDir: config, workspace: ws, gitRoot: repo })!
  expect(text).toContain("Agents: keep commits small.")
  expect(text).toContain(path.join(ws, "AGENTS.md"))
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "Claude only.\n")
  expect(claudeInstructions({ configDir: config, workspace: ws, gitRoot: repo })).not.toContain("Agents:")
  fs.rmSync(path.join(ws, "CLAUDE.md"))
  fs.rmSync(path.join(ws, "AGENTS.md"))
  fs.rmSync(path.join(config, "CLAUDE.md"))
  expect(claudeInstructions({ configDir: config, workspace: ws, gitRoot: repo })).toBeNull()
})

test("a project's CLAUDE.md that is a link is left out, so a command can't have the office read a file for it", () => {
  const { root, config, repo, ws } = layout()
  const secret = path.join(root, "home/.ssh-key")
  fs.writeFileSync(secret, "PRIVATE KEY")
  fs.rmSync(path.join(ws, "CLAUDE.md"))
  fs.symlinkSync(secret, path.join(ws, "CLAUDE.md"))
  const text = claudeInstructions({ configDir: config, workspace: ws, gitRoot: repo })!
  expect(text).not.toContain("PRIVATE KEY")
  expect(text).toContain("make test")
  // The owner's own may be a link (a dotfiles checkout, say): only the owner can change it.
  const dotfiles = path.join(root, "dotfiles.md")
  fs.writeFileSync(dotfiles, "From my dotfiles.\n")
  fs.rmSync(path.join(config, "CLAUDE.md"))
  fs.symlinkSync(dotfiles, path.join(config, "CLAUDE.md"))
  expect(claudeInstructions({ configDir: config, workspace: ws, gitRoot: repo })).toContain("From my dotfiles.")
})

test("a long CLAUDE.md is cut with a marker", () => {
  const { config, ws } = layout()
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "y".repeat(INSTRUCTIONS_MAX_CHARS + 50))
  const text = claudeInstructions({ configDir: config, workspace: ws, gitRoot: null })!
  expect(text).toContain("y".repeat(INSTRUCTIONS_MAX_CHARS) + "\n[cut here]")
  expect(text).not.toContain("y".repeat(INSTRUCTIONS_MAX_CHARS + 1))
})

test("the instructions file is made fresh, the user's alone, and never through a link", () => {
  const root = fs.realpathSync(tempDir())
  const file = writeInstructions(root, "S1", "first")
  expect(file).toBe(path.join(root, "S1.instructions.md"))
  expect([fs.readFileSync(file, "utf8"), fs.statSync(file).mode & 0o777]).toEqual(["first", 0o600])
  expect(fs.readFileSync(writeInstructions(root, "S1", "second"), "utf8")).toBe("second")
  const target = path.join(root, "target")
  fs.writeFileSync(target, "keep")
  fs.rmSync(file)
  fs.symlinkSync(target, file)
  expect(fs.readFileSync(writeInstructions(root, "S1", "third"), "utf8")).toBe("third")
  expect(fs.readFileSync(target, "utf8")).toBe("keep")
  expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
  expect(() => writeInstructions(root, "../S1", "x")).toThrow()
})

// A Claude Code session's tool parts (`claude.<Tool>`) show in the views the chat's own tools use: a command as a
// shell, a read, a write, an edit as its diff, and a search. An employee's calls to Codex and Claude Code
// (`codex_start` and the rest) show as one row each, naming the session.
import { expect, test } from "bun:test"
import { toolView } from "../../../src/routes/session"

test("toolView maps Claude Code's Bash, Read, Write, Edit, Glob and Grep to the chat's views", () => {
  expect(toolView("claude.Bash", { command: "bun test", description: "Run the tests" })).toEqual({
    view: "shell",
    input: { command: "bun test", description: "Run the tests" },
  })
  expect(toolView("claude.Read", { file_path: "/w/a.ts", offset: 10 }).input).toEqual({ filePath: "/w/a.ts", offset: 10 })
  expect(toolView("claude.Write", { file_path: "/w/b.ts", content: "x" })).toMatchObject({ view: "write" })
  expect(toolView("claude.Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" })).toEqual({
    view: "edit",
    input: { filePath: "/w/a.ts", oldString: "a", newString: "b" },
  })
  expect(toolView("claude.Grep", { pattern: "TODO", glob: "*.ts" })).toEqual({
    view: "search",
    input: { pattern: "TODO", include: "*.ts" },
  })
  expect(toolView("claude.WebFetch", { url: "https://example.com" }).view).toBe("generic")
})

/** A Codex or Claude Code tool's reply, as the office writes it, naming session `name` of `kind`. */
const reply = (kind: string, name: string) =>
  JSON.stringify({ [kind]: name, status: "idle", output: [], next: 0, more: false })

test("toolView reads an employee's Codex or Claude Code call: the harness, the call, the session and the message", () => {
  // A start names its session only in its reply.
  expect(toolView("codex_start", { message: "Fix the parser", wait: 60 }, reply("codex", "codex 1"))).toEqual({
    view: "harness",
    input: { harness: "codex", call: "start", session: "codex 1", message: "Fix the parser" },
  })
  // While it runs there is no reply yet, and a refusal names no session.
  expect(toolView("codex_start", { message: "Fix the parser" }, "{}").input.session).toBeUndefined()
  const refused = JSON.stringify({ refused: "four sessions run" })
  expect(toolView("claude_start", { message: "x" }, refused).input).toEqual({
    harness: "claude",
    call: "start",
    message: "x",
    refused: "four sessions run",
  })
  // The other calls name it in their input.
  expect(toolView("claude_send", { claude: "claude 2", message: "Go on" }, "{}")).toEqual({
    view: "harness",
    input: { harness: "claude", call: "send", session: "claude 2", message: "Go on" },
  })
  for (const call of ["interrupt", "stop", "history"])
    expect(toolView(`codex_${call}`, { codex: "codex 3", trace: true }).input).toEqual({
      harness: "codex",
      call,
      session: "codex 3",
    })
  expect(toolView("codex_restart", { codex: "codex 1" }).view).toBe("generic")
})

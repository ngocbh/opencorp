// A Claude Code session's tool parts (`claude.<Tool>`) show in the views the chat's own tools use: a command as a
// shell, a read, a write, an edit as its diff, and a search.
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

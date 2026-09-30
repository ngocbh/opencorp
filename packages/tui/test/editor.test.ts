import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { normalizePromptContent, openEditor } from "../src/editor"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()
})

test.skipIf(process.platform === "win32")(
  "runs $EDITOR through the shell, so a quoted path with a space and flags work",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "act ed "))
    try {
      const script = path.join(dir, "my editor.sh")
      writeFileSync(script, `#!/bin/sh\n[ "$1" = "--wait" ] || exit 3\nprintf ' edited' >> "$2"\n`)
      chmodSync(script, 0o755)
      delete process.env.VISUAL
      process.env.EDITOR = `'${script}' --wait`
      const renderer = {
        suspend() {},
        resume() {},
        requestRender() {},
        currentRenderBuffer: { clear() {} },
      }
      expect(await openEditor({ value: "original", renderer: renderer as never, stdin: "ignore" })).toBe(
        "original edited",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

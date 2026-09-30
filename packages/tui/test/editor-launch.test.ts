import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { launchEditor } from "../src/editor-launch"

test.skipIf(process.platform === "win32")(
  "launchEditor runs the editor setting through the shell with the file as its last argument",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "act ed "))
    try {
      const script = path.join(dir, "my editor.sh")
      writeFileSync(script, `#!/bin/sh\n[ "$1" = "--wait" ] || exit 3\nprintf ' edited' >> "$2"\n`)
      chmodSync(script, 0o755)
      const file = path.join(dir, "f.md")
      writeFileSync(file, "original")
      await launchEditor(`'${script}' --wait`, file, { stdin: "ignore" })
      expect(readFileSync(file, "utf8")).toBe("original edited")
      await expect(launchEditor(`'${script}'`, file, { stdin: "ignore" })).rejects.toThrow(
        "the editor exited with code 3",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

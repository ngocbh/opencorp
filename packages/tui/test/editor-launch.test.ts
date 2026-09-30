import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { editorCommand, launchEditor } from "../src/editor-launch"

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

test.skipIf(process.platform === "win32")(
  "launchEditor ignores Ctrl-C and Ctrl-\\ while the editor runs, then stops ignoring them",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "act-sig-"))
    try {
      // The editor survives the signals it sends its whole process group, as vi does Ctrl-C.
      const script = path.join(dir, "ed.sh")
      writeFileSync(script, `trap '' INT QUIT\nkill -INT 0\nkill -QUIT 0\nprintf ' edited' >> "$1"\n`)
      const file = path.join(dir, "f.md")
      writeFileSync(file, "original")
      const launcher = JSON.stringify(path.join(import.meta.dir, "../src/editor-launch.ts"))
      const code = [
        `import { launchEditor } from ${launcher}`,
        `await launchEditor(${JSON.stringify(`sh '${script}'`)}, ${JSON.stringify(file)}, { stdin: "ignore" })`,
        `  .then(() => console.log("resolved"), (e) => console.log(e.message))`,
        `console.log(process.listenerCount("SIGINT"), process.listenerCount("SIGQUIT"))`,
      ].join("\n")
      // Detached: its own process group, so the signals never reach the test runner.
      const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "inherit"] })
      let out = ""
      child.stdout.on("data", (chunk) => (out += chunk))
      const [status, signal] = await new Promise<[number | null, string | null]>((resolve) =>
        child.on("exit", (c, s) => resolve([c, s])),
      )
      expect({ status, signal }).toEqual({ status: 0, signal: null })
      // Whether sh -c exits with the editor or dies of the signal, the launcher lives to report it.
      expect(out.trim().split("\n").at(-1)).toBe("0 0")
      expect(readFileSync(file, "utf8")).toBe("original edited")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test("editorCommand hands the file to sh as an argument on POSIX and quotes it for cmd.exe on Windows", () => {
  expect(editorCommand("code --wait", "/tmp/ac-profile-x/profile.md", "darwin")).toEqual({
    command: "sh",
    args: ["-c", 'code --wait "$@"', "code --wait", "/tmp/ac-profile-x/profile.md"],
    shell: false,
  })
  // With shell: true, Node joins the arguments unquoted, so a temp path with a space would split.
  expect(editorCommand("code --wait", "C:\\Users\\Ann Lee\\AppData\\Local\\Temp\\p.md", "win32")).toEqual({
    command: 'code --wait "C:\\Users\\Ann Lee\\AppData\\Local\\Temp\\p.md"',
    args: [],
    shell: true,
  })
})

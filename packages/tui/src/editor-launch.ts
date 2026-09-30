import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import type { Stream } from "node:stream"

export type EditorStdio = "inherit" | "pipe" | "ignore" | number | Stream

/** The command that runs the editor setting `editor` on `file` on `platform`. */
export function editorCommand(editor: string, file: string, platform: NodeJS.Platform = process.platform) {
  // With shell: true, Node joins the arguments unquoted, so the file goes in quoted; a Windows
  // path can't hold a `"`.
  if (platform === "win32") return { command: `${editor} "${file}"`, args: [] as string[], shell: true }
  // As git does: the shell parses the editor setting (it may hold flags or a quoted path),
  // and the file goes in as an argument, so its path is never re-parsed.
  return { command: "sh", args: ["-c", `${editor} "$@"`, editor, file], shell: false }
}

/**
 * Runs the editor setting `editor` (from $VISUAL or $EDITOR) on `file` and resolves once it
 * exits 0; rejects if it can't start or exits otherwise.
 */
export function launchEditor(editor: string, file: string, opts: { cwd?: string; stdin?: EditorStdio } = {}) {
  return new Promise<void>((resolve, reject) => {
    const options = {
      cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : process.cwd(),
      stdio: [opts.stdin ?? "inherit", "inherit", "inherit"] as [EditorStdio, "inherit", "inherit"],
    }
    const { command, args, shell } = editorCommand(editor, file)
    const child = spawn(command, args, { ...options, shell })
    // As git's launch_editor does: Ctrl-C (or Ctrl-\) while the editor runs is for the editor,
    // so the caller outlives it and sees it exit, and can clean up rather than die mid-edit.
    const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGQUIT"]
    const ignore = () => {}
    for (const s of signals) process.on(s, ignore)
    const restore = () => signals.forEach((s) => process.off(s, ignore))
    child.on("error", (e) => {
      restore()
      reject(e)
    })
    child.on("exit", (code, signal) => {
      restore()
      if (code === 0) return resolve()
      reject(new Error(`the editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
    })
  })
}

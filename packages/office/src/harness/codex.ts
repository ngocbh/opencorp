/** One `codex app-server --listen stdio://`: its command. */
import fs from "node:fs"

export const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const

/** macOS's `CS_PATH`: where Python's `shutil.which` looks when no PATH is set at all. */
const CS_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

/** Codex couldn't be run, didn't start, refused the handshake, or died loading the thread. The message says what
 *  went wrong and what to do; it never holds Codex's stderr, which stays in the session's codex.log. */
export class CodexStartError extends Error {
  override name = "CodexStartError"
}

/** No `codex` on the office's PATH. */
export class CodexMissing extends CodexStartError {
  override name = "CodexMissing"
}

/** `codex app-server --listen stdio://` with `codex` found on `env`'s PATH (the office's own).
 *
 *  `OPENCORP_CODEX_BIN` in the office's `environ` names another binary (a path, or a name on that PATH). */
export function codexCommand(
  env: Record<string, string | undefined>,
  environ: Record<string, string | undefined> = process.env,
): string[] {
  const override = environ.OPENCORP_CODEX_BIN
  // `||`, as Python's `or`: an empty override means `codex`.
  const found = which(override || "codex", env.PATH)
  if (found === null && override)
    throw new CodexMissing(
      `OPENCORP_CODEX_BIN names ${override}, which isn't an executable the office can find; ` +
        "fix or unset it, then run `opencorp doctor`.",
    )
  if (found === null)
    throw new CodexMissing(
      "Codex isn't installed where the office can find it (on its PATH). Install it " +
        "(npm install -g @openai/codex), sign in with `codex login`, then run `opencorp doctor`.",
    )
  return [found, ...APP_SERVER_ARGS]
}

/** `name` as Python 3.12's `shutil.which(name, path=searchPath)` finds it on POSIX: as found, not resolved. */
function which(name: string, searchPath: string | undefined): string | null {
  if (name.includes("/")) return runnable(name) ? name : null
  const dirs = searchPath ?? process.env.PATH ?? CS_PATH
  if (!dirs) return null
  for (const dir of dirs.split(":")) {
    // Python's os.path.join: no separator added after an empty or slash-ended entry, nothing normalised.
    const file = dir === "" || dir.endsWith("/") ? dir + name : `${dir}/${name}`
    if (runnable(file)) return file
  }
  return null
}

/** `file` exists, isn't a directory, and this process may execute it. */
function runnable(file: string): boolean {
  try {
    if (fs.statSync(file).isDirectory()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

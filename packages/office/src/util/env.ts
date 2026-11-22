/** The env names the office's processes inherit, and finding a program on a `PATH`. It imports only `node:`
 *  builtins, since the daemon loads it before it re-execs into the office's own env. */
import fs from "node:fs"

/** The office env names both a worker and the daemon inherit (besides `LC_*`; the daemon adds `CODEX_ENV` and
 *  `CLAUDE_ENV`, see `daemonEnv` in `runtime/service/launch.ts`). The provider env and the key arrive with the run,
 *  never from here.
 *  `SSL_CERT_FILE` and `SSL_CERT_DIR` say where TLS finds CA certificates: some Linuxes (RHEL) don't fill the folder
 *  a bundled TLS stack looks in, so the owner points them at the system bundle. */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

/** An environment as `process.env` holds it. */
export type Env = Record<string, string | undefined>

/** Whether `file` is a non-directory this process may execute. */
function runnable(file: string): boolean {
  try {
    if (fs.statSync(file).isDirectory()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The program `name` as `searchPath` (a `PATH` value) finds it, or null. A name holding `/` is itself when absolute
 * and runnable; otherwise the first absolute entry holding a runnable non-directory `name` answers, as
 * `<entry>/<name>`. Links are not resolved; a caller that needs the realpath resolves it.
 */
export function which(name: string, searchPath: string | undefined): string | null {
  if (name.includes("/")) return name.startsWith("/") && runnable(name) ? name : null
  for (const entry of (searchPath ?? "").split(":")) {
    if (entry.startsWith("/") && runnable(`${entry}/${name}`)) return `${entry}/${name}`
  }
  return null
}

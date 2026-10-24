/** How the office daemon is started: its command, environment, folder and log, the host it runs on, and the
 *  check that pins a running daemon to them. Imports only `node:*`, `platform.ts` and `daemon/sockets.ts`:
 *  `daemonMain` runs `pinDaemon` before the daemon module loads. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The provider env and the key arrive with the run, never from here. SSL_CERT_FILE and SSL_CERT_DIR say where
// TLS finds CA certificates: some Linuxes (RHEL) don't fill the folder a bundled TLS stack looks in, so the owner
// points them at the system bundle.
/** The only parts of the office's environment the daemon and a worker inherit. */
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

/** Which Codex the office runs, when the caller's shell sets them: its home, and a binary other than `codex`. */
export const CODEX_ENV = ["CODEX_HOME", "OPENCORP_CODEX_BIN"] as const

/** An environment as `process.env` holds it. */
export type Env = Record<string, string | undefined>

/**
 * The daemon's environment: the worker allowlist, `LC_*` and `CODEX_ENV`, so no key in the caller's shell
 * reaches it. `PATH` keeps only its absolute entries, and is left out when none is.
 *
 * `LC_TERMINAL*` (iTerm's name and version) is left out: it isn't a locale, and it would change the service file
 * whenever the terminal updates. A relative `PATH` entry would refuse every workspace and let a cwd shadow a
 * tool; an empty `PATH` searches the cwd.
 */
export function daemonEnv(environ: Env): Record<string, string> {
  const kept: readonly string[] = [...INHERITED_ENV, ...CODEX_ENV]
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(environ)) {
    if (value === undefined) continue
    if (kept.includes(key) || (key.startsWith("LC_") && !key.startsWith("LC_TERMINAL"))) env[key] = value
  }
  if (env.PATH !== undefined) {
    const absolute = env.PATH.split(":").filter((entry) => entry.startsWith("/"))
    if (absolute.length) env.PATH = absolute.join(":")
    else delete env.PATH
  }
  return env
}

/** `value` as an absolute home path: a leading `~` is the user's home directory, and the nearest existing
 *  ancestor is resolved through its symlinks, with the rest (not created yet) appended. */
export function resolveHome(value: string): string {
  const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value
  let dir = path.resolve(expanded)
  let rest = ""
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), rest)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = path.dirname(dir)
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === dir) throw error
      rest = path.join(path.basename(dir), rest)
      dir = parent
    }
  }
}

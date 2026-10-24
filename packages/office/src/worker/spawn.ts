/** Spawn run workers, at most one per session (the spawn itself lands with the worker registry); for now the
 *  environment a worker starts with. */
import { type Env, INHERITED_ENV } from "../install/launch.ts"

// Defined in launch.ts so the daemon's pre-re-exec check doesn't load this module's later imports.
export { INHERITED_ENV } from "../install/launch.ts"

/** The environment a worker starts with: `INHERITED_ENV` and `LC_*` from the office's (`environ`), set values
 *  only. */
export function workerEnv(environ: Env = process.env): Record<string, string> {
  const kept: readonly string[] = INHERITED_ENV
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(environ)) {
    if (value !== undefined && (kept.includes(key) || key.startsWith("LC_"))) env[key] = value
  }
  return env
}

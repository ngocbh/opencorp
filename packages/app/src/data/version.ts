import type { Health } from "@opencorp/protocol"

export type Verdict = "ok" | "reload" | "out_of_date" | "not_built"

/** sessionStorage key: the build the app last reloaded for, so a reload never loops. */
export const RELOADED_FOR = "hq.reloaded-for"

/**
 * What to do after reading `/api/health`, on connect, on every reconnect, and when a lazy chunk fails to load: reload
 * once for a rebuilt dist, or show "out of date" when the dist was built for another office version.
 */
export function verdict(health: Health, build: string, o: { dev: boolean; reloadedFor: string | null }): Verdict {
  if (!health.app) return "not_built"
  // Under vite dev, __HQ_BUILD__ is "dev" and never matches dist/build.json.
  if (!o.dev && health.app.build !== build && o.reloadedFor !== health.app.build) return "reload"
  if (health.app.api !== health.office.api) return "out_of_date"
  return "ok"
}

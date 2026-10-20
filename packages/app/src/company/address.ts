// What /org's address says: which view shows, and the path Source has open. Only Source is in the address; Chart and
// List are this browser's choice (prefs.ts).
import type { View } from "./prefs"

/** What /org shows: the people as a chart or a list, or the company repo's files. */
export type Shown = View | "source"

type Param = string | string[] | undefined

const first = (p: Param) => (Array.isArray(p) ? p[0] : p)

/**
 * The view /org shows: Source when the address says so, on any screen; else the saved choice on a desktop (the chart
 * before the first), and the list on a phone.
 */
export function chooseView(view: Param, desktop: boolean, saved: View | null): Shown {
  if (first(view) === "source") return "source"
  return desktop ? (saved ?? "chart") : "list"
}

/** The address's path in the one path format: no leading or trailing `/`, and the root is "". */
export const pathOf = (path: Param) => (first(path) ?? "").replace(/^\/+|\/+$/g, "")

/** Source's address for `path`, with its slashes left readable; the root leaves `path` out. */
export const sourceHref = (path: string) =>
  path ? `/org?view=source&path=${encodeURIComponent(path).replace(/%2F/g, "/")}` : "/org?view=source"

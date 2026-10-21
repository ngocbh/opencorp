// The Run Logs list's filters, kept in the address so a filtered list can be linked to (the Org panel's "All runs").
import type { RunSummary } from "@opencorp/protocol"

export type RunFilters = { flow?: string; person?: string; status?: RunSummary["status"]; q?: string }

const STATUSES = new Set<string>(["running", "waiting", "idle", "finished", "failed", "interrupted"])
type Param = string | string[] | undefined
const first = (p: Param) => (Array.isArray(p) ? p[0] : p) || undefined

/** The filters an address's search params set; an unknown status is dropped. */
export function filtersOf(params: Record<string, Param>): RunFilters {
  const status = first(params.status)
  const f: RunFilters = {
    flow: first(params.flow),
    person: first(params.person),
    status: status && STATUSES.has(status) ? (status as RunSummary["status"]) : undefined,
    q: first(params.q),
  }
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as RunFilters
}

/** The list's address with `f` set. */
export function hrefOf(f: RunFilters): string {
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString()
  return q ? `/runs?${q}` : "/runs"
}

/** Whether `run` matches every filter set (the office decides which rows a page holds; this opens matching children). */
export const matches = (run: RunSummary, f: RunFilters) =>
  (!f.flow || run.flow === f.flow) &&
  (!f.person || run.driver === f.person || (run.participants ?? []).includes(f.person)) &&
  (!f.status || run.status === f.status) &&
  (!f.q || run.run_id.includes(f.q.trim().toUpperCase()))

/** Whether `q` is a whole run id (a ULID), which search opens instead of filtering by. */
export const isRunId = (q: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(q.trim().toUpperCase())

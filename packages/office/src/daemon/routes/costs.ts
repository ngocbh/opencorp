/** Spend per person since a time. */
import { CostReport } from "@opencorp/protocol"
import { HttpError, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/

/** The days in `month` (1–12) of `year`, leap years counted. */
function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
}

/** `raw`, an ISO-8601 time with an offset, as a protocol Timestamp; `HttpError(422)` naming query parameter `name`
 *  otherwise. Accepted: `YYYY-MM-DD`, then `T`, `t` or a space, then `HH`, `HH:MM`, `HH:MM:SS` or `HH:MM:SS` with a
 *  `.` or `,` fraction (digits past milliseconds cut), then `Z`, `±HH`, `±HHMM` or `±HH:MM`. */
export function utcTimestamp(raw: string | null | undefined, name = "since"): string {
  const refuse = () =>
    new HttpError(
      422,
      "invalid_body",
      `${name} must be an ISO-8601 time with an offset, such as 2026-10-19T00:00:00.000Z`,
    )
  const m = ISO.exec(raw ?? "")
  if (m === null) throw refuse()
  const field = (i: number) => Number(m[i] ?? 0)
  const [year, month, day, hour, minute, second] = [field(1), field(2), field(3), field(4), field(5), field(6)]
  const offset = m[8]!
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3))
  const offsetMinutes = offset.length > 3 ? Number(offset.slice(-2)) : 0
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysIn(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  )
    throw refuse()
  const ms = Number((m[7] ?? "").slice(0, 3).padEnd(3, "0"))
  const at = new Date(Date.UTC(2000, 0, 1, hour, minute, second, ms))
  // Date.UTC maps years 0–99 to 1900–1999; setUTCFullYear doesn't.
  at.setUTCFullYear(year, month - 1, day)
  const sign = offset.startsWith("-") ? -1 : 1
  const utc = new Date(at.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000)
  if (utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) throw refuse()
  // The store compares times as text, which is time order only in this one fixed-width UTC form.
  return utc.toISOString()
}

/** Spend per person since `?since=`. */
export function costs(ctx: RequestContext) {
  // The last value, as Starlette's `query_params.get`.
  return ctx.office.store.costsSince(utcTimestamp(ctx.query.getAll("since").at(-1)))
}

/** The cost routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  { method: "GET", path: "/costs", reply: CostReport, handler: costs },
]

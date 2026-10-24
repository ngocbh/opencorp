/** GET /costs: spend per person since a time. */
import { expect, test } from "bun:test"
import { HttpError } from "../../src/daemon/http.ts"
import { utcTimestamp } from "../../src/daemon/routes/costs.ts"
import { session } from "../store/helpers.ts"
import { makeOffice, request, served } from "./helpers.ts"

/** The `GET /costs` target with `since` as its query (none when null). */
function target(since: string | null): string {
  return since === null ? "/costs" : `/costs?${new URLSearchParams({ since })}`
}

test("since is normalized to utc", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await request(sock, "GET", target("2026-10-19T02:00:00+02:00"))
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ since: "2026-10-19T00:00:00.000Z", people: {} })
})

test("the report has each persons spend", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const s = office.store.createSession(session({ person: "minh" }))
  office.store.recordUsage({ sessionId: s.id, runId: "r", model: "m", usd: 0.5 })
  const r = await request(sock, "GET", target("2026-01-01T00:00:00Z"))
  expect((r.json() as { people: unknown }).people).toEqual({ minh: { usd: 0.5, unpriced_sessions: 0 } })
})

test.each([
  null,
  "",
  "yesterday",
  "2026-10-19T00:00:00", // no offset
  "0001-01-01T00:00:00+05:00", // before year 1 in UTC
  "0000-12-31T23:00:00-05:00", // year 0 on input
  "2026-10-19T02:00:00+02:60",
  "9999-12-31T23:00:00-05:00", // past 9999
  "2026-02-30T00:00:00Z",
  "2026-10-19T24:00:00Z",
  "2026-10-19T02:00:00+24:00",
  "2026-W42-1T00:00:00Z",
  "20261019T020000Z",
])("a missing or bad since is 422 [%s]", async (since) => {
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await request(sock, "GET", target(since))
  expect(r.status).toBe(422)
  expect(r.json()).toEqual({
    error: "invalid_body",
    message: "since must be an ISO-8601 time with an offset, such as 2026-10-19T00:00:00.000Z",
  })
})

test("since keeps milliseconds and python iso forms", () => {
  const cases: [string, string][] = [
    ["2026-10-19 02:00:00+02:00", "2026-10-19T00:00:00.000Z"],
    ["2026-10-19t02:00:00+02:00", "2026-10-19T00:00:00.000Z"],
    ["2026-10-19T02:00+02:00", "2026-10-19T00:00:00.000Z"],
    ["2026-10-19T02+02:00", "2026-10-19T00:00:00.000Z"],
    ["2026-10-19T02:00:00+0200", "2026-10-19T00:00:00.000Z"],
    ["2026-10-19T02:00:00+02", "2026-10-19T00:00:00.000Z"],
    ["2026-10-19T02:00:00.123456789Z", "2026-10-19T02:00:00.123Z"],
    ["2026-10-19T02:00:00,5Z", "2026-10-19T02:00:00.500Z"],
    ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
    ["0001-01-01T05:00:00+05:00", "0001-01-01T00:00:00.000Z"],
    ["2026-10-19T02:00:00-00:00", "2026-10-19T02:00:00.000Z"],
  ]
  for (const [input, expected] of cases) expect(utcTimestamp(input)).toBe(expected)
  expect(() => utcTimestamp("x", "until")).toThrow(HttpError)
  expect(() => utcTimestamp("x", "until")).toThrow(/^until must be/)
})

import { expect, test } from "bun:test"
import type { RunSummary } from "@opencorp/protocol"
import { filtersOf, hrefOf, isRunId, matches } from "../src/runs/filters"

const run = (over: Partial<RunSummary>) =>
  ({ run_id: "01JA1H0000000000000000A1B2", flow: "chat", driver: "ngocbh", participants: ["minh"], status: "idle",
     ...over }) as RunSummary

test("filters come from the address and go back to it", () => {
  const f = filtersOf({ flow: "chat", person: "minh", status: "idle", q: "a1b2", other: "x" })
  expect(f).toEqual({ flow: "chat", person: "minh", status: "idle", q: "a1b2" })
  expect(hrefOf(f)).toBe("/runs?flow=chat&person=minh&status=idle&q=a1b2")
  expect(hrefOf({})).toBe("/runs")
  expect(filtersOf({ status: "busy" })).toEqual({})
})

test("a run matches every filter that is set; the person is the driver or a participant", () => {
  expect(matches(run({}), { person: "minh" })).toBe(true)
  expect(matches(run({}), { person: "ngocbh" })).toBe(true)
  expect(matches(run({}), { person: "ann", flow: "chat" })).toBe(false)
  expect(matches(run({}), { q: "a1b2" })).toBe(true)
  expect(matches(run({}), {})).toBe(true)
})

test("an exact run id is 26 Crockford characters, any case", () => {
  expect(isRunId(" 01ja1h0000000000000000a1b2 ")).toBe(true)
  expect(isRunId("a1b2")).toBe(false)
  expect(isRunId("01JA1H0000000000000000A1BI")).toBe(false)
})

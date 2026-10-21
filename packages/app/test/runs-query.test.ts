import { expect, test } from "bun:test"
import type { RunSummary } from "@opencorp/protocol"
import {
  accept,
  DEFAULT_QUERY,
  flowsOf,
  hrefOf,
  isRunId,
  matches,
  paramsOf,
  parse,
  queryOfAddress,
  serialize,
  startedRange,
  suggest,
} from "../src/runs/query"

const run = (over: Partial<RunSummary>) =>
  ({ run_id: "01JA1H0000000000000000A1B2", flow: "chat", driver: "ngocbh", participants: ["minh"], status: "idle",
     launched_at: "2026-10-20T10:00:00.000Z", ...over }) as RunSummary

const NOW = new Date(2026, 9, 20, 15, 30) // local time
const day = (m: number, d: number) => new Date(2026, m - 1, d).toISOString()

test("qualifiers and free text parse into a query", () => {
  expect(parse("flow:chat @minh is:running started:7d a1b2").query).toEqual({
    flow: "chat", person: "minh", is: "running", started: "7d", text: "a1b2",
  })
  expect(parse("person:@minh").query).toEqual({ person: "minh" })
  expect(parse("person:minh IS:Open").query).toEqual({ person: "minh", is: "open" })
  expect(parse("   ").query).toEqual({})
  expect(parse("  flow:chat  ").hints).toEqual([])
})

test("each token keeps where it is and whether it was recognised", () => {
  const { tokens } = parse("flow:chat foo:x a1b2")
  expect(tokens.map(({ start, end, kind }) => [start, end, kind])).toEqual([
    [0, 9, "qualifier"],
    [10, 15, "ignored"],
    [16, 20, "text"],
  ])
  expect(parse("flow: @").tokens.map((t) => t.kind)).toEqual(["pending", "pending"])
})

test("the company's flows are its flows/ folders' YAML files", () => {
  const entries = [
    { path: "shared/flows/chat.yaml", type: "file" },
    { path: "shared/flows/review.yml", type: "file" },
    { path: "people/kai/flows/triage.yaml", type: "file" },
    { path: "people/kai/person.yaml", type: "file" },
    { path: "shared/flows/notes.md", type: "file" },
    { path: "shared/flows/old", type: "folder" },
    { path: "shared/flows/old/legacy.yaml", type: "file" },
  ] as const
  expect(flowsOf([...entries])).toEqual(["chat", "review", "triage"])
})

test("unknown qualifiers, bad values and a second value are hinted and ignored", () => {
  expect(parse("foo:bar").hints).toEqual(["unknown filter foo:"])
  expect(parse("foo:bar").query).toEqual({})
  const twice = parse("flow:chat flow:debrief @kai person:minh is:open is:failed")
  expect(twice.query).toEqual({ flow: "chat", person: "kai", is: "open" })
  expect(twice.hints).toEqual(["one flow: at a time", "one person: at a time", "one is: at a time"])
  expect(parse("a1b2 c3d4").hints).toEqual(["one run id at a time"])
  expect(parse("is:busy").hints).toEqual(["unknown state busy: is: takes open, closed or a state"])
  expect(parse("started:soon").hints).toEqual([
    "started: takes 24h, 7d, >2026-10-13 or 2026-10-01..2026-10-15",
  ])
  expect(parse("started:soon").query).toEqual({})
  // A qualifier with no value yet is still being typed: no hint, no filter.
  expect(parse("flow: @ is:")).toMatchObject({ query: {}, hints: [] })
})

test("started: is a window ending now or local days", () => {
  expect(startedRange("24h", NOW)).toEqual({ since: new Date(NOW.getTime() - 24 * 3_600_000).toISOString() })
  expect(startedRange("7d", NOW)).toEqual({ since: new Date(NOW.getTime() - 7 * 86_400_000).toISOString() })
  expect(startedRange(">2026-10-13", NOW)).toEqual({ since: day(10, 14) })
  expect(startedRange(">=2026-10-13", NOW)).toEqual({ since: day(10, 13) })
  expect(startedRange("<2026-10-13", NOW)).toEqual({ until: day(10, 13) })
  expect(startedRange("<=2026-10-13", NOW)).toEqual({ until: day(10, 14) })
  expect(startedRange("2026-10-13", NOW)).toEqual({ since: day(10, 13), until: day(10, 14) })
  expect(startedRange("2026-10-01..2026-10-15", NOW)).toEqual({ since: day(10, 1), until: day(10, 16) })
  expect(startedRange("2026-10-31..2026-11-01", NOW)).toEqual({ since: day(10, 31), until: day(11, 2) })
})

test("started: refuses what isn't a window or a real day", () => {
  for (const bad of ["0d", "7w", "d", "2026-13-01", "2026-02-30", "2026-10-15..2026-10-01", "2026-10-1", ">", "1.5h"])
    expect(startedRange(bad, NOW)).toBeUndefined()
})

test("a query maps onto GET /runs's parameters", () => {
  expect(paramsOf(parse(DEFAULT_QUERY).query, NOW)).toEqual({
    status: ["running", "waiting", "idle"],
    since: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
  })
  expect(paramsOf(parse("is:closed").query, NOW)).toEqual({ status: ["finished", "failed", "interrupted"] })
  expect(paramsOf(parse("flow:chat @minh is:failed a1b2").query, NOW)).toEqual({
    flow: "chat", person: "minh", status: ["failed"], q: "a1b2",
  })
  expect(paramsOf({}, NOW)).toEqual({})
})

test("a query serializes back to text that parses to the same query", () => {
  for (const text of [DEFAULT_QUERY, "flow:chat @minh is:failed started:2026-10-01..2026-10-15 a1b2", "", "@kai"]) {
    const q = parse(text).query
    expect(parse(serialize(q)).query).toEqual(q)
  }
  expect(serialize(parse("a1b2  person:@minh flow:chat").query)).toBe("flow:chat @minh a1b2")
})

test("an address's query: q as typed, old filter params turned into the query, the default when there's none", () => {
  expect(queryOfAddress({})).toEqual({ text: DEFAULT_QUERY, old: false })
  expect(queryOfAddress({ q: "" })).toEqual({ text: "", old: false })
  expect(queryOfAddress({ q: "flow:chat a1b2" })).toEqual({ text: "flow:chat a1b2", old: false })
  expect(queryOfAddress({ flow: "chat", person: "minh", status: "idle", q: "a1b2" })).toEqual({
    text: "flow:chat @minh is:idle a1b2", old: true,
  })
  expect(queryOfAddress({ person: ["kai", "ann"] })).toEqual({ text: "@kai", old: true })
  expect(queryOfAddress({ status: "busy" })).toEqual({ text: "is:busy", old: true })
})

test("the list's address keeps the query readable", () => {
  expect(hrefOf("@kai is:open started:7d")).toBe("/runs?q=@kai+is:open+started:7d")
  expect(hrefOf("")).toBe("/runs?q=")
  expect(hrefOf("started:>2026-10-13 a+b")).toBe("/runs?q=started:%3E2026-10-13+a%2Bb")
  expect(new URL(hrefOf("started:>2026-10-13 a+b"), "http://x").searchParams.get("q")).toBe("started:>2026-10-13 a+b")
})

test("a run matches every parameter set; the person is the driver or a participant", () => {
  expect(matches(run({}), { person: "minh" })).toBe(true)
  expect(matches(run({}), { person: "ngocbh" })).toBe(true)
  expect(matches(run({}), { person: "ann", flow: "chat" })).toBe(false)
  expect(matches(run({}), { q: "a1b2" })).toBe(true)
  expect(matches(run({}), { status: ["running", "idle"] })).toBe(true)
  expect(matches(run({}), { status: ["failed"] })).toBe(false)
  expect(matches(run({}), { since: "2026-10-20T10:00:00.000Z", until: "2026-10-20T10:00:01.000Z" })).toBe(true)
  expect(matches(run({}), { until: "2026-10-20T10:00:00.000Z" })).toBe(false)
  expect(matches(run({}), { since: "2026-10-20T10:00:00.001Z" })).toBe(false)
  expect(matches(run({}), {})).toBe(true)
})

test("an exact run id is 26 Crockford characters, any case", () => {
  expect(isRunId(" 01ja1h0000000000000000a1b2 ")).toBe(true)
  expect(isRunId("a1b2")).toBe(false)
  expect(isRunId("01JA1H0000000000000000A1BI")).toBe(false)
})

const sources = {
  flows: ["side_chat", "chat", "debrief", "profile_manager"],
  people: [
    { handle: "kai", name: "Kai" },
    { handle: "ngocbh", name: "Ngoc" },
    { handle: "lead", name: "Lead" },
  ],
}
const labels = (text: string, caret = text.length) => suggest(text, caret, sources)?.options.map((o) => o.insert)

test("autocomplete offers qualifiers, then each one's values, filtered as you type", () => {
  expect(labels("")).toEqual(["flow:", "person:", "is:", "started:"])
  expect(labels("st")).toEqual(["started:"])
  expect(labels("a1b2")).toBeUndefined()
  expect(labels("flow:")).toEqual(["flow:chat", "flow:debrief", "flow:profile_manager", "flow:side_chat"])
  expect(labels("flow:ch")).toEqual(["flow:chat", "flow:side_chat"]) // a prefix first, then anywhere
  expect(labels("@")).toEqual(["@kai", "@lead", "@ngocbh"])
  expect(labels("@ng")).toEqual(["@ngocbh"])
  expect(labels("person:ka")).toEqual(["person:kai"])
  expect(labels("person:@ka")).toEqual(["person:@kai"])
  expect(labels("is:")).toEqual(["is:open", "is:closed", "is:running", "is:waiting", "is:idle", "is:finished",
                                 "is:failed", "is:interrupted"])
  expect(labels("is:f")).toEqual(["is:finished", "is:failed"])
  expect(labels("started:")).toEqual(["started:24h", "started:7d", "started:30d"])
  expect(labels("foo:")).toBeUndefined()
  // The token under the caret, not the last one.
  expect(labels("is:open flow:", 3)).toEqual(labels("is:"))
})

test("people match by name or handle, and each option says who it is", () => {
  const people = [{ handle: "nguyen", name: "Minh Tran" }]
  expect(suggest("@tran", 5, { flows: [], people })?.options).toEqual([
    { insert: "@nguyen", label: "@nguyen", detail: "Minh Tran", complete: true },
  ])
})

test("accepting an option replaces the token under the caret", () => {
  const s = suggest("is:open fl a1b2", 10, sources)!
  expect(accept("is:open fl a1b2", s, s.options[0]!)).toEqual({ text: "is:open flow: a1b2", caret: 13 })
  const v = suggest("is:open flow:c", 14, sources)!
  // A value is a whole filter: a space follows it, and the caret goes past the space.
  expect(accept("is:open flow:c", v, v.options[0]!)).toEqual({ text: "is:open flow:chat ", caret: 18 })
  const mid = suggest("@k is:open", 2, sources)!
  expect(accept("@k is:open", mid, mid.options[0]!)).toEqual({ text: "@kai is:open", caret: 5 })
})

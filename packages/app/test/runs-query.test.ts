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
  expect(parse("is:recent is:failed @kai").query).toEqual({ recent: true, is: "failed", person: "kai" })
  expect(parse("IS:Recent is:open").query).toEqual({ recent: true, is: "open" })
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
  expect(parse("is:busy").hints).toEqual(["unknown state busy: is: takes recent, open, closed or a state"])
  expect(parse("started:soon").hints).toEqual([
    "started: takes 24h, 7d, >2026-10-13 or 2026-10-01..2026-10-15",
  ])
  expect(parse("started:soon").query).toEqual({})
  // A qualifier with no value yet is still being typed: no hint, no filter.
  expect(parse("flow: @ is:")).toMatchObject({ query: {}, hints: [] })
})

test("is:recent and started: don't go together: started: is hinted and ignored, in either order", () => {
  for (const text of ["is:recent started:24h", "started:24h is:recent"]) {
    const { query, tokens, hints } = parse(text)
    expect(query).toEqual({ recent: true })
    expect(hints).toEqual(["is:recent already covers started:"])
    expect(tokens.find((t) => t.text === "started:24h")?.kind).toBe("ignored")
    expect(tokens.find((t) => t.text === "is:recent")?.kind).toBe("qualifier")
  }
  // A second is:recent says nothing new.
  expect(parse("is:recent is:recent")).toMatchObject({ query: { recent: true }, hints: [] })
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
  for (const bad of ["0d", "7w", "d", "2026-13-01", "2026-02-30", "2026-10-15..2026-10-01", "2026-10-1", ">", "1.5h",
                     "99999999999d", "100000000d"])
    expect(startedRange(bad, NOW)).toBeUndefined()
  // A window too far back for a Date is hinted, not thrown.
  expect(parse("started:99999999999d")).toMatchObject({ query: {}, hints: [
    "started: takes 24h, 7d, >2026-10-13 or 2026-10-01..2026-10-15"] })
})

test("started: values are read in any case", () => {
  expect(parse("started:7D").query).toEqual({ started: "7d" })
  expect(parse("Started:24H").query).toEqual({ started: "24h" })
})

test("local days follow daylight saving: a 23-hour day and a 25-hour day", () => {
  const tz = process.env.TZ
  // Not this machine's zone, so the test shows the zone is followed rather than happening to match.
  process.env.TZ = "Europe/Berlin"
  try {
    expect(startedRange("2026-03-29", NOW)).toEqual({ since: "2026-03-28T23:00:00.000Z", until: "2026-03-29T22:00:00.000Z" })
    expect(startedRange("2026-10-25", NOW)).toEqual({ since: "2026-10-24T22:00:00.000Z", until: "2026-10-25T23:00:00.000Z" })
    expect(startedRange("2026-03-28..2026-03-29", NOW)).toEqual({
      since: "2026-03-27T23:00:00.000Z", until: "2026-03-29T22:00:00.000Z" })
  } finally {
    // Unset, TZ would become the string "undefined"; deleting it brings back the machine's zone.
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
})

test("a query maps onto GET /runs's parameters", () => {
  expect(DEFAULT_QUERY).toBe("is:recent")
  expect(paramsOf(parse(DEFAULT_QUERY).query, NOW)).toEqual({
    recent: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
  })
  expect(paramsOf(parse("is:recent is:failed").query, NOW)).toEqual({
    recent: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(), status: ["failed"],
  })
  expect(paramsOf(parse("is:open started:7d").query, NOW)).toEqual({
    status: ["running", "waiting", "idle"],
    since: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
  })
  expect(paramsOf(parse("is:closed").query, NOW)).toEqual({ status: ["finished", "failed", "interrupted"] })
  expect(paramsOf(parse("flow:chat @minh is:failed a1b2").query, NOW)).toEqual({
    flow: "chat", person: "minh", status: ["failed"], q: "a1b2",
  })
  expect(paramsOf({}, NOW)).toEqual({})
})

test("a query goes into the address and comes back as the same text", () => {
  for (const text of [DEFAULT_QUERY, "flow:chat @minh is:failed started:2026-10-01..2026-10-15 a1b2", "", "@kai",
                      "started:>=2026-10-13 a+b&c#d"]) {
    const q = new URL(hrefOf(text), "http://x").searchParams.get("q") ?? undefined
    expect(queryOfAddress({ q }).text).toBe(text)
  }
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
  expect(hrefOf("@kai is:recent")).toBe("/runs?q=@kai+is:recent")
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

test("recent matches an open run of any age, or a closed one launched at or after it", () => {
  const recent = "2026-10-13T10:00:00.000Z"
  const old = "2026-09-01T10:00:00.000Z"
  for (const status of ["running", "waiting", "idle"] as const)
    expect(matches(run({ status, launched_at: old }), { recent })).toBe(true)
  for (const status of ["finished", "failed", "interrupted"] as const) {
    expect(matches(run({ status, launched_at: old }), { recent })).toBe(false)
    expect(matches(run({ status, launched_at: recent }), { recent })).toBe(true)
  }
  expect(matches(run({ status: "idle", launched_at: old }), { recent, status: ["failed"] })).toBe(false)
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
  expect(labels("is:")).toEqual(["is:recent", "is:open", "is:closed", "is:running", "is:waiting", "is:idle", "is:finished",
                                 "is:failed"]) // eight at most
  expect(labels("is:r")).toEqual(["is:recent", "is:running"])
  expect(labels("is:f")).toEqual(["is:finished", "is:failed"])
  expect(labels("started:")).toEqual(["started:24h", "started:7d", "started:30d"])
  expect(labels("started:7D")).toEqual(["started:7d"])
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

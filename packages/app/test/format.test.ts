import { expect, test } from "bun:test"
import { ago, costText, describe, totalsText } from "../src/company/format"

test("a cost is dollars, plus +n unpriced for harness sessions", () => {
  expect(costText(0.42, 0)).toBe("$0.42")
  expect(costText(0, 1)).toBe("$0.00 +1 unpriced")
})

test("a closed branch's totals leave out zero counts, but never the people or the cost", () => {
  expect(totalsText({ people: 3, busy: 1, waiting: 2, needsYou: 2, usd: 0.42, unpriced: 1 })).toBe(
    "3 people · 1 busy · 2 waiting · 2 for you · $0.42 +1 unpriced")
  expect(totalsText({ people: 1, busy: 0, waiting: 0, needsYou: 0, usd: 0, unpriced: 0 })).toBe("1 person · $0.00")
})

test("a row's description: status, cards for the viewer, cost, and a closed branch's totals", () => {
  expect(describe({ status: "waiting", branch: false, needs: 1, cost: "$0.42" })).toBe("waiting · 1 card for you · $0.42")
  expect(describe({ status: "away", branch: false, needs: 0, cost: "$0.00" })).toBe("away · $0.00")
  expect(describe({ status: "busy", branch: true, needs: 2, cost: "$0.00", totals: "3 people · $0.42" })).toBe(
    "busy in this branch · 2 cards for you · $0.00 · 3 people · $0.42")
})

test("a commit's age, in words", () => {
  const now = Date.parse("2026-10-20T12:00:00Z")
  expect(ago("2026-10-20T11:59:40Z", now)).toBe("just now")
  expect(ago("2026-10-20T11:55:00Z", now)).toBe("5 minutes ago")
  expect(ago("2026-10-20T10:00:00Z", now)).toBe("2 hours ago")
  expect(ago("2026-10-19T10:00:00Z", now)).toBe("yesterday")
  expect(ago("2026-10-01T12:00:00Z", now)).toBe("19 days ago")
  expect(ago("2026-07-01T12:00:00Z", now)).toBe("3 months ago")
  expect(ago("2024-10-01T12:00:00Z", now)).toBe("2 years ago")
  expect(ago("2026-10-20T12:05:00Z", now)).toBe("just now") // a clock a little ahead
})

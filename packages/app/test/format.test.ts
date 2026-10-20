import { expect, test } from "bun:test"
import { costText, totalsText } from "../src/company/format"

test("a cost is dollars, plus +n unpriced for harness sessions", () => {
  expect(costText(0.42, 0)).toBe("$0.42")
  expect(costText(0, 1)).toBe("$0.00 +1 unpriced")
})

test("a closed branch's totals leave out zero counts, but never the people or the cost", () => {
  expect(totalsText({ people: 3, busy: 1, waiting: 2, needsYou: 2, usd: 0.42, unpriced: 1 })).toBe(
    "3 people · 1 busy · 2 waiting · 2 for you · $0.42 +1 unpriced")
  expect(totalsText({ people: 1, busy: 0, waiting: 0, needsYou: 0, usd: 0, unpriced: 0 })).toBe("1 person · $0.00")
})

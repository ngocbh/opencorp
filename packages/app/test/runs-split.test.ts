import { expect, test } from "bun:test"
import { DETAIL_MIN, TIMELINE_MIN, detailBounds, detailWidth } from "../src/runs/split"

test("node detail is half the width by default, between its min and what leaves the Timeline its min", () => {
  expect(detailWidth(null, 1000)).toBe(500)
  expect(detailBounds(1000)).toEqual({ min: DETAIL_MIN, max: 1000 - TIMELINE_MIN })
  // Half of a narrow page is under the min.
  expect(detailWidth(null, 620)).toBe(DETAIL_MIN)
})

test("a chosen width is clamped to the bounds, so the Timeline keeps its min", () => {
  expect(detailWidth(600, 1000)).toBe(600)
  expect(detailWidth(900, 1000)).toBe(1000 - TIMELINE_MIN)
  expect(detailWidth(100, 1000)).toBe(DETAIL_MIN)
})

test("on a page too narrow for both mins, the Timeline keeps its min", () => {
  expect(detailBounds(544)).toEqual({ min: 544 - TIMELINE_MIN, max: 544 - TIMELINE_MIN })
  expect(detailWidth(400, 544)).toBe(544 - TIMELINE_MIN)
  expect(detailWidth(null, 0)).toBe(0)
})

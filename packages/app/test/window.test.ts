import { expect, test } from "bun:test"
import { since } from "../src/data/window"

test("today starts at local midnight; 7 and 30 days count back from now", () => {
  const now = new Date(2026, 9, 19, 15, 30)
  expect(since("today", now)).toBe(new Date(2026, 9, 19, 0, 0).toISOString())
  expect(since("7d", now)).toBe(new Date(now.getTime() - 7 * 86_400_000).toISOString())
  expect(since("30d", now)).toBe(new Date(now.getTime() - 30 * 86_400_000).toISOString())
})

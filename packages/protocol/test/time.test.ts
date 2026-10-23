import { expect, test } from "bun:test"
import { now, stamp } from "../src/time"

test("now is a valid timestamp", () => {
  expect(now()).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u)
})

test("now is current utc", () => {
  expect(Math.abs(Date.now() - Date.parse(now()))).toBeLessThan(5000)
})

test("string order is time order", async () => {
  const stamps: string[] = []
  for (let i = 0; i < 3; i++) {
    stamps.push(now())
    await Bun.sleep(2)
  }
  expect(stamps).toEqual([...stamps].sort())
  expect(new Set(stamps).size).toBe(3)
  expect(new Set(stamps.map((s) => s.length)).size).toBe(1)
})

test("stamp writes any aware time in utc like now", () => {
  expect(stamp(new Date("2026-10-19T17:00:00.123+07:00"))).toBe("2026-10-19T10:00:00.123Z")
  expect(stamp(new Date()).length).toBe(now().length)
})

import { expect, test } from "bun:test"
import { interruptible, working } from "../../src/util/status"

test("Esc works on a waiting session; the spinner shows only while starting or busy", () => {
  expect((["starting", "busy", "waiting", "idle", "ended"] as const).map(interruptible)).toEqual([
    true,
    true,
    true,
    false,
    false,
  ])
  expect((["starting", "busy", "waiting", "idle"] as const).map(working)).toEqual([true, true, false, false])
  expect(interruptible(undefined)).toBe(false)
})

/** A run's end as the office writes it, and each session kind's flow label. */
import { expect, test } from "bun:test"
import { RunEnd, flowLabel } from "../../src/runs/outcomes.ts"

test("a reason is kept as given", () => {
  const end = new RunEnd("failed", "AuthError: 401 Bearer abcdefgh12345 for sk-unconfigured0123456789", "chat#0/reply")
  expect(end.reason).toBe("AuthError: 401 Bearer abcdefgh12345 for sk-unconfigured0123456789")
  expect(end.failedNode).toBe("chat#0/reply")
  expect(new RunEnd("finished").reason).toBeNull()
})

test("each session kind has a flow label", () => {
  expect(["main", "side", "profile_manager", "other"].map(flowLabel)).toEqual([
    "chat", "side_chat", "profile_manager", "other"])
  expect(flowLabel("constructor")).toBe("constructor")
})

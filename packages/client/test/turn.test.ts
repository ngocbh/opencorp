import { expect, test } from "bun:test"
import type { Session } from "@opencorp/protocol"
import { statusLabel } from "../src/turn"

const sess = (over: Partial<Session>) => ({ id: "S", status: "waiting", waiting_on: ["ann"], ...over }) as Session

test("statusLabel names who a waiting session waits on, and says when its cost cap holds it", () => {
  expect(statusLabel(sess({ status: "idle", waiting_on: [] }))).toBe("idle")
  expect(statusLabel(sess({ waiting_on: ["ann", "lead"] }))).toBe("waiting on @ann, @lead")
  expect(statusLabel(sess({ waiting_on: ["lead"], capped: true }))).toBe("cost cap reached, waiting on @lead")
  expect(statusLabel(sess({ waiting_on: ["ann", "lead"], capped: true }))).toBe("cost cap reached, waiting on @ann, @lead")
  expect(statusLabel(sess({ waiting_on: [] }))).toBe("waiting")
  expect(statusLabel(sess({ status: "busy", capped: true }))).toBe("busy")
})

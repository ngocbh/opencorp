import { expect, test } from "bun:test"
import { PROTOCOL_VERSION } from "../src/index"

test("protocol package loads", () => {
  expect(PROTOCOL_VERSION).toBe(1)
})

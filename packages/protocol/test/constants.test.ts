import { expect, test } from "bun:test"
import { PAIR_CODE_TTL_MS } from "@opencorp/protocol"

test("a pairing code lives five minutes", () => {
  expect(PAIR_CODE_TTL_MS).toBe(5 * 60_000)
})

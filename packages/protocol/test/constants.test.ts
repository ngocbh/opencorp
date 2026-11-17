import { expect, test } from "bun:test"
import { APPROVAL_YES, approvalAlwaysOption, approvalSessionOption, PAIR_CODE_TTL_MS } from "@opencorp/protocol"

test("a pairing code lives five minutes", () => {
  expect(PAIR_CODE_TTL_MS).toBe(5 * 60_000)
})

test("an approval card's Yes options name the rules they add", () => {
  expect(APPROVAL_YES).toBe("Yes")
  expect(approvalSessionOption(["rm -rf build", "make clean"])).toBe(
    "Yes, and don't ask again this session for: rm -rf build, make clean",
  )
  expect(approvalAlwaysOption(["make clean"])).toBe("Yes, and always allow: make clean")
})

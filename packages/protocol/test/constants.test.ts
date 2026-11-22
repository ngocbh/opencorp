import { expect, test } from "bun:test"
import {
  APPROVAL_YES, approvalAlwaysOption, approvalSessionOption, isOfficeNote, Message, OFFICE, PAIR_CODE_TTL_MS,
} from "@opencorp/protocol"

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

test("a note from the office is a user message whose author is office", () => {
  const note = Message.parse({
    id: "r1:000000000007",
    session_id: "01JA1H0000000000000000000A",
    role: "user",
    author: OFFICE,
    parts: [{ id: "r1:000000000007:0", type: "text", text: "shell 1: `make` ended, exit 2" }],
    created_at: "2026-11-22T00:00:00.000Z",
  })
  expect(isOfficeNote(note)).toBe(true)
  expect(isOfficeNote({ ...note, author: "minh" })).toBe(false)
  expect(isOfficeNote({ ...note, author: null })).toBe(false)
  expect(isOfficeNote({ ...note, role: "assistant" })).toBe(false)
})

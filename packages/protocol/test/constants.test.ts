import { expect, test } from "bun:test"
import {
  APPROVAL_YES, approvalAlwaysOption, approvalSessionOption, Handle, isInstrumentNote, Message, PAIR_CODE_TTL_MS,
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

test("an instrument's note is a user message the office marks with its instrument, whatever its author says", () => {
  const note = Message.parse({
    id: "r1:000000000007",
    session_id: "01JA1H0000000000000000000A",
    role: "user",
    instrument: { id: "01JA1X0000000000000000000A", name: "shell 1" },
    parts: [{ id: "r1:000000000007:0", type: "text", text: "shell 1: `make` ended, exit 2" }],
    created_at: "2026-11-22T00:00:00.000Z",
  })
  expect(note.author).toBeNull()
  expect(isInstrumentNote(note)).toBe(true)
  expect(isInstrumentNote({ ...note, instrument: null })).toBe(false)
  expect(isInstrumentNote({ ...note, role: "assistant" })).toBe(false)
  // A person's message is never one, and no handle can spell an instrument's name: handles hold no space.
  expect(isInstrumentNote(Message.parse({ ...note, instrument: null, author: "minh" }))).toBe(false)
  expect(Handle.safeParse("shell 1").success).toBe(false)
  expect(Message.safeParse({ ...note, author: "shell 1" }).success).toBe(false)
})

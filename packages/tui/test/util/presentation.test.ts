import { expect, test } from "bun:test"
import stripAnsi from "strip-ansi"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary under the OpenCorp logo", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencorp -s ses_123")
  expect(stripAnsi(epilogue)).toContain("█  █ █▀▀█ █▀▀█ █▀▀▄ █    █▀▀█ █▀▀ █▀▀█")
})

test("the epilogue says the session is saved, above how to continue it", () => {
  const plain = stripAnsi(sessionEpilogue({ title: "A session", sessionID: "ses_123" }))
  expect(plain).toContain("Saved. /sessions in this folder brings it back.")
  expect(plain.indexOf("Saved.")).toBeLessThan(plain.indexOf("opencorp -s ses_123"))
})

test("the epilogue's title loses control characters, which would reach the terminal after the TUI exits", () => {
  const epilogue = stripAnsi(sessionEpilogue({ title: "@minh · /tmp/a\x07b\x1b]0;T\x07", sessionID: "ses_123" }))
  expect(epilogue).toContain("@minh · /tmp/ab")
  expect(epilogue).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
})

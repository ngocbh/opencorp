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

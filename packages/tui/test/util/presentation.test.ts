import { expect, test } from "bun:test"
import stripAnsi from "strip-ansi"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary under the OpenCorp logo", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencorp -s ses_123")
  expect(stripAnsi(epilogue)).toContain("█  █ █▀▀█ █▀▀█ █▀▀▄ █    █▀▀█ █▀▀ █▀▀█")
})

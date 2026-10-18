import { expect, test } from "bun:test"
import type { Question } from "@opencorp/protocol"
import { isTurn, turnPath } from "../../src/office/turn"

test("turnPath drops a trailing #N from every segment", () => {
  expect(turnPath("chat#3/ask")).toBe("chat/ask")
  expect(turnPath("chat#3/sub/ask")).toBe("chat/sub/ask")
  expect(turnPath("ask")).toBe("ask")
  expect(turnPath("map#12/step#2/ask")).toBe("map/step/ask")
  expect(turnPath("v#2a/ask")).toBe("v#2a/ask")
})

const q = (fields: Partial<Question>): Question => ({
  id: "Q",
  session_id: "S",
  run_id: "run-1",
  node_id: null,
  source: "human_input",
  asker: "minh",
  question: "You:",
  status: "open",
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
  ...fields,
})

test("a human_input at chat/ask is the chat's turn; anything else is a card", () => {
  expect(isTurn(q({ node_id: "chat#1/ask" }))).toBe(true)
  expect(isTurn(q({ node_id: "chat#1/sub/ask" }))).toBe(false)
  expect(isTurn(q({ node_id: "ask" }))).toBe(false)
  expect(isTurn(q({ node_id: "chat#1/ask", source: "ask_user" }))).toBe(false)
  expect(isTurn(q({ node_id: null, source: "ask_user" }))).toBe(false)
})

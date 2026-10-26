/** Which node of a conversation flow is the turn. */
import { expect, test } from "bun:test"
import { staticPathOf } from "@ngocbh/yian/run"
import { ChatFlow, MAIN_CHAT } from "../../src/chat/turns.ts"

const CASES = [
  ["chat#3/ask", "chat/ask"],
  ["chat#0/ask", "chat/ask"],
  ["chat#3/sub#1/ask", "chat/sub/ask"],
  ["chat#3/sub/ask", "chat/sub/ask"],
  ["ask", "ask"],
  ["chat~1", "chat"],
  ["a#b/ask", "a#b/ask"],
] as const

test.each(CASES)("turn path strips each occurrence suffix [%s]", (nodeId, path) => {
  expect(staticPathOf(nodeId)).toBe(path)
  expect(new ChatFlow({ turn: path }).isTurn(nodeId)).toBe(true)
})

test("the main chat names its turn and reply", () => {
  expect(MAIN_CHAT.inbox).toBe("messages")
  expect(MAIN_CHAT.isTurn("chat#12/heard")).toBe(true)
  expect(MAIN_CHAT.isTurn("chat#12/sub/heard")).toBe(false)
  expect(MAIN_CHAT.isTurn(null)).toBe(false)
  expect(MAIN_CHAT.isTurn("heard")).toBe(false)
  expect(MAIN_CHAT.isReply("chat#0/reply")).toBe(true)
  expect(MAIN_CHAT.isReply("chat#0/heard")).toBe(false)
  expect(new ChatFlow({ turn: "talk/heard" }).isTurn("talk#2/heard")).toBe(true)
})

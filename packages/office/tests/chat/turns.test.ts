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

test("the main chat names its context and summarizer", () => {
  expect(MAIN_CHAT.context).toBe("chat/context")
  expect(MAIN_CHAT.summarizer).toBe("chat/context/compacted/folded/summarize")
  expect(MAIN_CHAT.inContext("chat#3/context")).toBe(true)
  expect(MAIN_CHAT.inContext("chat#3/context/compacted/folded/summarize")).toBe(true)
  expect(MAIN_CHAT.inContext("chat#3/contextual")).toBe(false)
  expect(MAIN_CHAT.inContext("chat#3/reply")).toBe(false)
  expect(MAIN_CHAT.inContext(null)).toBe(false)
  expect(MAIN_CHAT.iterationOf("chat#7/context/compacted/folded/summarize")).toBe(7)
  expect(MAIN_CHAT.iterationOf("chat#0/heard")).toBe(0)
  expect(MAIN_CHAT.iterationOf("talk#2/heard")).toBeNull()
  expect(MAIN_CHAT.iterationOf("heard")).toBeNull()
  expect(MAIN_CHAT.turnWorks(["chat#2/context/compacted/folded/summarize"])).toBe(true)
  expect(MAIN_CHAT.turnWorks(["chat#2/reply"])).toBe(true)
  expect(MAIN_CHAT.turnWorks(["chat#2/heard"])).toBe(false)
  expect(MAIN_CHAT.turnWorks([])).toBe(false)
})

import { expect, test } from "bun:test"
import type { Question } from "@opencorp/protocol"
import { emptyState } from "../../../src/office/store"
import { cardQuestions } from "../../../src/routes/chat/turn"

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

test("cardQuestions are a session's open questions, oldest first, without its turn", () => {
  const s = emptyState()
  s.questions = {
    T: q({ id: "T", node_id: "chat#2/ask", created_at: "2026-09-30T00:00:01Z" }),
    B: q({ id: "B", node_id: null, source: "ask_user", created_at: "2026-09-30T00:00:03Z" }),
    A: q({ id: "A", node_id: "chat#2/review", created_at: "2026-09-30T00:00:02Z" }),
    X: q({ id: "X", node_id: null, source: "ask_user", status: "answered" }),
    O: q({ id: "O", session_id: "OTHER", node_id: null, source: "ask_user" }),
  }
  expect(cardQuestions(s, "S").map((x) => x.id)).toEqual(["A", "B"])
})

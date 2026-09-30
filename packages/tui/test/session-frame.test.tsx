import type { Message } from "@agent-corp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../script/stub"
import { bootFrame } from "./fixture/frame"

test("a session shows text and tool parts, and streams deltas", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const at = "2026-01-01T00:00:00Z"
  office.state.messages[s.id] = [
    {
      id: "M1",
      session_id: s.id,
      role: "user",
      created_at: at,
      parts: [{ id: "a", type: "text", text: "fix the test" }],
    },
    {
      id: "M2",
      session_id: s.id,
      role: "assistant",
      created_at: at,
      parts: [
        {
          id: "b",
          type: "tool",
          call_id: "c1",
          tool: "read_file",
          state: "completed",
          input: { path: "src/app.py" },
          output: "...",
        },
        { id: "c", type: "tool", call_id: "c2", tool: "shell", state: "running", input: { command: "pytest -q" } },
        { id: "d", type: "text", text: "Looking" },
      ],
    },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until(
      (f) => f.includes("fix the test") && f.includes("src/app.py") && f.includes("pytest -q") && f.includes("Looking"),
    )
    office.live({ type: "part.delta", session_id: s.id, data: { message_id: "M2", part_id: "d", text: " at it" } })
    await app.until((f) => f.includes("Looking at it"))
    expect(app.frame()).toContain("@minh · idle")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a new message and a status change arrive live", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    const message: Message = {
      id: "M3",
      session_id: s.id,
      role: "assistant",
      created_at: "2026-01-01T00:00:00Z",
      parts: [
        {
          id: "e",
          type: "tool",
          call_id: "c3",
          tool: "edit_file",
          state: "completed",
          input: { path: "src/b.py", old: "a", new: "b" },
        },
      ],
    }
    office.live({ type: "message.updated", session_id: s.id, data: message as never })
    office.setStatus(s.id, "busy")
    await app.until((f) => f.includes("Edit src/b.py") && f.includes("@minh · busy"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an unknown session goes back home with a toast", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office), { sessionID: "01NOSUCHSESSION00000000000" })
  try {
    await app.until((f) => f.includes("Ask anything") && f.includes("not found"))
  } finally {
    await app.stop()
    office.stop()
  }
})

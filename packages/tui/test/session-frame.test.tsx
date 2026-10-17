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

test("an edit's diff numbers lines from where the edit landed, or not at all", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const edit = (id: string, path: string, output: string) => ({
    id,
    type: "tool" as const,
    call_id: id,
    tool: "edit_file",
    state: "completed" as const,
    input: { path, old: "Status: TODO\nOwner: minh", new: "Status: DONE\nOwner: minh" },
    output,
  })
  office.state.messages[s.id] = [
    {
      id: "M2",
      session_id: s.id,
      role: "assistant",
      created_at: "2026-01-01T00:00:00Z",
      parts: [
        edit("e1", "notes.md", "replaced 1 occurrence in notes.md at line 3"),
        // An office from before edits reported a line: the snippet's own numbers would be wrong.
        edit("e2", "old.md", "replaced 1 occurrence in old.md"),
      ],
    },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Edit notes.md") && f.includes("Edit old.md"))
    const frame = app.frame()
    const after = (title: string) => frame.slice(frame.indexOf(title)).split("\n").slice(1, 5).join("\n")
    expect(after("Edit notes.md")).toMatch(/3 - Status: TODO[\s\S]*3 \+ Status: DONE[\s\S]*4 {3}Owner: minh/)
    // Without a line the diff has no gutter: its colors alone mark the removed and added lines.
    expect(after("Edit old.md")).toMatch(/Status: TODO[\s\S]*Status: DONE[\s\S]*Owner: minh/)
    expect(after("Edit old.md")).not.toMatch(/\d/)
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

test("an answered question shows the user's answer, not the discussion sent to the model", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const output =
    'The user chose "Apache-2.0" (option 2 of the 3 shown).\n\n' +
    "Before answering, the user discussed your question with you in a side chat.\n" +
    'Discussion (JSON, oldest first):\n[{"role":"user","text":"why not MIT?"}]'
  office.state.messages[s.id] = [
    {
      id: "M1",
      session_id: s.id,
      role: "assistant",
      created_at: "2026-01-01T00:00:00Z",
      parts: [
        {
          id: "q",
          type: "tool",
          call_id: "c1",
          tool: "ask_user",
          state: "completed",
          input: { question: "Which license?" },
          output,
        },
      ],
    },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Which license?") && f.includes("Apache-2.0 (discussed in a side chat)"))
    expect(app.frame()).not.toContain("Before answering")
    expect(app.frame()).not.toContain("why not MIT?")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a failed turn shows why", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.state.messages[s.id] = [
    {
      id: "M1",
      session_id: s.id,
      role: "assistant",
      created_at: "2026-01-01T00:00:00Z",
      parts: [{ id: "e", type: "error", message: "The reply failed (AuthError: bad key). Send your message again." }],
    },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("The reply failed (AuthError: bad key). Send your message again."))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Codex parts: a command with output, a file change as a diff, an MCP call, and who approved", async () => {
  const office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex" })
  office.state.messages[s.id] = [
    {
      id: "M1",
      session_id: s.id,
      role: "assistant",
      created_at: new Date().toISOString(),
      parts: [
        {
          id: "p1",
          type: "tool",
          call_id: "c1",
          tool: "codex.command",
          state: "completed",
          input: { command: "pytest -q", exit_code: 0, approval: { decision: "accept", by: "ngocbh" } },
          output: "3 passed",
        },
        {
          id: "p2",
          type: "tool",
          call_id: "f1",
          tool: "codex.file_change",
          state: "completed",
          input: { changes: [{ path: "notes.md", kind: "add", diff: "hello\n" }] },
          output: "",
        },
        {
          id: "p3",
          type: "tool",
          call_id: "x1",
          tool: "codex.mcp_tool_call",
          state: "completed",
          input: { server: "docs", tool: "search", arguments: { q: "launchd" } },
          output: "3 hits",
        },
      ],
    },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("pytest -q") && f.includes("notes.md") && f.includes("docs/search"))
    expect(f).toContain("3 passed")
    expect(f).toContain("hello") // a new file's content, which Codex sends as its "diff"
    expect(f).toContain("approved by @ngocbh")
  } finally {
    await app.stop()
    office.stop()
  }
})

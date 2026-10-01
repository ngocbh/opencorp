import type { Message, Person, Session, ToolPart } from "@agent-corp/protocol"
import { describe, expect, test } from "bun:test"
import { formatMessage, formatPart, formatTranscript } from "../../src/util/transcript"

const people = [
  { handle: "minh", name: "Minh", kind: "agent", title: "Software engineer", manager: "ngocbh" },
] as Person[]
const session = {
  id: "S1",
  person: "minh",
  cwd: "/tmp/proj",
  status: "idle",
  kind: "main",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:05:00Z",
} as Session
const tool = (fields: Partial<ToolPart>): ToolPart => ({
  id: "t",
  type: "tool",
  call_id: "c",
  tool: "shell",
  state: "completed",
  input: { command: "ls" },
  ...fields,
})

describe("formatPart", () => {
  test("text, file, and tool parts", () => {
    expect(formatPart({ id: "a", type: "text", text: "hi" }, { toolDetails: true })).toBe("hi\n\n")
    expect(formatPart({ id: "b", type: "file", path: "a.png", mime: "image/png" }, { toolDetails: true })).toBe(
      "_File:_ a.png (image/png)\n\n",
    )
    expect(formatPart(tool({ output: "a\nb" }), { toolDetails: true })).toBe(
      '**Tool: shell**\n\n**Input:**\n```json\n{\n  "command": "ls"\n}\n```\n\n**Output:**\n```\na\nb\n```\n\n',
    )
    expect(formatPart(tool({ output: "x" }), { toolDetails: false })).toBe("**Tool: shell**\n\n")
  })

  test("an error part is its message", () => {
    expect(formatPart({ id: "e", type: "error", message: "The reply failed." }, { toolDetails: false })).toBe(
      "**Error:** The reply failed.\n\n",
    )
  })

  test("non-string output is JSON; errors are shown; fences in output don't break the block", () => {
    expect(formatPart(tool({ input: {}, output: { n: 1 } }), { toolDetails: true })).toContain(
      '**Output:**\n```\n{\n  "n": 1\n}\n```',
    )
    expect(formatPart(tool({ input: {}, state: "error", error: "boom" }), { toolDetails: true })).toContain(
      "**Error:**\n```\nboom\n```",
    )
    expect(formatPart(tool({ input: {}, output: "```\ncode\n```" }), { toolDetails: true })).toContain(
      "````\n```\ncode\n```\n````",
    )
  })
})

describe("formatMessage", () => {
  test("user messages are headed User; assistant messages by the person's handle", () => {
    const user: Message = {
      id: "M1",
      session_id: "S1",
      role: "user",
      created_at: "t",
      parts: [{ id: "a", type: "text", text: "go" }],
    }
    expect(formatMessage(user, session, people, { toolDetails: true })).toBe("## User\n\ngo\n\n")
    expect(formatMessage({ ...user, role: "assistant" }, session, people, { toolDetails: true })).toBe(
      "## @minh\n\ngo\n\n",
    )
    expect(
      formatMessage({ ...user, role: "assistant" }, { ...session, person: "gone" }, people, { toolDetails: true }),
    ).toBe("## gone\n\ngo\n\n")
  })
})

describe("formatTranscript", () => {
  test("a header, then the messages in creation order", () => {
    const messages: Message[] = [
      {
        id: "M2",
        session_id: "S1",
        role: "assistant",
        created_at: "2026-01-01T00:01:00Z",
        parts: [{ id: "b", type: "text", text: "done" }],
      },
      {
        id: "M1",
        session_id: "S1",
        role: "user",
        created_at: "2026-01-01T00:00:00Z",
        parts: [{ id: "a", type: "text", text: "go" }],
      },
    ]
    const out = formatTranscript(session, messages, people, { toolDetails: false })
    expect(out.startsWith("# @minh · /tmp/proj\n\n**Session ID:** S1\n")).toBe(true)
    expect(out.indexOf("## User")).toBeLessThan(out.indexOf("## @minh"))
    expect(out.endsWith("## @minh\n\ndone\n\n---\n\n")).toBe(true)
  })
})

import type { Message } from "@opencorp/protocol"
import { expect, onTestFinished, test } from "bun:test"
import { createFakeOffice, createStub } from "./fixture/fake-office"
import { bootFrame } from "./fixture/frame"
import { until } from "./fixture/until"
import { INTERRUPTED_TEXT } from "../src/routes/chat/freeze"

test("a waiting session's header names who it waits on, and a capped one says so", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    office.updateSession(s.id, { status: "waiting", waiting_on: ["ngocbh"] })
    await app.until((f) => f.includes("@minh · waiting on @ngocbh"))
    office.updateSession(s.id, { status: "waiting", waiting_on: ["ngocbh"], capped: true })
    await app.until((f) => f.includes("@minh · cost cap reached, waiting on @ngocbh"))
  } finally {
    await app.stop()
    office.stop()
  }
})

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

test("an assistant message whose only text part is empty draws nothing until a delta fills it", async () => {
  const at = "2026-01-01T00:00:00Z"
  const user = (id: string, text: string): Message => ({
    id,
    session_id: "",
    role: "user",
    created_at: at,
    parts: [{ id: id + "t", type: "text", text }],
  })
  const blank: Message = {
    id: "M2",
    session_id: "",
    role: "assistant",
    created_at: at,
    parts: [{ id: "b", type: "text", text: "" }],
  }
  const boot = async (messages: Message[]) => {
    const office = createFakeOffice()
    const s = office.state.sessions[0]
    office.state.messages[s.id] = messages.map((m) => ({ ...m, session_id: s.id }))
    const app = await bootFrame(createStub(office), { sessionID: s.id })
    onTestFinished(async () => {
      await app.stop()
      office.stop()
    })
    return { office, s, app }
  }
  const without = await boot([user("M1", "first question"), user("M3", "second question")])
  const expected = await without.app.until((f) => f.includes("first question") && f.includes("second question"))
  await without.app.stop()
  without.office.stop()

  const { office, s, app } = await boot([user("M1", "first question"), blank, user("M3", "second question")])
  const frame = await app.until((f) => f.includes("first question") && f.includes("second question"))
  // Only the gap between the two questions: the model name in the footer loads on its own.
  const gap = (f: string) => f.slice(f.indexOf("first question"), f.indexOf("second question"))
  expect(gap(frame)).toBe(gap(expected))
  expect(frame).not.toContain("On it")
  office.live({ type: "part.delta", session_id: s.id, data: { message_id: "M2", part_id: "b", text: "On it" } })
  await app.until((f) => f.includes("On it"))
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

test("a Codex change of several files shows each file; a failed command says its exit code", async () => {
  const office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex" })
  const at = new Date().toISOString()
  office.state.messages[s.id] = [
    {
      id: "M1",
      session_id: s.id,
      role: "assistant",
      created_at: at,
      parts: [
        {
          id: "p1",
          type: "tool",
          call_id: "c1",
          tool: "codex.command",
          state: "completed",
          input: { command: "make lint", exit_code: 2 },
          output: "lint failed",
        },
        {
          id: "p2",
          type: "tool",
          call_id: "f1",
          tool: "codex.file_change",
          state: "completed",
          input: {
            changes: [
              { path: "alpha.md", kind: "add", diff: "first file body\n" },
              { path: "beta.py", kind: "delete", diff: "second file body\n" },
              { path: "gamma.ts", kind: "update", diff: "@@ -1 +1 @@\n-old third\n+new third body\n" },
            ],
          },
          output: "",
        },
        {
          id: "p3",
          type: "tool",
          call_id: "f2",
          tool: "codex.file_change",
          state: "completed",
          input: { changes: [] },
          output: "",
        },
      ],
    },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("make lint") && f.includes("alpha.md"))
    expect(f).toContain("(exit 2)")
    expect(f).toContain("first file body")
    expect(f).toContain("second file body")
    expect(f).toContain("new third body")
    // A finished change with nothing in it isn't still being prepared.
    expect(f).not.toContain("Preparing edit")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("after Esc, the answer to a steer sent before it shows, and stays after the next send", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const say = (m: Message) => {
    office.state.messages[id] = [...office.state.messages[id].filter((x) => x.id !== m.id), m]
    office.live({ type: "message.updated", session_id: id, data: m as never })
  }
  const reply = (text: string): Message => ({
    id: office.nextId(),
    session_id: id,
    role: "assistant",
    created_at: new Date().toISOString(),
    parts: [{ id: office.nextId(), type: "text", text }],
  })
  let held: Message | undefined
  office.onPrompt((_, req) => {
    if (req.text !== "A") return say(reply(`Answer to ${req.text}.`))
    held = reply("Held back")
    say(held)
  })
  // The stopped reply ends with its marker; the office's next turn then answers the steer it never read.
  office.onInterrupt(() => {
    const part = { ...held!.parts[0], text: "Held back" + INTERRUPTED_TEXT } as Message["parts"][number]
    say({ ...held!, parts: [part] })
    say(reply("Answer to B."))
    office.replyEnded(id)
  })
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("A")
    app.input.pressEnter()
    await app.until((f) => f.includes("Held back") && f.includes("@minh · busy"))
    app.input.typeText("B steer")
    app.input.pressEnter()
    await until(() => office.requests.some((r) => (r.body as { text?: string } | undefined)?.text === "B steer"))
    app.input.pressEscape()
    await app.until((f) => f.includes("Answer to B.") && f.includes("@minh · idle"))
    app.input.typeText("C")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Answer to C."))
    expect(f).toContain("Answer to B.")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("after Esc, the answer to a steer shows in a chat whose first message was sent from home", async () => {
  const office = createFakeOffice()
  let id = ""
  // Kept in the office's transcript too, as the session view loads it again when it opens.
  const say = (m: Message) => {
    const list = office.state.messages[id] ?? []
    office.state.messages[id] = [...list.filter((x) => x.id !== m.id), m]
    office.live({ type: "message.updated", session_id: id, data: m as never })
  }
  const reply = (text: string): Message => ({
    id: office.nextId(),
    session_id: id,
    role: "assistant",
    created_at: new Date().toISOString(),
    parts: [{ id: office.nextId(), type: "text", text }],
  })
  let held: Message | undefined
  office.onPrompt((sessionId, req) => {
    id = sessionId
    if (req.text !== "A") return say(reply(`Answer to ${req.text}.`))
    held = reply("Held back")
    say(held)
  })
  // The stopped reply ends with its marker; the office's next turn then answers the steer it never read.
  office.onInterrupt(() => {
    const part = { ...held!.parts[0], text: "Held back" + INTERRUPTED_TEXT } as Message["parts"][number]
    say({ ...held!, parts: [part] })
    say(reply("Answer to B."))
    office.replyEnded(id)
  })
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("Ask anything") && f.includes("@minh"))
    app.input.typeText("A")
    app.input.pressEnter()
    await app.until((f) => f.includes("Held back") && f.includes("@minh · busy"))
    app.input.typeText("B steer")
    app.input.pressEnter()
    await until(() => office.requests.some((r) => (r.body as { text?: string } | undefined)?.text === "B steer"))
    app.input.pressEscape()
    await app.until((f) => f.includes("Answer to B.") && f.includes("@minh · idle"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an Esc in the turn that takes a steer straight after the last reply hides that turns late output", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const say = (m: Message) => {
    office.state.messages[id] = [...office.state.messages[id].filter((x) => x.id !== m.id), m]
    office.live({ type: "message.updated", session_id: id, data: m as never })
  }
  const reply = (text: string): Message => ({
    id: office.nextId(),
    session_id: id,
    role: "assistant",
    created_at: new Date().toISOString(),
    parts: [{ id: office.nextId(), type: "text", text }],
  })
  office.onPrompt(() => say(reply("Answer to A.")))
  // The stopped turn (the one taking B) writes its cut message after Esc.
  office.onInterrupt(() => {
    say(reply("Late B" + INTERRUPTED_TEXT))
    office.replyEnded(id)
  })
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("A")
    app.input.pressEnter()
    await app.until((f) => f.includes("Answer to A.") && f.includes("@minh · busy"))
    app.input.typeText("B steer")
    app.input.pressEnter()
    await app.until((f) => f.includes("B steer"))
    // The reply to A finishes without reading B, so the next turn takes B at once and the session stays busy.
    // The reply's cost comes in the same update, so the header shows once the count is in.
    office.updateSession(id, { turns: 1, cost: 0.25 })
    await app.until((f) => f.includes("$0.25"))
    app.input.pressEscape()
    await app.until((f) => f.includes("@minh · idle"))
    expect(await app.until(() => true)).not.toContain("Late B")
  } finally {
    await app.stop()
    office.stop()
  }
})

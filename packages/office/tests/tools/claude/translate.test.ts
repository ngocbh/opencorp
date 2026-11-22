/** Claude Code's lines as the office's transcript: real lines from the fixtures (`tests/fixtures/claude/stream.jsonl`,
 *  from the upstream TUI's recordings, and `stream-2.1.330.jsonl`, a real 2.1.330's), through the translator, as message, part and
 *  turn events. */
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import type { HarnessEvent } from "../../../src/tools/harness/adapter.ts"
import {
  INTERRUPTED_TEXT,
  OUTPUT_CUT,
  OUTPUT_MAX_CHARS,
  Translator,
} from "../../../src/tools/claude/translate.ts"

/** A JSON object from the fixture: `any`, since the tests edit what Claude Code wrote. */
type Obj = Record<string, any>

const FIXTURE = fileURLToPath(new URL("../../fixtures/claude/stream.jsonl", import.meta.url))
const LINES: Obj[] = fs
  .readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))

/** The fixture's line recorded at `source` (`file:line`), as Claude Code wrote it. */
function line(source: string): Obj {
  const found = LINES.find((entry) => entry.source === source)
  if (found === undefined) throw new Error(`no fixture line ${source}`)
  return structuredClone(found.message)
}

/** A translator and the events it wrote. */
function translator() {
  const events: HarnessEvent[] = []
  return { t: new Translator("01JSESSION0000000000000000", (e) => events.push(e)), events }
}

/** The events in a few words, to compare sequences. */
function brief(events: HarnessEvent[]): string[] {
  return events.map((e) => {
    if (e.type === "message") return `message/${e.message.role}`
    if (e.type === "part") {
      const p = e.part
      if (p.type === "text") return `text:${p.text}`
      if (p.type === "tool") return `tool:${p.tool}:${p.state}`
      return `part/${p.type}`
    }
    if (e.type === "model") return `model:${e.model}`
    return e.type
  })
}

test("a turn with a tool call writes its model, one assistant message with the call and its result, the text, and the usage", () => {
  const { t, events } = translator()
  for (const source of ["tools.jsonl:6", "tools.jsonl:9", "tools.jsonl:17", "tools.jsonl:35", "tools.jsonl:66"]) {
    expect(t.line(line(source)), source).toBe(true)
  }
  expect(t.turn).not.toBeNull()
  expect(t.line(line("tools.jsonl:70"))).toBe(true)
  expect(t.turn).toBeNull()
  expect(brief(events)).toEqual([
    "turn_started",
    "model:claude-haiku-5-5",
    "message/assistant",
    "tool:claude.mcp__fixture__lookup:running",
    "tool:claude.mcp__fixture__lookup:completed",
    "text:COPPER-OTTER",
    "turn_completed",
  ])
  const parts = events.flatMap((e) => (e.type === "part" ? [e.part] : []))
  const messages = new Set(events.flatMap((e) => (e.type === "part" ? [e.messageId] : [])))
  expect(messages.size).toBe(1)
  expect(parts[0]).toMatchObject({ call_id: "toolu_01GPXzQi1HJbmoKFc771ccNM", input: { key: "a" } })
  // The result replaces the call's part in place.
  expect(parts[1]).toMatchObject({ id: parts[0]!.id, output: "LILAC-HERON", error: null })
  const done = events.at(-1) as Extract<HarnessEvent, { type: "turn_completed" }>
  expect(done.turnId).toBe((events[0] as Extract<HarnessEvent, { type: "turn_started" }>).turnId)
  // Input counts what the cache served and stored, as the office counts Codex's.
  expect(done.usage).toEqual({ input_tokens: 6 + 2728 + 8273, cached_input_tokens: 8273, output_tokens: 195 })
})

test("an interrupt mid-text ends the message with the marker", () => {
  const { t, events } = translator()
  for (const source of ["tools-waiting-cancel.jsonl:50", "text-cancel.jsonl:15", "text-cancel.jsonl:19"]) t.line(line(source))
  expect(brief(events)).toEqual([
    "turn_started",
    "message/assistant",
    "text:WAITING-OTTER",
    `text:WAITING-OTTER${INTERRUPTED_TEXT}`,
    "turn_completed",
  ])
})

test("an interrupt while a tool waits shows the rejected call and the marker, and no failure", () => {
  const { t, events } = translator()
  const call = line("tools.jsonl:17")
  const rejected = line("tools-waiting-cancel.jsonl:34")
  rejected.message.content[0].tool_use_id = call.message.content[0].id
  for (const msg of [call, rejected, line("tools-waiting-cancel.jsonl:36"), line("tools-waiting-cancel.jsonl:37")]) {
    t.line(msg)
  }
  expect(brief(events)).toEqual([
    "turn_started",
    "message/assistant",
    "tool:claude.mcp__fixture__lookup:running",
    "tool:claude.mcp__fixture__lookup:error",
    `text:${INTERRUPTED_TEXT.trimStart()}`,
    "turn_completed",
  ])
  const failed = events[3] as Extract<HarnessEvent, { type: "part" }>
  expect((failed.part as { error: string }).error).toContain("The user doesn't want to proceed")
})

test("a tool still running when the turn ends is interrupted", () => {
  const { t, events } = translator()
  t.line(line("tools.jsonl:17"))
  t.line(line("text-cancel.jsonl:19"))
  expect(brief(events).slice(-3)).toEqual([
    "tool:claude.mcp__fixture__lookup:interrupted",
    `text:${INTERRUPTED_TEXT.trimStart()}`,
    "turn_completed",
  ])
})

test("an API error is shown once, from the turn's result", () => {
  const { t, events } = translator()
  t.line(line("billing-error.jsonl:8"))
  t.line(line("billing-error.jsonl:9"))
  expect(brief(events)).toEqual(["turn_started", "message/assistant", "turn_completed"])
  const shown = events.find((e) => e.type === "message") as Extract<HarnessEvent, { type: "message" }>
  expect(shown.message.parts[0]).toMatchObject({ type: "error" })
  expect((shown.message.parts[0] as { message: string }).message).toStartWith(
    "Claude Code's turn failed: API Error: 400 Third-party apps",
  )
})

test("a message mid-turn is a steer: what Claude Code writes after it opens a new message", () => {
  const { t, events } = translator()
  t.line(line("tools.jsonl:17"))
  t.user("also check b", "ngoc")
  t.line(line("tools.jsonl:35"))
  t.line(line("tools.jsonl:66"))
  t.line(line("tools.jsonl:70"))
  const user = events.find((e) => e.type === "message" && e.message.role === "user") as Extract<
    HarnessEvent,
    { type: "message" }
  >
  expect([user.message.author, user.message.parts]).toEqual(["ngoc", [expect.objectContaining({ text: "also check b" })]])
  const messageOf = (text: string) =>
    events.flatMap((e) => (e.type === "part" && e.part.type === "text" && e.part.text === text ? [e.messageId] : []))[0]
  const callMessage = events.find((e) => e.type === "part")!
  expect(messageOf("COPPER-OTTER")).not.toBe((callMessage as Extract<HarnessEvent, { type: "part" }>).messageId)
})

test("lines that aren't the transcript's are left to the caller, and a subagent's own lines are left out", () => {
  const { t, events } = translator()
  for (const source of ["tools.jsonl:7", "text-cancel.jsonl:13", "controls.jsonl:24", "tools.jsonl:18"]) {
    expect(t.line(line(source)), source).toBe(false)
  }
  const sub = line("tools.jsonl:66")
  sub.parent_tool_use_id = "toolu_agent"
  expect(t.line(sub)).toBe(true)
  expect(events).toEqual([])
})

test("a long tool output is cut with a marker, and an office stop interrupts what runs", () => {
  const { t, events } = translator()
  const call = line("tools.jsonl:17")
  const long = line("tools.jsonl:35")
  long.message.content[0].content = [{ type: "text", text: "x".repeat(OUTPUT_MAX_CHARS + 10) }, { type: "image" }]
  t.line(call)
  t.line(long)
  const cut = events.at(-1) as Extract<HarnessEvent, { type: "part" }>
  expect((cut.part as { output: string }).output).toBe("x".repeat(OUTPUT_MAX_CHARS) + OUTPUT_CUT)
  t.line(line("tools.jsonl:25"))
  t.abort()
  expect(brief(events).slice(-2)).toEqual([
    "tool:claude.mcp__fixture__lookup:interrupted",
    `text:${INTERRUPTED_TEXT.trimStart()}`,
  ])
  expect(t.turn).toBeNull()
  t.abort()
  t.error("Claude Code stopped")
  const last = events.at(-1) as Extract<HarnessEvent, { type: "message" }>
  expect([last.message.role, last.message.parts]).toEqual([
    "assistant",
    [expect.objectContaining({ type: "error", message: "Claude Code stopped" })],
  ])
})

test("messages Esc dropped before any turn took them end with the marker, in a message of their own", () => {
  const { t, events } = translator()
  t.user("Fix the build.", "minh")
  t.dropped()
  expect(t.turn).toBeNull()
  expect(brief(events)).toEqual(["message/user", "message/assistant", `text:${INTERRUPTED_TEXT.trimStart()}`])
  // The next turn's words open a message of their own.
  t.line({ type: "system", subtype: "init", model: "claude-opus-5-5" })
  t.line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Again." }] } })
  const opened = events.filter((e) => e.type === "message" && e.message.role === "assistant")
  expect(opened).toHaveLength(2)
})

/** The 2.1.330 lines of recorded run `name` (`f1`, `e1`), in the order Claude Code wrote them. */
function run(name: string): Obj[] {
  const file = fileURLToPath(new URL("../../fixtures/claude/stream-2.1.330.jsonl", import.meta.url))
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => JSON.parse(text) as Obj)
    .filter((entry) => entry.source.startsWith(`${name}.`))
    .map((entry) => entry.message)
}

test("2.1.330's turns read as recorded: two interrupted mid-command, the message one left queued its own turn, and the lines the office doesn't read left to the caller", () => {
  const { t, events } = translator()
  const unread = new Set<string>()
  for (const msg of run("f1")) {
    if (!t.line(msg)) unread.add(msg.type === "system" ? `system/${msg.subtype}` : msg.type)
  }
  expect([...unread].sort()).toEqual([
    "command_lifecycle",
    "control_response",
    "rate_limit_event",
    "system/task_notification",
    "system/task_started",
  ])
  expect(t.turn).toBeNull()
  expect(brief(events).filter((e) => e.startsWith("turn_") || e.startsWith("text:"))).toEqual([
    "turn_started",
    `text:${INTERRUPTED_TEXT.trimStart()}`,
    "turn_completed",
    "turn_started",
    `text:${INTERRUPTED_TEXT.trimStart()}`,
    "turn_completed",
    "turn_started",
    "text:PAPAYA",
    "turn_completed",
  ])
  // The command each interrupt stopped shows as rejected, and no turn shows a failure.
  const tools = events.flatMap((e) => (e.type === "part" && e.part.type === "tool" ? [e.part] : []))
  expect(tools.filter((p) => p.state !== "running").map((p) => p.state)).toEqual(["error", "error"])
  expect(events.some((e) => e.type === "message" && e.message.parts.some((p) => p.type === "error"))).toBe(false)
})

test("2.1.330's thinking, its refusals with nobody to ask and its thinking-token counts read without a failure", () => {
  const { t, events } = translator()
  for (const msg of run("e1")) t.line(msg)
  expect(t.turn).toBeNull()
  const kinds = brief(events)
  expect(kinds.slice(0, 2)).toEqual(["model:claude-sonnet-5-5", "turn_started"])
  expect(kinds.at(-1)).toBe("turn_completed")
  // Thinking isn't shown; each call is, with its result.
  const tools = events.flatMap((e) => (e.type === "part" && e.part.type === "tool" ? [e.part] : []))
  const calls = new Set(tools.map((p) => p.call_id))
  expect(calls.size).toBe(7)
  expect(tools.filter((p) => p.state === "running")).toHaveLength(7)
  expect(events.some((e) => e.type === "message" && e.message.parts.some((p) => p.type === "error"))).toBe(false)
})

// Upstream's verbosity and grouping tests, ported to an assistant message's parts: no thoughts, instruction loads or
// code-mode scripts here, and a run never crosses a message.
import { expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencorp/protocol"
import { activitySummary, busyLabel, summarizeActivity } from "../../../src/routes/session/activity-summary"
import { groupRefs, partitionPending, partPath, type SessionRow } from "../../../src/routes/session/grouping/session"
import { reduceMessageRows } from "../../../src/routes/session/rows"
import { toolName } from "../../../src/routes/session"

const AT = "2026-11-23T10:00:00.000Z"
const tool = (id: string, name: string, state: ToolPart["state"] = "completed"): ToolPart => ({
  id,
  type: "tool",
  call_id: id,
  tool: name,
  state,
  input: {},
})
const text = (id: string, value: string): Part => ({ id, type: "text", text: value })
const assistant = (id: string, parts: Part[]): Message => ({
  id,
  session_id: "S",
  role: "assistant",
  created_at: AT,
  parts,
})
// The tests name each tool by the upstream tool it stands for.
const reduce = (message: Message, verbosity: "low" | "medium" | "high", pending = new Set<string>()) =>
  reduceMessageRows(message, verbosity, (part) => part.tool, pending)
const shape = (rows: SessionRow[]) => rows.map((row) => (row.type === "group" ? `${row.kind}:${row.size}` : row.type))
const item = (name: string, state: ToolPart["state"] = "completed") => ({ name, state })

test("exploration groups at every level; other tools stand alone", () => {
  for (const verbosity of ["medium", "high"] as const) {
    expect(partPath({ type: "tool", name: "read" }, verbosity)).toEqual(["exploration"])
    expect(partPath({ type: "tool", name: "list" }, verbosity)).toEqual(["exploration"])
    expect(partPath({ type: "tool", name: "search" }, verbosity)).toEqual(["exploration"])
    expect(partPath({ type: "tool", name: "shell" }, verbosity)).toEqual([])
  }
})

test("low wraps tools in activity; text, files and errors break it", () => {
  expect(partPath({ type: "tool", name: "read" }, "low")).toEqual(["activity", "exploration"])
  expect(partPath({ type: "tool", name: "shell" }, "low")).toEqual(["activity"])
  expect(partPath({ type: "tool", name: "Codex" }, "low")).toEqual(["activity"])
  expect(partPath({ type: "text" }, "low")).toEqual([])
  expect(partPath({ type: "file" }, "low")).toEqual([])
  expect(partPath({ type: "error" }, "low")).toEqual([])
})

test("low hydration nests subgroups inside one activity group per run", () => {
  const rows = reduce(
    assistant("a", [
      tool("r1", "read"),
      tool("g1", "search"),
      tool("sh", "shell"),
      tool("r2", "read"),
      text("t", "Done"),
      tool("sh2", "shell", "running"),
    ]),
    "low",
  )
  expect(shape(rows)).toEqual(["activity:4", "part", "activity:1"])
  const activity = rows[0]
  if (activity.type !== "group") throw new Error("Expected activity")
  expect(activity.children.map((child) => (child.type === "group" ? child.kind : child.entry.type))).toEqual([
    "exploration",
    "part",
    "exploration",
  ])
  expect(activity.completed).toBe(true)
  expect(rows[2].type === "group" && rows[2].completed).toBe(false)
})

test("medium hydration groups only reads and searches", () => {
  const rows = reduce(assistant("a", [tool("r1", "read"), tool("l1", "list"), tool("sh", "shell"), tool("r2", "read")]), "medium")
  expect(shape(rows)).toEqual(["exploration:2", "part", "exploration:1"])
})

test("blank text draws nothing and breaks no run", () => {
  expect(shape(reduce(assistant("a", [tool("s1", "shell"), text("t", " \n"), tool("s2", "shell")]), "low"))).toEqual([
    "activity:2",
  ])
})

test("permission-blocked tools inside an activity group are tracked as pending without reordering", () => {
  const rows = reduce(assistant("a", [tool("r1", "read"), tool("sh", "shell", "running"), tool("r2", "read")]), "low")
  partitionPending(rows, new Set(["sh"]))
  const activity = rows[0]
  if (activity.type !== "group" || activity.kind !== "activity") throw new Error("Expected activity")
  expect(activity.pending).toEqual([{ messageID: "a", partID: "sh" }])
  expect(groupRefs(activity).map((ref) => ref.partID)).toEqual(["r1", "r2"])
  expect(groupRefs(activity, true).map((ref) => ref.partID)).toEqual(["r1", "sh", "r2"])
})

test("a blocked read moves to the end of its exploration group, and back once its card closes", () => {
  const rows = reduce(assistant("a", [tool("r1", "read", "running"), tool("r2", "read")]), "medium", new Set(["r1"]))
  const group = rows[0]
  if (group.type !== "group" || group.kind !== "exploration") throw new Error("Expected exploration")
  expect(groupRefs(group).map((ref) => ref.partID)).toEqual(["r2"])
  expect(group.pending).toEqual([{ messageID: "a", partID: "r1" }])
  expect(groupRefs(group, true).map((ref) => ref.partID)).toEqual(["r2", "r1"])
  partitionPending(rows, new Set())
  expect(group.pending).toEqual([])
})

test("activity summary counts finished work by category", () => {
  const items = [
    item("shell"),
    item("shell"),
    item("edit"),
    item("patch"),
    item("write"),
    item("read"),
    item("search"),
    item("Codex"),
  ]
  expect(activitySummary(items)).toEqual({ label: "2 commands, 3 edits, 1 read, 2 tools", active: false })
})

test("running work is active but not counted, and failed or interrupted tools are counted", () => {
  const summary = activitySummary([
    item("read", "running"),
    item("shell", "pending"),
    item("read"),
    item("crm_quote", "error"),
    item("shell", "interrupted"),
  ])
  expect(summary).toEqual({ label: "1 command, 1 read, 1 tool", active: true })
})

test("questions stand alone at every level and end an activity run", () => {
  for (const verbosity of ["low", "medium", "high"] as const)
    expect(partPath({ type: "tool", name: "question" }, verbosity)).toEqual([])
  const rows = reduce(assistant("a", [tool("r1", "read"), tool("q", "question", "running"), tool("r2", "read")]), "low")
  expect(rows.map((row) => (row.type === "group" ? row.kind : row.type))).toEqual(["activity", "part", "activity"])
})

test("until something finishes, the label is the first running item's status", () => {
  const message = assistant("a", [tool("e1", "edit", "running"), tool("s1", "shell", "running")])
  const activity = reduce(message, "low")[0]
  if (activity.type !== "group") throw new Error("Expected activity")
  const resolve = (ref: { partID: string }) => {
    const part = message.parts.find((p) => p.id === ref.partID)
    return part?.type === "tool" ? item(part.tool, part.state) : undefined
  }
  expect(summarizeActivity(activity, resolve, [])).toEqual({ label: "Running edit…", active: true })
})

test("a tool waiting on a card is left out of its summary", () => {
  const message = assistant("a", [tool("s1", "shell"), tool("s2", "shell", "running")])
  const activity = reduce(message, "low", new Set(["s2"]))[0]
  if (activity.type !== "group") throw new Error("Expected activity")
  const resolve = (ref: { partID: string }) => {
    const part = message.parts.find((p) => p.id === ref.partID)
    return part?.type === "tool" ? item(part.tool, part.state) : undefined
  }
  expect(summarizeActivity(activity, resolve, activity.pending)).toEqual({ label: "1 command", active: false })
})

test("busy labels depend only on the tool and whether it is still being prepared", () => {
  expect(busyLabel(item("shell", "pending"))).toBe("Preparing command…")
  expect(busyLabel(item("shell", "running"))).toBe("Running command…")
  expect(busyLabel(item("read", "running"))).toBe("Running read…")
  expect(busyLabel(item("Codex", "running"))).toBe("Running Codex…")
})

test("each office tool stands for the upstream tool of its view", () => {
  const names = (tool: string, input: Record<string, unknown> = {}) =>
    toolName({ id: "p", type: "tool", call_id: "c", tool, state: "completed", input })
  expect(names("workspace_shell")).toBe("shell")
  expect(names("terminal_run")).toBe("shell")
  expect(names("terminal_type")).toBe("shell")
  expect(names("terminal_read")).toBe("shell")
  expect(names("codex.command")).toBe("shell")
  expect(names("workspace_read_file")).toBe("read")
  expect(names("claude.Read")).toBe("read")
  expect(names("workspace_list")).toBe("list")
  expect(names("claude.Grep")).toBe("search")
  expect(names("workspace_write_file")).toBe("write")
  expect(names("edit_file")).toBe("edit")
  expect(names("codex.file_change")).toBe("patch")
  expect(names("ask_user")).toBe("question")
  expect(names("codex_start")).toBe("Codex")
  expect(names("claude_send")).toBe("Claude Code")
  expect(names("codex.mcp_tool_call", { server: "docs", tool: "search" })).toBe("docs/search")
  expect(names("crm_quote")).toBe("crm_quote")
})

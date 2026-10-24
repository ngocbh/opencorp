/** Codex items as transcript parts, and server requests as cards with their replies. */
import fs from "node:fs"
import { Ajv } from "ajv"
import { expect, test } from "bun:test"
import type { Message, Part } from "@opencorp/protocol"
import type { HarnessEvent } from "../../src/harness/adapter.ts"
import { changeCounts, COMMAND, FILE_CHANGE, MCP_TOOL, OUTPUT_CUT, OUTPUT_MAX_CHARS, REFUSED, relative, SERVED,
  Translator } from "../../src/harness/translate.ts"
import { agentMessage, agentMessageDelta, command, commandStarted, error, fileChange, fill }
  from "../../src/testing/fake_codex.ts"

const FIXTURES = new URL("../fixtures/codex/", import.meta.url)
/** The recorded sessions' names, without `.jsonl`, sorted. */
const RECORDED = fs.readdirSync(new URL("sessions/", FIXTURES)).filter((name) => name.endsWith(".jsonl"))
  .map((name) => name.slice(0, -".jsonl".length)).sort()

// Python's Draft7Validator checks no `format`.
const ajv = new Ajv({ strict: false, validateFormats: false })

/** A JSON object from the wire: `any`, since the assertions read whatever Codex sent. */
type Msg = Record<string, any>

const SID = "01JSESS10N000000000000000S"

/** A translator for session `SID` in "/w", and the events it emits. */
function tr(log?: (line: string) => void): { t: Translator; events: HarnessEvent[] } {
  const events: HarnessEvent[] = []
  return { t: new Translator(SID, "/w", (e) => events.push(e), log), events }
}

/** Hands each notification step to the translator, as the session would. */
function feed(t: Translator, steps: Msg[], turn = "turn_1"): void {
  for (const step of steps) {
    if ("notify" in step) t.notification(step.notify, fill(step.params, turn, "/w", "thr_1"))
  }
}

/** The messages the live events make, as the store keeps them: a part replaces the one with its id. */
function fold(events: HarnessEvent[]): Message[] {
  const messages: Message[] = []
  const find = (id: string) => messages.find((m) => m.id === id)!
  for (const e of events) {
    if (e.type === "message") {
      messages.push(structuredClone(e.message))
    } else if (e.type === "part") {
      const list = find(e.messageId).parts
      const at = list.findIndex((p) => p.id === e.part.id)
      if (at === -1) list.push(structuredClone(e.part))
      else list[at] = structuredClone(e.part)
    } else if (e.type === "delta") {
      const part = find(e.messageId).parts.find((p) => p.id === e.partId)!
      if (part.type === "text") part.text += e.text
    }
  }
  return messages
}

function parts(events: HarnessEvent[]): Part[] {
  return fold(events).flatMap((m) => m.parts)
}

/** Each message's role and its parts as text, or [tool, state]. */
function shape(events: HarnessEvent[]): [string, unknown[]][] {
  return fold(events).map((m) => [m.role, m.parts.map((p) =>
    p.type === "text" ? p.text : p.type === "tool" ? [p.tool, p.state] : p.type)])
}

function texts(events: HarnessEvent[]): string[] {
  return parts(events).flatMap((p) => p.type === "text" ? [p.text] : [])
}

function errors(events: HarnessEvent[]): string[] {
  return parts(events).flatMap((p) => p.type === "error" ? [p.message] : [])
}

// --- text, deltas, reasoning, turn ends and errors ---------------------------------------

test("an agent message streams into one text part", () => {
  const { t, events } = tr()
  feed(t, agentMessage("m1", "Hello there"))
  t.turnCompleted("turn_1", "completed", null)
  const messages = fold(events)
  expect(messages.length).toBe(1)
  expect(messages[0]!.role).toBe("assistant")
  expect(messages[0]!.author).toBe(null)
  expect(texts(events)).toEqual(["Hello there"])
})

test("a message completed without deltas still shows", () => {
  const { t, events } = tr()
  t.notification("item/completed", { turnId: "turn_1", item: { type: "agentMessage", id: "m1", text: "Hi" } })
  t.turnCompleted("turn_1", "completed", null)
  expect(texts(events)).toEqual(["Hi"])
})

test("a completed message adds only what the deltas left out", () => {
  const logged: string[] = []
  const { t, events } = tr((line) => logged.push(line))
  feed(t, [agentMessageDelta("m1", "Hello w")])
  t.notification("item/completed", { turnId: "turn_1", item: { type: "agentMessage", id: "m1",
    text: "Hello world, done." } })
  feed(t, [agentMessageDelta("m2", "Hello wrld")])  // deltas that don't lead to the final text
  t.notification("item/completed", { turnId: "turn_1", item: { type: "agentMessage", id: "m2",
    text: "Hello world, done." } })
  t.turnCompleted("turn_1", "completed", null)
  expect(texts(events)).toEqual(["Hello world, done.", "Hello wrld"])
  expect(logged).toEqual(["codex: message m2 completed with text its deltas didn't lead to"])
})

test("reasoning summaries show as thinking text", () => {
  const { t, events } = tr()
  t.notification("item/completed", { turnId: "turn_1", item: { type: "reasoning", id: "r1",
    summary: ["Check the tests first."] } })
  t.turnCompleted("turn_1", "completed", null)
  expect(texts(events)).toEqual(["(thinking) Check the tests first."])
})

test("a reasoning item with an empty summary writes nothing", () => {
  const { t, events } = tr()
  t.notification("item/completed", { turnId: "turn_1", item: { type: "reasoning", id: "r1", summary: [] } })
  t.turnCompleted("turn_1", "completed", null)
  expect(events).toEqual([])
})

test("an interrupted turn ends with the marker even with no items", () => {
  const { t, events } = tr()
  t.turnCompleted("turn_1", "interrupted", null)
  expect(texts(events)).toEqual(["[interrupted]"])
})

test("a failed turn adds its error", () => {
  const { t, events } = tr()
  feed(t, agentMessage("m1", "Trying"))
  t.turnCompleted("turn_1", "failed", { message: "usage limit reached" })
  expect(errors(events)).toEqual(["Codex's turn failed: usage limit reached"])
  expect(fold(events).at(-1)!.author).toBe(null)
})

test("errors codex retries are not shown and a failure it already said shows once", () => {
  const { t, events } = tr()
  feed(t, [error("rate limited, retrying", { willRetry: true }), error("stream broke", { willRetry: false })])
  t.turnCompleted("turn_1", "failed", { message: "stream broke" })
  feed(t, [error("disk full", { willRetry: false })], "turn_2")
  t.turnCompleted("turn_2", "failed", { message: "usage limit reached" })
  expect(errors(events)).toEqual(["Codex: stream broke", "Codex: disk full", "Codex's turn failed: usage limit reached"])
})

test("items share one message and one that starts after a steer opens the next", () => {
  const { t, events } = tr()
  feed(t, agentMessage("m1", "One."))
  t.user("and also", "ngocbh")
  feed(t, agentMessage("m2", "Two."))
  t.turnCompleted("turn_1", "completed", null)
  expect(shape(events)).toEqual([["assistant", ["One."]], ["user", ["and also"]], ["assistant", ["Two."]]])
  expect(fold(events)[1]!.author).toBe("ngocbh")
})

test("a steer mid stream leaves the streaming text in its message", () => {
  const { t, events } = tr()
  const steps = agentMessage("m1", "Hello there")
  feed(t, steps.slice(0, 2))  // started, and the first delta
  t.user("stop at 5", "ngocbh")
  feed(t, [...steps.slice(2), ...agentMessage("m2", "Stopping at 5.")])
  t.turnCompleted("turn_1", "completed", null)
  expect(shape(events)).toEqual([["assistant", ["Hello there"]], ["user", ["stop at 5"]],
    ["assistant", ["Stopping at 5."]]])
  const [first, , third] = fold(events)
  for (const e of events) {
    if (e.type === "delta") expect(e.messageId).toBe(e.partId === first!.parts[0]!.id ? first!.id : third!.id)
  }
})

test("a steer mid stream then an interrupt keeps the text whole and marks after the steer", () => {
  const { t, events } = tr()
  const steps = agentMessage("m1", "Hello there")
  feed(t, steps.slice(0, 2))
  t.user("stop", "ngocbh")
  feed(t, [steps[2]!])
  t.turnCompleted("turn_1", "interrupted", null)
  expect(shape(events)).toEqual([["assistant", ["Hello there"]], ["user", ["stop"]], ["assistant", ["[interrupted]"]]])
})

test("an error mid turn puts what follows below it", () => {
  const { t, events } = tr()
  feed(t, [...agentMessage("m1", "One."), error("hiccup", { willRetry: false }), ...agentMessage("m2", "Two.")])
  t.turnCompleted("turn_1", "completed", null)
  expect(shape(events)).toEqual([["assistant", ["One."]], ["assistant", ["error"]], ["assistant", ["Two."]]])
})

test("a long session keeps nothing from its finished turns", () => {
  const { t, events } = tr()
  for (let n = 1; n < 6; n++) {
    const turn = `turn_${n}`
    feed(t, [...command("c", "true"), commandStarted(`c${n}`, "sleep 9"), ...agentMessage(`m${n}`, "Hi").slice(0, 2),
      error("hiccup", { willRetry: false })], turn)
    t.turnCompleted(turn, n % 2 ? "interrupted" : "failed", { message: "hiccup" })
    feed(t, [error("late", { willRetry: false })], turn)  // after its turn ended: nothing to keep
    t.turnCompleted(turn, "interrupted", null)  // ended twice (a turn's end, then a dead app-server)
  }
  const kept = [t["items"], t["streamed"], t["nodes"], t["segments"], t["shown"], t["afterError"]]
  expect(kept.map((x) => x.size)).toEqual([0, 0, 0, 0, 0, 0])
  const live = t["live"]
  expect([live["messages"], live["texts"], live["tools"], live["steered"], live["tails"]].map((x) => x.size))
    .toEqual([0, 0, 0, 0, 0])
  expect(errors(events)).toEqual(Array(5).fill("Codex: hiccup"))
  // One marker per interrupted turn, below its error; ending a turn again adds none.
  expect(texts(events).filter((x) => x === "[interrupted]").length).toBe(3)
})

test("a part event is not changed by later deltas", () => {
  const { t, events } = tr()
  feed(t, agentMessage("m1", "Hello there"))
  t.turnCompleted("turn_1", "completed", null)
  const first = events.find((e) => e.type === "part")!
  expect(first.type === "part" && first.part.type === "text" && first.part.text).toBe("Hello")
})

// --- tool items --------------------------------------------------------------------------

test("a command is a tool part with its exit code and capped output", () => {
  const { t, events } = tr()
  feed(t, command("c1", "pytest -q", { output: "x".repeat(OUTPUT_MAX_CHARS + 10), exitCode: 1 }))
  t.turnCompleted("turn_1", "completed", null)
  const [part, ...rest] = parts(events)
  expect(rest).toEqual([])
  if (part?.type !== "tool") throw new Error("not a tool part")
  expect([part.tool, part.state, part.input.command, part.input.exit_code])
    .toEqual([COMMAND, "completed", "pytest -q", 1])
  expect(typeof part.output === "string" && part.output.endsWith(OUTPUT_CUT)).toBe(true)
  expect((part.output as string).length).toBe(OUTPUT_MAX_CHARS + OUTPUT_CUT.length)
})

test("a file change keeps paths kinds and diffs", () => {
  const { t, events } = tr()
  feed(t, fileChange("f1", "notes.md", "hi\n"))
  t.turnCompleted("turn_1", "completed", null)
  const [part, ...rest] = parts(events)
  expect(rest).toEqual([])
  if (part?.type !== "tool") throw new Error("not a tool part")
  expect(part.tool).toBe(FILE_CHANGE)
  expect(part.input.changes).toEqual([{ path: "notes.md", kind: "add", diff: "hi\n" }])
})

test("a file change under the cwd is named relative to it", () => {
  // Codex sends absolute paths; the owner reads them as the project's.
  const { t, events } = tr()
  feed(t, [...fileChange("f1", "{cwd}/docs/notes.md", "hi\n"), ...fileChange("f2", "/etc/hosts", "x\n")])
  t.turnCompleted("turn_1", "completed", null)
  expect(parts(events).map((p) => p.type === "tool" && (p.input.changes as Msg[])[0]!.path))
    .toEqual(["docs/notes.md", "/etc/hosts"])
  expect(relative("/w", "/w")).toBe("/w")
  expect(relative("/wx/a", "/w")).toBe("/wx/a")
  expect(relative("a.py", "/w")).toBe("a.py")
})

test.each([
  ["add", "one\ntwo\n", [2, 0]],  // Codex sends a new file's content
  ["delete", "one\n+two\n-three\n", [0, 3]],  // and a deleted file's content
  ["update", "@@ -1,2 +1,2 @@\n-z\n+x\n+y\n keep\n", [2, 1]],
  ["update", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: b.py", [1, 1]],
  ["update", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n--- x\n+++ y\n", [1, 1]],  // headers, then lines "-- x" and "++ y"
] as [string, string, [number, number]][])("a file changes lines are counted by its kind [%s]", (kind, diff, counts) => {
  expect(changeCounts(kind, diff)).toEqual(counts)
})

test("a declined command is an error part and a running one is interrupted at turn end", () => {
  const { t, events } = tr()
  feed(t, [command("c1", "rm -rf build", { status: "declined", exitCode: null })[1]!])
  feed(t, [commandStarted("c2", "sleep 9")])
  t.turnCompleted("turn_1", "interrupted", null)
  const states = Object.fromEntries(parts(events).flatMap((p) =>
    p.type === "tool" ? [[p.input.command, [p.state, p.error]]] : []))
  expect(states).toEqual({ "rm -rf build": ["error", "declined"], "sleep 9": ["interrupted", null] })
})

test("an mcp call names server and tool", () => {
  const { t, events } = tr()
  t.notification("item/completed", { turnId: "turn_1", item: {
    type: "mcpToolCall", id: "x1", server: "docs", tool: "search", status: "completed",
    arguments: { q: "launchd" }, result: { content: [{ type: "text", text: "3 hits" }] }, error: null } })
  t.turnCompleted("turn_1", "completed", null)
  const [part, ...rest] = parts(events)
  expect(rest).toEqual([])
  if (part?.type !== "tool") throw new Error("not a tool part")
  expect(part.tool).toBe(MCP_TOOL)
  expect(part.input).toEqual({ server: "docs", tool: "search", arguments: { q: "launchd" } })
  expect(part.output).toContain("3 hits")
})

test("a steer while a command runs completes its part in place", () => {
  const { t, events } = tr()
  feed(t, [commandStarted("c1", "sleep 3")])
  t.user("also b", "ngocbh")
  feed(t, [command("c1", "sleep 3")[1]!, ...agentMessage("m1", "Slept.")])
  t.turnCompleted("turn_1", "completed", null)
  expect(shape(events)).toEqual([["assistant", [[COMMAND, "completed"]]], ["user", ["also b"]],
    ["assistant", ["Slept."]]])
})

test("two steers around a running command keep it in its message", () => {
  const { t, events } = tr()
  feed(t, [commandStarted("c1", "sleep 3")])
  t.user("a", "ngocbh")
  feed(t, agentMessage("m1", "One."))
  t.user("b", "ngocbh")
  feed(t, [command("c1", "sleep 3")[1]!, ...agentMessage("m2", "Two.")])
  t.turnCompleted("turn_1", "completed", null)
  expect(shape(events)).toEqual([["assistant", [[COMMAND, "completed"]]], ["user", ["a"]], ["assistant", ["One."]],
    ["user", ["b"]], ["assistant", ["Two."]]])
})

test("a running command from before a steer is interrupted with the turn", () => {
  const { t, events } = tr()
  feed(t, [commandStarted("c1", "sleep 30")])
  t.user("never mind", "ngocbh")
  t.turnCompleted("turn_1", "interrupted", null)
  expect(shape(events)).toEqual([["assistant", [[COMMAND, "interrupted"]]], ["user", ["never mind"]],
    ["assistant", ["[interrupted]"]]])
})

// --- the pinned schema -------------------------------------------------------------------

test("every server request in the pinned schema is served or refused", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("schema/ServerRequest.json", FIXTURES), "utf8"))
  const methods = new Set<string>(schema.oneOf.flatMap((branch: Msg) => branch.properties.method.enum))
  const known = new Set([...SERVED, ...REFUSED])
  const added = [...methods].filter((m) => !known.has(m)).sort()
  const gone = [...known].filter((m) => !methods.has(m)).sort()
  expect([added, gone], `new: ${JSON.stringify(added)}; gone: ${JSON.stringify(gone)}`).toEqual([[], []])
})

// --- the recorded real sessions ----------------------------------------------------------

test("the recordings include the core scenarios", () => {
  const core = ["plain", "command-approve", "command-decline", "file-change", "interrupt", "steer", "resume"]
  for (const scenario of core) expect(RECORDED.includes(scenario), scenario).toBe(true)
})

test.each(RECORDED)("each recorded agent messages deltas add up to its completed text [%s]", (name) => {
  // Only agent messages: real Codex can leave a command's first output line out of its deltas (steer.jsonl).
  const deltas = new Map<string, string>()
  const texts = new Map<string, string>()
  const lines = fs.readFileSync(new URL(`sessions/${name}.jsonl`, FIXTURES), "utf8").split("\n").filter((line) => line)
  for (const line of lines) {
    const msg: Msg = JSON.parse(line).msg
    if (msg.method === "item/agentMessage/delta") {
      deltas.set(msg.params.itemId, (deltas.get(msg.params.itemId) ?? "") + msg.params.delta)
    } else if (msg.method === "item/completed" && msg.params.item.type === "agentMessage") {
      texts.set(msg.params.item.id, msg.params.item.text)
    }
  }
  for (const [id, text] of deltas) {
    expect(texts.has(id), id).toBe(true)
    expect(text).toBe(texts.get(id)!)
  }
})

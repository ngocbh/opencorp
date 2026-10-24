/** Codex items as transcript parts, and server requests as cards with their replies. */
import fs from "node:fs"
import { Ajv } from "ajv"
import { expect, test } from "bun:test"
import type { Message, Part } from "@opencorp/protocol"
import type { HarnessEvent } from "../../src/harness/adapter.ts"
import { changeCounts, REFUSED, SERVED, Translator } from "../../src/harness/translate.ts"
import { agentMessage, agentMessageDelta, error, fill } from "../../src/testing/fake_codex.ts"

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
  const deltas = events.flatMap((e) => e.type === "delta" ? [[e.partId, e.messageId]] : [])
  expect(new Set(deltas.filter(([p]) => p === first!.parts[0]!.id).map(([, m]) => m))).toEqual(new Set([first!.id]))
  expect(new Set(deltas.filter(([p]) => p === third!.parts[0]!.id).map(([, m]) => m))).toEqual(new Set([third!.id]))
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

test("a part event is not changed by later deltas", () => {
  const { t, events } = tr()
  feed(t, agentMessage("m1", "Hello there"))
  t.turnCompleted("turn_1", "completed", null)
  const first = events.find((e) => e.type === "part")!
  expect(first.type === "part" && first.part.type === "text" && first.part.text).toBe("Hello")
})

// --- file changes ------------------------------------------------------------------------

test.each([
  ["add", "one\ntwo\n", [2, 0]],  // Codex sends a new file's content
  ["delete", "one\n+two\n-three\n", [0, 3]],  // and a deleted file's content
  ["update", "@@ -1,2 +1,2 @@\n-z\n+x\n+y\n keep\n", [2, 1]],
  ["update", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: b.py", [1, 1]],
  ["update", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n--- x\n+++ y\n", [1, 1]],  // headers, then lines "-- x" and "++ y"
] as [string, string, [number, number]][])("a file changes lines are counted by its kind [%s]", (kind, diff, counts) => {
  expect(changeCounts(kind, diff)).toEqual(counts)
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

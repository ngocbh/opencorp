/** Codex items as transcript parts, and server requests as cards with their replies. */
import fs from "node:fs"
import { Ajv } from "ajv"
import { expect, test } from "bun:test"
import type { Message, Part } from "@opencorp/protocol"
import type { HarnessEvent } from "../../src/harness/adapter.ts"
import { changeCounts, COMMAND, FILE_CHANGE, type Issued, MCP_TOOL, OUTPUT_CUT, OUTPUT_MAX_CHARS, REFUSED, relative,
  REPLY_SCHEMAS, SERVED, Translator, Unserved } from "../../src/harness/translate.ts"
import { agentMessage, agentMessageDelta, command, commandApproval, commandStarted, error, fileChange,
  fileChangeApproval, fill, formElicitation, mcpApproval, mcpApprovalQuestion, networkApproval, permissionsApproval,
  question, urlElicitation, userInput } from "../../src/testing/fake_codex.ts"

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

/** The card for a request step, with its params filled in as the session would. */
function card(t: Translator, step: Msg, runId = "turn_1"): Issued {
  return t.card(step.request, fill(step.params, runId, "/w", "thr_1"), { runId, nodeId: String(step.id) })
}

/** A check of a reply against the pinned response schema of `method`. */
function replyCheck(method: string) {
  return ajv.compile(JSON.parse(fs.readFileSync(new URL(`schema/${REPLY_SCHEMAS[method]}.json`, FIXTURES), "utf8")))
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
  const deltas = events.flatMap((e) => e.type === "delta" ? [[e.partId, e.messageId] as const] : [])
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

test("a moved file keeps where it moved to on its part and card", () => {
  const { t, events } = tr()
  const steps = fileChange("f1", "{cwd}/a.py", "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: {cwd}/b.py", { kind: "update" })
  for (const step of steps) step.params.item.changes[0].kind.move_path = "{cwd}/b.py"
  feed(t, steps.slice(0, 1))
  expect(card(t, fileChangeApproval(2, "f1")).card.question).toContain("a.py → b.py (update, +1/-1)")
  feed(t, steps.slice(1))
  t.turnCompleted("turn_1", "completed", null)
  const part = parts(events)[0]!
  if (part.type !== "tool") throw new Error("not a tool part")
  const [change, ...rest] = part.input.changes as Msg[]
  expect(rest).toEqual([])
  expect([change!.path, change!.move_path, change!.kind]).toEqual(["a.py", "b.py", "update"])
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
  expect(part.output).toBe('[{"type": "text", "text": "3 hits"}]')
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

// --- approval cards ----------------------------------------------------------------------

test("a command approval offers the four decisions and replies with the picked one", () => {
  const { t } = tr()
  feed(t, [commandStarted("c1", "touch a")])
  const c = card(t, commandApproval(1, "c1", "touch a"))
  expect([c.card.kind, c.runId, c.nodeId, c.callId]).toEqual(["command", "turn_1", "1", "c1"])
  expect(c.card.options).toEqual(["Approve", "Approve for this session", "Deny so Codex continues", "Deny and stop"])
  expect(c.card.question).toContain("$ touch a")
  expect(c.reply("Approve for this session")).toEqual([{ decision: "acceptForSession" }, "acceptForSession"])
})

test("only offered decisions show and persistent ones never do", () => {
  const { t } = tr()
  const step = commandApproval(1, "c1", "curl x")
  step.params.availableDecisions = ["accept", { acceptWithExecpolicyAmendment: {} }, "cancel"]
  expect(card(t, step).card.options).toEqual(["Approve", "Deny and stop"])
})

test.each([
  ["add", "hi\nthere\n", "notes.md (add, +2/-0)"],
  ["delete", "a\nb\nc\n", "notes.md (delete, +0/-3)"],
  ["update", "@@ -1 +1,2 @@\n-z\n+x\n+y\n", "notes.md (update, +2/-1)"],
])("a file change card counts lines by kind [%s]", (kind, diff, says) => {
  const { t } = tr()
  feed(t, [fileChange("f1", "{cwd}/notes.md", diff, { kind })[0]!])  // an absolute path, as Codex sends
  const c = card(t, fileChangeApproval(2, "f1"))
  expect(c.card.kind).toBe("file_change")
  expect(c.card.question).toContain(says)
  expect(c.reply("Deny so Codex continues")).toEqual([{ decision: "decline" }, "decline"])
})

test("a file change card offers only the decisions codex lists", () => {
  const { t } = tr()
  feed(t, [fileChange("f1", "{cwd}/notes.md", "hi\n")[0]!])
  const step = fileChangeApproval(2, "f1")
  step.params.availableDecisions = ["accept", { acceptWithExecpolicyAmendment: {} }, "decline"]
  const c = card(t, step)
  expect(c.card.options).toEqual(["Approve", "Deny so Codex continues"])
  const check = replyCheck(step.request)
  for (const label of c.card.options) expect(check(c.reply(label)[0])).toBe(true)
  for (const label of ["Approve for this session", "Deny and stop", "toString"]) {
    expect(() => c.reply(label)).toThrow(new RangeError("the answer isn't one of the card's options"))
  }
  step.params.availableDecisions = []
  expect(card(t, step).card.options).toEqual([])
})

test("a command approval names the permissions it asks for", () => {
  const { t } = tr()
  const step = commandApproval(1, "c1", "make out")
  step.params.additionalPermissions = { network: { enabled: true },
    fileSystem: { write: ["/w/out"], read: null, entries: null } }
  expect(card(t, step).card.question.split("\n")).toEqual(["$ make out", "in /w",
    'and asks for {"network": {"enabled": true}, "fileSystem": {"write": ["/w/out"]}}'])
})

test("a command card whose permissions are all null names none", () => {
  const { t } = tr()
  const step = commandApproval(1, "c1", "make out")
  step.params.additionalPermissions = { network: null, fileSystem: { read: null, write: null } }
  expect(card(t, step).card.question).toBe("$ make out\nin /w")
})

test("input to a running command is titled as such", () => {
  const { t } = tr()
  const step = commandApproval(1, "c1", "python3")
  step.params.kind = "writeStdin"
  expect(card(t, step).card.title).toBe("Codex wants to send input to a running command")
  step.params.kind = "command"
  expect(card(t, step).card.title).toBe("Codex wants to run a command")
})

test("a network approval names the host", () => {
  // Codex sends a managed-network approval with no command or cwd, only networkApprovalContext.
  const { t } = tr()
  const c = card(t, networkApproval(7, "c2", "pypi.org"))
  expect([c.card.kind, c.card.title, c.card.question]).toEqual(["command", "Codex wants network access",
    "https to pypi.org"])
  expect(c.reply("Approve")).toEqual([{ decision: "accept" }, "accept"])
})

test("a permissions card grants what was asked for this turn or session or nothing", () => {
  const { t } = tr()
  const c = card(t, permissionsApproval(3, "p1"))
  expect(c.card.kind).toBe("permissions")
  expect(c.card.options).toEqual(["Approve for this turn", "Approve for this session", "Deny"])
  expect(c.reply("Approve for this turn")).toEqual([{ permissions: { network: { enabled: true } }, scope: "turn" },
    "turn"])
  expect(c.reply("Deny")).toEqual([{ permissions: {}, scope: "turn" }, "decline"])
})

// --- question, MCP and elicitation cards -------------------------------------------------

test("codex questions are pages with secret ones marked", () => {
  const { t } = tr()
  const step = userInput(4, "u1", [question("token", "Token", "Paste it", { secret: true }),
    question("env", "Env", "Where?", { options: ["prod", "dev"] })])
  const c = card(t, step)
  expect(c.card.kind).toBe("question")
  expect(c.card.questions?.map((p) => p.header)).toEqual(["Token", "Env"])
  expect(c.card.questions?.map((p) => p.secret)).toEqual([true, false])
  expect(c.card.answer_schema.map((f) => f.name)).toEqual(["Env"])  // no "other": only its options
  expect(c.reply({ Token: "s3cret", Env: "dev" })).toEqual([
    { answers: { token: { answers: ["s3cret"] }, env: { answers: ["dev"] } } }, "answer"])
})

test.each(["elicitation", "user_input"])("an mcp tool approval is one card in either wire form [%s]", (form) => {
  const { t } = tr()
  const step = form === "elicitation" ? mcpApproval(5, "docs", "search")
    : mcpApprovalQuestion(5, "u2", "docs", "search")
  const c = card(t, step)
  expect(c.card.kind).toBe("mcp_tool")
  expect(c.card.options).toEqual(["Allow", "Allow for this session", "Cancel"])
  if (form === "elicitation") {
    expect([c.card.title, c.callId]).toEqual(["Codex wants to use an MCP tool", "request-5"])
    expect(c.reply("Allow for this session")).toEqual([{ action: "accept", _meta: { persist: "session" } },
      "acceptForSession"])
    expect(c.reply("Cancel")).toEqual([{ action: "cancel" }, "cancel"])
  } else {
    expect(c.callId).toBe("u2")
    expect(c.reply("Allow")).toEqual([{ answers: { mcp_tool_call_approval_1: { answers: ["Allow"] } } }, "accept"])
  }
})

test("an mcp approval without a session choice offers two", () => {
  const { t } = tr()
  expect(card(t, mcpApproval(5, "docs", "search", { sessionOption: false })).card.options).toEqual(["Allow", "Cancel"])
})

test("other elicitations are cards too", () => {
  const { t } = tr()
  const url = { request: "mcpServer/elicitation/request", id: 6, params: {
    serverName: "gh", threadId: "{thread}", turnId: null, mode: "url", elicitationId: "e1",
    message: "Sign in to GitHub", url: "https://example.com/login" } }
  let c = card(t, url, "codex-123")
  expect(c.card.kind).toBe("elicitation")
  expect(c.card.question).toContain("https://example.com/login")
  expect(c.card.options).toEqual(["Done", "Decline", "Cancel"])
  expect(c.reply("Done")).toEqual([{ action: "accept" }, "accept"])
  const form = { request: "mcpServer/elicitation/request", id: 7, params: {
    serverName: "jira", threadId: "{thread}", turnId: "{turn}", mode: "form", message: "Ticket details",
    requestedSchema: { type: "object", properties: {
      priority: { type: "string", enum: ["low", "high"] }, points: { type: "integer" },
      urgent: { type: "boolean" } } } } }
  c = card(t, form)
  expect(c.card.questions?.map((p) => p.header)).toEqual(["priority", "points", "urgent"])
  // A number field is typed, so the answer check converts "3" or refuses "x" before the store or Codex sees it.
  expect(c.card.answer_schema.map((f) => [f.name, f.type, f.enum])).toEqual([
    ["priority", "str", ["low", "high"]], ["points", "int", null], ["urgent", "str", ["Yes", "No"]]])
  expect(c.reply({ priority: "high", points: 3, urgent: "Yes" })).toEqual([
    { action: "accept", content: { priority: "high", points: 3, urgent: true } }, "accept"])
})

test("a form with no fields is an accept decline or cancel card", () => {
  const { t } = tr()
  const c = card(t, formElicitation(7, "jira", "Go on?", {}))
  expect([c.card.kind, c.card.question, c.card.questions]).toEqual(["elicitation", "jira: Go on?", null])
  expect(c.card.options).toEqual(["Accept", "Decline", "Cancel"])
  expect(c.reply("Decline")).toEqual([{ action: "decline" }, "decline"])
})

test.each([
  // more fields than a card has pages
  ["five fields", Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`f${i}`, { type: "string" }]))],
  // a list, which a page can't give
  ["a list", { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } }],
  // titled choices, whose values differ
  ["titled choices", { env: { type: "string", oneOf: [{ const: "p", title: "Prod" }] } }],
])("a form a card cannot answer in full is unserved [%s]", (_name, properties) => {
  const { t } = tr()
  expect(() => card(t, formElicitation(7, "jira", "Ticket", properties))).toThrow(Unserved)
})

test("more than four questions or an unknown method is unserved", () => {
  const { t } = tr()
  const many = userInput(8, "u3", [0, 1, 2, 3, 4].map((i) => question(`q${i}`, `Q${i}`, "?")))
  expect(() => card(t, many)).toThrow(Unserved)
  expect(() => t.card("item/tool/call", {}, { runId: "turn_1", nodeId: "9" })).toThrow(Unserved)
})

test.each([
  // A device verification wants a proof in its reply, which no answer on a card makes.
  ["openai/userVerification", { title: "Verify", description: "Confirm it's you", challenge: "c1" }],
  // OpenAI's own forms have a schema the pinned protocol leaves open, so a card can't type their reply.
  ["openai/form", { message: "Pick", requestedSchema: { anything: true } }],
  ["openaiForm", { message: "Pick", requestedSchema: { anything: true } }],
])("an elicitation in a mode a card cannot answer is unserved [%s]", (mode, rest) => {
  const { t } = tr()
  const params = { serverName: "gh", threadId: "thr_1", turnId: null, mode, ...rest }
  const ask = () => t.card("mcpServer/elicitation/request", params, { runId: "codex-1", nodeId: "10" })
  expect(ask).toThrow(Unserved)
  expect(ask).toThrow(`in mode ${mode}`)
})

test("an answer that isnt an offered option makes no reply", () => {
  const { t } = tr()
  // A fixed text, so it holds neither the answer nor a key.
  const refused = (c: Issued, answer: unknown) => {
    let thrown: unknown
    try {
      c.reply(answer)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as Error).message).toBe("the answer isn't one of the card's options")
  }
  const option = card(t, commandApproval(1, "c1", "touch a"))
  for (const answer of ["Always allow", "toString", null, 1, ["Approve"]]) refused(option, answer)
  const page = card(t, userInput(4, "u1", [question("token", "Token", "Paste it", { secret: true })]))
  for (const answer of [{ Tokn: "x" }, { constructor: "x" }, "dev", { Token: 1 }, { Token: { x: 1 } }]) {
    refused(page, answer)
  }
  const env = card(t, userInput(5, "u2", [question("env", "Env", "Where?", { options: ["prod", "dev"] })]))
  for (const answer of [{ Env: "staging" }, { Env: ["prod", "staging"] }, { Env: [] }, new Date(), new Map()]) {
    refused(env, answer)
  }
  const form = card(t, formElicitation(9, "jira", "Ticket", { points: { type: "integer" },
    priority: { type: "string", enum: ["low", "high"] }, urgent: { type: "boolean" }, summary: { type: "string" } }))
  for (const answer of [{ constructor: "x" }, { priority: "zzz" }, { urgent: "maybe" }, { summary: { x: 1 } },
    new Date(), new Map()]) {
    refused(form, answer)
  }
})

test("a typed form answer that isnt a number makes no reply", () => {
  const { t } = tr()
  const form = card(t, formElicitation(9, "jira", "Ticket", { points: { type: "integer" },
    weight: { type: "number" } }))
  const refused = (answer: Record<string, unknown>) => {
    let thrown: unknown
    try {
      form.reply(answer)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as Error).message).toBe("the answer isn't a number")
  }
  for (const points of ["x", "1.5", "12345678901234567890", "Infinity", "0x10", ""]) refused({ points })
  for (const weight of ["x", "Infinity", "0x10", ""]) refused({ weight })
  expect(form.reply({ points: " 3 ", weight: "2.5" })).toEqual([
    { action: "accept", content: { points: 3, weight: 2.5 } }, "accept"])
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

test("every reply a card makes matches codexs response schema", () => {
  const { t } = tr()
  feed(t, [commandStarted("c1", "touch a"), fileChange("f1", "a.md", "a\n")[0]!])
  const steps = [commandApproval(1, "c1", "touch a"), fileChangeApproval(2, "f1"), permissionsApproval(3, "p1"),
    userInput(4, "u1", [question("env", "Env", "Where?", { options: ["prod", "dev"] })]),
    mcpApproval(5, "docs", "search"), mcpApprovalQuestion(6, "u2", "docs", "search"),
    networkApproval(7, "c2", "example.com"), urlElicitation(8, "gh", "Sign in", "https://e.com/l"),
    formElicitation(9, "jira", "Ticket", { points: { type: "integer" }, urgent: { type: "boolean" } })]
  // A form's answer as the answer check returns it.
  const answers: Record<number, unknown[]> = { 4: [{ Env: "dev" }], 9: [{ points: 3, urgent: "No" }] }
  for (const step of steps) {
    const c = card(t, step)
    const check = replyCheck(step.request)
    for (const answer of answers[step.id] ?? c.card.options) {
      expect(check(c.reply(answer)[0]), `${step.request} ${JSON.stringify(check.errors)}`).toBe(true)
    }
  }
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

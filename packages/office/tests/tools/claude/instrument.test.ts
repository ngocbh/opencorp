/** The Claude Code instrument: the harness instrument in Claude Code's words, its sessions `claude 1` and on, its
 *  listing and record of kind `claude`, and each tool call in the trace; on a scripted host, so no Claude Code runs.
 *  What every harness instrument does (waits, Esc, cut-off calls, pages) is the Codex instrument's tests'. */
import fs from "node:fs"
import path from "node:path"
import type { Message, Part } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import {
  CLAUDE,
  ClaudeInstrument,
  markClaudeInterrupted,
  readClaudeRecord,
} from "../../../src/tools/claude/instrument.ts"
import type {
  HarnessHost,
  HarnessListing,
  HarnessThread,
  ThreadEvents,
  TurnEnded,
} from "../../../src/tools/harness/instrument.ts"
import { MAX_LIVE } from "../../../src/tools/harness/instrument.ts"
import { Translator } from "../../../src/tools/claude/translate.ts"
import { tempDir, waitFor } from "../../helpers.ts"

const CHAT = "01JA1H00000000000000000CHT"
let ids = 0
const id = () => `m${++ids}`
const at = () => new Date().toISOString()

/** A Claude Code session as the host's stand-in runs it: each message starts a turn, and the test answers it. */
class Session implements HarnessThread {
  readonly sent: string[] = []
  busy = false

  constructor(
    readonly id: string,
    readonly events: ThreadEvents,
  ) {}

  async send(text: string): Promise<unknown> {
    this.sent.push(text)
    const parts: Part[] = [{ id: id(), type: "text", text }]
    this.events.event({ type: "message", message: { id: id(), session_id: this.id, role: "user", author: "minh", parts, created_at: at() } })
    this.busy = true
    this.events.state("busy")
    return "turn"
  }

  /** Claude Code answers with `parts` and its turn ends. */
  answer(parts: Part[]): void {
    const message: Message = { id: id(), session_id: this.id, role: "assistant", author: null, parts, created_at: at() }
    this.events.event({ type: "message", message })
    this.busy = false
    this.events.state("idle")
  }

  async interrupt(): Promise<void> {}

  async stop(): Promise<void> {
    queueMicrotask(() => this.events.state("ended"))
  }

  harnessSessionId(): string {
    return `claude-${this.id}`
  }
}

class Host implements HarnessHost {
  readonly sessionId = CHAT
  readonly driver = "minh"
  readonly owner = "ngocbh"
  readonly root = tempDir()
  readonly sessions: Session[] = []
  readonly listed = new Map<string, HarnessListing>()
  failOpen: Error | null = null
  readonly notes: TurnEnded[] = []

  label(author: string | null): string {
    return author === "minh" ? "@minh" : "Ngoc (owner)"
  }

  async open(sessionId: string, _name: string, events: ThreadEvents): Promise<HarnessThread> {
    if (this.failOpen) throw this.failOpen
    const session = new Session(sessionId, events)
    this.sessions.push(session)
    events.state("idle")
    return session
  }

  recordsDir(): string {
    const dir = path.join(this.root, "claude")
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  /** Where session `sessionId`'s record is. */
  recordDir(sessionId: string): string {
    return path.join(this.root, "claude", sessionId)
  }

  log(): void {}

  resumable(): void {}

  list(instrument: HarnessListing): void {
    this.listed.set(instrument.id, instrument)
  }

  changed(): void {}

  remove(instrumentId: string): void {
    this.listed.delete(instrumentId)
  }

  ended(note: TurnEnded): void {
    this.notes.push(note)
  }
}

function made() {
  const host = new Host()
  const tools = new ClaudeInstrument(host).tools()
  const call = async (name: keyof typeof tools, args: Record<string, unknown>) =>
    JSON.parse(String(await tools[name].call(args))) as Record<string, any>
  return { host, tools, call }
}

/** A Bash call of Claude Code's that completed with `output`. */
const bash = (command: string, output: string): Part => ({
  id: id(), type: "tool", call_id: `toolu_${id()}`, tool: "claude.Bash", state: "completed",
  input: { command, description: "Run it" }, output, error: null,
})

test("start opens claude 1 and replies naming it claude, with Claude Code's words as claude's", async () => {
  const m = made()
  const reply = m.call("start", { message: "Fix the build." })
  const session = await waitFor(() => (m.host.sessions[0]?.busy ? m.host.sessions[0] : undefined), { what: "the turn" })
  session.answer([bash("bun test", "12 pass"), { id: id(), type: "text", text: "All 12 pass." }])
  expect(await reply).toMatchObject({ claude: "claude 1", status: "idle" })
  expect((await reply).output).toEqual([
    { author: "@minh", text: "Fix the build." },
    { author: "claude", text: "All 12 pass." },
  ])
  expect(m.host.listed.get(session.id)!.info()).toMatchObject({ kind: "claude", name: "claude 1", profile: "harness" })
  // The tools are the model's claude_start and the rest, in Claude Code's words.
  expect(Object.keys(m.tools)).toEqual(["start", "send", "interrupt", "stop", "history"])
  expect(m.tools.start.description).toContain("Start a Claude Code session")
  expect(m.tools.send.parameters).toMatchObject({ required: ["claude", "message"] })
})

test("the record is a claude record, Claude Code's words labelled Claude Code, and each tool call is in the trace", async () => {
  const m = made()
  const reply = m.call("start", { message: "Run the tests." })
  const session = await waitFor(() => (m.host.sessions[0]?.busy ? m.host.sessions[0] : undefined), { what: "the turn" })
  session.answer([bash("bun test", "12 pass"), { id: id(), type: "text", text: "Done." }])
  await reply
  const dir = m.host.recordDir(session.id)
  expect(readClaudeRecord(dir)).toMatchObject({ kind: "claude", name: "claude 1", driver: "minh", state: "running" })
  expect(fs.readFileSync(path.join(dir, "conversation.log"), "utf8")).toContain(
    '<authored_message author="Claude Code">\nDone.\n</authored_message>',
  )
  expect(fs.readFileSync(path.join(dir, "trace.log"), "utf8")).toContain("[Bash] $ bun test\n12 pass")
  const found = await m.call("history", { claude: "claude 1", query: "12 pass" })
  expect(found.output).toEqual([{ author: "claude", text: "[Bash] $ bun test\n12 pass" }])
  expect(markClaudeInterrupted(dir)).toBe(true)
  expect(readClaudeRecord(dir)!.state).toBe("interrupted")
})

test("a command Claude Code refused reaches the employee's reply and the record as one line, and the turn completed, not failed", async () => {
  const m = made()
  expect((await m.call("start", { message: "Run the eval.", wait: 0 })).status).toBe("running")
  const [session] = m.host.sessions
  // Claude Code's lines through the translator, as a session's are.
  const translator = new Translator(session!.id, (e) => {
    if (e.type === "message" || e.type === "part") session!.events.event(e)
  })
  const command = 'OUT=results/eval && ( time python3 -m robust_location --output "$OUT" )'
  const why = "A group in parentheses in this command can't be checked before it runs"
  const told = `Permission for this tool use was denied. What required approval: ${why}`
  for (const line of [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } },
    { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_1",
      decision_reason_type: "asyncAgent", message: told },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: told }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "I'll run it in plain steps." }] } },
  ]) translator.line(line)
  session!.events.state("idle")
  const refused = `Claude Code refused \`${command}\`: ${why}`
  await waitFor(() => m.host.notes.length === 1, { what: "the note" })
  expect(m.host.notes[0]!.text.split("\n")[0]).toBe("claude 1: the turn on `Run the eval.` completed")
  const reply = await m.call("history", { claude: "claude 1" })
  expect(reply.output).toContainEqual({ author: "claude", text: `${refused}\n\nI'll run it in plain steps.` })
  const dir = m.host.recordDir(session!.id)
  expect(fs.readFileSync(path.join(dir, "conversation.log"), "utf8")).toContain(refused)
  // The trace keeps the call and what Claude Code told the model, as it wrote it.
  expect(fs.readFileSync(path.join(dir, "trace.log"), "utf8")).toContain(`[Bash (error)] $ ${command}\n${told}`)
})

test("a failed tool call shows why in the trace, and another tool its input whole", () => {
  const text = CLAUDE.toolText({
    id: "p", type: "tool", call_id: "c", tool: "claude.Edit", state: "error",
    input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" }, output: "", error: "File has not been read yet.",
  })
  expect(text).toBe('[Edit (error)] {"file_path":"/w/a.ts","old_string":"a","new_string":"b"}\nFile has not been read yet.')
})

test("a start that can't open says why and what to fix, and the listing shows it failed", async () => {
  const m = made()
  m.host.failOpen = new Error("Claude Code's sandbox can't start on this machine: install bubblewrap and socat")
  const reply = await m.call("start", { message: "Hi." })
  expect(reply).toMatchObject({ claude: "claude 1", status: "failed" })
  expect(reply.error).toContain("install bubblewrap and socat")
  const [listing] = [...m.host.listed.values()]
  expect(listing!.info()).toMatchObject({ status: "failed", error: expect.stringContaining("bubblewrap") })
})

test(`a start past ${MAX_LIVE} live Claude Code sessions is refused, naming them`, async () => {
  const m = made()
  for (let n = 0; n < MAX_LIVE; n++) {
    const reply = m.call("start", { message: `Task ${n}.`, wait: 0 })
    await reply
  }
  const refused = await m.call("start", { message: "One more." })
  expect(refused.refused).toBe(
    `this chat has ${MAX_LIVE} live Claude Code sessions (claude 1, claude 2, claude 3, claude 4), the most it may: ` +
      "send one of them the work, or stop one, before starting another",
  )
  expect(m.host.sessions).toHaveLength(MAX_LIVE)
})

test("a Claude Code turn a reply said runs on gets its note when it ends, signed claude 1, in Claude Code's words", async () => {
  const m = made()
  expect((await m.call("start", { message: "Fix the build.", wait: 0 })).status).toBe("running")
  const [session] = m.host.sessions
  session!.answer([bash("bun test", "12 pass"), { id: id(), type: "text", text: "All 12 pass." }])
  await waitFor(() => m.host.notes.length === 1, { what: "the note" })
  const [note] = m.host.notes
  expect([note!.key, note!.session]).toEqual([`claude:${session!.id}:1`, "claude 1"])
  expect(note!.text.split("\n")).toEqual([
    "claude 1: the turn on `Fix the build.` completed",
    expect.stringMatching(/^It ran for \d+s\. Claude Code's last message ends:$/),
    "```",
    "All 12 pass.",
    "```",
  ])
})

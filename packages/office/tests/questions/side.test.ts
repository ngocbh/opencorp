/** A side session's discussion and its seed file (Python's `tests/questions/test_side.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { RunLogEntry } from "@ngocbh/yian/run"
import type { Message, Part } from "@opencorp/protocol"
import { Transcript } from "../../src/chat/transcript.ts"
import { discussion, readSeed, SEED_FILE, writeSeed } from "../../src/questions/side.ts"
import { newId } from "../../src/store/store.ts"
import type { Delivery } from "../../src/worker/job.ts"
import { fakeLlm, logPrefix, send, TemplateOffice, waitingChat } from "../chat/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { openStore, session } from "../store/helpers.ts"
import { advanceJob, run, type TestWorker } from "../worker/helpers.ts"

setDefaultTimeout(30_000)

function text(t: string): Part {
  return { id: newId(), type: "text", text: t }
}

function tool(): Part {
  return {
    id: newId(),
    type: "tool",
    call_id: "c1",
    tool: "read_file",
    state: "completed",
    input: { path: "a" },
    output: "secret file text",
    error: null,
  }
}

function message(sessionId: string, parts: Part[], role: "user" | "assistant" = "assistant"): Message {
  return { id: newId(), session_id: sessionId, role, author: null, parts, created_at: new Date().toISOString() }
}

/** Each entry as its role and text. */
function pairs(entries: { role: string; text: string }[]): [string, string][] {
  return entries.map((e) => [e.role, e.text])
}

test("the discussion is human messages and final reply text", () => {
  const store = openStore()
  const side = store.createSession(session({ kind: "side", status: "idle" }))
  const messages = [
    message(side.id, [text("why not fail fast?")], "user"),
    message(side.id, [text("Let me look."), tool(), text("The sandbox is rate-limited.")]),
    message(side.id, [text("ok"), text("and retries?")], "user"),
    message(side.id, [tool()]), // a reply that was stopped before any text
  ]
  const transcript = { messages: () => messages, runningReply: () => null }
  expect(pairs(discussion(store, transcript, side.id))).toEqual([
    ["user", "why not fail fast?"],
    ["assistant", "The sandbox is rate-limited."],
    ["user", "ok\n\nand retries?"],
  ])
})

/** A template office whose tool calls first deliver `delivery` to the run and wait for its reply. */
class DeliverDuringTool extends TemplateOffice {
  constructor(private readonly delivery: Delivery) {
    super()
  }

  override async toolCall(worker: TestWorker, group: string, name: string, args: Record<string, unknown>) {
    await worker.deliver(this.delivery)
    const delivered = () => this.replies.some((reply) => reply.id === this.delivery.id)
    await waitFor(delivered, { timeout: 10_000, what: "the reply" })
    return await super.toolCall(worker, group, name, args)
  }
}

// waiting: held at its cost cap, the reply not final
test.each(["busy", "waiting"] as const)("a reply still running is not in the discussion [%s]", async (left) => {
  const fake = await fakeLlm()
  fake.script({ content: "Let me look.", tool_calls: [{ id: "c1", name: "toolbox_stub" }] }, { content: "Because" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const office = new DeliverDuringTool(send("during", "and retries?"))
  await run(advanceJob(job, { deliver: [send("s1", "why?")] }), office, { env: fake.env() })
  const store = openStore()
  const side = store.createSession(session({ kind: "side", status: left, run_ids: ["r1"] }))
  const reply = (entry: RunLogEntry) => entry.nodeId === "chat#0/reply"
  const step = (entry: RunLogEntry) => (entry.envelope.record as unknown as { step: { kind: string } }).step
  /** The discussion read from the log's leading records while `keep` holds. */
  const upTo = (keep: (entry: RunLogEntry) => boolean) => {
    const cut = tempDir()
    logPrefix(job.log, keep, cut)
    return discussion(store, new Transcript(cut), side.id)
  }
  // The send is committed but not read yet: a queued message, which stays.
  const beforeSteer = upTo((entry) => !(reply(entry) && entry.kind === "node_step" && step(entry).kind === "steer"))
  expect(pairs(beforeSteer)).toEqual([
    ["user", "why?"],
    ["user", "and retries?"],
  ])
  // The reply is split by the steer and still running: both halves are left out.
  const beforeEnd = upTo((entry) => !(reply(entry) && entry.kind === "node_succeeded"))
  expect(beforeEnd.map((e) => e.role)).toEqual(["user", "user"])
  // The reply is final once it finished, though the session still says busy or waiting.
  expect(pairs(upTo(() => true))).toEqual([
    ["user", "why?"],
    ["assistant", "Let me look."],
    ["user", "and retries?"],
    ["assistant", "Because"],
  ])
})

test("a seed is a private file read back as written", () => {
  const root = tempDir()
  const dir = path.join(root, "sessions", "s1")
  const file = path.join(dir, SEED_FILE)
  const mode = (p: string) => fs.lstatSync(p).mode & 0o777
  writeSeed(dir, "SEED")
  expect(mode(dir)).toBe(0o700)
  expect(mode(file)).toBe(0o600)
  expect(readSeed(dir)).toBe("SEED")

  const open = path.join(root, "open")
  fs.mkdirSync(open, { mode: 0o700 })
  fs.writeFileSync(path.join(open, SEED_FILE), "old")
  fs.chmodSync(path.join(open, SEED_FILE), 0o644)
  writeSeed(open, "SEED")
  expect(mode(path.join(open, SEED_FILE))).toBe(0o600)
  expect(readSeed(open)).toBe("SEED")

  expect(readSeed(path.join(root, "sessions", "s2"))).toBeNull()

  const linked = path.join(root, "linked")
  const target = path.join(root, "target")
  fs.mkdirSync(linked, { mode: 0o700 })
  fs.writeFileSync(target, "TARGET", { mode: 0o600 })
  fs.symlinkSync(target, path.join(linked, SEED_FILE))
  expect(() => readSeed(linked)).toThrow()
  writeSeed(linked, "SEED")
  expect(fs.lstatSync(path.join(linked, SEED_FILE)).isFile()).toBe(true)
  expect(readSeed(linked)).toBe("SEED")
  expect(fs.readFileSync(target, "utf8")).toBe("TARGET")

  fs.chmodSync(file, 0o640)
  expect(() => readSeed(dir)).toThrow()
})

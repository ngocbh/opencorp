/** A session's transcript, read from its runs' logs (Python's `tests/chat/test_transcript.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import { Message } from "@opencorp/protocol"
import { Transcript } from "../../src/chat/transcript.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import { newId } from "../../src/store/store.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import type { Delivery, Job } from "../../src/worker/job.ts"
import { tempDir } from "../helpers.ts"
import { advanceJob, run } from "../worker/helpers.ts"
import { advance, fakeLlm, logPrefix, send, TemplateOffice, waitingChat } from "./helpers.ts"

setDefaultTimeout(30_000)

/** The messages of the runs `runIds` under `runs`, each checked against the protocol's `Message`. */
function messages(runs: string, sessionId: string, runIds: string[]): Message[] {
  const read = new Transcript(runs).messages(sessionId, runIds)
  for (const message of read) Message.parse(message)
  return read
}

/** Each message as its role and its text parts' texts. */
function texts(read: Message[]): [string, string[]][] {
  return read.map((m) => [m.role, m.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))])
}

/** Applies `deliver` to the waiting run `job` without moving it on. */
async function apply(job: Job, fake: FakeLLM, deliver: Delivery[]): Promise<void> {
  await run(advanceJob(job, { deliver, advance: false }), new TemplateOffice(), { env: fake.env() })
}

test("a user message comes from its turns take commit", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello both." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "one"), send("s2", "two")])
  const read = messages(runs, newId(), ["r1"])
  expect(texts(read).slice(0, 2)).toEqual([
    ["user", ["one"]],
    ["user", ["two"]],
  ])
})

test("a user message can name its author", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Done." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "approve it", "ngocbh"), send("s2", "composer message")])
  const read = messages(runs, newId(), ["r1"])
  expect(read.filter((m) => m.role === "user").map((m) => m.author)).toEqual(["ngocbh", null])
})

test("a turn context part never shows", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const event = { role: "user", parts: [{ type: "text", text: "Context: seed" }, { type: "text", text: "hi" }] }
  await advance(job, fake, [{ id: "s1", op: "send", inbox: "messages", event }])
  const read = messages(runs, newId(), ["r1"])
  expect(texts(read.filter((m) => m.role === "user"))).toEqual([["user", ["hi"]]])
})

test("a send no take has read is a queued message of the last run only", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const runs = tempDir()
  const first = await waitingChat(fake, "chat", {}, { runs, runId: "r1" })
  await advance(first, fake, [send("s1", "one")])
  await apply(first, fake, [send("s2", "lost")])
  const second = await waitingChat(fake, "chat", {}, { runs, runId: "r2" })
  await apply(second, fake, [send("s3", "queued")])
  const read = messages(runs, newId(), ["r1", "r2"])
  expect(texts(read.filter((m) => m.role === "user"))).toEqual([
    ["user", ["one"]],
    ["user", ["queued"]],
  ])
  expect(read.at(-1)!.id.startsWith("r2:")).toBe(true)
  expect(texts([read.at(-1)!])).toEqual([["user", ["queued"]]])
})

test("an orphan take commit leaves its messages queued", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello both." })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  await advance(job, fake, [send("s1", "one"), send("s2", "two")])
  const crashed = tempDir()
  logPrefix(job.log, (entry) => !(entry.kind === "node_succeeded" && MAIN_CHAT.isTurn(entry.nodeId)), crashed)
  const read = messages(crashed, newId(), ["r1"])
  expect(texts(read)).toEqual([
    ["user", ["one"]],
    ["user", ["two"]],
  ])
})

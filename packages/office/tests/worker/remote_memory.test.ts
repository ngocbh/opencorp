/** The worker's memory: FileMemory's contract over the channel, each call a request the office answers from its own
 *  memory, and its errors mapped back to yian's. */
import fs from "node:fs"
import path from "node:path"
import { expect, spyOn, test } from "bun:test"
import {
  FileMemory,
  loadFlow,
  MemoryBase,
  MemoryBusyError,
  type MemoryContract,
  memoryErrorKind,
  MemoryMissingError,
  type MemorySession,
  runFlow,
} from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { isPermanentToolError, isReportedToolError } from "@ngocbh/yian/tools"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { RemoteMemory } from "../../src/worker/remote_memory.ts"
import { BaseHandlers } from "../../src/worker/rpc.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { tempDir } from "../helpers.ts"
import { officeEnd, PROFILED, profileMemory } from "./helpers.ts"

const SIGNAL = new AbortController().signal
const AUTHOR = { kind: "agent", name: "reply", run: "r1", node: "reply" } as const

/** minh's profile in a temp folder, the office's handlers serving it as `profile`, and the worker's memory over
 *  them. */
async function remote(text = "# Minh\n") {
  const root = path.join(tempDir(), "memory")
  const handlers = new BaseHandlers({ memories: { profile: profileMemory(root, text) } })
  const memory = new RemoteMemory(await officeEnd(handlers), "profile")
  return { root, handlers, memory }
}

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error,
  )
}

/** A memory with FileMemory's contract whose `open` and every session call throw `error`. */
class Throwing extends MemoryBase {
  static override readonly contract: MemoryContract = FileMemory.contract

  constructor(readonly error: () => unknown) {
    super()
  }

  override async open(): Promise<MemorySession> {
    throw this.error()
  }

  override async reset(): Promise<void> {
    throw this.error()
  }
}

test("it has FileMemory's contract and binds a FileMemory input", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "ok" })
  const { memory } = await remote("# Minh\nPrefers terse answers.\n")
  expect((memory.constructor as typeof MemoryBase).contract).toBe(FileMemory.contract)
  const env = (name: string) => fake.env()[name]
  const inputs = { message: "hi", profile: memory }
  const result = await runFlow(await loadFlow(PROFILED), inputs, { llmConfig: LLM_CONFIG, env })
  expect(result.status).toBe("succeeded")
  expect(JSON.stringify(fake.requests()[0]!.messages)).toContain("Prefers terse answers.")
})

test("a session's calls round trip", async () => {
  const { root, memory } = await remote()
  const session = await memory.open({ create: true, itemType: null, signal: SIGNAL })
  expect([session.created, session.info.type, session.info.identity]).toEqual([true, "FileMemory", "people/minh"])
  expect(session.info.settings).toMatchObject({ index: "profile.md", max_file_chars: 128000n })
  expect(session.info.tools.map((tool) => tool.name)).toEqual(FileMemory.contract.tools.map((tool) => tool.name))
  const { recall } = await session.snapshot()
  expect(recall).toEqual({ text: "# Minh\n", cut: null, hint: null })
  const read = await session.call("read", { path: "profile.md" }, { signal: SIGNAL })
  expect(read).toMatchObject({ path: "profile.md", text: "# Minh" })
  expect(await session.call("search", { query: "minh" }, { signal: SIGNAL })).toMatchObject({ matches: [{ line: 1n }] })
  await session.close()
  expect(fs.readFileSync(path.join(root, "profile.md"), "utf8")).toBe("# Minh\n")
})

test("changes, undo, erase, history and reset are refused in the worker, sending nothing", async () => {
  const { root, memory } = await remote()
  const session = await memory.open({ create: true, itemType: null, signal: SIGNAL })
  const sent = spyOn(memory.rpc, "request")
  const change: JsonObject = { op: "append", path: "profile.md", text: "x" }
  const reason = "the office keeps this memory; a run only reads it"
  const refused = { ok: false, reason, current: null } as const
  expect(await session.apply({ id: "c-1", change, author: AUTHOR, signal: SIGNAL })).toEqual(refused)
  expect(await session.undo({ id: "u-1", changeId: "c-1", author: AUTHOR, signal: SIGNAL })).toEqual(refused)
  const erase = session.erase({ id: "e-1", target: { path: "profile.md" }, author: AUTHOR, signal: SIGNAL })
  for (const call of [erase, session.history({ limit: 1 }), memory.reset({ signal: SIGNAL })]) {
    expect(((await rejection(call)) as Error).message).toBe(reason)
  }
  expect(sent).not.toHaveBeenCalled()
  sent.mockRestore()
  await session.close()
  expect(fs.readFileSync(path.join(root, "profile.md"), "utf8")).toBe("# Minh\n")
})

test("a closed session is gone from the office", async () => {
  const { memory } = await remote()
  const session = await memory.open({ create: true, itemType: null, signal: SIGNAL })
  await session.close()
  const error = await rejection(session.snapshot())
  expect(error).toMatchObject({ code: "EIO", syscall: "read", message: "no such memory session" })
})

test("a missing memory is yian's MemoryMissingError", async () => {
  const { root, memory } = await remote()
  fs.rmSync(root, { recursive: true })
  const error = await rejection(memory.open({ create: false, itemType: null, signal: SIGNAL }))
  expect(error).toBeInstanceOf(MemoryMissingError)
  expect(memoryErrorKind(error)).toBe("missing")
  expect((error as Error).message).toBe("the memory isn't at its location: there is no folder")
})

test("a busy memory is yian's MemoryBusyError", async () => {
  const profile = new Throwing(() => new MemoryBusyError("this memory is busy"))
  const busy = new BaseHandlers({ memories: { profile } })
  const memory = new RemoteMemory(await officeEnd(busy), "profile")
  const error = await rejection(memory.open({ create: true, itemType: null, signal: SIGNAL }))
  expect(error).toBeInstanceOf(MemoryBusyError)
  expect([memoryErrorKind(error), (error as Error).message]).toEqual(["busy", "this memory is busy"])
})

test("a read tool's refusal is a permanent reported error the model reads", async () => {
  const { memory } = await remote()
  const session = await memory.open({ create: true, itemType: null, signal: SIGNAL })
  const error = await rejection(session.call("read", { path: "nope.md" }, { signal: SIGNAL }))
  expect([isReportedToolError(error), isPermanentToolError(error)]).toEqual([true, true])
  expect((error as Error).message).toBe("`nope.md` doesn't exist")
  await session.close()
})

test("any other failure is a system error", async () => {
  const broken = new BaseHandlers({ memories: { profile: new Throwing(() => new Error("disk on fire")) } })
  const memory = new RemoteMemory(await officeEnd(broken), "profile")
  const opened = await rejection(memory.open({ create: true, itemType: null, signal: SIGNAL }))
  expect(opened).toMatchObject({ code: "EIO", syscall: "read", message: "disk on fire" })
  expect(memoryErrorKind(opened)).toBeNull()
  const unnamed = new RemoteMemory(memory.rpc, "notes")
  const error = await rejection(unnamed.open({ create: true, itemType: null, signal: SIGNAL }))
  expect(error).toMatchObject({ code: "EIO", syscall: "read", message: "no memory named 'notes'" })
})

test("a closed channel is a system error", async () => {
  const { memory } = await remote()
  const session = await memory.open({ create: true, itemType: null, signal: SIGNAL })
  memory.rpc.channel.close()
  const error = await rejection(session.call("read", { path: "profile.md" }, { signal: SIGNAL }))
  expect(error).toMatchObject({ code: "EIO", syscall: "read" })
})

test("an aborted call rejects with the signal's reason", async () => {
  const { memory } = await remote()
  const stop = new AbortController()
  stop.abort(new Error("stopped"))
  const error = await rejection(memory.open({ create: true, itemType: null, signal: stop.signal }))
  expect((error as Error).message).toBe("stopped")
})

test("the sessions a worker left open close when it goes", async () => {
  const { handlers, memory } = await remote()
  const session = await memory.open({ create: true, itemType: null, signal: SIGNAL })
  handlers.exited(null, 0)
  expect(await rejection(session.snapshot())).toMatchObject({ code: "EIO", message: "no such memory session" })
  // The handlers still serve a memory opened after.
  const again = await memory.open({ create: false, itemType: null, signal: SIGNAL })
  expect((await again.snapshot()).recall.text).toBe("# Minh\n")
})

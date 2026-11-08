/** Worker requests: the office answers each with its handlers, checked against the job, with value-free errors. */
import fs from "node:fs"
import { PassThrough } from "node:stream"
import { expect, onTestFinished, test } from "bun:test"
import {
  ChangeIdReusedError,
  FileMemory,
  MemoryBase,
  MemoryBusyError,
  type MemoryContract,
  MemoryMissingError,
  type MemorySession,
} from "@ngocbh/yian"
import { isPending, isReportedToolError, pending, ReportedToolError, ToolSet } from "@ngocbh/yian/tools"
import { z } from "zod"
import { Channel, ChannelClosed, FrameTooLarge, type Frame } from "../../src/worker/channel.ts"
import { groupSpecs, toolSpec } from "../../src/worker/job.ts"
import {
  answerRequest,
  ASK_KEYS,
  AskRefused,
  type AskRequest,
  askUserStub,
  BaseHandlers,
  errnoFields,
  errorKind,
  isRequest,
  modelFromSchema,
  type OfficeTool,
  RemoteError,
  remoteTool,
  replyTo,
  Rpc,
  type RpcLog,
} from "../../src/worker/rpc.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { officeEnd, profileMemory, recordFrames, workerFor } from "./helpers.ts"

/** A tool taking string `properties`, all required, that runs `call`. */
function tool(call: (args: Record<string, unknown>) => unknown, properties = ["text"]): OfficeTool {
  return {
    description: "A test tool.",
    parameters: {
      type: "object",
      properties: Object.fromEntries(properties.map((key) => [key, { type: "string" }])),
      required: properties,
    },
    call,
  }
}

/** A memory with FileMemory's contract whose `open` and `reset` run `fail` (the first throws what it returns), and
 *  whose `open` otherwise gives a session that throws `error` from each call. */
class Failing extends MemoryBase {
  static override readonly contract: MemoryContract = FileMemory.contract

  constructor(readonly fail: () => unknown = () => new Error("down")) {
    super()
  }

  override async open(): Promise<MemorySession> {
    throw this.fail()
  }

  override async reset(): Promise<void> {
    throw this.fail()
  }
}

/** A `log` that records its calls. */
function recorder(): { calls: [string, string][]; log: RpcLog } {
  const calls: [string, string][] = []
  return { calls, log: (level, line) => void calls.push([level, line]) }
}

const throwingLog: RpcLog = () => {
  throw new Error("log is broken")
}

const OPEN = { type: "memory_open", id: 1, memory: "profile", create: true, item_type: null }

/** A `tool_call` frame for tool `name` of group `g`, with a call id of the job's run. */
function call(name: string, args: Record<string, unknown> = { text: "x" }): Frame {
  return { type: "tool_call", id: 3, group: "g", name, args, call_id: "r1/n/1/0" }
}

type Served = { tools?: Record<string, OfficeTool>; memories?: Record<string, MemoryBase>; log?: RpcLog }

/** The reply to `frame` from handlers holding `tools` in group `g` and `memories`, with a job granting all of them. */
async function answer(frame: Frame, { tools = {}, memories = {}, log }: Served = {}): Promise<Frame> {
  const handlers = new BaseHandlers({ tools: { g: tools }, memories })
  return answerRequest(frame, handlers, workerFor(handlers), { log })
}

test("answer request error codes", async () => {
  const profile = new Failing(() => new MemoryBusyError("this memory is busy"))
  const lookup = tool((args) => {
    throw new Error(`'${args.key}'`)
  }, ["key"])
  const empty = tool(() => {
    throw new Error("")
  })
  const handlers = new BaseHandlers({ tools: { g: { lookup, empty } }, memories: { profile } })
  // The job grants a memory and a tool the handlers lack, so BaseHandlers itself refuses them.
  const granted = groupSpecs(handlers.tools)
  const missing = { name: "missing", description: "", parameters: { type: "object", properties: {} } }
  const worker = workerFor(handlers, {
    memory: ["profile", "other"],
    groups: { ...granted, g: [...granted.g!, missing] },
  })
  expect(await answerRequest(OPEN, handlers, worker)).toEqual({
    type: "memory_reply",
    id: 1,
    error: "busy",
    message: "this memory is busy",
  })
  const frame = { type: "tool_call", id: 3, group: "g", name: "lookup", args: { key: "k" }, call_id: "r1/n/1/0" }
  expect(await answerRequest(frame, handlers, worker)).toEqual({
    type: "tool_result",
    id: 3,
    error: "failed",
    message: "'k'",
  })
  const other = await answerRequest({ ...OPEN, memory: "other" }, handlers, worker)
  expect([other.error, other.message]).toEqual(["failed", "no memory named 'other'"])
  const absent = await answerRequest(call("missing"), handlers, worker)
  expect([absent.error, absent.message]).toEqual(["failed", "no tool 'missing' in group 'g'"])
  const blank = await answerRequest(call("empty"), handlers, worker)
  expect([blank.error, blank.message]).toEqual(["failed", "Error"])
})

test("a memory's errors keep yian's kinds", async () => {
  const reused = "change id `c-1` was used for another change"
  const cases: [unknown, Record<string, unknown>][] = [
    [new MemoryBusyError("busy now"), { error: "busy", message: "busy now" }],
    [new MemoryMissingError("not there"), { error: "missing", message: "not there" }],
    [new ChangeIdReusedError("c-1"), { error: "change_id_reused", message: reused }],
    [new ReportedToolError("gone", { permanent: true }), { error: "refused", message: "gone", permanent: true }],
    [new ReportedToolError("try again"), { error: "refused", message: "try again", permanent: false }],
    [Object.assign(new Error("index locked"), { code: "EBUSY" }), { error: "failed", message: "index locked" }],
    [new TypeError("bad id"), { error: "failed", message: "bad id" }],
  ]
  for (const [error, reply] of cases) {
    const memories = { profile: new Failing(() => error) }
    expect(await answer(OPEN, { memories })).toEqual({ type: "memory_reply", id: 1, ...reply })
  }
  const parse = tool(() => {
    throw new Error("bad text")
  })
  const failed = await answer(call("parse"), { tools: { parse } })
  expect([failed.error, failed.message]).toEqual(["failed", "bad text"])
})

test("only an errno code and a syscall that read as one are kept", () => {
  const error = (fields: Record<string, unknown>) => Object.assign(new Error("x"), fields)
  expect(errnoFields(error({ code: "EACCES", syscall: "mkdir" }))).toEqual({ code: "EACCES", syscall: "mkdir" })
  expect(errnoFields(error({ code: "rm -rf /", syscall: "mkdir /x" }))).toEqual({})
  expect(errnoFields(error({ code: "ERR_INVALID_ARG_TYPE" }))).toEqual({})
  expect(errnoFields({ code: "ENOENT", syscall: "stat" })).toEqual({ code: "ENOENT", syscall: "stat" })
  expect(errnoFields("EACCES")).toEqual({})
})

test("a failed request logs only its exception type", async () => {
  const parse = tool((args) => {
    throw new TypeError(`bad text ${args.text}`)
  })
  const { calls, log } = recorder()
  const reply = await answer(call("parse", { text: "s3cret" }), { tools: { parse }, log })
  expect(reply.message).toBe("bad text s3cret")
  expect(calls).toEqual([["INFO", "worker tool_call request failed: TypeError"]])
})

test("a malformed request is failed not a memory's error", async () => {
  const memories = { profile: new Failing(() => new MemoryBusyError("busy")) }
  const cases: [Frame, string][] = [
    [{ type: "memory_open", id: 1, create: true }, "memory_open request is missing 'memory'"],
    [{ ...OPEN, create: "yes" }, "memory_open request has a bad 'create'"],
    [{ type: "memory_call", id: 1, session: "s", tool: "read", args: [] }, "memory_call request has a bad 'args'"],
    [{ type: "memory_close", id: 1 }, "memory_close request is missing 'session'"],
  ]
  for (const [frame, message] of cases) {
    expect(await answer(frame, { memories })).toEqual({ type: "memory_reply", id: 1, error: "failed", message })
  }
})

test("memory replies are plain json", async () => {
  const memories = { profile: profileMemory(`${tempDir()}/memory`, "# Minh\n") }
  const handlers = new BaseHandlers({ memories })
  const worker = workerFor(handlers)
  const opened = await answerRequest(OPEN, handlers, worker)
  expect(opened).toMatchObject({ type: "memory_reply", id: 1, created: true, info: { identity: "people/minh" } })
  const session = opened.session as string
  const ask = (frame: Frame) => answerRequest({ id: 3, session, ...frame }, handlers, worker)
  expect(await ask({ type: "memory_snapshot" })).toMatchObject({ recall: { text: "# Minh\n", cut: null, hint: null } })
  const read = await ask({ type: "memory_call", tool: "read", args: { path: "profile.md" } })
  expect(read).toMatchObject({ type: "memory_reply", id: 3, result: { path: "profile.md", text: "# Minh" } })
  expect(await ask({ type: "memory_close" })).toEqual({ type: "memory_reply", id: 3 })
  expect(await ask({ type: "memory_snapshot" })).toEqual({
    type: "memory_reply",
    id: 3,
    error: "failed",
    message: "no such memory session",
  })
})

/** An office profile memory in a temp folder holding `# Minh\n`, handlers serving it, a worker whose job names it,
 *  and the session a `memory_open` opened on it. */
async function openProfile() {
  const root = `${tempDir()}/memory`
  const handlers = new BaseHandlers({ memories: { profile: profileMemory(root, "# Minh\n") } })
  const worker = workerFor(handlers)
  const opened = await answerRequest(OPEN, handlers, worker)
  return { root, handlers, worker, session: opened.session as string }
}

test.each([
  ["memory_apply", { change_id: "c-1", change: { op: "append", path: "profile.md", text: "x" }, author: {} }],
  ["memory_undo", { change_id: "u-1", undoes: "c-1", author: {} }],
  ["memory_erase", { change_id: "e-1", target: { path: "profile.md" }, author: {} }],
  ["memory_history", { limit: 5 }],
  ["memory_reset", { memory: "profile" }],
])("a worker can't change or reset a memory, nor read its history [%s]", async (type, fields) => {
  const { root, handlers, worker, session } = await openProfile()
  expect(isRequest(type)).toBe(false)
  // No request type of the office takes it: the worker's channel drops it unanswered.
  await expect(answerRequest({ type, id: 2, session, ...fields }, handlers, worker)).rejects.toThrow(TypeError)
  expect(fs.readFileSync(`${root}/profile.md`, "utf8")).toBe("# Minh\n")
})

test("a memory call takes only the memory's read tools", async () => {
  const { root, handlers, worker, session } = await openProfile()
  for (const tool of ["append", "rewrite", "delete", "nope"]) {
    const args = { path: "profile.md", text: "x", if_hash: "h" }
    const reply = await answerRequest({ type: "memory_call", id: 2, session, tool, args }, handlers, worker)
    expect([reply.error, reply.message]).toEqual(["failed", `no read tool '${tool}'`])
  }
  for (const tool of ["list", "read", "search"]) {
    const args = tool === "search" ? { query: "minh" } : tool === "read" ? { path: "profile.md" } : {}
    const reply = await answerRequest({ type: "memory_call", id: 2, session, tool, args }, handlers, worker)
    expect(reply.error).toBeUndefined()
  }
  expect(fs.readFileSync(`${root}/profile.md`, "utf8")).toBe("# Minh\n")
})

test("a worker opens each memory once at a time", async () => {
  const { handlers, worker, session } = await openProfile()
  const again = await answerRequest(OPEN, handlers, worker)
  expect([again.error, again.message]).toEqual(["failed", "memory 'profile' is open already"])
  await answerRequest({ type: "memory_close", id: 3, session }, handlers, worker)
  expect((await answerRequest(OPEN, handlers, worker)).error).toBeUndefined()
})

test("the sessions a worker left open close when it exits or moves on to its next job", async () => {
  for (const leave of [(h: BaseHandlers) => h.exited(null, 0), (h: BaseHandlers) => h.released(null)]) {
    const { handlers, worker, session } = await openProfile()
    leave(handlers)
    const snapshot = await answerRequest({ type: "memory_snapshot", id: 2, session }, handlers, worker)
    expect([snapshot.error, snapshot.message]).toEqual(["failed", "no such memory session"])
  }
})

test("a forged tool call for a group the job was not given is refused", async () => {
  const ran: string[] = []
  const toolbox = { shout: tool(() => ran.push("shout")), purge: tool(() => ran.push("purge"), []) }
  const admin = { wipe: tool(() => ran.push("wipe"), []) }
  const handlers = new BaseHandlers({ tools: { toolbox, admin } })
  const worker = workerFor(handlers, { groups: groupSpecs({ toolbox: { shout: toolbox.shout } }) })
  const wipe = { type: "tool_call", id: 9, group: "admin", name: "wipe", args: {}, call_id: "r1/n/1/0" }
  const forged = await answerRequest(wipe, handlers, worker)
  expect(forged).toEqual({ type: "tool_result", id: 9, error: "failed", message: "no tool 'wipe' in group 'admin'" })
  const unlisted = await answerRequest({ ...wipe, group: "toolbox" }, handlers, worker)
  expect([unlisted.error, unlisted.message]).toEqual(["failed", "no tool 'wipe' in group 'toolbox'"])
  // The handlers hold purge, so only the job check can refuse it.
  const purge = await answerRequest({ ...wipe, group: "toolbox", name: "purge" }, handlers, worker)
  expect([purge.error, purge.message]).toEqual(["failed", "no tool 'purge' in group 'toolbox'"])
  expect(ran).toEqual([])
})

test("a forged memory request for a memory the job was not given is refused", async () => {
  const ran: string[] = []
  const notes = new Failing(() => ran.push("notes"))
  const handlers = new BaseHandlers({ memories: { profile: new Failing(), notes } })
  const worker = workerFor(handlers, { memory: ["profile"] })
  const reply = await answerRequest({ ...OPEN, memory: "notes" }, handlers, worker)
  expect([reply.type, reply.error, reply.message]).toEqual(["memory_reply", "failed", "no memory named 'notes'"])
  expect(ran).toEqual([])
})

test("object method names are never tools or memories", async () => {
  const ran: string[] = []
  const keys = ["__proto__", "constructor", "toString"]
  const shout = tool(() => "OK")
  const sneaky = tool(() => ran.push("tool"), [])
  const notes = new Failing(() => ran.push("memory"))
  const each = <T>(value: T) => Object.fromEntries(keys.map((key) => [key, value]))
  // The handlers hold each name as an own key, which the job doesn't grant, so only the job check can refuse it.
  const handlers = new BaseHandlers({
    tools: { toolbox: { shout, ...each(sneaky) }, ...each({ shout: sneaky }) },
    memories: { profile: new Failing(), ...each(notes) },
  })
  for (const key of keys) {
    expect([Object.hasOwn(handlers.tools, key), Object.hasOwn(handlers.tools.toolbox!, key)]).toEqual([true, true])
    expect(Object.hasOwn(handlers.memories.memories, key)).toBe(true)
  }
  const worker = workerFor(handlers, { groups: groupSpecs({ toolbox: { shout } }), memory: ["profile"] })
  for (const key of keys) {
    const shout = { type: "tool_call", id: 1, group: "toolbox", name: "shout", args: {}, call_id: "r1/n/1/0" }
    const group = await answerRequest({ ...shout, group: key }, handlers, worker)
    expect([group.error, group.message]).toEqual(["failed", `no tool 'shout' in group '${key}'`])
    const name = await answerRequest({ ...shout, name: key }, handlers, worker)
    expect([name.error, name.message]).toEqual(["failed", `no tool '${key}' in group 'toolbox'`])
    const reply = await answerRequest({ ...OPEN, memory: key }, handlers, worker)
    expect([reply.error, reply.message]).toEqual(["failed", `no memory named '${key}'`])
  }
  expect(ran).toEqual([])
  for (const type of ["toString", "__proto__", "constructor"]) expect(isRequest(type)).toBe(false)
  expect(isRequest("tool_call")).toBe(true)
  await expect(answerRequest({ type: "toString", id: 1 }, handlers, worker)).rejects.toThrow(TypeError)
  // BaseHandlers' own lookups, without the job check in front of them.
  const bare = new BaseHandlers({ tools: { toolbox: {} } })
  await expect(bare.toolCall(null, "toolbox", "constructor", {})).rejects.toThrow(
    "no tool 'constructor' in group 'toolbox'",
  )
  await expect(bare.toolCall(null, "__proto__", "constructor", {})).rejects.toThrow(
    "no tool 'constructor' in group '__proto__'",
  )
  const open = { op: "open", memory: "toString", create: true, itemType: null } as const
  await expect(new BaseHandlers().memory(null, open)).rejects.toThrow(
    "no memory named 'toString'",
  )
  await expect(new BaseHandlers().memory(null, { op: "snapshot", session: "toString" })).rejects.toThrow(
    "no such memory session",
  )
})

test("ask user passes the handler only the six keys", async () => {
  const seen: { worker: unknown; request: AskRequest }[] = []
  class Asking extends BaseHandlers {
    override askUser(worker: unknown, request: AskRequest): unknown {
      seen.push({ worker, request })
      return "yes"
    }
  }
  const handlers = new Asking()
  const worker = workerFor(handlers)
  const request = { question: "Go?", title: "T", options: ["yes", "no"], session_id: "other", run_id: "x" }
  const reply = await answerRequest({ type: "ask_user", id: 4, request, call_id: "r1/n/1/0" }, handlers, worker)
  expect(reply).toEqual({ type: "answer", id: 4, answer: "yes" })
  expect(seen).toHaveLength(1)
  expect(seen[0]!.request).toEqual({
    question: "Go?",
    questions: null,
    answer_schema: null,
    title: "T",
    node_id: null,
    options: ["yes", "no"],
  })
  expect(Object.keys(seen[0]!.request)).toEqual([...ASK_KEYS])
  expect(seen[0]!.worker).toBe(worker)
  expect(worker.job.session_id).toBe("s1")
})

test("a malformed field is failed without its value", async () => {
  const tools = { shout: tool(() => "OK") }
  const shout = { type: "tool_call", id: 1, group: "g", name: "shout", args: {} }
  const group = await answer({ ...shout, group: { secret: "sk-1" } }, { tools })
  expect([group.error, group.message]).toEqual(["failed", "tool_call request has a bad 'group'"])
  expect(JSON.stringify(group)).not.toContain("sk-1")
  const args = await answer({ ...shout, args: [1] }, { tools })
  expect([args.error, args.message]).toEqual(["failed", "tool_call request has a bad 'args'"])
  const ask = await answer({ type: "ask_user", id: 3, request: "x" })
  expect([ask.type, ask.error, ask.message]).toEqual(["answer", "failed", "ask_user request has a bad 'request'"])
})

test("a thrown non error value is a failed reply", async () => {
  const bare = tool(() => {
    throw Object.create(null)
  })
  const text = tool(() => {
    throw "plain text"
  })
  const { calls, log } = recorder()
  const reply = await answer(call("bare"), { tools: { bare, text }, log })
  expect([reply.error, reply.message]).toEqual(["failed", "a non-Error value was thrown"])
  expect(calls).toEqual([["INFO", "worker tool_call request failed: object"]])
  const plain = await answer(call("text"), { tools: { bare, text } })
  expect([plain.error, plain.message]).toEqual(["failed", "plain text"])
})

test("an error whose name or message cannot be read is a failed reply", async () => {
  const badName = tool(() => {
    throw Object.defineProperty(new Error("x"), "name", {
      get() {
        throw new Error("boom")
      },
    })
  })
  const badMessage = tool(() => {
    throw Object.defineProperty(new Error("x"), "message", {
      get() {
        throw new Error("boom")
      },
    })
  })
  const spaced = tool(() => {
    throw Object.assign(new Error("y"), { name: "bad name with spaces" })
  })
  // A revoked Proxy throws on every check, instanceof included.
  const revoked = () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    throw proxy
  }
  const tools = { badName, badMessage, spaced, revoked: tool(revoked) }
  const { calls, log } = recorder()
  const first = await answer(call("badName"), { tools, log })
  expect([first.error, first.message]).toEqual(["failed", "x"])
  const second = await answer(call("badMessage"), { tools, log })
  expect([second.error, second.message]).toEqual(["failed", "Error"])
  const third = await answer(call("spaced"), { tools, log })
  expect([third.error, third.message]).toEqual(["failed", "y"])
  const fourth = await answer(call("revoked"), { tools, log })
  expect(fourth).toEqual({ type: "tool_result", id: 3, error: "failed", message: "Error" })
  expect(calls).toEqual([
    ["INFO", "worker tool_call request failed: Error"],
    ["INFO", "worker tool_call request failed: Error"],
    ["INFO", "worker tool_call request failed: Error"],
    ["INFO", "worker tool_call request failed: Error"],
  ])
  const memories = { profile: new Failing(revoked) }
  const reply = await answer(OPEN, { memories })
  expect([reply.type, reply.error, reply.message]).toEqual(["memory_reply", "failed", "Error"])
  expect(await answer(call("badName"), { tools, log: throwingLog })).toEqual(first)
})

test("reply to never rejects", async () => {
  const handlers = new BaseHandlers({ tools: { g: { shout: tool((args) => String(args.text).toUpperCase()) } } })
  const worker = workerFor(handlers)
  const frame = { type: "tool_call", id: 7, group: "g", name: "shout", args: { text: "hi" }, call_id: "r1/n/1/0" }

  /** A channel whose `send` rejects with each of `errors` in turn, then resolves; it records the frames sent. */
  function channel(...errors: Error[]): { sent: Frame[]; channel: Pick<Channel, "send"> } {
    const sent: Frame[] = []
    const send = async (out: Frame): Promise<void> => {
      sent.push(out)
      const error = errors.shift()
      if (error !== undefined) throw error
    }
    return { sent, channel: { send } }
  }

  const message = "the reply could not be sent (FrameTooLarge)"
  const failed = { type: "tool_result", id: 7, error: "failed", message }
  // (c) with a log that throws, each case still sends what it would with a working log.
  const { calls, log: recording } = recorder()
  for (const log of [recording, throwingLog]) {
    // (a) a closed channel: the reply is dropped.
    const closed = channel(new ChannelClosed())
    await replyTo(closed.channel, frame, handlers, worker, { log })
    expect(closed.sent).toEqual([{ type: "tool_result", id: 7, result: "HI" }])

    // (b) a reply that can't be sent: a failed reply instead; a failing second send is dropped too.
    const tooLarge = channel(new FrameTooLarge(10, 5))
    await replyTo(tooLarge.channel, frame, handlers, worker, { log })
    expect(tooLarge.sent).toEqual([{ type: "tool_result", id: 7, result: "HI" }, failed])
    const twice = channel(new FrameTooLarge(10, 5), new Error("down"))
    await replyTo(twice.channel, frame, handlers, worker, { log })
    expect(twice.sent).toEqual([{ type: "tool_result", id: 7, result: "HI" }, failed])
  }
  expect(calls).toEqual([
    ["WARNING", "worker could not answer a tool_call request: FrameTooLarge"],
    ["WARNING", "worker could not answer a tool_call request: FrameTooLarge"],
  ])

  // (d) not a request: nothing is sent.
  const ignored = channel()
  await replyTo(ignored.channel, { type: "toString", id: 7 }, handlers, worker)
  expect(ignored.sent).toEqual([])
})

const shout: OfficeTool = {
  description: "Return text in capitals.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  call: (args) => String(args.text).toUpperCase(),
}

/** An office tool with one required argument `key` of JSON Schema `schema`, recording each value it gets. */
function taking(key: string, schema: Record<string, unknown>): { seen: unknown[]; tool: OfficeTool } {
  const seen: unknown[] = []
  const parameters = { type: "object", properties: { [key]: schema }, required: [key] }
  return { seen, tool: { description: "Take a value.", parameters, call: (args) => void seen.push(args[key]) } }
}

/** What `promise` rejects with; fails if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error,
  )
}

test("a remote tool runs in the office", async () => {
  const rpc = await officeEnd(new BaseHandlers({ tools: { toolbox: { shout } } }))
  const remote = remoteTool(rpc, "toolbox", toolSpec("shout", shout))
  expect([remote.name, remote.description]).toEqual(["shout", "Return text in capitals."])
  expect(await new ToolSet({ toolbox: [remote] }).invoke("shout", { text: "hi" }, { callId: "r1/n/1/0" })).toBe("HI")
})

test("a remote tool sends validated args with defaults", async () => {
  const seen: unknown[][] = []
  const readFile: OfficeTool = {
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", default: 0 },
        limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
      },
      required: ["path"],
    },
    call: ({ path, offset, limit }) => {
      seen.push([path, offset, limit])
      return "ok"
    },
  }
  const rpc = await officeEnd(new BaseHandlers({ tools: { workspace: { read_file: readFile } } }))
  const tools = new ToolSet({ workspace: [remoteTool(rpc, "workspace", toolSpec("read_file", readFile))] })
  expect(await tools.invoke("read_file", { path: "a.txt", limit: 3 }, { callId: "r1/n/1/0" })).toBe("ok")
  const error = await rejection(tools.invoke("read_file", { offset: 1 }))
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toContain("path")
  expect(seen).toEqual([["a.txt", 0, 3]])
})

test("an office tool error is the tool result", async () => {
  const boom: OfficeTool = {
    ...shout,
    description: "Fail.",
    call: () => {
      throw new Error("no grant for boom")
    },
  }
  const handlers = new BaseHandlers({ tools: { toolbox: { boom } } })
  // The job grants shout too, so the handlers, which lack it, refuse it.
  const worker = workerFor(handlers, { groups: groupSpecs({ toolbox: { boom, shout } }) })
  const rpc = await officeEnd(handlers, { worker })
  const tools = new ToolSet({
    toolbox: [remoteTool(rpc, "toolbox", toolSpec("boom", boom)), remoteTool(rpc, "toolbox", toolSpec("shout", shout))],
  })
  const failed = await rejection(tools.invoke("boom", { text: "x" }, { callId: "r1/n/1/0" }))
  expect(isReportedToolError(failed)).toBe(true)
  expect((failed as Error).message).toBe("error: no grant for boom")
  const missing = await rejection(tools.invoke("shout", { text: "x" }, { callId: "r1/n/1/1" }))
  expect(isReportedToolError(missing)).toBe(true)
  expect((missing as Error).message).toBe("error: no tool 'shout' in group 'toolbox'")
})

/** The frames of `type` among the `recorded` ones, decoded. */
function sentFrames(recorded: string[], type: string): Frame[] {
  return recorded.map((text) => JSON.parse(text) as Frame).filter((frame) => frame.type === type)
}

test("ask user sends the six keys and returns the answer", async () => {
  class Answering extends BaseHandlers {
    request: AskRequest | undefined
    override askUser(_worker: unknown, request: AskRequest): unknown {
      this.request = request
      return "Paris"
    }
  }
  const handlers = new Answering()
  const frames = recordFrames()
  const asking = new ToolSet({ ask_user: askUserStub(await officeEnd(handlers)) })
  const deadline = "2026-10-26T12:00:00.000Z"
  const args = { question: "Which city?", options: ["Paris", "Rome"], deadline }
  expect(await asking.invokeTrusted("ask_user", args, { callId: "r1/reply/1/0" })).toBe("Paris")
  const [sent] = sentFrames(frames, "ask_user")
  expect([sent!.call_id, sent!.deadline]).toEqual(["r1/reply/1/0", deadline])
  expect(handlers.request).toEqual({
    question: "Which city?",
    questions: null,
    answer_schema: null,
    title: null,
    node_id: null,
    options: ["Paris", "Rome"],
  })
  const nobody = new ToolSet({ ask_user: askUserStub(await officeEnd(new BaseHandlers())) })
  await expect(nobody.invoke("ask_user", { question: "Hello?" }, { callId: "r1/n/1/0" })).rejects.toThrow(
    "ask_user failed: nobody is here to answer",
  )
})

test("an ask user refusal is its own reply code and other failures stay failed", async () => {
  let thrown: unknown
  class Refusing extends BaseHandlers {
    override askUser(): unknown {
      throw thrown
    }
  }
  const handlers = new Refusing()
  const worker = workerFor(handlers)
  const frame = { type: "ask_user", id: 5, request: { question: " " }, call_id: "r1/n/1/0" }
  const { calls, log } = recorder()
  thrown = new AskRefused("ask_user question is blank: write the question to ask the user")
  expect(await answerRequest(frame, handlers, worker, { log })).toEqual({
    type: "answer",
    id: 5,
    error: "refused",
    message: "ask_user question is blank: write the question to ask the user",
  })
  expect(calls).toEqual([["INFO", "worker ask_user request refused: AskRefused"]])
  for (const error of [new Error("store is down"), new TypeError("bad question")]) {
    thrown = error
    const reply = await answerRequest(frame, handlers, worker)
    expect([reply.error, reply.message]).toEqual(["failed", error.message])
  }
})

test("a refused model ask user is the tool result and a refused ask node or a failure is not", async () => {
  let reply: Frame = {}
  class Replying extends BaseHandlers {
    override askUser(): unknown {
      if (reply.error === "refused") throw new AskRefused(String(reply.message))
      throw new Error(String(reply.message))
    }
  }
  const asking = new ToolSet({ ask: askUserStub(await officeEnd(new Replying())) })
  reply = { error: "refused", message: "ask_user question is blank: write the question to ask the user" }
  const refused = await rejection(asking.invoke("ask_user", { question: "" }, { callId: "r1/reply/1/0" }))
  expect(isReportedToolError(refused)).toBe(true)
  expect((refused as Error).message).toBe("error: ask_user question is blank: write the question to ask the user")
  const nodeCall = { prompt: "", nodeId: "sop#0/ask" }
  const node = await rejection(asking.invokeTrusted("ask", nodeCall, { callId: "r1/sop#0/ask" }))
  expect(isReportedToolError(node)).toBe(false)
  expect((node as Error).message).toBe(`ask_user failed: ${String(reply.message)}`)
  reply = { error: "failed", message: "store is down" }
  const failed = await rejection(asking.invoke("ask_user", { question: "Go?" }, { callId: "r1/reply/1/1" }))
  expect(isReportedToolError(failed)).toBe(false)
  expect((failed as Error).message).toBe("ask_user failed: store is down")
})

/** Handlers whose questions and tools all answer later: each returns yian's pending marker. */
class Later extends BaseHandlers {
  override askUser(): unknown {
    return pending()
  }

  override async toolCall(): Promise<unknown> {
    return pending()
  }
}

test("a pending reply becomes the yian pending marker", async () => {
  const handlers = new Later()
  const worker = workerFor(handlers, { groups: groupSpecs({ toolbox: { shout } }) })
  const rpc = await officeEnd(handlers, { worker })
  const tools = new ToolSet({
    ask_user: askUserStub(rpc),
    toolbox: [remoteTool(rpc, "toolbox", toolSpec("shout", shout))],
  })
  expect(isPending(await tools.invoke("ask_user", { question: "Which city?" }, { callId: "r1/n/1/0" }))).toBe(true)
  expect(isPending(await tools.invoke("shout", { text: "hi" }, { callId: "r1/n/1/1" }))).toBe(true)
})

test("a remote tool sends its call id", async () => {
  const frames = recordFrames()
  const rpc = await officeEnd(new BaseHandlers({ tools: { toolbox: { shout } } }))
  const tools = new ToolSet({ toolbox: [remoteTool(rpc, "toolbox", toolSpec("shout", shout))] })
  expect(await tools.invoke("shout", { text: "hi" }, { callId: "r1/reply/1/0" })).toBe("HI")
  const [sent] = sentFrames(frames, "tool_call")
  expect(sent).toEqual({
    type: "tool_call",
    id: 1,
    group: "toolbox",
    name: "shout",
    args: { text: "hi" },
    call_id: "r1/reply/1/0",
  })
})

test("a pending handler result is a pending reply", async () => {
  const handlers = new Later()
  const worker = workerFor(handlers, { groups: groupSpecs({ toolbox: { shout } }) })
  const asked = await answerRequest(
    { type: "ask_user", id: 5, request: { question: "Go?" }, call_id: "r1/n/1/0" },
    handlers,
    worker,
  )
  expect(asked).toEqual({ type: "answer", id: 5, pending: true })
  const called = await answerRequest(
    { type: "tool_call", id: 6, group: "toolbox", name: "shout", args: { text: "x" }, call_id: "r1/t" },
    handlers,
    worker,
  )
  expect(called).toEqual({ type: "tool_result", id: 6, pending: true })
})

test("the office handlers get the call id", async () => {
  const seen: [string, string][] = []
  class Recording extends BaseHandlers {
    override askUser(_worker: unknown, _request: AskRequest, callId: string): unknown {
      seen.push(["ask_user", callId])
      return "yes"
    }

    override async toolCall(
      worker: unknown,
      group: string,
      name: string,
      args: Record<string, unknown>,
      callId: string,
    ): Promise<unknown> {
      seen.push(["tool_call", callId])
      return await super.toolCall(worker, group, name, args, callId)
    }
  }
  const options: unknown[] = []
  const echo: OfficeTool = {
    ...shout,
    call: (_args, given) => {
      options.push(given)
      return "ok"
    },
  }
  const handlers = new Recording({ tools: { toolbox: { echo } } })
  const worker = workerFor(handlers)
  const request = { question: "Go?" }
  const asked = await answerRequest({ type: "ask_user", id: 1, request, call_id: "r1/reply/1/0" }, handlers, worker)
  expect(asked).toEqual({ type: "answer", id: 1, answer: "yes" })
  const frame = { type: "tool_call", id: 2, group: "toolbox", name: "echo", args: { text: "x" } }
  const called = await answerRequest({ ...frame, call_id: "r1/reply/1/1" }, handlers, worker)
  expect(called).toEqual({ type: "tool_result", id: 2, result: "ok" })
  expect(seen).toEqual([
    ["ask_user", "r1/reply/1/0"],
    ["tool_call", "r1/reply/1/1"],
  ])
  expect(options).toEqual([{ callId: "r1/reply/1/1" }])
})

test("a request whose call id is another runs is refused", async () => {
  const ran: string[] = []
  class Recording extends BaseHandlers {
    override askUser(): unknown {
      ran.push("ask_user")
      return "yes"
    }

    override async toolCall(): Promise<unknown> {
      ran.push("tool_call")
      return "ok"
    }
  }
  const handlers = new Recording({ tools: { toolbox: { shout } } })
  const worker = workerFor(handlers)
  expect(worker.job.run_id).toBe("r1")
  const frames: Record<string, Frame> = {
    ask_user: { type: "ask_user", id: 1, request: { question: "Go?" } },
    tool_call: { type: "tool_call", id: 2, group: "toolbox", name: "shout", args: { text: "x" } },
  }
  for (const [kind, frame] of Object.entries(frames)) {
    for (const callId of ["r2/reply/1/0", "r1", "r10/x"]) {
      const reply = await answerRequest({ ...frame, call_id: callId }, handlers, worker)
      expect([reply.error, reply.message]).toEqual(["failed", `${kind} request's call_id is not this run's`])
      expect(String(reply.message)).not.toContain(callId)
    }
    for (const callId of [5, ["r1/x"]]) {
      const reply = await answerRequest({ ...frame, call_id: callId }, handlers, worker)
      expect([reply.error, reply.message]).toEqual(["failed", `${kind} request has a bad 'call_id'`])
    }
    const missing = await answerRequest(frame, handlers, worker)
    expect([missing.error, missing.message]).toEqual(["failed", `${kind} request is missing 'call_id'`])
  }
  expect(ran).toEqual([])
})

test("model from schema covers the json types", () => {
  const model = modelFromSchema("args", {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Who." },
      count: { type: "integer", default: 2 },
      ratio: { type: "number" },
      on: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      extra: { type: "object" },
      mode: { enum: ["a", "b"] },
      either: { type: ["string", "null"] },
      maybe: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
    },
  })
  const value = model.parse({ name: "x", ratio: 0.5, on: true, tags: ["t"], extra: { k: 1 }, mode: "a", either: null })
  expect(value).toEqual({
    name: "x",
    count: 2,
    ratio: 0.5,
    on: true,
    tags: ["t"],
    extra: { k: 1 },
    mode: "a",
    either: null,
    maybe: null,
  })
  const json = z.toJSONSchema(model, { unrepresentable: "any" })
  expect((json.properties?.name as { description?: string }).description).toBe("Who.")
  for (const bad of [{}, { name: "x", tags: "t" }, { name: "x", mode: "c" }, { name: "x", count: "many" }]) {
    expect(model.safeParse(bad).success).toBe(false)
  }
  expect(model.parse({ name: "x", count: 2n ** 64n }).count).toBe(2n ** 64n)
})

test("concurrent requests get their own replies", async () => {
  const slow: OfficeTool = {
    description: "Echo after a delay.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, delay: { type: "number" } },
      required: ["text", "delay"],
    },
    call: ({ text, delay }) => new Promise((resolve) => setTimeout(() => resolve(text), Number(delay))),
  }
  const rpc = await officeEnd(new BaseHandlers({ tools: { g: { slow } } }), { concurrent: true })
  const tools = new ToolSet({ g: [remoteTool(rpc, "g", toolSpec("slow", slow))] })
  const order: string[] = []
  const run = async (text: string, delay: number) => {
    const result = await tools.invoke("slow", { text, delay }, { callId: `r1/${text}/1/0` })
    order.push(text)
    return [text, result] as const
  }
  expect(Object.fromEntries(await Promise.all([run("a", 300), run("b", 0)]))).toEqual({ a: "a", b: "b" })
  expect(order).toEqual(["b", "a"])
})

test("a forged frame through the channel is refused", async () => {
  const ran: string[] = []
  const wipe: OfficeTool = { description: "Wipe.", call: () => void ran.push("wipe") }
  const handlers = new BaseHandlers({ tools: { toolbox: { shout }, admin: { wipe } } })
  const worker = workerFor(handlers, { groups: groupSpecs({ toolbox: { shout } }) })
  const rpc = await officeEnd(handlers, { worker })
  const forged = { group: "admin", name: "wipe", args: {}, call_id: "r1/n/1/0" }
  const error = await rejection(rpc.request("tool_call", forged))
  expect(error).toBeInstanceOf(RemoteError)
  expect([(error as RemoteError).code, (error as RemoteError).message]).toEqual([
    "failed",
    "no tool 'wipe' in group 'admin'",
  ])
  expect(ran).toEqual([])
})

test("a reply that cannot be sent becomes a failed reply", async () => {
  const cyclic: OfficeTool = {
    description: "Return a cycle.",
    call: () => {
      const loop: Record<string, unknown> = {}
      loop.self = loop
      return loop
    },
  }
  const { calls, log } = recorder()
  const rpc = await officeEnd(new BaseHandlers({ tools: { g: { cyclic } } }), { log })
  const tools = new ToolSet({ g: [remoteTool(rpc, "g", toolSpec("cyclic", cyclic))] })
  const error = await rejection(tools.invoke("cyclic", {}, { callId: "r1/n/1/0" }))
  expect(isReportedToolError(error)).toBe(true)
  expect((error as Error).message).toBe("error: the reply could not be sent (TypeError)")
  expect(calls).toEqual([["WARNING", "worker could not answer a tool_call request: TypeError"]])
})

test("bigint arguments reach the office tool", async () => {
  const { seen, tool: receive } = taking("n", { type: "integer" })
  const rpc = await officeEnd(new BaseHandlers({ tools: { g: { receive } } }))
  const tools = new ToolSet({ g: [remoteTool(rpc, "g", toolSpec("receive", receive))] })
  await tools.invoke("receive", { n: 2n ** 64n }, { callId: "r1/n/1/0" })
  expect(seen).toEqual([2n ** 64n])
})

test("a model written $v key reaches the office tool", async () => {
  const { seen, tool: receive } = taking("payload", { type: "object" })
  const rpc = await officeEnd(new BaseHandlers({ tools: { g: { receive } } }))
  const payload = { $v: "x", value: 1 }
  const tools = new ToolSet({ g: [remoteTool(rpc, "g", toolSpec("receive", receive))] })
  await tools.invoke("receive", { payload }, { callId: "r1/n/1/0" })
  expect(seen).toEqual([payload])
})

test("object arguments keep a proto key", async () => {
  const { seen, tool: receive } = taking("obj", { type: "object" })
  const rpc = await officeEnd(new BaseHandlers({ tools: { g: { receive } } }))
  const obj = JSON.parse('{"__proto__": {"x": 1}, "a": 2}')
  const tools = new ToolSet({ g: [remoteTool(rpc, "g", toolSpec("receive", receive))] })
  await tools.invoke("receive", { obj }, { callId: "r1/n/1/0" })
  expect(seen).toHaveLength(1)
  expect(Object.keys(seen[0] as object)).toEqual(["__proto__", "a"])
  expect(Object.getPrototypeOf(seen[0])).toBe(Object.prototype)
})

/** An `Rpc` over a channel nobody answers, whose transport takes each write `delay` ms later; `writes()` counts the
 *  writes taken. The channel closes when the test finishes. */
function unanswered(delay = 0): { rpc: Rpc; writes: () => number } {
  const readable = new PassThrough()
  let writes = 0
  const channel = new Channel({
    readable,
    write: () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          writes++
          resolve()
        }, delay),
      ),
    endWrite: () => {},
    destroy: () => readable.destroy(),
  })
  onTestFinished(() => channel.close())
  return { rpc: new Rpc(channel), writes: () => writes }
}

test("a request ends when its signal aborts", async () => {
  const reason = new Error("the office stopped the run")
  const sent = unanswered()
  const stop = new AbortController()
  const asked = rejection(sent.rpc.request("tool_call", { group: "g" }, { signal: stop.signal }))
  await waitFor(() => sent.writes() === 1, { timeout: 5000, what: "the request to be sent" })
  stop.abort(reason)
  expect(await asked).toBe(reason)
  expect(sent.rpc.deliver({ type: "tool_result", id: 1, result: "late" })).toBe(false)

  // Aborted while the send is still pending: the reply promise already has a handler, so nothing is unhandled.
  const slow = unanswered(20)
  const early = new AbortController()
  const during = rejection(slow.rpc.request("tool_call", {}, { signal: early.signal }))
  early.abort(reason)
  expect(slow.writes()).toBe(0)
  expect(await during).toBe(reason)
  // An already aborted signal sends nothing.
  expect(await rejection(slow.rpc.request("tool_call", {}, { signal: early.signal }))).toBe(reason)
  // The first write's 20 ms timer, set earlier, always fires first: this only checks nothing more is written, and a
  // slow machine can't make it fail wrongly.
  await Bun.sleep(50)
  expect(slow.writes()).toBe(1)
})

test("a closed rpc rejects pending and later requests", async () => {
  const sent = unanswered()
  const first = rejection(sent.rpc.request("tool_call", { group: "g" }))
  const second = rejection(sent.rpc.request("ask_user", { request: {} }))
  await waitFor(() => sent.writes() === 2, { timeout: 5000, what: "both requests to be sent" })
  const closed = new ChannelClosed()
  sent.rpc.close(closed)
  expect(await first).toBe(closed)
  expect(await second).toBe(closed)
  expect(await rejection(sent.rpc.request("memory_snapshot", { session: "s" }))).toBe(closed)
  expect(sent.writes()).toBe(2)
})

test("the kind of an error for a log line adds its errno code and syscall, never its message", () => {
  const errno = (code: unknown, syscall?: unknown) => Object.assign(new Error("secret /x"), { code, syscall })
  expect(errorKind(errno("ENOENT", "realpath"))).toBe("Error ENOENT realpath")
  expect(errorKind(errno("EACCES"))).toBe("Error EACCES")
  expect(errorKind(Object.assign(new TypeError("secret"), { code: "ERR_INVALID_ARG_TYPE" }))).toBe("TypeError")
  for (const code of ["enoent x", "ENOENT secret", 2, "E".repeat(40)]) expect(errorKind(errno(code))).toBe("Error")
  expect(errorKind(errno("ENOENT", "realpath /x"))).toBe("Error ENOENT")
  const trap = new Error("secret")
  Object.defineProperty(trap, "code", {
    get() {
      throw new Error("no")
    },
  })
  expect(errorKind(trap)).toBe("Error")
  expect(errorKind("secret")).toBe("string")
})

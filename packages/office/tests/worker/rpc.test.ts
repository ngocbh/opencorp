/** Worker requests: the office answers each with its handlers, checked against the job, with value-free errors. */
import { expect, test } from "bun:test"
import { MarkdownVersionMismatch, type MarkdownStore } from "@ngocbh/yian"
import { ChannelClosed, FrameTooLarge, type Channel, type Frame } from "../../src/worker/channel.ts"
import { groupSpecs } from "../../src/worker/job.ts"
import {
  answerRequest,
  ASK_KEYS,
  type AskRequest,
  BaseHandlers,
  isRequest,
  type OfficeTool,
  replyTo,
  type RpcLog,
} from "../../src/worker/rpc.ts"
import { workerFor } from "./helpers.ts"

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

/** A store whose `read` and `write` are the given ones (by default an empty document at `v0`). */
function store(over: Partial<MarkdownStore> = {}): MarkdownStore {
  return { read: () => ["", "v0"] as const, write: () => "v1", ...over }
}

/** A `log` that records its calls. */
function recorder(): { calls: [string, string][]; log: RpcLog } {
  const calls: [string, string][] = []
  return { calls, log: (level, line) => void calls.push([level, line]) }
}

const throwingLog: RpcLog = () => {
  throw new Error("log is broken")
}

const READ = { type: "store_read", id: 1, store: "profile" }
const WRITE = { type: "store_write", id: 2, store: "profile", text: "t", base_version: "v1" }

/** A `tool_call` frame for tool `name` of group `g`. */
function call(name: string, args: Record<string, unknown> = { text: "x" }): Frame {
  return { type: "tool_call", id: 3, group: "g", name, args }
}

type Served = { tools?: Record<string, OfficeTool>; stores?: Record<string, MarkdownStore>; log?: RpcLog }

/** The reply to `frame` from handlers holding `tools` in group `g` and `stores`, with a job granting all of them. */
async function answer(frame: Frame, { tools = {}, stores = {}, log }: Served = {}): Promise<Frame> {
  const handlers = new BaseHandlers({ tools: { g: tools }, stores })
  return answerRequest(frame, handlers, workerFor(handlers), { log })
}

test("answer request error codes", async () => {
  const profile = store({
    read: (version) => {
      throw new RangeError(`no version ${version}`)
    },
    write: (_text, { baseVersion }) => {
      throw new MarkdownVersionMismatch(baseVersion, "v2")
    },
  })
  const lookup = tool((args) => {
    throw new Error(`'${args.key}'`)
  }, ["key"])
  const empty = tool(() => {
    throw new Error("")
  })
  const handlers = new BaseHandlers({ tools: { g: { lookup, empty } }, stores: { profile } })
  const worker = workerFor(handlers)
  expect(await answerRequest({ ...READ, version: "v0" }, handlers, worker)).toEqual({
    type: "store_reply",
    id: 1,
    error: "unknown_version",
    message: "no version v0",
  })
  const reply = await answerRequest(WRITE, handlers, worker)
  expect([reply.error, reply.expected, reply.current]).toEqual(["mismatch", "v1", "v2"])
  const frame = { type: "tool_call", id: 3, group: "g", name: "lookup", args: { key: "k" } }
  expect(await answerRequest(frame, handlers, worker)).toEqual({
    type: "tool_result",
    id: 3,
    error: "failed",
    message: "'k'",
  })
  const other = await answerRequest({ ...READ, store: "other" }, handlers, worker)
  expect([other.error, other.message]).toEqual(["unavailable", "no store named 'other'"])
  const blank = await answerRequest(call("empty"), handlers, worker)
  expect([blank.error, blank.message]).toEqual(["failed", "Error"])
})

test("store value and os errors keep their codes", async () => {
  const profile = store({
    read: () => {
      throw new RangeError("document is not valid UTF-8")
    },
    write: (text) => {
      if (text === "busy") throw Object.assign(new Error("git index is locked"), { code: "EBUSY" })
      if (text === "lone") throw new RangeError("text holds a lone surrogate")
      throw new TypeError("text must be a string")
    },
  })
  const stores = { profile }
  const read = await answer(READ, { stores })
  expect([read.error, read.message]).toEqual(["unknown_version", "document is not valid UTF-8"])
  const lone = await answer({ ...WRITE, text: "lone" }, { stores })
  expect([lone.error, lone.message]).toEqual(["invalid", "text holds a lone surrogate"])
  const busy = await answer({ ...WRITE, text: "busy" }, { stores })
  expect([busy.error, busy.message]).toEqual(["unavailable", "git index is locked"])
  const refused = await answer(WRITE, { stores })
  expect([refused.error, refused.message]).toEqual(["invalid", "text must be a string"])
  const parse = tool(() => {
    throw new Error("bad text")
  })
  const failed = await answer(call("parse"), { tools: { parse } })
  expect([failed.error, failed.message]).toEqual(["failed", "bad text"])
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

test("a malformed request is failed not a store error", async () => {
  const reply = await answer({ type: "store_read", id: 1 }, { stores: { profile: store() } })
  expect(reply).toEqual({
    type: "store_reply",
    id: 1,
    error: "failed",
    message: "store_read request is missing 'store'",
  })
})

test("store replies are plain json", async () => {
  const stores = { profile: store({ read: () => Object.freeze(["text", "v1"] as const), write: () => "v2" }) }
  const read = await answer(READ, { stores })
  const write = await answer(WRITE, { stores })
  expect(read).toEqual({ type: "store_reply", id: 1, text: "text", version: "v1" })
  expect(write).toEqual({ type: "store_reply", id: 2, version: "v2" })
})

test("a forged tool call for a group the job was not given is refused", async () => {
  const ran: string[] = []
  const toolbox = { shout: tool(() => ran.push("shout")), purge: tool(() => ran.push("purge"), []) }
  const admin = { wipe: tool(() => ran.push("wipe"), []) }
  const handlers = new BaseHandlers({ tools: { toolbox, admin } })
  const worker = workerFor(handlers, { groups: groupSpecs({ toolbox: { shout: toolbox.shout } }) })
  const wipe = { type: "tool_call", id: 9, group: "admin", name: "wipe", args: {} }
  const forged = await answerRequest(wipe, handlers, worker)
  expect(forged).toEqual({ type: "tool_result", id: 9, error: "failed", message: "no tool 'wipe' in group 'admin'" })
  const unlisted = await answerRequest({ ...wipe, group: "toolbox" }, handlers, worker)
  expect([unlisted.error, unlisted.message]).toEqual(["failed", "no tool 'wipe' in group 'toolbox'"])
  // The handlers hold purge, so only the job check can refuse it.
  const purge = await answerRequest({ ...wipe, group: "toolbox", name: "purge" }, handlers, worker)
  expect([purge.error, purge.message]).toEqual(["failed", "no tool 'purge' in group 'toolbox'"])
  expect(ran).toEqual([])
})

test("a forged store request for a store the job was not given is refused", async () => {
  const ran: string[] = []
  const notes = store({
    read: () => {
      ran.push("read")
      return ["secret notes", "v0"] as const
    },
    write: () => {
      ran.push("write")
      return "v1"
    },
  })
  const handlers = new BaseHandlers({ stores: { profile: store(), notes } })
  const worker = workerFor(handlers, { memory: { profile: { store: "profile" } } })
  for (const frame of [{ ...READ, store: "notes" }, { ...WRITE, store: "notes" }]) {
    const reply = await answerRequest(frame, handlers, worker)
    expect([reply.type, reply.error, reply.message]).toEqual(["store_reply", "unavailable", "no store named 'notes'"])
  }
  expect(ran).toEqual([])
})

test("object method names are never tools or stores", async () => {
  const ran: string[] = []
  const keys = ["__proto__", "constructor", "toString"]
  const shout = tool(() => "OK")
  const sneaky = tool(() => ran.push("tool"), [])
  const notes = store({
    read: () => {
      ran.push("read")
      return ["", "v0"] as const
    },
    write: () => {
      ran.push("write")
      return "v1"
    },
  })
  const each = <T>(value: T) => Object.fromEntries(keys.map((key) => [key, value]))
  // The handlers hold each name as an own key, which the job doesn't grant, so only the job check can refuse it.
  const handlers = new BaseHandlers({
    tools: { toolbox: { shout, ...each(sneaky) }, ...each({ shout: sneaky }) },
    stores: { profile: store(), ...each(notes) },
  })
  for (const key of keys) {
    expect([Object.hasOwn(handlers.tools, key), Object.hasOwn(handlers.tools.toolbox!, key)]).toEqual([true, true])
    expect(Object.hasOwn(handlers.stores, key)).toBe(true)
  }
  const worker = workerFor(handlers, {
    groups: groupSpecs({ toolbox: { shout } }),
    memory: { profile: { store: "profile" } },
  })
  for (const key of keys) {
    const shout = { type: "tool_call", id: 1, group: "toolbox", name: "shout", args: {} }
    const group = await answerRequest({ ...shout, group: key }, handlers, worker)
    expect([group.error, group.message]).toEqual(["failed", `no tool 'shout' in group '${key}'`])
    const name = await answerRequest({ ...shout, name: key }, handlers, worker)
    expect([name.error, name.message]).toEqual(["failed", `no tool '${key}' in group 'toolbox'`])
    for (const frame of [{ ...READ, store: key }, { ...WRITE, store: key }]) {
      const reply = await answerRequest(frame, handlers, worker)
      expect([reply.error, reply.message]).toEqual(["unavailable", `no store named '${key}'`])
    }
  }
  expect(ran).toEqual([])
  for (const type of ["toString", "__proto__", "constructor"]) expect(isRequest(type)).toBe(false)
  expect(isRequest("tool_call")).toBe(true)
  await expect(answerRequest({ type: "toString", id: 1 }, handlers, worker)).rejects.toThrow(TypeError)
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
  const reply = await answerRequest({ type: "ask_user", id: 4, request }, handlers, worker)
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
  const stores = { profile: store({ read: revoked, write: revoked }) }
  for (const frame of [READ, WRITE]) {
    const reply = await answer(frame, { stores })
    expect([reply.type, reply.error, reply.message]).toEqual(["store_reply", "unavailable", "Error"])
  }
  expect(await answer(call("badName"), { tools, log: throwingLog })).toEqual(first)
})

test("reply to never rejects", async () => {
  const handlers = new BaseHandlers({ tools: { g: { shout: tool((args) => String(args.text).toUpperCase()) } } })
  const worker = workerFor(handlers)
  const frame = { type: "tool_call", id: 7, group: "g", name: "shout", args: { text: "hi" } }

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

/** A memory the office keeps, served to the worker over its channel: yian's FileMemory contract, each call a
 *  request. */
import {
  type Applied,
  type Author,
  type ChangeEntry,
  ChangeIdReusedError,
  type Erased,
  FileMemory,
  MemoryBase,
  MemoryBusyError,
  type MemoryContract,
  type MemoryInfo,
  MemoryMissingError,
  type MemorySession,
  type Recall,
} from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { ReportedToolError } from "@ngocbh/yian/tools"
import { ChannelClosed, type Frame } from "./channel.ts"
import { RemoteError, type RequestType, type Rpc } from "./rpc.ts"

/**
 * The office memory `name` of the worker's job, with FileMemory's contract: `open` and `reset` and each call of a
 * session it opens are one `memory_<op>` request.
 *
 * An error reply is thrown as yian's memory contract has it: `busy`, `change_id_reused` (from a change) and `missing`
 * as yian's `MemoryBusyError`, `ChangeIdReusedError` and `MemoryMissingError`; `refused`, a refusal the model reads,
 * as a `ReportedToolError`, permanent when the reply says so; and any other reply or a closed channel as a Node system
 * error (code `EIO`, syscall `read` or `write`). An aborted signal rejects with its reason; the office's call may
 * still complete, which a change's id makes safe to send again.
 */
export class RemoteMemory extends MemoryBase {
  static override readonly contract: MemoryContract = FileMemory.contract

  constructor(
    readonly rpc: Rpc,
    readonly name: string,
  ) {
    super()
  }

  override async open(o: {
    create: boolean
    itemType: JsonObject | null
    signal: AbortSignal
  }): Promise<MemorySession> {
    const fields = { memory: this.name, create: o.create, item_type: o.itemType }
    const reply = await request(this.rpc, "memory_open", fields, { signal: o.signal, syscall: "read" })
    // The office end is trusted office code: its reply fields are what its session gave.
    return new RemoteSession(this.rpc, reply.session as string, reply.info as MemoryInfo, reply.created === true)
  }

  override async reset(o: { signal: AbortSignal }): Promise<void> {
    await request(this.rpc, "memory_reset", { memory: this.name }, { signal: o.signal, syscall: "write" })
  }
}

/** A session the office opened on its memory, `id` its office-made id. */
class RemoteSession implements MemorySession {
  readonly #rpc: Rpc
  readonly #id: string
  readonly info: MemoryInfo
  readonly created: boolean

  constructor(rpc: Rpc, id: string, info: MemoryInfo, created: boolean) {
    this.#rpc = rpc
    this.#id = id
    this.info = info
    this.created = created
  }

  async snapshot(): Promise<{ version: string; recall: Recall }> {
    const reply = await this.#request("memory_snapshot", {}, { syscall: "read" })
    return { version: reply.version as string, recall: reply.recall as Recall }
  }

  async call(tool: string, args: JsonObject, o: { signal: AbortSignal }): Promise<JsonObject> {
    const reply = await this.#request("memory_call", { tool, args }, { signal: o.signal, syscall: "read" })
    return reply.result as JsonObject
  }

  async apply(c: { id: string; change: JsonObject; author: Author; signal: AbortSignal }): Promise<Applied> {
    const fields = { change_id: c.id, change: c.change, author: c.author }
    const reply = await this.#request("memory_apply", fields, { signal: c.signal, syscall: "write", changeId: c.id })
    return reply.applied as Applied
  }

  async undo(o: { id: string; changeId: string; author: Author; signal: AbortSignal }): Promise<Applied> {
    const fields = { change_id: o.id, undoes: o.changeId, author: o.author }
    const reply = await this.#request("memory_undo", fields, { signal: o.signal, syscall: "write", changeId: o.id })
    return reply.applied as Applied
  }

  async erase(o: { id: string; target: JsonObject; author: Author; signal: AbortSignal }): Promise<Erased> {
    const fields = { change_id: o.id, target: o.target, author: o.author }
    const reply = await this.#request("memory_erase", fields, { signal: o.signal, syscall: "write", changeId: o.id })
    return { version: reply.version as string, disabledUndos: reply.disabled_undos as string[] }
  }

  async history(o: { limit: number }): Promise<ChangeEntry[]> {
    return (await this.#request("memory_history", { limit: o.limit }, { syscall: "read" })).changes as ChangeEntry[]
  }

  async close(): Promise<void> {
    await this.#request("memory_close", {}, { syscall: "read" })
  }

  #request(type: RequestType, fields: Frame, options: RequestOptions): Promise<Frame> {
    return request(this.#rpc, type, { session: this.#id, ...fields }, options)
  }
}

/** How a request is sent, and what its errors become: the call's signal, the syscall of its I/O error, and a change's
 *  id, which a reused-id reply names. */
type RequestOptions = { signal?: AbortSignal; syscall: "read" | "write"; changeId?: string }

/** Sends one memory request; rejects with the error yian's contract has for its reply (see `RemoteMemory`). */
async function request(rpc: Rpc, type: RequestType, fields: Frame, options: RequestOptions): Promise<Frame> {
  const { signal, syscall, changeId } = options
  try {
    return await rpc.request(type, fields, { signal })
  } catch (error) {
    if (error instanceof RemoteError) {
      if (error.code === "busy") throw new MemoryBusyError(error.message)
      if (error.code === "missing") throw new MemoryMissingError(error.message)
      if (error.code === "change_id_reused" && changeId !== undefined) throw new ChangeIdReusedError(changeId)
      if (error.code === "refused") {
        throw new ReportedToolError(error.message, { permanent: error.reply.permanent === true })
      }
      throw systemError(error.message, syscall)
    }
    if (error instanceof ChannelClosed) throw systemError(error.message, syscall)
    throw error
  }
}

/** A Node system error, as a memory throws for storage it can't reach. */
function systemError(message: string, syscall: "read" | "write"): Error {
  return Object.assign(new Error(message), { code: "EIO", syscall })
}

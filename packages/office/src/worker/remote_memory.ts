/** A memory the office keeps, served to the worker over its channel: yian's FileMemory contract, each call a
 *  request. */
import {
  type Applied,
  type Author,
  type ChangeEntry,
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

/** Why a run can't change, undo, erase, list the history of or reset an office memory: the office keeps it. */
export const READ_ONLY = "the office keeps this memory; a run only reads it"

/**
 * The office memory `name` of the worker's job, with FileMemory's contract, which a run only reads: `open`, and a
 * session's `snapshot`, read tool `call` and `close`, are each one `memory_<op>` request. A change or an undo is
 * refused with `READ_ONLY`, which the model reads, and an erase, the history and `reset` throw it; none sends
 * anything.
 *
 * An error reply is thrown as yian's memory contract has it: `busy` and `missing` as yian's `MemoryBusyError` and
 * `MemoryMissingError`; `refused`, a refusal the model reads, as a `ReportedToolError`, permanent when the reply says
 * so; and any other reply or a closed channel as a Node system error (code `EIO`, syscall `read`). An aborted signal
 * rejects with its reason.
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
    const reply = await request(this.rpc, "memory_open", fields, { signal: o.signal })
    // The office end is trusted office code: its reply fields are what its session gave.
    return new RemoteSession(this.rpc, reply.session as string, reply.info as MemoryInfo, reply.created === true)
  }

  override async reset(_o: { signal: AbortSignal }): Promise<void> {
    throw new Error(READ_ONLY)
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
    const reply = await this.#request("memory_snapshot", {})
    return { version: reply.version as string, recall: reply.recall as Recall }
  }

  async call(tool: string, args: JsonObject, o: { signal: AbortSignal }): Promise<JsonObject> {
    const reply = await this.#request("memory_call", { tool, args }, { signal: o.signal })
    return reply.result as JsonObject
  }

  /** A refusal, as a cap's is: the change writes nothing. */
  async apply(_c: { id: string; change: JsonObject; author: Author; signal: AbortSignal }): Promise<Applied> {
    return { ok: false, reason: READ_ONLY, current: null }
  }

  async undo(_o: { id: string; changeId: string; author: Author; signal: AbortSignal }): Promise<Applied> {
    return { ok: false, reason: READ_ONLY, current: null }
  }

  async erase(_o: { id: string; target: JsonObject; author: Author; signal: AbortSignal }): Promise<Erased> {
    throw new Error(READ_ONLY)
  }

  async history(_o: { limit: number }): Promise<ChangeEntry[]> {
    throw new Error(READ_ONLY)
  }

  async close(): Promise<void> {
    await this.#request("memory_close", {})
  }

  #request(type: RequestType, fields: Frame, options: RequestOptions = {}): Promise<Frame> {
    return request(this.#rpc, type, { session: this.#id, ...fields }, options)
  }
}

/** How a request is sent: the call's signal. */
type RequestOptions = { signal?: AbortSignal }

/** Sends one memory request; rejects with the error yian's contract has for its reply (see `RemoteMemory`). */
async function request(rpc: Rpc, type: RequestType, fields: Frame, options: RequestOptions): Promise<Frame> {
  try {
    return await rpc.request(type, fields, { signal: options.signal })
  } catch (error) {
    if (error instanceof RemoteError) {
      if (error.code === "busy") throw new MemoryBusyError(error.message)
      if (error.code === "missing") throw new MemoryMissingError(error.message)
      if (error.code === "refused") {
        throw new ReportedToolError(error.message, { permanent: error.reply.permanent === true })
      }
      throw systemError(error.message)
    }
    if (error instanceof ChannelClosed) throw systemError(error.message)
    throw error
  }
}

/** A Node system error, as a memory throws for storage it can't reach. */
function systemError(message: string): Error {
  return Object.assign(new Error(message), { code: "EIO", syscall: "read" })
}

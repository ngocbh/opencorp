/** The office's end of a worker's memories: the memories its job names, and the sessions the worker opens on them. */
import { randomUUID } from "node:crypto"
import type { MemoryBase, MemorySession } from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { repr } from "../perm/redact.ts"
import type { Frame } from "./channel.ts"

/** A worker's memory request, by its frame type `memory_<op>`: `open` names a memory of the job; the others name the
 *  session `open` made. A worker only reads: nothing it sends changes a memory, or names an author or a change id. */
export type MemoryRequest =
  | { op: "open"; memory: string; create: boolean; itemType: JsonObject | null }
  | { op: "snapshot"; session: string }
  | { op: "call"; session: string; tool: string; args: JsonObject }
  | { op: "close"; session: string }

/** Why a request names a memory the office doesn't serve; the same text whether the job or the host refuses it. */
export function noMemory(name: string): string {
  return `no memory named ${repr(name)}`
}

/** An open session, the memory it is on, and the names of that memory's read tools. */
interface Opened {
  readonly memory: string
  readonly session: MemorySession
  readonly reads: ReadonlySet<string>
}

/**
 * The office's end of one worker's memories: `memories` by name, and the sessions the worker opened on them, each by
 * an id the office made. A worker reads them as a run whose grants only read: it may hold one session on each memory
 * at a time (a run call opens each once), take its snapshot, call its read tools and close it. `answer` runs one
 * request; `close` closes the sessions open, once the worker is gone or has moved on to other handlers.
 */
export class MemoryHost {
  readonly memories: Readonly<Record<string, MemoryBase>>
  readonly #sessions = new Map<string, Opened>()
  /** Aborts the calls in flight when `close` runs; a fresh one serves the requests after. */
  #live = new AbortController()

  constructor(memories: Record<string, MemoryBase> = {}) {
    this.memories = { ...memories }
  }

  /** Runs `request` and returns its reply's fields. Throws what the memory or its session throws, and an Error for
   *  a memory, a session or a read tool it doesn't have, or a second session on one memory. */
  async answer(request: MemoryRequest): Promise<Frame> {
    const { signal } = this.#live
    switch (request.op) {
      case "open": {
        const memory = this.#memory(request.memory)
        this.#checkClosed(request.memory)
        const contract = (memory.constructor as typeof MemoryBase).contract
        const reads = new Set(contract.tools.filter((tool) => !tool.write).map((tool) => tool.name))
        const session = await memory.open({ create: request.create, itemType: request.itemType, signal })
        try {
          // The worker went while the memory opened, or another open of it got in first.
          signal.throwIfAborted()
          this.#checkClosed(request.memory)
        } catch (error) {
          await session.close()
          throw error
        }
        const id = randomUUID()
        this.#sessions.set(id, { memory: request.memory, session, reads })
        return { session: id, info: session.info, created: session.created }
      }
      case "snapshot": {
        const { version, recall } = await this.#opened(request.session).session.snapshot()
        return { version, recall }
      }
      case "call": {
        const { session, reads } = this.#opened(request.session)
        if (!reads.has(request.tool)) throw new Error(`no read tool ${repr(request.tool)}`)
        return { result: await session.call(request.tool, request.args, { signal }) }
      }
      case "close": {
        const { session } = this.#opened(request.session)
        this.#sessions.delete(request.session)
        await session.close()
        return {}
      }
    }
  }

  /** Aborts the calls in flight and closes every session open; never rejects. Later requests are served afresh. */
  async close(): Promise<void> {
    this.#live.abort(new Error("the worker is gone"))
    this.#live = new AbortController()
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    await Promise.allSettled(sessions.map((open) => open.session.close()))
  }

  #memory(name: string): MemoryBase {
    if (!Object.hasOwn(this.memories, name)) throw new Error(noMemory(name))
    return this.memories[name]!
  }

  /** Throws when the worker holds a session on the memory `name`. */
  #checkClosed(name: string): void {
    for (const open of this.#sessions.values()) {
      if (open.memory === name) throw new Error(`memory ${repr(name)} is open already`)
    }
  }

  #opened(id: string): Opened {
    const opened = this.#sessions.get(id)
    if (opened === undefined) throw new Error("no such memory session")
    return opened
  }
}

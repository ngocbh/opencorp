/** The office's end of a worker's memories: the memories its job names, and the sessions the worker opens on them. */
import { randomUUID } from "node:crypto"
import type { Author, MemoryBase, MemorySession } from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { repr } from "../perm/redact.ts"
import type { Frame } from "./channel.ts"

/** A worker's memory request, by its frame type `memory_<op>`: `open` and `reset` name a memory of the job; the
 *  others name a session `open` made. */
export type MemoryRequest =
  | { op: "open"; memory: string; create: boolean; itemType: JsonObject | null }
  | { op: "reset"; memory: string }
  | { op: "snapshot"; session: string }
  | { op: "call"; session: string; tool: string; args: JsonObject }
  | { op: "apply"; session: string; id: string; change: JsonObject; author: Author }
  | { op: "undo"; session: string; id: string; changeId: string; author: Author }
  | { op: "erase"; session: string; id: string; target: JsonObject; author: Author }
  | { op: "history"; session: string; limit: number }
  | { op: "close"; session: string }

/** Why a request names a memory the office doesn't serve; the same text whether the job or the host refuses it. */
export function noMemory(name: string): string {
  return `no memory named ${repr(name)}`
}

/**
 * The office's end of one worker's memories: `memories` by name, and the sessions the worker opened on them, each by
 * an id the office made. `answer` runs one request on them; `close` closes the sessions open, once the worker is
 * gone.
 */
export class MemoryHost {
  readonly memories: Readonly<Record<string, MemoryBase>>
  readonly #sessions = new Map<string, MemorySession>()
  /** Aborts the calls in flight when `close` runs; a fresh one serves the requests after. */
  #live = new AbortController()

  constructor(memories: Record<string, MemoryBase> = {}) {
    this.memories = { ...memories }
  }

  /** Runs `request` and returns its reply's fields. Throws what the memory or its session throws, and an Error for
   *  a memory or a session it doesn't have. */
  async answer(request: MemoryRequest): Promise<Frame> {
    const { signal } = this.#live
    switch (request.op) {
      case "open": {
        const { create, itemType } = request
        const session = await this.#memory(request.memory).open({ create, itemType, signal })
        // The worker went while the memory opened.
        if (signal.aborted) {
          await session.close()
          throw signal.reason
        }
        const id = randomUUID()
        this.#sessions.set(id, session)
        return { session: id, info: session.info, created: session.created }
      }
      case "reset":
        await this.#memory(request.memory).reset({ signal })
        return {}
      case "snapshot": {
        const { version, recall } = await this.#session(request.session).snapshot()
        return { version, recall }
      }
      case "call":
        return { result: await this.#session(request.session).call(request.tool, request.args, { signal }) }
      case "apply": {
        const { id, change, author } = request
        return { applied: await this.#session(request.session).apply({ id, change, author, signal }) }
      }
      case "undo": {
        const { id, changeId, author } = request
        return { applied: await this.#session(request.session).undo({ id, changeId, author, signal }) }
      }
      case "erase": {
        const { id, target, author } = request
        const erased = await this.#session(request.session).erase({ id, target, author, signal })
        return { version: erased.version, disabled_undos: erased.disabledUndos }
      }
      case "history":
        return { changes: await this.#session(request.session).history({ limit: request.limit }) }
      case "close": {
        const session = this.#session(request.session)
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
    await Promise.allSettled(sessions.map((session) => session.close()))
  }

  #memory(name: string): MemoryBase {
    if (!Object.hasOwn(this.memories, name)) throw new Error(noMemory(name))
    return this.memories[name]!
  }

  #session(id: string): MemorySession {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new Error("no such memory session")
    return session
  }
}

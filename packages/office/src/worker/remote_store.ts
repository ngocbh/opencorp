/** A Yian `MarkdownStore` served by the office over the worker channel. */
import { MarkdownVersionMismatch, type MarkdownStore } from "@ngocbh/yian"
import { ChannelClosed, type Frame } from "./channel.ts"
import { type JsonObject, RemoteError, type RequestType, type Rpc } from "./rpc.ts"

/**
 * `read`/`write` on the office store named `store`, one request frame per call.
 *
 * Error replies are thrown as Yian's store contract has them: `MarkdownVersionMismatch` for `mismatch`, a
 * `RangeError` for `unknown_version` and `invalid`, and a Node system error (`code` `EIO`, `syscall` `read` or
 * `write`) for any other code or a closed channel.
 */
export class RemoteMarkdownStore implements MarkdownStore {
  constructor(
    readonly rpc: Rpc,
    readonly store: string,
  ) {}

  /** The document at `version` (latest when `null`) and its version. */
  async read(version: string | null = null): Promise<readonly [string, string]> {
    const reply = await this.#call("store_read", "read", { version })
    // The office end is trusted office code: its reply fields are strings.
    return [reply.text as string, reply.version as string]
  }

  /** Replaces the document if `baseVersion` is current; resolves to the new version. */
  async write(
    text: string,
    { baseVersion, provenance = null }: { baseVersion: string; provenance?: JsonObject | null },
  ): Promise<string> {
    const reply = await this.#call("store_write", "write", { text, base_version: baseVersion, provenance })
    return reply.version as string
  }

  async #call(type: RequestType, syscall: "read" | "write", fields: Frame): Promise<Frame> {
    try {
      return await this.rpc.request(type, { store: this.store, ...fields })
    } catch (error) {
      if (error instanceof RemoteError) {
        if (error.code === "mismatch") {
          throw new MarkdownVersionMismatch(String(error.reply.expected), String(error.reply.current))
        }
        if (error.code === "unknown_version" || error.code === "invalid") throw new RangeError(error.message)
        throw systemError(error.message, syscall)
      }
      if (error instanceof ChannelClosed) throw systemError(error.message, syscall)
      throw error
    }
  }
}

/** A Node system error, as a host store throws for a transport failure. */
function systemError(message: string, syscall: "read" | "write"): Error {
  return Object.assign(new Error(message), { code: "EIO", syscall })
}

/** A person's profile.md in the company clone as a yian MarkdownStore, versioned by git blob id. */
import { createHash } from "node:crypto"
import type { MarkdownStore } from "@ngocbh/yian"
import { Handle } from "@opencorp/protocol"
import { type CompanyGit, CompanyGitError, WHITESPACE } from "../company/git.ts"

/** The JSON object a `MarkdownStore` write carries as provenance. */
export type JsonObject = NonNullable<Parameters<MarkdownStore["write"]>[1]["provenance"]>

export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The git blob id of `data`. */
export function blobId(data: Uint8Array): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex")
}

/** `text` with each run of Python's whitespace as one space, and none at either end. */
function collapse(text: string): string {
  return text.split(WHITESPACE).filter(Boolean).join(" ")
}

/**
 * `profile(@<handle>): <source>`, with a `Commit-Id` trailer when `provenance` has one.
 *
 * `source` falls back to `from feedback on run <run_id>` (yian's provenance has a run id but no
 * source), then to `write`. Throws a RangeError for a commit id that isn't one token.
 */
export function commitMessage(handle: string, provenance: JsonObject | null | undefined): string {
  const commitId = commitIdOf(provenance)
  let source = provenance?.source
  const runId = provenance?.run_id
  if (!(typeof source === "string" && collapse(source))) {
    source = typeof runId === "string" && runId ? `from feedback on run ${runId}` : "write"
  }
  // One line, whatever the caller sent, so neither part can add a trailer.
  const subject = `profile(@${collapse(handle)}): ${collapse(source)}`
  return commitId === null ? subject : `${subject}\n\nCommit-Id: ${commitId}`
}

/** `provenance.commit_id`, or null; a RangeError if it isn't one token git's argv can carry. */
function commitIdOf(provenance: JsonObject | null | undefined): string | null {
  const value = provenance?.commit_id
  if (value === undefined || value === null) return null
  // A NUL fails the spawn and a lone surrogate would be rewritten on its way to git.
  if (typeof value === "string" && value && !WHITESPACE.test(value) && !value.includes("\0") && value.isWellFormed()) {
    return value
  }
  throw new RangeError(`commit_id must be a string without whitespace, not ${JSON.stringify(value) ?? String(value)}`)
}

/** A Node system error (code `EIO`) for storage that can't be reached, as yian's store contract asks. */
function systemError(messageOrError: string | Error, syscall: string): Error {
  const [message, cause] =
    typeof messageOrError === "string" ? [messageOrError, undefined] : [messageOrError.message, messageOrError]
  return Object.assign(new Error(message, { cause }), { code: "EIO", syscall })
}

/**
 * `people/<handle>/profile.md` in the company clone, as a yian `MarkdownStore`.
 *
 * Versions are git blob ids, and every version handed out is committed, so it stays readable.
 * The constructor does no I/O: the office builds one per request.
 */
export class GitProfileStore {
  readonly git: CompanyGit
  readonly handle: string
  readonly path: string

  constructor(git: CompanyGit, handle: string) {
    if (!Handle.safeParse(handle).success) throw new RangeError(`not a handle: ${JSON.stringify(handle)}`)
    this.git = git
    this.handle = handle
    this.path = `people/${handle}/profile.md`
  }

  /**
   * Returns `[text, version]`. Reading the current version commits pending hand edits first.
   *
   * Throws a RangeError for an unknown version or text that isn't UTF-8, and a Node system error
   * when git fails.
   */
  async read(version: string | null = null): Promise<readonly [string, string]> {
    if (version !== null) {
      const data = await this.#blob(version)
      if (data === null) throw new RangeError(`unknown profile version ${JSON.stringify(version)}`)
      return [this.#decode(data), version]
    }
    const [current, data] = await this.git
      .locked(async (locked) => {
        await locked.commitHandEdits()
        const current = await this.#current()
        return [current, await this.#blob(current)] as const
      })
      .catch((error: unknown) => {
        throw error instanceof CompanyGitError ? systemError(error, "read") : error
      })
    if (data === null) throw systemError(`blob ${current} of ${this.path} is missing from the clone`, "read")
    return [this.#decode(data), current]
  }

  /** The blob id of the profile at HEAD; a missing profile is the empty blob. */
  async #current(): Promise<string> {
    return (await this.git.blobId(this.path)) ?? EMPTY_BLOB
  }

  async #blob(version: string): Promise<Uint8Array | null> {
    // The empty blob is only in the object store once some empty file was committed.
    return version === EMPTY_BLOB ? new Uint8Array() : await this.git.readBlob(version)
  }

  /** `data` as UTF-8 text, a leading byte order mark kept; a RangeError if it isn't UTF-8. */
  #decode(data: Uint8Array): string {
    try {
      return UTF8.decode(data)
    } catch (error) {
      if (error instanceof TypeError) throw new RangeError(`${this.path} is not UTF-8`)
      throw error
    }
  }
}

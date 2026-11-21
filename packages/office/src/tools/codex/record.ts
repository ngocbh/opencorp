/** A Codex instrument's record (`../harness/record.ts`): `meta.json`, `conversation.log` and `trace.log` in the
 *  host's folder for it, Codex's messages labelled `Codex` and its entries `codex`'s; each command with its output,
 *  each file change with its diff, and each error in the trace. */
import { HarnessRecord, type RecordFile, markRecordInterrupted, readRecord } from "../harness/record.ts"
import { CODEX } from "./tools.ts"

/** One Codex session's record. */
export class CodexRecord extends HarnessRecord {
  /** Makes the record in `dir`, as `HarnessRecord` does, for a Codex session. */
  constructor(dir: string, meta: ConstructorParameters<typeof HarnessRecord>[2], options?: { keep?: number }) {
    super(CODEX, dir, meta, options)
  }
}

/** The Codex record in `dir`, read from its meta.json; null when `dir` holds none. */
export function readCodexRecord(dir: string): RecordFile | null {
  return readRecord(dir, "codex")
}

/** Marks the Codex record in `dir` interrupted if it is still running; whether it marked it. */
export function markInterrupted(dir: string): boolean {
  return markRecordInterrupted(dir, "codex")
}

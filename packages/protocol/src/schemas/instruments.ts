import { z } from "zod"
import { Timestamp, Ulid } from "./common"

/** A tool an agent works that the owner can watch and step into: a shell, or (later) a Codex or Claude Code session. */
export const Instrument = z.strictObject({
  id: Ulid,
  session_id: Ulid,
  kind: z.enum(["terminal", "codex", "claude"]),
  /** Its name in the list: `shell 1`. */
  name: z.string(),
  /** Who drives it: an agent's handle, or `opencorp`. */
  driver: z.string(),
  /** The sandbox it runs in. */
  profile: z.enum(["workspace", "ssh", "none"]),
  /** Whether it takes typed input (a PTY), or not (pipes). */
  interactive: z.boolean(),
  /** The PTY's size now, which every viewer draws at; null for pipes. */
  size: z.strictObject({ cols: z.int().min(1), rows: z.int().min(1) }).nullable().default(null),
  status: z.enum(["starting", "idle", "running", "waiting", "ended", "failed", "interrupted"]),
  /** While waiting: on what only the owner may answer. */
  waiting: z.enum(["secret", "approval"]).nullable().default(null),
  /** The command running now, as the agent or the owner ran it. */
  command: z.string().nullable().default(null),
  /** Why it failed, in words the owner can act on. */
  error: z.string().nullable().default(null),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type Instrument = z.input<typeof Instrument>

/** `instrument.output` data: raw terminal bytes, base64; `offset` is the byte offset of the first byte, counted from
 *  the instrument's start. A client applies only the bytes past what it has, however events were coalesced. */
export const InstrumentOutput = z.strictObject({ instrument_id: Ulid, offset: z.int().min(0), data: z.string() })
export type InstrumentOutput = z.input<typeof InstrumentOutput>

/** The owner's keys to a shell, as typed (control characters included). Never logged or recorded. */
export const InstrumentKeysRequest = z.strictObject({ data: z.string().min(1).max(4096) })
export type InstrumentKeysRequest = z.input<typeof InstrumentKeysRequest>

/** The size the owner's view draws a shell at, which its PTY then takes. */
export const InstrumentSizeRequest = z.strictObject({ cols: z.int().min(10).max(1000), rows: z.int().min(4).max(500) })
export type InstrumentSizeRequest = z.input<typeof InstrumentSizeRequest>

/** What the office still holds of a shell's raw output, for a client joining late: the bytes from `offset` to
 *  `end`, starting at a line. The client then applies `instrument.output` past `end`. */
export const InstrumentScreen = z.strictObject({ offset: z.int().min(0), end: z.int().min(0), data: z.string() })
export type InstrumentScreen = z.input<typeof InstrumentScreen>

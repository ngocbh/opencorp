import { z } from "zod"
import { Handle, Timestamp, Ulid } from "./common"

/** A tool an agent works that the owner can watch and step into: a shell, or a Codex or Claude Code session. */
export const Instrument = z.strictObject({
  /** A shell's own id. A Codex or Claude Code instrument's is its own session's, a child session of `session_id`
   *  (`Session.instrument_of`), which a client opens as a chat. */
  id: Ulid,
  session_id: Ulid,
  kind: z.enum(["terminal", "codex", "claude"]),
  /** Its name in the list: `shell 1`. */
  name: z.string(),
  /** Who drives it: an agent's handle, or `opencorp`, the built-in agent. */
  driver: Handle,
  /** The sandbox it runs in: an employee's workspace, the SSH-only profile, the harness profile Codex and Claude Code
   *  run in, or none, which only the owner allows. */
  profile: z.enum(["workspace", "ssh", "harness", "none"]),
  /** Whether it takes typed input (a PTY), or not (pipes). */
  interactive: z.boolean(),
  /** The PTY's size now, which every viewer draws at; null for pipes. */
  size: z.strictObject({ cols: z.int().min(1), rows: z.int().min(1) }).nullable().default(null),
  /** `starting` until it opens; then `idle` between commands, `running` a command, or `waiting` on the owner (see
   *  `waiting`). An `ended` or `failed` one stays listed, with its scrollback, until its host removes it
   *  (`instrument.removed`). Instruments live in the office's memory, so none outlives it: a command an office stop
   *  cut off is the record's to mark interrupted. */
  status: z.enum(["starting", "idle", "running", "waiting", "ended", "failed"]),
  /** While waiting: on what only the owner may answer. */
  waiting: z.enum(["secret", "approval"]).nullable().default(null),
  /** The command the agent is running now, as it ran it. Never built from the owner's keys, so what the owner types,
   *  a password at a prompt that doesn't echo included, never reaches it. */
  command: z.string().nullable().default(null),
  /** Why it failed, in words the owner can act on. */
  error: z.string().nullable().default(null),
  /** A shell's: a line the owner is part-way through holds it, refusing its driver's commands and keys until Enter runs
   *  it or Ctrl-C gives it back (at the shell's prompt, Ctrl-U or deleting it too). False at a secret prompt. */
  owner_typing: z.boolean().default(false),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type Instrument = z.input<typeof Instrument>

/** `instrument.output` data: raw terminal bytes, base64; `offset` is the byte offset of the first byte, counted from
 *  the instrument's start. A client applies only the bytes past what it has, however events were coalesced. An event
 *  whose `offset` is past what it has is a gap: the office dropped output it couldn't send in time, so the client reads
 *  the screen again (`InstrumentScreen`). */
export const InstrumentOutput = z.strictObject({ instrument_id: Ulid, offset: z.int().min(0), data: z.string() })
export type InstrumentOutput = z.input<typeof InstrumentOutput>

/** `instrument.removed` data: the instrument its host took out of the session's list. */
export const InstrumentRemoved = z.strictObject({ id: Ulid, session_id: Ulid })
export type InstrumentRemoved = z.input<typeof InstrumentRemoved>

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

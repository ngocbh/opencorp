/** Side chats: the person who asked a question, in a session of its own, talking it through with the human. */
import fs from "node:fs"
import path from "node:path"
import type { DiscussionEntry } from "@opencorp/protocol"
import { LIVE } from "../chat/state.ts"
import type { Transcript } from "../chat/transcript.ts"
import type { SessionRecord, Store } from "../store/store.ts"

export const EXIT_WORDS: ReadonlySet<string> = new Set(["/exit", "/quit", "/end"])
export const BACK_HINT = "use /back to return to the question"
/** The side session's seed, in its session dir: kept off `Session` so session events stay small. */
export const SEED_FILE = "seed.md"

/** Replaces the seed of the side session whose dir is `sessionDir` with `seed`, atomically, as a 0600 file in a
 *  0700 dir; a symlink at the seed's path is replaced, not followed. */
export function writeSeed(sessionDir: string, seed: string): void {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const tmp = path.join(sessionDir, `.${SEED_FILE}.${process.pid}.tmp`)
  fs.rmSync(tmp, { force: true }) // left by a crashed run with the same pid; the daemon is the only writer
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    fs.fchmodSync(fd, 0o600) // the umask may have narrowed it
    fs.writeFileSync(fd, seed)
    fs.fsyncSync(fd)
    const open = fd
    fd = undefined // so a failing close isn't closed again below, where an EBADF would hide its error
    fs.closeSync(open)
    fs.renameSync(tmp, path.join(sessionDir, SEED_FILE))
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/** The seed of the side session whose dir is `sessionDir`, or null if it has none. Throws when the seed's path is a
 *  symlink, or not a regular file of this user that others can't read or write. */
export function readSeed(sessionDir: string): string | null {
  const file = path.join(sessionDir, SEED_FILE)
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd: number
  try {
    // O_NONBLOCK so a FIFO planted in its place can't hang the open; fstat then refuses it.
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null
    throw error
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.uid !== process.geteuid!() || st.mode & 0o077) {
      throw new Error(`'${file}' must be a regular file private to its owner (mode 0600)`)
    }
    return fs.readFileSync(fd, "utf8")
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The discussion so far in the side session `sideSessionId`: each human message and each reply's final text, in
 * order. A reply still running (the session is busy or waiting and its last run's last reply hasn't finished) isn't
 * final yet, so its assistant messages are left out; a message queued behind it stays.
 */
export function discussion(
  store: Store,
  transcript: Pick<Transcript, "messages" | "runningReply">,
  sideSessionId: string,
): DiscussionEntry[] {
  const side = store.getSession(sideSessionId)
  if (side === undefined) return []
  const last = side.run_ids.at(-1)
  // Read before the messages: the worker appends to the log between the two reads, and this order can only drop a
  // reply that has just finished, never keep a partial one.
  const cut =
    (side.status === "busy" || side.status === "waiting") && last !== undefined ? transcript.runningReply(last) : null
  let messages = transcript.messages(side.id, side.run_ids)
  if (cut !== null) {
    messages = messages.filter((m) => !(m.role === "assistant" && m.id.startsWith(`${last}:`) && m.id >= cut))
  }
  const entries: DiscussionEntry[] = []
  for (const message of messages) {
    const texts = message.parts.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text] : []))
    if (texts.length === 0) continue
    if (message.role === "user") entries.push({ role: "user", text: texts.join("\n\n") })
    else entries.push({ role: "assistant", text: texts.at(-1)! })
  }
  return entries
}

/** True for a session with (or about to have) a live run. */
export function isLive(session: SessionRecord | undefined): boolean {
  return session !== undefined && LIVE.includes(session.status)
}

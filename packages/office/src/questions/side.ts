/** Side chats: the person who asked a question, in a session of its own, talking it through with the human. */
import fs from "node:fs"
import path from "node:path"
import type { DiscussionEntry } from "@opencorp/protocol"
import { LIVE } from "../chat/state.ts"
import type { Transcript } from "../chat/transcript.ts"
import { checkFolder, replaceFile } from "../secrets.ts"
import type { SessionRecord, Store } from "../store/store.ts"

export const EXIT_WORDS: ReadonlySet<string> = new Set(["/exit", "/quit", "/end"])
export const BACK_HINT = "use /back to return to the question"
/** The side session's seed, in its session dir: kept off `Session` so session events stay small. */
export const SEED_FILE = "seed.md"

// No folder lock on the seed: the daemon is its only writer, writing it once before the side session's first
// spawn, and the rename is atomic; `readSeed` stays sync because `turnContext` is a synchronous check.

/** Replaces the seed of the side session whose dir is `sessionDir` with `seed`, atomically, as a 0600 file; creates
 *  the dir 0700 if it's missing. A symlink at the seed's path is replaced, not followed. Throws `PrivateFileError`
 *  when the dir is a symlink, or not a directory of this user with mode 0700 or narrower. */
export function writeSeed(sessionDir: string, seed: string): void {
  // Resolved so a `/.` tail can't make lstat follow a symlinked folder.
  const dir = path.resolve(sessionDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  checkFolder(dir, "session folder")
  replaceFile(dir, SEED_FILE, seed)
}

/** The seed of the side session whose dir is `sessionDir`, or null if it has none. Throws `PrivateFileError` when
 *  the dir is a symlink, or not a directory of this user with mode 0700 or narrower, and throws when the seed's path
 *  is a symlink, or not a regular file of this user that others can't read or write. */
export function readSeed(sessionDir: string): string | null {
  const dir = path.resolve(sessionDir)
  try {
    checkFolder(dir, "session folder")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null
    throw error
  }
  const file = path.join(dir, SEED_FILE)
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
 * order. A reply still running (the session is starting, busy, waiting or ending and its last run's last reply
 * hasn't finished) isn't final yet, so its assistant messages are left out; a message queued behind it stays. A
 * first reply runs while the session is `starting`, and End's copy can land while it is `ending`. While a reopen
 * starts its new run (`starting`, the new run not added yet), a reply the last run left unfinished is left out too.
 */
export function discussion(
  store: Store,
  transcript: Pick<Transcript, "messages" | "runningReply">,
  sideSessionId: string,
): DiscussionEntry[] {
  const side = store.getSession(sideSessionId)
  if (side === undefined) return []
  const last = side.run_ids.at(-1)
  // Read before the messages, as the worker may append to the log between the two reads: a reply that finishes in
  // between is left out (Python's conservative outcome). Only a reply that both starts and records text in between
  // could show early, and the reads are microseconds apart.
  const running = ["starting", "busy", "waiting", "ending"].includes(side.status)
  const cut = running && last !== undefined ? transcript.runningReply(last) : null
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

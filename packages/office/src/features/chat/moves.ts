/** The moves of a chat's unread messages between its inbox and its queue that may not have finished. */
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { replaceFile } from "../../util/private_files.ts"

/**
 * A move of an unread message between a chat's inbox and its queue: its run, the send's seq there, the inbox it was in
 * (`from`), the one it goes to (`to`), the person who moved it, their own message, and whether its send there failed
 * and it goes `back` instead. A move is a withdraw, then a send, which yian can't do in one step yet (yian#1831): it
 * is recorded before the withdraw, again before a send back, and dropped once the message is where it goes or back
 * where it was, so an office stop between the steps finishes or reverses it at the next start, never both.
 */
export const Move = z.strictObject({
  run_id: z.string().min(1),
  seq: z.number().int().positive(),
  from: z.string().min(1),
  to: z.string().min(1),
  by: z.string().min(1),
  back: z.boolean().default(false),
})
export type Move = z.output<typeof Move>

/** The file in a session's folder that holds its moves. */
const FILE = "moves.json"

/** The moves recorded in session folder `folder`; none when the file is missing or isn't a list of moves. */
export function readMoves(folder: string): Move[] {
  let text: string
  try {
    text = fs.readFileSync(path.join(folder, FILE), "utf8")
  } catch {
    return []
  }
  try {
    const parsed = z.array(Move).safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** Records `moves` in session folder `folder`, as a private file replaced at once; the actor is its only writer. */
export function writeMoves(folder: string, moves: readonly Move[]): void {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  replaceFile(folder, FILE, JSON.stringify(moves))
}

/** Whether `a` and `b` are the move of the same send. */
export function sameMove(a: Move, b: Move): boolean {
  return a.run_id === b.run_id && a.seq === b.seq
}

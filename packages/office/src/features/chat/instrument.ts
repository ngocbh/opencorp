/** An employee's harness instrument: the sessions of one harness (Codex, Claude Code) a main chat's employee drives
 *  (`HarnessInstrument`), each the chat's own child session (its sessions' `startInstrument`), under the employee's
 *  permission, with the owner's word winning; each listed as the chat's instrument, with its record in the chat's
 *  `<kind>/<session id>/` folder. After an office restart, a session the stop cut off continues on the employee's next
 *  message, the same child session on the harness's own session (its sessions' `resumeInstrument`). The note of a turn
 *  the employee was told runs on, once it ends, goes to the session's actor (`onEnded`), and after a restart the actor
 *  holds a note of each one still owed (`restoreHarnessNotes`). */
import fs from "node:fs"
import path from "node:path"
import type { Instruments } from "../../runtime/sessions/instruments.ts"
import { HarnessError } from "../../runtime/sessions/state.ts"
import type { SessionRecord, Store } from "../../runtime/store/store.ts"
import { CLAUDE } from "../../tools/claude/instrument.ts"
import { CODEX } from "../../tools/codex/tools.ts"
import {
  HarnessInstrument,
  HarnessStopping,
  type HarnessThread,
  restoredNote,
  type ThreadEvents,
  type TurnEnded,
} from "../../tools/harness/instrument.ts"
import { loadRecord } from "../../tools/harness/record.ts"
import type { Harness } from "../../tools/harness/tools.ts"
import { checkFolder, makePrivateFolder } from "../../util/private_files.ts"

/** The office's sessions of one harness, where each of a chat's instrument sessions runs. */
export interface InstrumentSessions {
  readonly store: Pick<Store, "getSession">
  readonly log: (line: string) => void
  startInstrument(
    chat: SessionRecord,
    id: string,
    o: { observer: ThreadEvents; label: (author: string | null) => string; owner: string | null },
  ): Promise<unknown>
  resumeInstrument(
    chat: SessionRecord,
    id: string,
    harnessSessionId: string,
    o: { observer: ThreadEvents; label: (author: string | null) => string; owner: string | null },
  ): Promise<unknown>
  /** Lets the owner's message to session `id`, which an office restart cut off, continue it through `resume`. */
  resumable(id: string, resume: ((by: string | null) => Promise<void>) | null): void
  prompt(sessionId: string, text: string, options: { by: string | null }): Promise<unknown>
  interrupt(sessionId: string): Promise<void>
  end(sessionId: string): Promise<void>
}

/** What a chat's harness instrument is made from; the agent sets none of it. */
export interface EmployeeInstrumentOptions {
  /** The main chat whose employee drives it. */
  readonly chat: SessionRecord
  /** The office's sessions of the harness, where each of its sessions runs. */
  readonly sessions: InstrumentSessions
  /** The chat's folder; the records go to its `<kind>/<session id>/`. */
  readonly folder: string
  /** The office's live instruments, where each session is listed. */
  readonly instruments: Pick<Instruments, "add" | "updated" | "remove">
  /** The chat's owner, and how each author is named (`speakers`). */
  readonly speakers: { readonly owner: string | null; label(author: string | null): string }
}

/** The notes a restart may have cost the chat at `folder`: each note of a turn's end a Codex or Claude Code session's
 *  record still owes the employee, as it was written, or `restoredNote` for a turn the stop cut off, under that note's
 *  key, so a note the run already has is never sent twice, and signed by the session's name. Oldest session first,
 *  each one's notes in order. A record that can't be read gives none. */
export function restoreHarnessNotes(folder: string): { text: string; key: string; author: string }[] {
  return [CODEX, CLAUDE].flatMap((harness) => {
    const dir = path.join(folder, harness.kind)
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const sessions: { notes: { text: string; key: string; author: string }[]; started: string }[] = []
    for (const name of names) {
      let record: ReturnType<typeof loadRecord>
      try {
        record = loadRecord(harness, path.join(dir, name))
      } catch {
        continue
      }
      const { meta } = record
      const notes = (meta.told ?? []).map(({ key, text }) => ({
        text: text ?? restoredNote(harness, meta, key), key, author: meta.name,
      }))
      sessions.push({ notes, started: meta.started })
    }
    sessions.sort((a, b) => a.started.localeCompare(b.started))
    return sessions.flatMap((session) => session.notes)
  })
}

/** A main chat's instrument of one harness, as its harness binds it (see the module). */
export class EmployeeInstrument {
  readonly #instrument: HarnessInstrument
  /** Who gets the notes of turns that ended: the session's actor. */
  #onEnded: ((note: TurnEnded) => void) | null = null

  constructor(harness: Harness, o: EmployeeInstrumentOptions) {
    const { chat, sessions, instruments, speakers } = o
    const driver = chat.person
    this.#instrument = new HarnessInstrument(harness, {
      sessionId: chat.id,
      driver,
      owner: speakers.owner,
      label: (author) => speakers.label(author),
      open: async (id, _name, events, { resume } = {}): Promise<HarnessThread> => {
        const of = { observer: events, label: speakers.label, owner: speakers.owner }
        try {
          if (resume === undefined) await sessions.startInstrument(chat, id, of)
          else await sessions.resumeInstrument(chat, id, resume, of)
        } catch (error) {
          // The office is stopping: a session it was to continue waits for the next start.
          if (error instanceof HarnessError && error.status === 503) throw new HarnessStopping(error.message)
          throw error
        }
        return {
          send: (text) => sessions.prompt(id, text, { by: driver }),
          interrupt: () => sessions.interrupt(id),
          stop: () => sessions.end(id),
          harnessSessionId: () => sessions.store.getSession(id)?.harness_session_id ?? null,
        }
      },
      recordsDir: () => {
        const records = path.join(o.folder, harness.kind)
        for (const dir of [o.folder, records]) {
          makePrivateFolder(dir)
          checkFolder(dir, "folder")
        }
        return records
      },
      log: (line) => sessions.log(line),
      resumable: (id, resume) => sessions.resumable(id, resume),
      list: (listing) => instruments.add(chat.id, listing),
      changed: (id) => instruments.updated(chat.id, id),
      remove: (id) => instruments.remove(chat.id, id),
      ended: (note) => this.#onEnded?.(note),
    })
  }

  /** Gives `listener` (the session's actor) the note of each turn the employee was told runs on, once it ends; it
   *  replaces any listener before it. */
  onEnded(listener: (note: TurnEnded) => void): void {
    this.#onEnded = listener
  }

  /** The run has the note under `key`: the session's record owes it no more, so a restart never sends it again. */
  delivered(key: string): void {
    this.#instrument.delivered(key)
  }

  /** A message for the employee arrived: the replies its calls wait on come now, the turns going on. */
  messageArrived(): void {
    this.#instrument.messageArrived()
  }

  /** The model-facing tools: the harness's group. */
  tools(): ReturnType<HarnessInstrument["tools"]> {
    return this.#instrument.tools()
  }

  /** The chat's run stopped (its worker died, or the cost cap stopped it): ends every call's wait, and interrupts each
   *  turn a call waited on that the employee started. */
  cutCalls(): void {
    this.#instrument.cutCalls()
  }

  /** The chat ended: ends every session of the chat, those an office restart left too, and takes its listing out. */
  close(): Promise<void> {
    return this.#instrument.close()
  }

  /** The office stops, having stopped the harness sessions: each live one's record waits for the next start to
   *  continue it, and the listings go. */
  suspend(): Promise<void> {
    return this.#instrument.suspend()
  }
}

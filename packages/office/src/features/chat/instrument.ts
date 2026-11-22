/** An employee's harness instrument: the sessions of one harness (Codex, Claude Code) a main chat's employee drives
 *  (`HarnessInstrument`), each the chat's own child session (its sessions' `startInstrument`), under the employee's
 *  permission, with the owner's word winning; each listed as the chat's instrument, with its record in the chat's
 *  `<kind>/<session id>/` folder. After an office restart, a session the stop cut off continues on the employee's next
 *  message, the same child session on the harness's own session (its sessions' `resumeInstrument`). */
import path from "node:path"
import type { Instruments } from "../../runtime/sessions/instruments.ts"
import type { SessionRecord, Store } from "../../runtime/store/store.ts"
import { HarnessInstrument, type HarnessThread, type ThreadEvents } from "../../tools/harness/instrument.ts"
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

/** A main chat's instrument of one harness, as its harness binds it (see the module). */
export class EmployeeInstrument {
  readonly #instrument: HarnessInstrument

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
        if (resume === undefined) await sessions.startInstrument(chat, id, of)
        else await sessions.resumeInstrument(chat, id, resume, of)
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
      list: (listing) => instruments.add(chat.id, listing),
      changed: (id) => instruments.updated(chat.id, id),
      remove: (id) => instruments.remove(chat.id, id),
    })
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

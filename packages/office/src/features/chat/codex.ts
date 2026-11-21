/** An employee's Codex instrument: the Codex sessions a main chat's employee drives (`CodexInstrument`), each the
 *  chat's own child session (`CodexSessions.startInstrument`), on a thread under the employee's permission, with the
 *  owner's word winning; each listed as the chat's instrument, with its record in the chat's `codex/<session id>/`
 *  folder. */
import path from "node:path"
import type { CodexSessions } from "../codex/sessions.ts"
import type { Instruments } from "../../runtime/sessions/instruments.ts"
import type { SessionRecord } from "../../runtime/store/store.ts"
import { CodexInstrument, type CodexThread } from "../../tools/codex/instrument.ts"
import { checkFolder, makePrivateFolder } from "../../util/private_files.ts"

/** What a chat's Codex instrument is made from; the agent sets none of it. */
export interface EmployeeCodexOptions {
  /** The main chat whose employee drives it. */
  readonly chat: SessionRecord
  /** The office's Codex sessions, where each of its sessions runs. */
  readonly sessions: Pick<CodexSessions, "startInstrument" | "prompt" | "interrupt" | "end">
  /** The chat's folder; the records go to its `codex/<session id>/`. */
  readonly folder: string
  /** The office's live instruments, where each session is listed. */
  readonly instruments: Pick<Instruments, "add" | "updated" | "remove">
  /** The chat's owner, and how each author is named (`speakers`). */
  readonly speakers: { readonly owner: string | null; label(author: string | null): string }
}

/** A main chat's Codex instrument, as its harness binds it (see the module). */
export class EmployeeCodex {
  readonly #codex: CodexInstrument

  constructor(o: EmployeeCodexOptions) {
    const { chat, sessions, instruments, speakers } = o
    const driver = chat.person
    this.#codex = new CodexInstrument({
      sessionId: chat.id,
      driver,
      owner: speakers.owner,
      label: (author) => speakers.label(author),
      open: async (id, _name, events): Promise<CodexThread> => {
        await sessions.startInstrument(chat, id, { observer: events, label: speakers.label, owner: speakers.owner })
        return {
          send: (text) => sessions.prompt(id, text, { by: driver }),
          interrupt: () => sessions.interrupt(id),
          stop: () => sessions.end(id),
        }
      },
      recordDir: (id) => {
        const records = path.join(o.folder, "codex")
        for (const dir of [o.folder, records]) {
          makePrivateFolder(dir)
          checkFolder(dir, "folder")
        }
        return path.join(records, id)
      },
      list: (listing) => instruments.add(chat.id, listing),
      changed: (id) => instruments.updated(chat.id, id),
      remove: (id) => instruments.remove(chat.id, id),
    })
  }

  /** The model-facing tools: the `codex` group. */
  tools(): ReturnType<CodexInstrument["tools"]> {
    return this.#codex.tools()
  }

  /** The chat's run stopped (its worker died, or the cost cap stopped it): ends every call's wait, and interrupts each
   *  Codex turn a call waited on that the employee started. */
  cutCalls(): void {
    this.#codex.cutCalls()
  }

  /** Ends every Codex session of the chat and takes its listing out. */
  close(): Promise<void> {
    return this.#codex.close()
  }
}

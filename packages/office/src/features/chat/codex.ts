/** An employee's Codex instrument: the Codex sessions a main chat's employee drives (`EmployeeInstrument`), each the
 *  chat's own child session (`CodexSessions.startInstrument`), on a thread under the employee's permission, with the
 *  owner's word winning; each listed as the chat's instrument, with its record in the chat's `codex/<session id>/`
 *  folder. */
import { CODEX } from "../../tools/codex/tools.ts"
import { EmployeeInstrument, type EmployeeInstrumentOptions } from "./instrument.ts"

/** A main chat's Codex instrument, as its harness binds it. */
export class EmployeeCodex extends EmployeeInstrument {
  constructor(o: EmployeeInstrumentOptions) {
    super(CODEX, o)
  }
}

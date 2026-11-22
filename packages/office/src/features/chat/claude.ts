/** An employee's Claude Code instrument: the Claude Code sessions a main chat's employee drives (`EmployeeInstrument`),
 *  each the chat's own child session (`ClaudeSessions.startInstrument`), its Claude Code under the employee's
 *  permission, with the owner's word winning; each listed as the chat's instrument, with its record in the chat's
 *  `claude/<session id>/` folder. */
import { CLAUDE } from "../../tools/claude/instrument.ts"
import { EmployeeInstrument, type EmployeeInstrumentOptions } from "./instrument.ts"

/** A main chat's Claude Code instrument, as its harness binds it. */
export class EmployeeClaude extends EmployeeInstrument {
  constructor(o: EmployeeInstrumentOptions) {
    super(CLAUDE, o)
  }
}

/** The Codex instrument: one chat's Codex sessions, by name, as its host binds them (`../harness/instrument.ts`, in
 *  Codex's words). Each session is its own Codex thread, opened under the employee's permission by the host. */
import { type HarnessHost, HarnessInstrument } from "../harness/instrument.ts"
import { CODEX } from "./tools.ts"

export {
  type HarnessHost as CodexHost,
  type HarnessListing as CodexListing,
  type HarnessThread as CodexThread,
  type HarnessTool as CodexTool,
  MAX_LIVE,
  PAGE_CHARS,
  type ThreadEvents,
  type ThreadState,
} from "../harness/instrument.ts"

/** One chat's Codex sessions, as its host binds them, and the tools the agent works them with. */
export class CodexInstrument extends HarnessInstrument {
  constructor(host: HarnessHost) {
    super(CODEX, host)
  }
}

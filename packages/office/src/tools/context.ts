/** What a run can offer its host tools. */
// Types only: perm/monitor.ts type-imports tools/workspace.ts, which imports this module, so nothing here may
// load at runtime.
import type { CompanyRepo } from "../company/loader.ts"
import type { Monitor } from "../perm/monitor.ts"
import type { Carried, OnQuestion } from "../questions/ask.ts"
import type { QuestionRecord, SessionRecord, Store } from "../store/store.ts"
import type { WorkspaceTools } from "./workspace.ts"

/**
 * What one run can offer its tools; each group offers only the tools whose needs are set.
 *
 * `session.person` is who the tools act for. `repo` is the run's pinned company repo. `monitor` audits workspace
 * calls and holds the asset grants. `readOnly` limits `workspace` to its read tools. `question` is what a side
 * chat is about.
 */
export interface ToolContext {
  readonly store?: Store
  readonly repo?: CompanyRepo
  readonly session?: SessionRecord
  readonly runId?: string | null
  readonly onQuestion?: OnQuestion
  readonly carried?: Carried
  readonly monitor?: Monitor
  /** What `Monitor.workspace` takes, so a stand-in fits. */
  readonly workspace?: Pick<WorkspaceTools, "call">
  readonly readOnly?: boolean
  readonly question?: QuestionRecord
}

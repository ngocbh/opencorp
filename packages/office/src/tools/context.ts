/** What a run can offer its host tools. */
// Types only: this module names the office objects a run hands its tools, and loads none of them.
import type { CompanyRepo } from "../company/loader.ts"
import type { Monitor } from "../runtime/permissions/monitor.ts"
import type { Carried, OnQuestion } from "../runtime/questions/ask.ts"
import type { QuestionRecord, SessionRecord, Store } from "../runtime/store/store.ts"
import type { OfficeTool } from "../runtime/worker/rpc.ts"
import type { Terminal } from "./terminal/terminal.ts"
import type { WorkspaceTools } from "./workspace.ts"

/**
 * What one run can offer its tools; each group offers only the tools whose needs are set.
 *
 * `session.person` is who the tools act for. `repo` is the run's pinned company repo. `monitor` holds the asset
 * grants. `readOnly` limits `workspace` to its read tools. `question` is what a side chat is about. `terminal` is the
 * session's shells, as its host binds them: their sandbox and permissions.
 */
export interface ToolContext {
  readonly store?: Store
  readonly repo?: CompanyRepo
  readonly session?: SessionRecord
  readonly runId?: string | null
  readonly onQuestion?: OnQuestion
  readonly carried?: Carried
  readonly monitor?: Monitor
  /** The workspace's file tools, by name: `WorkspaceTools.call`, so a stand-in fits. */
  readonly workspace?: Pick<WorkspaceTools, "call">
  readonly readOnly?: boolean
  readonly question?: QuestionRecord
  /** What the `terminal` group offers: the tools of the session's terminal. */
  readonly terminal?: Pick<Terminal, "tools">
  /** What the `codex` group offers: the tools of the session's Codex instrument. */
  readonly codex?: { tools(): Record<string, OfficeTool> }
  /** What the `claude` group offers: the tools of the session's Claude Code instrument. */
  readonly claude?: { tools(): Record<string, OfficeTool> }
}

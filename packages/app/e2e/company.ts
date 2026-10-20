// Fixture data for Playwright: a company, its live sessions, open cards, costs and work items.
import type { CompanyView, CostReport, Person, Question, Session, WorkItem } from "@opencorp/protocol"

export const SHA = "0123456789abcdef0123456789abcdef01234567"
export const T = "2026-10-19T10:00:00.000Z"

export type Data = {
  view: CompanyView
  sessions: Session[]
  questions: Question[]
  costs: CostReport["people"]
  workItems: Record<string, WorkItem>
}

export const person = (handle: string, name: string, kind: Person["kind"], title: string, manager: string | null,
  groups: string[] = []): Person =>
  ({ handle, name, kind, title, manager, groups, devices: [], password_hash: null, home_office: "mac", harnesses: ["composer"] })

export const session = (id: string, who: string, status: Session["status"], over: Partial<Session> = {}): Session =>
  ({ id, person: who, harness: "composer", office: "mac", cwd: "/work", repo_commit: SHA, status, kind: "main",
     created_at: T, updated_at: T, ...over })

export const card = (id: string, sessionId: string, asker: string, over: Partial<Question> = {}): Question =>
  ({ id, session_id: sessionId, run_id: "r1", node_id: null, source: "ask_user", asker, question: "Which one?",
     status: "open", created_at: T, updated_at: T, ...over })

export const item = (id: string, title: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title, kind: "task", status: "in_progress", requester: "ngocbh", created_at: T, updated_at: T, ...over })

/**
 * Acme: the CEO @ngocbh (human); @lead (agent, head of ENG) with @minh (also in OPS) and @kai under them; @ann
 * (human); @zoe, whose manager doesn't exist (unplaced); a file that doesn't parse. @minh is busy in Codex, @kai is
 * idle with a card for the CEO, @lead is idle with an ask_manager card whose work item W1 the CEO is assigned.
 */
export function acme(): Data {
  const people = [
    person("ngocbh", "Ngoc", "human", "CEO", null),
    person("lead", "Lead", "agent", "Tech lead", "ngocbh", ["eng"]),
    person("minh", "Minh", "agent", "Engineer", "lead", ["eng", "ops"]),
    person("kai", "Kai", "agent", "Engineer", "lead", ["eng"]),
    person("ann", "Ann", "human", "Designer", "ngocbh"),
    person("zoe", "Zoe", "agent", "Analyst", "ghost"),
  ]
  return {
    view: {
      sha: SHA,
      company: { name: "Acme", ceo: "ngocbh" },
      people,
      groups: [{ id: "eng", name: "ENG", parent: null, head: "lead" }, { id: "ops", name: "OPS", parent: "eng", head: null }],
      issues: [{ path: "people/bad/person.yaml", code: "repo.schema", message: "kind: isn't an allowed value", severity: "error" }],
    },
    sessions: [
      session("S-minh", "minh", "busy", { harness: "codex", work_item_id: "W-minh" }),
      session("S-kai", "kai", "idle", { opened_by: "ngocbh", cost: 0.42 }),
      session("S-lead", "lead", "idle", { cost: 0 }),
    ],
    questions: [card("Q-kai", "S-kai", "kai"), card("Q-lead", "S-lead", "lead", { source: "ask_manager", work_item_id: "W1" })],
    costs: { minh: { usd: 0, unpriced_sessions: 1 }, kai: { usd: 0.42, unpriced_sessions: 0 } },
    workItems: {
      W1: item("W1", "Pick a database", { kind: "question", requester: "lead", assignee: "ngocbh" }),
      "W-minh": item("W-minh", "Fix the build", { assignee: "minh" }),
    },
  }
}

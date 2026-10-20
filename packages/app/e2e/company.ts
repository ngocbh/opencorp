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

/** Acme, with its CEO only. */
export function acme(): Data {
  return {
    view: { sha: SHA, company: { name: "Acme", ceo: "ngocbh" }, people: [person("ngocbh", "Ngoc", "human", "CEO", null)],
            groups: [], issues: [] },
    sessions: [],
    questions: [],
    costs: {},
    workItems: {},
  }
}

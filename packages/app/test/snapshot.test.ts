import { expect, test } from "bun:test"
import { emptyState } from "@opencorp/client"
import { hqSnapshot, LIVE } from "../src/data/snapshot"

test("HQ's snapshot reads the company, live sessions, open questions and costs, and replaces them", async () => {
  const asked: unknown[] = []
  const client: any = {
    company: { get: async () => ({ sha: "s1", company: { name: "Acme", ceo: "ngocbh" }, people: [], groups: [], issues: [] }) },
    sessions: { list: async (o: unknown) => (asked.push(o), [{ id: "S1", status: "busy", updated_at: "2026-10-19T10:00:00.000Z" }]) },
    questions: { list: async (o: unknown) => (asked.push(o), []) },
    costs: { since: async (s: string) => ({ since: s, people: {} }) },
  }
  const s = emptyState()
  s.questions.old = { id: "old", status: "open" } as any
  s.sessions = [{ id: "gone", status: "idle", updated_at: "2026-10-19T09:00:00.000Z" } as any]
  ;(await hqSnapshot(() => "2026-10-19T00:00:00.000Z")(client))(s)
  expect([s.company?.name, s.sessions.map((x) => x.id), Object.keys(s.questions), s.costs?.since]).toEqual([
    "Acme", ["S1"], [], "2026-10-19T00:00:00.000Z"])
  expect(asked).toEqual([{ status: LIVE, limit: 500 }, { status: "open" }])
})

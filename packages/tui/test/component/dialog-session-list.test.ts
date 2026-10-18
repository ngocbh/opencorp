import type { Person, Session } from "@opencorp/protocol"
import { describe, expect, test } from "bun:test"
import { listedSessions, sessionCategory, sessionRow } from "../../src/component/dialog-session-list"
import { Locale } from "../../src/util/locale"

const now = Date.parse("2026-09-30T12:00:00Z")
const ago = (ms: number) => new Date(now - ms).toISOString()
const people: Person[] = [
  { handle: "minh", name: "Minh", kind: "agent", title: "Software engineer", manager: null },
]

function session(id: string, fields: Partial<Session> = {}): Session {
  return {
    id,
    person: "minh",
    harness: "composer",
    office: "laptop",
    cwd: "/tmp/proj",
    repo_commit: "c",
    status: "idle",
    kind: "main",
    cost: 0,
    cost_cap_usd: null,
    created_at: ago(0),
    updated_at: ago(0),
    ...fields,
  }
}

describe("dialog session list", () => {
  test("lists main sessions newest first, in cwd when given", () => {
    const sessions = [
      session("a", { updated_at: ago(60_000) }),
      session("b", { updated_at: ago(1_000), cwd: "/tmp/other" }),
      session("c", { updated_at: ago(0), kind: "side" }),
      session("d", { updated_at: ago(5_000) }),
    ]
    expect(listedSessions(sessions).map((s) => s.id)).toEqual(["b", "d", "a"])
    expect(listedSessions(sessions, "/tmp/proj").map((s) => s.id)).toEqual(["d", "a"])
  })

  test("a row shows the person, the folder with home abbreviated, and the age", () => {
    const s = session("a", { updated_at: ago(5 * 60_000) })
    expect(sessionRow(s, people, { now, home: "/home/me" })).toBe("@minh · /tmp/proj · 5m ago")
    const mine = session("b", { cwd: "/home/me/code/app", person: "gone", updated_at: ago(3 * 3600_000) })
    expect(sessionRow(mine, people, { now, home: "/home/me" })).toBe("gone · ~/code/app · 3h ago")
  })

  test("sessions group under Today or their date", () => {
    expect(sessionCategory(session("a", { updated_at: ago(60_000) }), now)).toBe("Today")
    const old = ago(3 * 86400_000)
    expect(sessionCategory(session("a", { updated_at: old }), now)).toBe(new Date(old).toDateString())
  })

  test("relative times", () => {
    expect(Locale.relative(now - 10_000, now)).toBe("just now")
    expect(Locale.relative(now - 5 * 60_000, now)).toBe("5m ago")
    expect(Locale.relative(now - 2 * 86400_000, now)).toBe("2d ago")
    expect(Locale.relative(now - 30 * 86400_000, now)).toBe(Locale.datetime(now - 30 * 86400_000))
  })
})

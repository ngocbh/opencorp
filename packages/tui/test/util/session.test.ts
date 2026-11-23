// The upstream TUI's session family, ported with a child's parent read from `instrument_of`; and what a link to a
// session says, in place of upstream's title.
import { describe, expect, test } from "bun:test"
import { sessionFamily, sessionLabels } from "../../src/util/session"

describe("util.session", () => {
  test("flattens nested children from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", instrument_of: "root" },
      { id: "grandchild-a", instrument_of: "child-a" },
      { id: "great-grandchild-a", instrument_of: "grandchild-a" },
      { id: "grandchild-a2", instrument_of: "child-a" },
      { id: "child-b", instrument_of: "root" },
      { id: "grandchild-b", instrument_of: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("a session the list doesn't hold has no family", () => {
    expect(sessionFamily([{ id: "root" }, { id: "child", instrument_of: "root" }], "gone")).toEqual([])
  })

  test("a session's label is its person and its name, a Codex or Claude Code session's from its chat's list", () => {
    const labels = sessionLabels({
      people: [{ handle: "minh" }, { handle: "ngocbh" }],
      sessions: [
        { id: "chat", person: "minh", kind: "main", harness: "yian", instrument_of: null },
        { id: "codex", person: "minh", kind: "instrument", harness: "codex", instrument_of: "chat" },
        // Not in its chat's list yet: its harness names it.
        { id: "claude", person: "minh", kind: "instrument", harness: "claude", instrument_of: "chat" },
        { id: "side", person: "minh", kind: "side", harness: "yian" },
        { id: "profile", person: "minh", kind: "profile_manager", harness: "yian" },
        // Someone the office no longer lists, by their bare handle, as the session list names them.
        { id: "gone", person: "thanh", kind: "main", harness: "yian" },
      ],
      instruments: { chat: [{ id: "codex", name: "codex 1" }] },
    })
    expect(Object.fromEntries(labels)).toEqual({
      chat: "@minh · chat",
      codex: "@minh · codex 1",
      claude: "@minh · Claude Code session",
      side: "@minh · side chat",
      profile: "@minh · profile",
      gone: "thanh · chat",
    })
  })

  test("a name the office sends with control characters shows them printable", () => {
    const labels = sessionLabels({
      people: [{ handle: "minh" }],
      sessions: [{ id: "codex", person: "minh", kind: "instrument", harness: "codex", instrument_of: "chat" }],
      instruments: { chat: [{ id: "codex", name: "codex\u001b[31m 1" }] },
    })
    expect(labels.get("codex")).not.toContain("\u001b")
  })
})

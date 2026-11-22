// The upstream TUI's session family, ported with a child's parent read from `instrument_of`.
import { describe, expect, test } from "bun:test"
import { sessionFamily } from "../../src/util/session"

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
})

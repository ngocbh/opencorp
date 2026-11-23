/** @jsxImportSource @opentui/solid */
// The picker's tabs, ported from the upstream TUI's: a fixed order, the active tab kept while tabs come and go, and the
// tab it opens on, the first with something running. Ours are Sessions (the chat's Codex and Claude Code sessions) and
// Shell (its shells).
import type { Instrument, Session } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { busyCounts, busyTab, createComposerTabs, harnessFamily } from "../../../src/routes/session/composer/tabs"

async function setup(defaultTab?: string) {
  const [open, setOpen] = createSignal(false)
  let tabs!: ReturnType<typeof createComposerTabs>
  const app = await testRender(
    () => {
      tabs = createComposerTabs({ open, defaultTab: () => defaultTab })
      return <text>{tabs.active()}</text>
    },
    { width: 20, height: 1 },
  )
  return { app, tabs, setOpen }
}

test("composer tabs keep a canonical order and the active tab while a tab comes and goes", async () => {
  const { app, tabs, setOpen } = await setup()
  try {
    tabs.register({ id: "shell", label: "Shell" })
    tabs.register({ id: "subagents", label: "Sessions" })
    setOpen(true)
    expect(tabs.active()).toBe("subagents")
    tabs.setActive("shell")
    expect(tabs.list().map((tab) => tab.id)).toEqual(["subagents", "shell"])

    const remove = tabs.register({ id: "other", label: "Other" })
    expect(tabs.list().map((tab) => tab.id)).toEqual(["subagents", "shell", "other"])
    expect(tabs.active()).toBe("shell")
    remove()
    expect(tabs.active()).toBe("shell")

    const again = tabs.register({ id: "other", label: "Other" })
    tabs.setActive("other")
    again()
    expect(tabs.active()).toBe("subagents")
  } finally {
    app.renderer.destroy()
  }
})

test("composer tabs open on the requested tab", async () => {
  const { app, tabs, setOpen } = await setup("shell")
  try {
    tabs.register({ id: "subagents", label: "Sessions" })
    tabs.register({ id: "shell", label: "Shell" })
    setOpen(true)
    expect(tabs.active()).toBe("shell")
  } finally {
    app.renderer.destroy()
  }
})

test("composer tabs switch to the requested tab once it registers, until the user picks one", async () => {
  const { app, tabs, setOpen } = await setup("shell")
  try {
    tabs.register({ id: "subagents", label: "Sessions" })
    setOpen(true)
    expect(tabs.active()).toBe("subagents")
    tabs.register({ id: "shell", label: "Shell" })
    expect(tabs.active()).toBe("shell")
    tabs.setActive("subagents")
    tabs.register({ id: "other", label: "Other" })
    expect(tabs.active()).toBe("subagents")
  } finally {
    app.renderer.destroy()
  }
})

const AT = "2026-11-20T10:00:00.000Z"
const ids = { chat: "01JA1K0000000000000000CHAT", a: "01JA1K00000000000000000AAA", b: "01JA1K00000000000000000BBB" }

/** A session of the chat's family, as the store holds it. */
function session(id: string, fields: Partial<Session>): Session {
  return {
    id, person: "minh", harness: "yian", office: "laptop", cwd: "/tmp/proj", repo_commit: "a".repeat(40),
    status: "idle", kind: "main", cost: 0, cost_cap_usd: null, created_at: AT, updated_at: AT, ...fields,
  } as Session
}

/** An instrument of the chat, as its list names it. */
function listed(id: string, fields: Partial<Instrument>): Instrument {
  return {
    id, session_id: ids.chat, kind: "terminal", name: "shell 1", driver: "minh", profile: "workspace",
    interactive: true, status: "running", created_at: AT, updated_at: AT, ...fields,
  }
}

test("the family is the chat's Codex and Claude Code sessions, those the store doesn't hold yet from the chat's list", () => {
  const sessions = [
    session(ids.chat, {}),
    session(ids.a, { harness: "codex", kind: "instrument", instrument_of: ids.chat, status: "ended" }),
  ]
  const instruments = {
    [ids.chat]: [
      listed("01JA1K0000000000000000SHEL", {}),
      listed(ids.a, { kind: "codex", name: "codex 1", profile: "harness", status: "ended" }),
      listed(ids.b, { kind: "claude", name: "claude 1", profile: "harness", status: "running", created_at: "2026-11-20T10:01:00.000Z" }),
    ],
  }
  const family = harnessFamily({ sessions, instruments }, ids.chat)
  expect(family.map(({ sessionID, harness, name, state, prefix }) => ({ sessionID, harness, name, state, prefix }))).toEqual([
    { sessionID: ids.a, harness: "codex", name: "codex 1", state: "ended", prefix: "" },
    { sessionID: ids.b, harness: "claude", name: "claude 1", state: "running", prefix: "" },
  ])
  // From a child, the same family.
  expect(harnessFamily({ sessions, instruments }, ids.a).map((e) => e.sessionID)).toEqual([ids.a, ids.b])
})

test("the picker opens on the first busy tab, else Sessions", () => {
  const family = (state: "running" | "idle" | "ended") => [
    { sessionID: ids.a, harness: "codex" as const, name: "codex 1", state, prefix: "" },
  ]
  const shell = (status: Instrument["status"]) => [listed("01JA1K0000000000000000SHEL", { status })]

  const running = busyCounts({ family: family("running"), shells: shell("idle"), sessionID: ids.chat })
  expect(running).toEqual({ subagents: 1, shells: 0 })
  expect(busyTab(running)).toBe("subagents")

  // The owner's case: the shell runs, the Codex session ended.
  const shells = busyCounts({ family: family("ended"), shells: shell("running"), sessionID: ids.chat })
  expect(shells).toEqual({ subagents: 0, shells: 1 })
  expect(busyTab(shells)).toBe("shell")

  // An idle session isn't busy; nor is the session the picker is in.
  expect(busyCounts({ family: family("idle"), shells: [], sessionID: ids.chat })).toEqual({ subagents: 0, shells: 0 })
  expect(busyCounts({ family: family("running"), shells: [], sessionID: ids.a })).toEqual({ subagents: 0, shells: 0 })
  expect(busyTab({ subagents: 0, shells: 0 })).toBe("subagents")
})

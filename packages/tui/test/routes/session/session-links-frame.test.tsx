// Session ids in an assistant reply, as upstream's session links: the id of a session the TUI holds is underlined in
// the link colour, and a click opens it, one of the chat's Codex or Claude Code sessions in the right pane.
import type { Instrument, Message, Session } from "@opencorp/protocol"
import { TextAttributes } from "@opentui/core"
import { expect, setDefaultTimeout, test } from "bun:test"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>

// A test here waits on several frames in turn, each up to 3 s.
setDefaultTimeout(20_000)

const AT = "2026-11-22T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
// A ULID the office holds no session for, as a run's id.
const unknown = "01JQ8Z3V4XKM5N6P7R8S9T0WXY"

/** An assistant message in `session` saying `text`. */
const say = (office: FakeOffice, session: string, text: string): Message => ({
  id: office.nextId(),
  session_id: session,
  role: "assistant",
  author: null,
  parts: [{ id: `pa${office.nextId()}`, type: "text", text }],
  created_at: AT,
})

/** Adds a Codex session minh's chat `chat` drives, listed as the chat's instrument `codex 1`. */
function codex(office: FakeOffice, chat: string) {
  const s = office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness: "codex",
    kind: "instrument",
    instrument_of: chat,
  })
  office.addInstrument(chat, {
    id: s.id,
    session_id: chat,
    kind: "codex",
    name: "codex 1",
    driver: "minh",
    profile: "harness",
    interactive: false,
    status: "idle",
    created_at: AT,
    updated_at: AT,
  } satisfies Instrument)
  office.state.messages[s.id] = [say(office, s.id, "codex 1 says hello.")]
  return s
}

/** Boots minh's chat on a 120x30 screen with a reply of each text `setup` returns once it has added its sessions. */
async function boot(setup: (office: FakeOffice, chat: Session) => string | string[]) {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  office.state.messages[chat.id] = [setup(office, chat)].flat().map((text) => say(office, chat.id, text))
  const app = await bootFrame(createStub(office), { sessionID: chat.id }, { width: 120, height: 30 })
  await app.until((f) => f.includes("@minh auto ·"))
  return { office, chat, app }
}

/** The underlined spans on screen, in order. */
const underlined = (app: App) =>
  app.setup
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .filter((s) => s.attributes & TextAttributes.UNDERLINE)

/** Clicks the first cell of `needle` a few cells in. */
async function click(app: App, needle: string) {
  const rows = app.frame().split("\n")
  const y = rows.findIndex((r) => r.includes(needle))
  if (y < 0) throw new Error(`${needle} isn't on screen:\n` + app.frame())
  app.setup.renderer.clearSelection()
  await app.setup.mockMouse.click(rows[y]!.indexOf(needle) + 3, y)
}

/** Whether the right pane is open: its box's top-left corner shows. */
const paneOpen = (f: string) => f.includes("┌")

test("a reply links another session's id and the chat's Codex session's; the chat's own and an unknown ULID stay plain", async () => {
  let other!: Session
  let child!: Session
  const { office, chat, app } = await boot((office, chat) => {
    other = office.newSession({ person: "minh", cwd: "/tmp/proj" })
    child = codex(office, chat.id)
    return `Ask ${other.id} or ${child.id}. This chat is ${chat.id}, and ${unknown} is a run.`
  })
  try {
    await app.until((f) => f.includes(unknown) && underlined(app).length === 2)
    expect(underlined(app).map((s) => s.text.trim())).toEqual([other.id, child.id])
    // In the link colour, as upstream's.
    for (const span of underlined(app)) expect(span.fg.equals(theme.markdownLink)).toBe(true)
    expect(app.frame()).toContain(`This chat is ${chat.id}, and`)
    expect(app.frame()).toContain(`${unknown} is a run.`)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a click on the chat's Codex session's id opens it in the right pane, beside the chat", async () => {
  let child!: Session
  const { office, app } = await boot((office, chat) => {
    child = codex(office, chat.id)
    return `Codex runs in ${child.id} now.`
  })
  try {
    await app.until(() => underlined(app).length === 1)
    expect(paneOpen(app.frame())).toBe(false)
    await click(app, child.id)
    const f = await app.until((f) => paneOpen(f) && f.includes("codex 1 says hello."))
    // Beside the chat, which still shows the reply.
    expect(f).toContain("Codex runs in")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a click on another session's id goes to it", async () => {
  let other!: Session
  const { office, app } = await boot((office) => {
    other = office.newSession({ person: "minh", cwd: "/tmp/proj" })
    office.state.messages[other.id] = [say(office, other.id, "The other chat says hi.")]
    return `See ${other.id} for the plan.`
  })
  try {
    await app.until(() => underlined(app).length === 1)
    await click(app, other.id)
    const f = await app.until((f) => f.includes("The other chat says hi."))
    expect(f).not.toContain("for the plan.")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a code span links only when it is exactly a session's id", async () => {
  let child!: Session
  const { office, app } = await boot((office, chat) => {
    child = codex(office, chat.id)
    return `Run \`codex resume ${child.id}\` or open \`${child.id}\`.`
  })
  try {
    await app.until(() => underlined(app).length === 1)
    expect(underlined(app).map((s) => s.text.trim())).toEqual([child.id])
    expect(app.frame()).toContain(`codex resume ${child.id}`)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("with a dozen sessions in the office, a reply still links an id, and a reply naming none shows", async () => {
  let other!: Session
  const { office, app } = await boot((office) => {
    const sessions = Array.from({ length: 12 }, () => office.newSession({ person: "minh", cwd: "/tmp/proj" }))
    other = sessions[5]!
    office.state.messages[other.id] = [say(office, other.id, "The other chat says hi.")]
    return [`See ${other.id} for the plan.`, "Nothing to link here."]
  })
  try {
    await app.until((f) => f.includes("Nothing to link here.") && underlined(app).length === 1)
    expect(underlined(app).map((s) => s.text.trim())).toEqual([other.id])
    await click(app, other.id)
    await app.until((f) => f.includes("The other chat says hi."))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a session that comes into the list with a delta naming it links in every block that names it", async () => {
  const later = "01JQ8Z3V4XKM5N6P7R8S9T0WXZ"
  const { office, chat, app } = await boot(() => `See ${later} first.`)
  try {
    await app.until((f) => f.includes("first."))
    expect(underlined(app)).toHaveLength(0)
    const message = office.state.messages[chat.id]![0]!
    // Written together, both land in one flush: the delta's new block runs the hook before the effect that
    // re-renders the blocks already naming the session.
    office.newSession({ id: later, person: "minh", cwd: "/tmp/proj" })
    office.live({
      type: "part.delta",
      session_id: chat.id,
      data: { message_id: message.id, part_id: message.parts[0]!.id, text: `\n\nThen ${later} again.` },
    })
    await app.until((f) => f.includes("again.") && underlined(app).length === 2)
    expect(underlined(app).map((s) => s.text.trim())).toEqual([later, later])
  } finally {
    await app.stop()
    office.stop()
  }
})

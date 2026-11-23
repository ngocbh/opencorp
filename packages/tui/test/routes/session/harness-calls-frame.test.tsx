// An employee's Codex and Claude Code calls in the chat, as the upstream TUI's subagent row: the picker's name for the
// session and the message, `✓` once a start is done, `↳` for a call to a session already started, and a spinner while
// the call or the session runs. A click opens the session in the right pane, unless the chat doesn't list it.
import type { Instrument, Message, Session, ToolPart } from "@opencorp/protocol"
import { expect, setDefaultTimeout, test } from "bun:test"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>

// A test here waits on several frames in turn, each up to 3 s.
setDefaultTimeout(20_000)

const AT = "2026-11-22T10:00:00.000Z"

/** A reply as the office writes it, naming session `name` of `kind`. */
const reply = (kind: string, name: string, status = "idle") =>
  JSON.stringify({ [kind]: name, status, output: [], next: 0, more: false })

let n = 0
/** A completed call of `tool` with `input` and `output`, unless `fields` say otherwise. */
const call = (
  tool: string,
  input: Record<string, unknown>,
  output: string,
  fields: Partial<ToolPart> = {},
): ToolPart => ({
  id: `p${++n}`,
  type: "tool",
  call_id: `call_${n}`,
  tool,
  state: "completed",
  input,
  output,
  ...fields,
})

/** Adds a session of `kind` minh's chat `chat` drives, its child session, listed as the chat's instrument `name`. */
function child(office: FakeOffice, chat: string, kind: "codex" | "claude", name: string, status: Session["status"]) {
  const s = office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness: kind,
    kind: "instrument",
    instrument_of: chat,
    status,
  })
  const listed: Instrument["status"] = status === "busy" ? "running" : status === "ended" ? "ended" : "idle"
  office.addInstrument(chat, {
    id: s.id,
    session_id: chat,
    kind,
    name,
    driver: "minh",
    profile: "harness",
    interactive: false,
    status: listed,
    created_at: AT,
    updated_at: AT,
  })
  office.state.messages[s.id] = [
    {
      id: office.nextId(),
      session_id: s.id,
      role: "assistant",
      author: null,
      parts: [{ id: `pa${s.id}`, type: "text", text: `${name} says hello.` }],
      created_at: AT,
    },
  ]
  return s
}

/** Boots minh's chat with one assistant message of `parts` on a 120x30 screen, after `setup` adds its sessions. */
async function boot(parts: ToolPart[], setup: (office: FakeOffice, chat: string) => void = () => {}) {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  setup(office, chat.id)
  office.state.messages[chat.id] = [
    { id: "M1", session_id: chat.id, role: "assistant", created_at: AT, parts },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: chat.id }, { width: 120, height: 30 })
  await app.until((f) => f.includes("@minh auto ·"))
  return { office, chat, app }
}

const rows = (f: string) => f.split("\n")
/** The screen row holding `needle`, trimmed, and where it is. */
function row(f: string, needle: string) {
  const y = rows(f).findIndex((r) => r.includes(needle))
  if (y < 0) throw new Error(`${needle} isn't on screen:\n` + f)
  return { text: rows(f)[y]!.trim(), x: rows(f)[y]!.indexOf(needle), y }
}
/** Whether the row holding `needle` starts with a spinner frame. */
const spins = (f: string, needle: string) => SPINNER_FRAMES.some((frame) => row(f, needle).text.startsWith(frame))
/** Whether the right pane is open: its box's top-left corner shows. */
const paneOpen = (f: string) => f.includes("┌")

/** Clicks the row holding `needle`, a few cells into it. */
async function click(app: App, needle: string) {
  const at = row(app.frame(), needle)
  await app.setup.mockMouse.click(at.x + 2, at.y)
}

test("Codex and Claude Code calls show the session's name and the message, ✓ or ↳, and spin while their session runs", async () => {
  const { office, app } = await boot(
    [
      call("codex_start", { message: "Fix the parser.\nThen run the tests." }, reply("codex", "codex 1", "running")),
      call("codex_send", { codex: "codex 1", message: "Use the other API" }, reply("codex", "codex 1", "running")),
      call("codex_interrupt", { codex: "codex 1" }, reply("codex", "codex 1")),
      call("claude_start", { message: "Start the server" }, reply("claude", "claude 1")),
      call("claude_history", { claude: "claude 1", trace: true }, reply("claude", "claude 1")),
      call("claude_stop", { claude: "claude 1" }, reply("claude", "claude 1", "ended")),
      // A start that hasn't replied: no name yet.
      call("codex_start", { message: "Write the docs" }, "{}", { state: "running" }),
    ],
    (office, chat) => {
      child(office, chat, "codex", "codex 1", "busy")
      child(office, chat, "claude", "claude 1", "idle")
    },
  )
  try {
    let f = await app.until((f) => f.includes("Codex — Write the docs"))
    // Upstream's icons, its row label in the picker's names, and the message on one line.
    expect(row(f, "Claude Code: claude 1 — Start the server").text).toStartWith("✓ ")
    expect(row(f, "Claude Code: claude 1 — history").text).toStartWith("↳ ")
    expect(row(f, "Claude Code: claude 1 — stop").text).toStartWith("↳ ")
    expect(f).toContain("Codex: codex 1 — Fix the parser. Then run the tests.")
    // Every call to codex 1 spins while it runs a turn, and the start that hasn't replied while it runs.
    for (const label of ["Fix the parser.", "Codex: codex 1 — Use the other API", "Codex: codex 1 — interrupt"])
      expect(spins(f, label)).toBe(true)
    expect(spins(f, "Codex — Write the docs")).toBe(true)
    expect(spins(f, "Claude Code: claude 1 — Start the server")).toBe(false)
    // The reply's fields never show.
    expect(f).not.toContain('"next"')

    // Its turn ends.
    const codex = office.state.sessions.find((s) => s.harness === "codex")!
    office.setStatus(codex.id, "idle")
    f = await app.until((f) => row(f, "Fix the parser.").text.startsWith("✓ "))
    expect(row(f, "Codex: codex 1 — Use the other API").text).toStartWith("↳ ")
    expect(row(f, "Codex: codex 1 — interrupt").text).toStartWith("↳ ")
    expect(spins(f, "Codex — Write the docs")).toBe(true)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a click on a call opens its session in the right pane; a call to a session the chat doesn't list opens nothing", async () => {
  const { office, app } = await boot(
    [
      call("codex_send", { codex: "codex 1", message: "Use the other API" }, reply("codex", "codex 1")),
      call("claude_history", { claude: "claude 2" }, JSON.stringify({ refused: "claude 2 isn't open" })),
      call("codex_start", { message: "Write the docs" }, "{}", { state: "running" }),
    ],
    (office, chat) => {
      child(office, chat, "codex", "codex 1", "idle")
    },
  )
  try {
    await app.until((f) => f.includes("Claude Code: claude 2 — history") && f.includes("Codex — Write the docs"))
    await click(app, "Claude Code: claude 2 — history")
    await click(app, "Codex — Write the docs")
    await Bun.sleep(200)
    await app.setup.renderOnce()
    expect(paneOpen(app.frame())).toBe(false)

    await click(app, "Codex: codex 1 — Use the other API")
    const f = await app.until((f) => paneOpen(f) && f.includes("codex 1 says hello."))
    // Beside the chat, which still shows the call.
    expect(f).toContain("Codex: codex 1 — Use the other API")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a refused call says why after its label, as a terminal call does", async () => {
  const { office, app } = await boot(
    [
      call(
        "codex_send",
        { codex: "codex 1", message: "Use the other API" },
        JSON.stringify({ refused: "a turn the owner started runs" }),
      ),
      call("codex_send", { codex: "codex 1", message: "Go on" }, reply("codex", "codex 1")),
    ],
    (office, chat) => {
      child(office, chat, "codex", "codex 1", "idle")
    },
  )
  try {
    const f = await app.until((f) => f.includes("Codex: codex 1 — Go on"))
    expect(row(f, "Use the other API").text).toBe(
      "↳ Codex: codex 1 — Use the other API · refused: a turn the owner started runs",
    )
    expect(row(f, "Codex: codex 1 — Go on").text).toBe("↳ Codex: codex 1 — Go on")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("with tool details hidden, a completed call folds away as any tool does, and a running one stays", async () => {
  const { office, app } = await boot(
    [
      call("codex_send", { codex: "codex 1", message: "Use the other API" }, reply("codex", "codex 1")),
      call("codex_start", { message: "Write the docs" }, "{}", { state: "running" }),
    ],
    (office, chat) => {
      child(office, chat, "codex", "codex 1", "busy")
    },
  )
  try {
    await app.until((f) => f.includes("Codex: codex 1 — Use the other API"))
    app.input.pressKey("p", { ctrl: true })
    await app.until((f) => f.includes("Commands"))
    // The search box takes focus a moment after it renders.
    await Bun.sleep(50)
    app.input.typeText("Hide tool details")
    await app.until((f) => f.split("Hide tool details").length > 2)
    app.input.pressEnter()
    const f = await app.until((f) => !f.includes("Use the other API"))
    expect(f).toContain("Codex — Write the docs")
  } finally {
    await app.stop()
    office.stop()
  }
})
